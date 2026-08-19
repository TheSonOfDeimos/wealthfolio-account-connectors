import type { AddonContext } from '@wealthfolio/addon-sdk';
import { createBrokeredFetch, readKeyPair } from '@wealthfolio-connectors/connector-kit';
import { API_KEY_SECRET_KEY, API_SECRET_SECRET_KEY } from '../config';
import { createCryptoComClient } from './client';
import type { CryptoComClient } from './client';

/** The two keyring entries this connector uses. */
export const CRYPTOCOM_KEYS = {
  apiKeyEntry: API_KEY_SECRET_KEY,
  apiSecretEntry: API_SECRET_SECRET_KEY,
} as const;

/**
 * A Crypto.com client that reaches the network through Wealthfolio's broker.
 *
 * `createBrokeredFetch` is called with no auth descriptor. The host can only
 * build `basic` and `bearer` headers, and Crypto.com wants neither — its
 * signature travels inside the JSON body as a `sig` field, which the broker
 * forwards verbatim because it is body content rather than a header.
 *
 * That makes this the easiest of the three connectors for the broker to carry,
 * and it does not change the one real cost, which belongs in the open: like the
 * Kraken connector and unlike the Trading 212 one, this reads its API secret
 * back out of the keyring and holds it in memory for the length of a signature.
 * A key with "Can Read" and neither toggle enabled bounds what that is worth to
 * anyone, and `allowedHosts` bounds where it can be sent.
 *
 * Returns undefined when no credentials are stored, so a caller can show the
 * setup form rather than fail a request nobody could have authenticated.
 */
export async function createSource(ctx: AddonContext): Promise<CryptoComClient | undefined> {
  const pair = await readKeyPair(ctx, CRYPTOCOM_KEYS);
  if (!pair) return undefined;

  return createCryptoComClient({
    apiKey: pair.apiKey,
    apiSecret: pair.apiSecret,
    fetch: createBrokeredFetch(ctx),
    /**
     * Deliberately no `onThrottle`.
     *
     * `get-trades` is limited to one request per second, so a backfill waits on
     * it roughly once per week of history — about 100 times. Reporting each of
     * those through `ctx.api.logger` put 100 lines in the browser console,
     * where the host renders an addon's `info` as a `console.warn`: a sync that
     * was working perfectly filled DevTools with warnings.
     *
     * The pacing is not hidden, it is reported where it belongs — the pipeline
     * already tells the Activity panel how many requests a stream has made and
     * that trades are limited to one a second. The Node tools pass their own
     * callback and print it to stdout, which is the place a long wait actually
     * needs explaining.
     */
  });
}
