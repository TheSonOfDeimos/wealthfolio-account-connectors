import { describe, expect, it } from 'vitest';
import {
  T212ApiError,
  T212RateLimitError,
  T212_LIVE_BASE_URL,
  Trading212Client,
  basicAuthHeader,
  toBasicSecret,
} from '../src/index';
import type { HttpTransport } from '../src/index';
import { buyApple, sampleHistory } from './fixtures';
import { STUB_API_KEY, STUB_API_SECRET, createT212Stub } from './t212-stub';
import type { T212Stub } from './t212-stub';

/** Transport that signs requests the way an out-of-app script would. */
function signedTransport(stub: T212Stub, apiKey = STUB_API_KEY, apiSecret = STUB_API_SECRET): HttpTransport {
  return {
    request: (request) => stub.handle(request, basicAuthHeader(apiKey, apiSecret)),
  };
}

function client(stub: T212Stub, transport = signedTransport(stub)) {
  // No pacing in tests; the throttle is exercised separately.
  return new Trading212Client({ transport, minRequestIntervalMs: 0 });
}

describe('toBasicSecret', () => {
  it('encodes key:secret as base64', () => {
    expect(toBasicSecret('abc', 'def')).toBe('YWJjOmRlZg==');
    expect(basicAuthHeader('abc', 'def')).toBe('Basic YWJjOmRlZg==');
  });
});

describe('Trading212Client', () => {
  it('defaults to the live environment', async () => {
    const stub = createT212Stub();
    const seen: string[] = [];
    const transport: HttpTransport = {
      request: (request) => {
        seen.push(request.url);
        return stub.handle(request, basicAuthHeader(STUB_API_KEY, STUB_API_SECRET));
      },
    };
    await new Trading212Client({ transport, minRequestIntervalMs: 0 }).getAccountSummary();
    expect(seen[0]).toBe(`${T212_LIVE_BASE_URL}/equity/account/summary`);
  });

  it('reads the account summary', async () => {
    const summary = await client(createT212Stub()).getAccountSummary();
    expect(summary.currency).toBe('GBP');
    expect(summary.cash.availableToTrade).toBe(1250.5);
    expect(summary.totalValue).toBe(10000.75);
  });

  it('captures rate-limit headers from the last response', async () => {
    const instance = client(createT212Stub());
    await instance.getAccountSummary();
    expect(instance.lastRateLimit.limit).toBe(6);
    expect(instance.lastRateLimit.period).toBe(60);
    expect(instance.lastRateLimit.remaining).toBe(5);
  });

  it('rejects wrong credentials with a 401', async () => {
    const stub = createT212Stub();
    const wrong = signedTransport(stub, 'nope', 'wrong');
    await expect(client(stub, wrong).getAccountSummary()).rejects.toBeInstanceOf(T212ApiError);
    await expect(client(stub, wrong).getAccountSummary()).rejects.toThrow(/HTTP 401/);
  });

  it('surfaces 429 as a dedicated rate-limit error', async () => {
    const stub = createT212Stub({ alwaysRateLimit: true });
    await expect(client(stub).getHistoricalOrders()).rejects.toBeInstanceOf(T212RateLimitError);
  });

  it('follows nextPagePath until the history is exhausted', async () => {
    const orders = Array.from({ length: 7 }, (_, index) => {
      const order = buyApple();
      order.order.id = 1000 + index;
      order.fill.id = 2000 + index;
      return order;
    });
    const stub = createT212Stub({ orders });

    const result = await client(stub).getAllHistoricalOrders({ limit: 3, maxPages: 10 });

    expect(result.items).toHaveLength(7);
    expect(result.pagesFetched).toBe(3);
    expect(result.truncated).toBe(false);
    // First call has no cursor; later calls reuse the server-supplied path.
    expect(stub.calls[0]).toBe('/api/v0/equity/history/orders?limit=3');
    expect(stub.calls[1]).toBe('/api/v0/equity/history/orders?limit=3&cursor=3');
    expect(stub.calls[2]).toBe('/api/v0/equity/history/orders?limit=3&cursor=6');
  });

  it('stops at maxPages and reports the history as truncated', async () => {
    const orders = Array.from({ length: 10 }, () => buyApple());
    const stub = createT212Stub({ orders });

    const result = await client(stub).getAllHistoricalOrders({ limit: 2, maxPages: 2 });

    expect(result.items).toHaveLength(4);
    expect(result.pagesFetched).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it('caps the page size at the API maximum of 50', async () => {
    const stub = createT212Stub({ orders: sampleHistory() });
    await client(stub).getHistoricalOrders({ limit: 500 });
    expect(stub.calls[0]).toContain('limit=50');
  });

  it('paces requests using the injected clock', async () => {
    const stub = createT212Stub({ orders: Array.from({ length: 4 }, () => buyApple()) });
    const slept: number[] = [];
    let clock = 0;

    const instance = new Trading212Client({
      transport: signedTransport(stub),
      minRequestIntervalMs: 10_000,
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    });

    await instance.getAllHistoricalOrders({ limit: 2, maxPages: 2 });

    // One gap between two requests, at the full interval since no real time passed.
    expect(slept).toEqual([10_000]);
  });

  it('reports non-JSON bodies instead of throwing a parse error', async () => {
    const transport: HttpTransport = {
      request: async () => ({ status: 200, headers: {}, body: '<html>maintenance</html>' }),
    };
    await expect(
      new Trading212Client({ transport, minRequestIntervalMs: 0 }).getAccountSummary(),
    ).rejects.toThrow(/expected JSON/);
  });
});
