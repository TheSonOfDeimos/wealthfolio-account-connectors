/**
 * The API key and secret, and where they live.
 *
 * Only ever written from what you type into the addon's own form, and only ever
 * into Wealthfolio's keyring. Nothing here reads them back: the host attaches
 * them to each Trading 212 request itself, so the addon never holds them in
 * memory after the moment they are saved.
 *
 * Nothing is read from the source tree. The key pair used to live in
 * `config.ts`, which meant the credentials form never appeared and a real pair
 * was compiled into `dist/addon.js` in plaintext. The Node scripts —
 * `pnpm smoke:live`, `pnpm symbols:generate` — take theirs from `.env`
 * instead, since they run outside the sandbox and have no keyring to read.
 */
import type { AddonContext } from '@wealthfolio/addon-sdk';

/**
 * Base64 of `API_KEY:API_SECRET` — the exact string Wealthfolio's keyring must
 * hold for `network.request({ auth: { type: 'basic' } })`. The host emits it
 * verbatim after `Basic `, so the encoding has to happen on this side.
 */
export function toBasicSecret(apiKey: string, apiSecret: string): string {
  const raw = `${apiKey}:${apiSecret}`;
  // Credentials are ASCII, so btoa is safe. It exists in the sandbox iframe
  // and in Node 18+.
  return typeof btoa === 'function' ? btoa(raw) : Buffer.from(raw, 'utf-8').toString('base64');
}

export async function saveCredentials(
  ctx: AddonContext,
  secretKey: string,
  apiKey: string,
  apiSecret: string,
): Promise<void> {
  const key = apiKey.trim();
  const secret = apiSecret.trim();
  if (!key || !secret) {
    throw new Error('Both the API key and the API secret are required.');
  }
  await ctx.api.secrets.set(secretKey, toBasicSecret(key, secret));
}

export async function hasCredentials(ctx: AddonContext, secretKey: string): Promise<boolean> {
  const stored = await ctx.api.secrets.get(secretKey);
  return Boolean(stored);
}

export async function clearCredentials(ctx: AddonContext, secretKey: string): Promise<void> {
  await ctx.api.secrets.delete(secretKey);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Key pairs a connector has to read back
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where a provider's key and secret live when the connector must sign for
 * itself.
 *
 * The functions above exist so the addon never sees the credentials: the host
 * builds the `Authorization` header from a named keyring entry, and the
 * plaintext stays out of addon memory entirely. That only works for providers
 * the broker can authenticate — `basic` and `bearer`, and nothing else.
 *
 * An exchange that signs each request with an HMAC over a nonce and the body
 * cannot be served that way, so the connector has to hold the secret long
 * enough to compute a signature. These functions are that path, kept separate
 * and named plainly rather than folded into the ones above, because the
 * difference is a security property and not an implementation detail.
 *
 * Two entries rather than one encoded string: nothing here is being handed to
 * a header, so there is no encoding to agree on, and a secret is easier to
 * rotate on its own.
 */
export interface KeyPairKeys {
  apiKeyEntry: string;
  apiSecretEntry: string;
}

export async function saveKeyPair(
  ctx: AddonContext,
  keys: KeyPairKeys,
  apiKey: string,
  apiSecret: string,
): Promise<void> {
  const key = apiKey.trim();
  const secret = apiSecret.trim();
  if (!key || !secret) {
    throw new Error('Both the API key and the API secret are required.');
  }
  await ctx.api.secrets.set(keys.apiKeyEntry, key);
  await ctx.api.secrets.set(keys.apiSecretEntry, secret);
}

/** Undefined when either half is missing, so a partial save cannot half-work. */
export async function readKeyPair(
  ctx: AddonContext,
  keys: KeyPairKeys,
): Promise<{ apiKey: string; apiSecret: string } | undefined> {
  const [apiKey, apiSecret] = await Promise.all([
    ctx.api.secrets.get(keys.apiKeyEntry),
    ctx.api.secrets.get(keys.apiSecretEntry),
  ]);
  return apiKey && apiSecret ? { apiKey, apiSecret } : undefined;
}

export async function hasKeyPair(ctx: AddonContext, keys: KeyPairKeys): Promise<boolean> {
  return (await readKeyPair(ctx, keys)) !== undefined;
}

export async function clearKeyPair(ctx: AddonContext, keys: KeyPairKeys): Promise<void> {
  await ctx.api.secrets.delete(keys.apiKeyEntry);
  await ctx.api.secrets.delete(keys.apiSecretEntry);
}
