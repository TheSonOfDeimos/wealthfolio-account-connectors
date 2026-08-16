/**
 * Kraken request signing.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  Why this module exists at all
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Wealthfolio's network broker supports two auth types, `basic` and `bearer`,
 * and refuses any `Authorization` header an addon sets itself. Kraken wants a
 * per-request HMAC-SHA512 over a nonce and the POST body. Nothing the host
 * offers can produce that, so the connector signs its own requests and sends
 * the result as two ordinary headers — `API-Key` and `API-Sign`, neither of
 * which is on the broker's forbidden list.
 *
 * The cost is real and belongs in the open: unlike the Trading 212 connector,
 * this one reads its API secret back out of the keyring and holds it in memory
 * for the length of a signature. A read-only Kraken key bounds the damage; the
 * manifest's `allowedHosts` bounds where it can be sent.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  Written against WebCrypto on purpose
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `globalThis.crypto.subtle` exists in Node 19+ and in the browser, so this is
 * the same code in `pnpm smoke:live` and inside the addon sandbox. That is the
 * point: the Node tools exercise the exact signing path that ships, rather than
 * a Node-flavoured stand-in that happens to agree.
 *
 * One caveat kept for the record. WebCrypto is only defined in a secure
 * context, and the addon runs in an opaque-origin `srcdoc` iframe. Secure
 * context should be inherited from `tauri://` and from `127.0.0.1`, but if it
 * turns out not to be, the fix is to swap the two primitives below for
 * `@noble/hashes` — zero dependencies, synchronous, no context requirement.
 * Nothing else in this file would change.
 */

/**
 * The detail that breaks naive ports.
 *
 * Kraken signs `HMAC-SHA512(uriPath + SHA256(nonce + body))`, and that `+` is a
 * concatenation of **bytes**. Node's own examples fake it by turning the digest
 * into a latin1 string, which works there and cannot be ported — a signature
 * built from a UTF-8 encoding of that string is well-formed and rejected every
 * time, with an error message that says only "Invalid key".
 */
/**
 * Backed by a plain `ArrayBuffer` rather than the default `ArrayBufferLike`,
 * because WebCrypto's `BufferSource` excludes `SharedArrayBuffer` and the
 * looser type will not satisfy it.
 */
type Bytes = Uint8Array<ArrayBuffer>;

function concatBytes(a: Bytes, b: Bytes): Bytes {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function base64Encode(bytes: Bytes): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64Decode(value: string): Bytes {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

/**
 * `API-Sign` for one request.
 *
 * `secret` is Kraken's "Private key" exactly as it is displayed: base64, and
 * decoded here rather than by the caller, so a secret never has to be stored in
 * a second form.
 */
export async function signRequest(
  path: string,
  body: string,
  nonce: string,
  secret: string,
): Promise<string> {
  const encoder = new TextEncoder();

  const inner: Bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', encoder.encode(nonce + body) as Bytes),
  );
  const message = concatBytes(encoder.encode(path) as Bytes, inner);

  const key = await crypto.subtle.importKey(
    'raw',
    base64Decode(secret),
    { name: 'HMAC', hash: 'SHA-512' },
    false,
    ['sign'],
  );

  return base64Encode(new Uint8Array(await crypto.subtle.sign('HMAC', key, message)));
}

/**
 * Nonces, which Kraken requires to increase strictly per key.
 *
 * Microsecond-scaled milliseconds, with a floor so two calls inside the same
 * millisecond cannot collide. The scaling leaves room to move to a finer clock
 * later without ever emitting a nonce below one already used — going backwards
 * locks the key out until the newer nonce is passed again.
 *
 * This is also why the key should be used by nothing else: a second tool
 * issuing its own nonces against the same key produces `EAPI:Invalid nonce`
 * that looks exactly like a bug in here.
 */
export function createNonceSource(): () => string {
  let last = 0;
  return () => {
    const now = Date.now() * 1000;
    last = now > last ? now : last + 1;
    return String(last);
  };
}
