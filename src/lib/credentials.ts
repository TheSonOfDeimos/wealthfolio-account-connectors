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
import { CREDENTIALS_SECRET_KEY } from '../config';

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
  apiKey: string,
  apiSecret: string,
): Promise<void> {
  const key = apiKey.trim();
  const secret = apiSecret.trim();
  if (!key || !secret) {
    throw new Error('Both the API key and the API secret are required.');
  }
  await ctx.api.secrets.set(CREDENTIALS_SECRET_KEY, toBasicSecret(key, secret));
}

export async function hasCredentials(ctx: AddonContext): Promise<boolean> {
  const stored = await ctx.api.secrets.get(CREDENTIALS_SECRET_KEY);
  return Boolean(stored);
}

export async function clearCredentials(ctx: AddonContext): Promise<void> {
  await ctx.api.secrets.delete(CREDENTIALS_SECRET_KEY);
}
