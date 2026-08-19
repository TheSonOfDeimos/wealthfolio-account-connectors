/**
 * The Crypto.com Exchange transport.
 *
 * Hand-written, for the same reason the Kraken one is: every Crypto.com client
 * on npm brings its own HTTP layer, and that is precisely the layer the addon
 * sandbox forbids. The sandbox is an opaque-origin iframe with no egress; the
 * only way out is `ctx.api.network.request`.
 *
 * ccxt covers this exchange properly and was read as the reference
 * implementation — its `sign()` pins down the signature payload and its endpoint
 * table pins down the costs — but depending on it would mean shipping megabytes
 * and a bundled transport to reach eight endpoints. `npm-kraken-api` served the
 * same role for the other connector.
 *
 * So `fetch` is a parameter. Under Node it is the real one; inside the addon it
 * is the brokered one. Nothing else about a request differs between the two,
 * which is what makes `pnpm smoke:live` evidence about the addon rather than
 * about a script that resembles it.
 */
import { createIdSource, signRequest } from './sign';
import type { Params } from './sign';
import {
  CRYPTOCOM_BASE_URL,
  CRYPTOCOM_V2_BASE_URL,
  DEFAULT_INTERVAL_MS,
  METHOD_INTERVAL_MS,
} from '../config';
import type { CryptoComReply } from './types';

export interface CryptoComClientOptions {
  apiKey: string;
  /** The API secret as Crypto.com displays it. Not base64; never decoded. */
  apiSecret: string;
  /** Node's global under the tools; the brokered one inside the addon. */
  fetch: typeof globalThis.fetch;
  /** Called before a call sleeps, so a long walk does not look hung. */
  onThrottle?: (method: string, seconds: number) => void;
}

export interface CryptoComClient {
  /** Public endpoints: GET, unsigned, and free of the private rate limits. */
  publicCall<T>(method: string, params?: Record<string, string>): Promise<T>;
  /** Private endpoints: POST, signed, and paced per method. */
  privateCall<T>(method: string, params?: Params): Promise<T>;
  /**
   * The same, against the older `v2` host.
   *
   * Only the statement export lives there. Named separately rather than
   * inferred from the method string, so nothing reaches the legacy API by
   * accident — a call that silently lands on the wrong host returns a
   * confusingly ordinary "method not found".
   */
  legacyCall<T>(method: string, params?: Params): Promise<T>;
}

/**
 * A Crypto.com API error, kept distinct from a transport failure.
 *
 * The difference decides what to do about it: `UNAUTHORIZED` is the signature
 * or the key, `TOO_MANY_REQUESTS` is the pacing, and a thrown `TypeError` is
 * the network. Collapsing them into one message is what makes a signing bug
 * take an evening instead of a minute.
 */
export class CryptoComError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    readonly detail: string,
  ) {
    super(`${method}: ${detail} (code ${code})`);
    this.name = 'CryptoComError';
  }

  /** True when waiting and retrying is the right response. */
  get isRateLimit(): boolean {
    return this.code === 42901 || this.code === 429 || /TOO_MANY_REQUESTS/i.test(this.detail);
  }

  /**
   * True when the key is wrong, unsigned correctly, or lacks a permission.
   *
   * `40101` is Crypto.com's `UNAUTHORIZED`, and it covers a genuinely bad key,
   * a correct key signed wrongly, and a nonce outside the 60-second window —
   * three quite different problems behind one code, which is why the message is
   * carried through rather than replaced with a friendlier guess.
   */
  get isAuth(): boolean {
    return this.code === 40101 || this.code === 401 || /UNAUTHORIZED/i.test(this.detail);
  }
}

/**
 * Crypto.com's rate limits, which apply **per method** rather than per key.
 *
 * Most private endpoints allow 100 requests/second; `get-trades` and
 * `get-order-history` allow one. Modelling this as a shared counter — the way
 * Kraken's works — would be wrong in a way that matters: a one-per-second
 * `get-trades` walk would throttle the deposit walk beside it, turning a
 * two-minute extraction into a ten-minute one for no reason the API asked for.
 *
 * So each method keeps its own clock, and waits only on itself.
 */
function createLimiter(onThrottle?: (method: string, seconds: number) => void) {
  const nextAllowedAt = new Map<string, number>();

  return async function take(method: string): Promise<void> {
    const interval = METHOD_INTERVAL_MS[method] ?? DEFAULT_INTERVAL_MS;
    const now = Date.now();
    const earliest = nextAllowedAt.get(method) ?? 0;

    if (earliest > now) {
      const waitMs = earliest - now;
      // Only worth announcing when it is long enough for someone to notice the
      // pause; the 15ms spacing on ordinary methods would otherwise flood.
      if (waitMs >= 250) onThrottle?.(method, waitMs / 1000);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    nextAllowedAt.set(method, Math.max(now, earliest) + interval);
  };
}

export function createCryptoComClient(options: CryptoComClientOptions): CryptoComClient {
  const { apiKey, apiSecret, fetch } = options;
  const nextId = createIdSource();
  const take = createLimiter(options.onThrottle);

  async function unwrap<T>(method: string, response: Response): Promise<T> {
    const text = await response.text();
    let reply: CryptoComReply<T>;
    try {
      reply = JSON.parse(text) as CryptoComReply<T>;
    } catch {
      throw new Error(`${method}: HTTP ${response.status}, unparseable body: ${text.slice(0, 200)}`);
    }

    // A non-zero `code` inside an HTTP 200 is the normal way this API reports
    // failure, so the status line is checked second and only as a fallback for
    // the cases that never reach the application at all.
    if (reply.code !== 0) {
      const detail =
        reply.detail_message ?? reply.message ?? reply.detail_code ?? `HTTP ${response.status}`;
      throw new CryptoComError(method, reply.code, detail);
    }
    if (reply.result === undefined) {
      // Legitimate for the endpoints that acknowledge rather than answer, so
      // this returns an empty object instead of throwing. A caller expecting
      // rows gets an empty list, which reads correctly at every call site here.
      return {} as T;
    }
    return reply.result;
  }

  async function signedCall<T>(baseUrl: string, method: string, params: Params): Promise<T> {
    await take(method);

    // One value serves as both the request id and the nonce, which is what
    // Crypto.com's own samples do. The signature covers both positions, so they
    // must be the same value here and in the body.
    const id = nextId();
    const sig = await signRequest(method, id, apiKey, params, id, apiSecret);

    const response = await fetch(`${baseUrl}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, method, params, api_key: apiKey, sig, nonce: id }),
    });

    return unwrap<T>(method, response);
  }

  return {
    async publicCall<T>(method: string, params: Record<string, string> = {}) {
      const query = new URLSearchParams(params).toString();
      const url = `${CRYPTOCOM_BASE_URL}/${method}${query ? `?${query}` : ''}`;
      return unwrap<T>(method, await fetch(url, { method: 'GET' }));
    },

    privateCall<T>(method: string, params: Params = {}) {
      return signedCall<T>(CRYPTOCOM_BASE_URL, method, params);
    },

    legacyCall<T>(method: string, params: Params = {}) {
      return signedCall<T>(CRYPTOCOM_V2_BASE_URL, method, params);
    },
  };
}
