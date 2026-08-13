import { header, T212ApiError, T212RateLimitError } from './http';
import type { HttpTransport } from './http';
import type {
  T212AccountSummary,
  T212HistoricalOrder,
  T212Page,
  T212RateLimit,
} from './types';

/**
 * Trading 212 environments.
 *
 * This project defaults to LIVE (your real account). Every call the adapter
 * makes is a read; nothing here places or cancels orders. Point `baseUrl` at
 * DEMO if you would rather rehearse against paper money — you must also add
 * `demo.trading212.com` to `network.allowedHosts` in the addon manifest,
 * because the host broker only reaches declared hosts.
 */
export const T212_LIVE_BASE_URL = 'https://live.trading212.com/api/v0';
export const T212_DEMO_BASE_URL = 'https://demo.trading212.com/api/v0';

/** Max items per page the API accepts on list endpoints. */
const MAX_PAGE_LIMIT = 50;

export interface Trading212ClientOptions {
  transport: HttpTransport;
  /** Defaults to the live environment. */
  baseUrl?: string;
  /**
   * Minimum gap between requests, in milliseconds. `/history/orders` allows
   * 6 requests per minute, so paging without a pause trips the limiter after
   * six pages. Default 10s keeps a full page walk inside the budget.
   */
  minRequestIntervalMs?: number;
  /** Injectable for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface FetchOrdersPage {
  limit?: number;
  cursor?: number | string;
  ticker?: string;
}

export interface FetchAllOrdersOptions extends Omit<FetchOrdersPage, 'cursor'> {
  /** Safety valve so a large history cannot page forever. Default 5. */
  maxPages?: number;
  /** Called after each page so a UI can show progress. */
  onPage?: (page: T212Page<T212HistoricalOrder>, pageNumber: number) => void;
}

/**
 * Thin, read-only client over the Trading 212 Public API.
 *
 * Authentication is *not* handled here on purpose. In the addon, credentials
 * live in the OS keyring and the host broker attaches the `Authorization`
 * header from a secret the addon never sees in plaintext. The `basicAuthHeader`
 * helper below exists for out-of-app scripts (see `scripts/smoke-live.ts`).
 */
export class Trading212Client {
  private readonly transport: HttpTransport;
  private readonly baseUrl: string;
  private readonly minRequestIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  // A separate flag rather than a `lastRequestAt === 0` sentinel: an injected
  // clock legitimately starts at 0, which would disable pacing entirely.
  private hasRequested = false;
  private lastRequestAt = 0;

  /** Rate-limit headers from the most recent response, if the API sent any. */
  lastRateLimit: T212RateLimit = {};

  constructor(options: Trading212ClientOptions) {
    this.transport = options.transport;
    this.baseUrl = (options.baseUrl ?? T212_LIVE_BASE_URL).replace(/\/+$/, '');
    this.minRequestIntervalMs = options.minRequestIntervalMs ?? 10_000;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
  }

  /** `GET /equity/account/summary` — cash and investment totals. */
  async getAccountSummary(): Promise<T212AccountSummary> {
    return this.get<T212AccountSummary>('/equity/account/summary');
  }

  /** `GET /equity/history/orders` — one page of historical order fills. */
  async getHistoricalOrders(options: FetchOrdersPage = {}): Promise<T212Page<T212HistoricalOrder>> {
    const query = new URLSearchParams();
    query.set('limit', String(Math.min(options.limit ?? MAX_PAGE_LIMIT, MAX_PAGE_LIMIT)));
    if (options.cursor !== undefined) query.set('cursor', String(options.cursor));
    if (options.ticker) query.set('ticker', options.ticker);
    return this.get<T212Page<T212HistoricalOrder>>(`/equity/history/orders?${query}`);
  }

  /**
   * Walk `nextPagePath` until it is null or `maxPages` is reached.
   *
   * The docs are explicit that `nextPagePath` should be used verbatim — it
   * already carries the cursor and limit — so we follow it rather than
   * reconstructing the query ourselves.
   */
  async getAllHistoricalOrders(
    options: FetchAllOrdersOptions = {},
  ): Promise<{ items: T212HistoricalOrder[]; pagesFetched: number; truncated: boolean }> {
    const maxPages = options.maxPages ?? 5;
    const items: T212HistoricalOrder[] = [];

    let page = await this.getHistoricalOrders({ limit: options.limit, ticker: options.ticker });
    let pagesFetched = 1;
    items.push(...page.items);
    options.onPage?.(page, pagesFetched);

    while (page.nextPagePath && pagesFetched < maxPages) {
      page = await this.getByPath<T212Page<T212HistoricalOrder>>(page.nextPagePath);
      pagesFetched += 1;
      items.push(...page.items);
      options.onPage?.(page, pagesFetched);
    }

    return { items, pagesFetched, truncated: page.nextPagePath !== null };
  }

  /** Issue a GET against a path relative to the API root (e.g. `/equity/positions`). */
  private async get<T>(path: string): Promise<T> {
    return this.send<T>(`${this.baseUrl}${path}`, path);
  }

  /**
   * Issue a GET against a server-supplied absolute path such as
   * `/api/v0/equity/history/orders?limit=2&cursor=…`. The API root already
   * ends in `/api/v0`, so that prefix is stripped before joining.
   */
  private async getByPath<T>(apiPath: string): Promise<T> {
    const relative = apiPath.replace(/^\/api\/v0/, '');
    return this.send<T>(`${this.baseUrl}${relative}`, relative);
  }

  private async send<T>(url: string, path: string): Promise<T> {
    await this.throttle();

    const response = await this.transport.request({
      url,
      method: 'GET',
      headers: { Accept: 'application/json' },
    });

    this.lastRateLimit = parseRateLimit(response.headers);

    if (response.status === 429) {
      throw new T212RateLimitError(path, response.body, this.secondsUntilReset());
    }
    if (response.status < 200 || response.status >= 300) {
      throw new T212ApiError(response.status, path, response.body);
    }

    try {
      return JSON.parse(response.body) as T;
    } catch {
      throw new T212ApiError(response.status, path, `expected JSON, got: ${response.body.slice(0, 200)}`);
    }
  }

  private async throttle(): Promise<void> {
    if (this.minRequestIntervalMs <= 0 || !this.hasRequested) {
      this.hasRequested = true;
      this.lastRequestAt = this.now();
      return;
    }
    const elapsed = this.now() - this.lastRequestAt;
    const wait = this.minRequestIntervalMs - elapsed;
    if (wait > 0) await this.sleep(wait);
    this.lastRequestAt = this.now();
  }

  private secondsUntilReset(): number | undefined {
    const reset = this.lastRateLimit.reset;
    if (reset === undefined) return this.lastRateLimit.period;
    return Math.max(0, Math.ceil(reset - this.now() / 1000));
  }
}

function parseRateLimit(headers: Record<string, string>): T212RateLimit {
  const num = (name: string): number | undefined => {
    const raw = header(headers, name);
    if (raw === undefined) return undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  return {
    limit: num('x-ratelimit-limit'),
    remaining: num('x-ratelimit-remaining'),
    used: num('x-ratelimit-used'),
    period: num('x-ratelimit-period'),
    reset: num('x-ratelimit-reset'),
  };
}

/**
 * Build the `Authorization` value Trading 212 expects: base64 of
 * `API_KEY:API_SECRET`, prefixed with `Basic `.
 *
 * The addon does not use this — the host broker builds the header from the
 * keyring secret so the plaintext never enters the sandbox. It is here for
 * Node-side scripts and for the `basic` secret the broker consumes, which is
 * itself the base64 half of this value (see `toBasicSecret`).
 */
export function basicAuthHeader(apiKey: string, apiSecret: string): string {
  return `Basic ${toBasicSecret(apiKey, apiSecret)}`;
}

/**
 * Base64 of `API_KEY:API_SECRET` — the exact string the Wealthfolio secrets
 * store must hold for `network.request({ auth: { type: 'basic' } })`.
 */
export function toBasicSecret(apiKey: string, apiSecret: string): string {
  const raw = `${apiKey}:${apiSecret}`;
  if (typeof btoa === 'function') {
    // Browser/sandbox path. Credentials are ASCII, so btoa is safe here.
    return btoa(raw);
  }
  return Buffer.from(raw, 'utf-8').toString('base64');
}
