import type { AddonContext } from '@wealthfolio/addon-sdk';
import { createBrokeredFetch, readKeyPair } from '@wealthfolio-connectors/connector-kit';
import { API_KEY_SECRET_KEY, API_SECRET_SECRET_KEY } from '../config';
import { createKrakenClient } from './client';
import type { KrakenClient } from './client';

/** The two keyring entries this connector uses. */
export const KRAKEN_KEYS = {
  apiKeyEntry: API_KEY_SECRET_KEY,
  apiSecretEntry: API_SECRET_SECRET_KEY,
} as const;

/**
 * A Kraken client that reaches the network through Wealthfolio's broker.
 *
 * `createBrokeredFetch` is called with no auth descriptor on purpose. The host
 * can only build `basic` and `bearer` headers, and Kraken wants an HMAC over a
 * nonce and the request body — so the signature is computed here and sent as
 * `API-Key` and `API-Sign`, which the broker permits because neither is on its
 * forbidden-header list.
 *
 * The consequence, stated plainly because it is the one real cost of this
 * connector: the private key is read back out of the keyring and lives in
 * addon memory for the length of a request. A read-only Kraken key bounds what
 * that is worth to anyone, and `allowedHosts` bounds where it can be sent.
 *
 * Returns undefined when no credentials are stored, so a caller can show the
 * setup form rather than fail a request nobody could have authenticated.
 */
export async function createSource(ctx: AddonContext): Promise<KrakenClient | undefined> {
  const pair = await readKeyPair(ctx, KRAKEN_KEYS);
  if (!pair) return undefined;

  return createKrakenClient({
    apiKey: pair.apiKey,
    apiSecret: pair.apiSecret,
    fetch: createBrokeredFetch(ctx),
    onThrottle: (seconds) =>
      ctx.api.logger.info(`[kraken] waiting ${seconds.toFixed(1)}s on the rate limiter`),
  });
}
