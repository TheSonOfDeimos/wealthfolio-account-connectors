import { toBasicSecret } from '../src/index';
import type {
  HttpRequest,
  HttpResponse,
  T212AccountSummary,
  T212HistoricalOrder,
} from '../src/index';

/**
 * An in-memory Trading 212 API.
 *
 * Implements the parts of the contract the client depends on — Basic auth,
 * cursor pagination via `nextPagePath`, `x-ratelimit-*` headers, and the 401 /
 * 429 responses — so the client can be exercised without touching a real
 * account. Shapes follow https://docs.trading212.com/api.
 */

export interface T212StubOptions {
  apiKey?: string;
  apiSecret?: string;
  summary?: T212AccountSummary;
  orders?: T212HistoricalOrder[];
  /** Fills per page; the real API caps this at 50. */
  pageSize?: number;
  /** Fail every request with 429 to exercise the rate-limit path. */
  alwaysRateLimit?: boolean;
}

export interface T212Stub {
  handle: (request: HttpRequest, authorization?: string) => Promise<HttpResponse>;
  /** Paths served so far, for assertions about pagination. */
  calls: string[];
}

export const STUB_API_KEY = 'test-api-key';
export const STUB_API_SECRET = 'test-api-secret';

export function createT212Stub(options: T212StubOptions = {}): T212Stub {
  const expectedAuth = `Basic ${toBasicSecret(
    options.apiKey ?? STUB_API_KEY,
    options.apiSecret ?? STUB_API_SECRET,
  )}`;
  const orders = options.orders ?? [];
  const pageSize = options.pageSize ?? 50;
  const calls: string[] = [];

  const handle = async (
    request: HttpRequest,
    authorization?: string,
  ): Promise<HttpResponse> => {
    const url = new URL(request.url);
    calls.push(`${url.pathname}${url.search}`);

    if (options.alwaysRateLimit) {
      return json(429, { code: 'BusinessRejectReason.TOO_MANY_REQUESTS' }, rateLimitHeaders(0));
    }
    if (authorization !== expectedAuth) {
      return json(401, { code: 'Unauthorised' });
    }

    if (url.pathname.endsWith('/equity/account/summary')) {
      return json(200, options.summary ?? defaultSummary());
    }

    if (url.pathname.endsWith('/equity/history/orders')) {
      const limit = Math.min(Number(url.searchParams.get('limit') ?? pageSize), pageSize);
      const cursor = url.searchParams.get('cursor');
      const start = cursor ? Number(cursor) : 0;
      const items = orders.slice(start, start + limit);
      const nextStart = start + items.length;
      const nextPagePath =
        nextStart < orders.length
          ? `/api/v0/equity/history/orders?limit=${limit}&cursor=${nextStart}`
          : null;
      return json(200, { items, nextPagePath });
    }

    return json(404, { code: 'NotFound', path: url.pathname });
  };

  return { handle, calls };
}

function json(
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): HttpResponse {
  return {
    status,
    headers: {
      'content-type': 'application/json',
      ...rateLimitHeaders(),
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

function rateLimitHeaders(remaining = 5): Record<string, string> {
  return {
    'x-ratelimit-limit': '6',
    'x-ratelimit-period': '60',
    'x-ratelimit-remaining': String(remaining),
    'x-ratelimit-used': String(6 - remaining),
    'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 60),
  };
}

function defaultSummary(): T212AccountSummary {
  return {
    id: 12345678,
    currency: 'GBP',
    cash: { availableToTrade: 1250.5, inPies: 0, reservedForOrders: 0 },
    investments: {
      currentValue: 8750.25,
      totalCost: 8000,
      realizedProfitLoss: 120.4,
      unrealizedProfitLoss: 750.25,
    },
    totalValue: 10000.75,
  };
}
