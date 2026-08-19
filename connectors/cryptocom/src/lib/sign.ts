/**
 * Crypto.com Exchange request signing.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  Why this module exists at all
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Wealthfolio's network broker builds exactly two kinds of `Authorization`
 * header, `basic` and `bearer`, and refuses any an addon sets itself.
 * Crypto.com uses neither: it wants an HMAC-SHA256 over the request's own
 * contents, carried *inside the JSON body* as a `sig` field.
 *
 * That is actually the friendlier of the two shapes this repo has met. Kraken
 * needed custom headers and got them only because `API-Key` and `API-Sign` are
 * not on the broker's forbidden list; Crypto.com needs no special header at
 * all, because the signature travels in the body the broker already forwards
 * verbatim.
 *
 * The cost is the same one and belongs in the open: like Kraken and unlike
 * Trading 212, this connector reads its API secret back out of the keyring and
 * holds it in memory for the length of a signature. A key with "Can Read" and
 * neither toggle enabled bounds the damage; `allowedHosts` bounds where it can
 * be sent.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  Written against WebCrypto on purpose
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `globalThis.crypto.subtle` exists in Node 19+ and in the browser, so this is
 * the same code under `pnpm smoke:live` and inside the addon sandbox. That is
 * the point: the Node tools exercise the signing path that ships, rather than a
 * Node-flavoured stand-in that happens to agree with it.
 */

/**
 * Backed by a plain `ArrayBuffer` rather than the default `ArrayBufferLike`,
 * because WebCrypto's `BufferSource` excludes `SharedArrayBuffer` and the
 * looser type will not satisfy it.
 */
type Bytes = Uint8Array<ArrayBuffer>;

/** A request parameter, as Crypto.com's own signing sample allows them to nest. */
export type ParamValue = string | number | boolean | null | undefined | ParamValue[] | { [key: string]: ParamValue };
export type Params = Record<string, ParamValue>;

/**
 * Flatten `params` into the string that goes into the signature.
 *
 * This is Crypto.com's `params_to_str`, and it is the whole of the difficulty
 * here. The rules, from their reference implementation:
 *
 *  - keys sorted **lexicographically**, then each emitted as `key` + `value`
 *    with no separator anywhere — no `=`, no `&`, no braces;
 *  - a nested object recurses by the same rule;
 *  - an array emits each element in order, with no delimiter and no index;
 *  - `null` and `undefined` emit the literal text `null`.
 *
 * Two details are worth stating because getting either wrong produces a
 * well-formed signature that is rejected with `UNAUTHORIZED`, which says
 * nothing about the cause:
 *
 *  1. **Sort the keys, do not trust insertion order.** JavaScript objects
 *     mostly preserve it and Crypto.com does not care what JavaScript does; the
 *     server sorts, so this must sort.
 *  2. **`false` is `"false"`, and `0` is `"0"`.** A truthiness check anywhere in
 *     here silently drops both, and an account with no such parameters passes
 *     every test until the day one appears.
 *
 * The numbers this connector sends are integer timestamps and page sizes, so
 * `String(value)` is exact. It would not be for a price near the float limits —
 * `String(1e21)` is `"1e+21"` — but no signed request here carries one, and
 * inventing a decimal formatter for a case that does not arise would be code
 * nothing exercises.
 */
export function paramsToString(value: ParamValue): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return value.map(paramsToString).join('');
  if (typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .map((key) => key + paramsToString(value[key]))
      .join('');
  }
  return String(value);
}

function toHex(bytes: Bytes): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/**
 * The `sig` for one request.
 *
 * The signed payload is `method + id + api_key + params_to_str(params) + nonce`,
 * concatenated with nothing between the parts, and the result is **lowercase
 * hex** — not base64, which is the one habit carried over from the Kraken
 * connector that produces a silent, total authentication failure.
 *
 * `secret` is the API secret exactly as Crypto.com displays it: a UTF-8 string
 * used as the HMAC key directly. It is not base64 and must not be decoded.
 */
export async function signRequest(
  method: string,
  id: number,
  apiKey: string,
  params: Params,
  nonce: number,
  secret: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const payload = `${method}${id}${apiKey}${paramsToString(params)}${nonce}`;

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret) as Bytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  return toHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(payload) as Bytes)));
}

/**
 * Request ids, which double as the nonce.
 *
 * Crypto.com asks that `nonce` be the current time in milliseconds and rejects
 * one more than 60 seconds from its own clock — so unlike Kraken's, this is a
 * freshness check rather than a strictly-increasing counter, and sharing the
 * key with another tool does not break it.
 *
 * The floor is still here. Two requests inside the same millisecond would carry
 * the same id, and an id is how a reply is matched to its request; keeping them
 * distinct costs one integer and removes a class of confusion from every log
 * that follows.
 */
export function createIdSource(): () => number {
  let last = 0;
  return () => {
    const now = Date.now();
    last = now > last ? now : last + 1;
    return last;
  };
}
