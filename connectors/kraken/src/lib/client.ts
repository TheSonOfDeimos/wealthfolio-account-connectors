/**
 * The Kraken transport.
 *
 * Hand-written because every Kraken client on npm bundles its own HTTP layer —
 * axios, got, `request` — and that is exactly the layer the addon sandbox
 * forbids. The sandbox is an opaque-origin iframe with no egress; the only way
 * out is `ctx.api.network.request`. `t212-sdk` was usable only because it takes
 * an injected `fetch`; no Kraken wrapper offers the same seam, and the surface
 * this connector needs is six endpoints.
 *
 * So `fetch` is a parameter here. Under Node it is the real one; inside the
 * addon it is the brokered one, which the host allows to carry `API-Key` and
 * `API-Sign` because neither appears on its forbidden-header list. Nothing else
 * about a request differs between the two.
 *
 * The reference implementation this follows is `kraken-api`'s `kraken.js` (MIT,
 * deprecated, Node-only) — read, not depended on.
 */
import { createNonceSource, signRequest } from './sign';
import { KRAKEN_BASE_URL, RATE_LIMIT } from '../config';
import type { KrakenReply } from './types';

export interface KrakenClientOptions {
  apiKey: string;
  /** Kraken's "Private key", base64, exactly as displayed. */
  apiSecret: string;
  /** Node's global under the tools; the brokered one inside the addon. */
  fetch: typeof globalThis.fetch;
  /** Higher-tier accounts decay twice as fast; see `RATE_LIMIT`. */
  tier?: 'standard' | 'higher';
  /** Called before a call sleeps, so a long walk does not look hung. */
  onThrottle?: (seconds: number) => void;
}

export interface KrakenClient {
  /** Public endpoints take no auth and cost nothing against the private counter. */
  publicCall<T>(method: string, params?: Record<string, string>): Promise<T>;
  /** Private endpoints are POST, signed, and paced against the counter. */
  privateCall<T>(method: string, params?: Record<string, string>, cost?: number): Promise<T>;
}

/**
 * A Kraken API error, kept distinct from a transport failure.
 *
 * The difference matters when reading a failed run: `EAPI:Invalid key` is a
 * signing or permissions problem, `EGeneral:Temporary lockout` is a rate
 * problem, and a thrown `TypeError` is the network. Collapsing them into one
 * message costs an evening, which is why they are separated here.
 */
export class KrakenError extends Error {
  constructor(
    readonly method: string,
    readonly codes: string[],
  ) {
    super(`${method}: ${codes.join(', ')}`);
    this.name = 'KrakenError';
  }

  /** True when waiting and retrying is the right response. */
  get isRateLimit(): boolean {
    return this.codes.some((code) => code.includes('Rate limit') || code.includes('Too many'));
  }

  /** True when the key lacks a permission, or the signature is wrong. */
  get isAuth(): boolean {
    return this.codes.some((code) => code.includes('Invalid key') || code.includes('Permission'));
  }
}

/**
 * Kraken's private rate limiter, modelled rather than discovered.
 *
 * A counter starts at zero, each call adds its cost, and the counter decays
 * continuously. Exceed the maximum and the key is locked out — a far worse
 * outcome than waiting, so this waits. History endpoints cost 4 against a
 * maximum of 20 decaying at 0.5/s, which is one page every eight seconds
 * sustained, after an initial burst of five.
 *
 * That pace is the reason a full backfill takes minutes, and the reason the
 * extractor reports progress per page rather than per stream.
 */
function createLimiter(tier: 'standard' | 'higher', onThrottle?: (seconds: number) => void) {
  const decay = tier === 'higher' ? RATE_LIMIT.decayHigher : RATE_LIMIT.decayStandard;
  let counter = 0;
  let updatedAt = Date.now();

  return async function take(cost: number): Promise<void> {
    const now = Date.now();
    counter = Math.max(0, counter - ((now - updatedAt) / 1000) * decay);
    updatedAt = now;

    if (counter + cost > RATE_LIMIT.max) {
      const seconds = (counter + cost - RATE_LIMIT.max) / decay;
      onThrottle?.(seconds);
      await new Promise((resolve) => setTimeout(resolve, Math.ceil(seconds * 1000)));
      counter = Math.max(0, counter - seconds * decay);
      updatedAt = Date.now();
    }

    counter += cost;
  };
}

export function createKrakenClient(options: KrakenClientOptions): KrakenClient {
  const { apiKey, apiSecret, fetch } = options;
  const nextNonce = createNonceSource();
  const take = createLimiter(options.tier ?? 'standard', options.onThrottle);

  async function unwrap<T>(method: string, response: Response): Promise<T> {
    // Kraken answers 200 with an error array far more often than it answers a
    // non-200, so the status alone proves nothing.
    const text = await response.text();
    let reply: KrakenReply<T>;
    try {
      reply = JSON.parse(text) as KrakenReply<T>;
    } catch {
      throw new Error(`${method}: HTTP ${response.status}, unparseable body: ${text.slice(0, 200)}`);
    }
    if (reply.error?.length) throw new KrakenError(method, reply.error);
    if (reply.result === undefined) throw new Error(`${method}: no result and no error`);
    return reply.result;
  }

  return {
    async publicCall<T>(method: string, params: Record<string, string> = {}) {
      const query = new URLSearchParams(params).toString();
      const url = `${KRAKEN_BASE_URL}/0/public/${method}${query ? `?${query}` : ''}`;
      return unwrap<T>(method, await fetch(url, { method: 'GET' }));
    },

    async privateCall<T>(method: string, params: Record<string, string> = {}, cost = 1) {
      await take(cost);

      const path = `/0/private/${method}`;
      const nonce = nextNonce();
      const body = new URLSearchParams({ nonce, ...params }).toString();

      const response = await fetch(KRAKEN_BASE_URL + path, {
        method: 'POST',
        headers: {
          'API-Key': apiKey,
          'API-Sign': await signRequest(path, body, nonce, apiSecret),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      });

      return unwrap<T>(method, response);
    },
  };
}
