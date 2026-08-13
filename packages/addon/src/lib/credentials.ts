import { toBasicSecret } from '@t212/core';
import type { AddonContext } from '@wealthfolio/addon-sdk';
import { CREDENTIALS_SECRET_KEY, DEV_CREDENTIALS } from '../config';

/**
 * Store the key pair in the OS keyring in the exact form the network broker
 * expects for `auth: { type: 'basic' }` — base64 of `API_KEY:API_SECRET`.
 */
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

/**
 * Move credentials hardcoded in `config.ts` into the keyring on first run.
 *
 * Convenience for local development: fill in `DEV_CREDENTIALS`, start the
 * addon, and it is configured. Existing keyring values win, so this never
 * overwrites credentials you entered through the UI.
 */
export async function seedDevCredentials(ctx: AddonContext): Promise<boolean> {
  const { apiKey, apiSecret } = DEV_CREDENTIALS;
  if (!apiKey || !apiSecret) return false;
  if (await hasCredentials(ctx)) return false;

  await saveCredentials(ctx, apiKey, apiSecret);
  ctx.api.logger.info(
    '[trading212] Seeded API credentials from config.ts into the keyring. Clear DEV_CREDENTIALS before sharing this addon.',
  );
  return true;
}
