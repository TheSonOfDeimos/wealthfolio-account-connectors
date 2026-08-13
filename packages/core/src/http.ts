/**
 * The transport seam.
 *
 * Inside Wealthfolio the sandboxed iframe cannot call `fetch` directly — every
 * request goes through the host broker (`ctx.api.network.request`). The shape
 * below is deliberately identical to the SDK's `NetworkRequest`/`NetworkResponse`
 * so the addon adapter is a one-liner, while tests can supply a stub.
 */

export interface HttpRequest {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
  headers?: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface HttpTransport {
  request(request: HttpRequest): Promise<HttpResponse>;
}

/** Any non-2xx response from Trading 212. */
export class T212ApiError extends Error {
  readonly status: number;
  readonly path: string;
  readonly body: string;

  constructor(status: number, path: string, body: string) {
    super(`Trading 212 ${path} failed with HTTP ${status}: ${describe(status, body)}`);
    this.name = 'T212ApiError';
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

/** HTTP 429 — carries the reset hint so callers can back off sensibly. */
export class T212RateLimitError extends T212ApiError {
  /** Seconds until the limit window resets, when the API told us. */
  readonly retryAfterSeconds?: number;

  constructor(path: string, body: string, retryAfterSeconds?: number) {
    super(429, path, body);
    this.name = 'T212RateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function describe(status: number, body: string): string {
  const hint =
    status === 401
      ? 'check the API key and secret'
      : status === 403
        ? 'the key lacks scope for this endpoint, or an IP restriction blocked it'
        : status === 429
          ? 'rate limited'
          : '';
  const trimmed = body.trim().slice(0, 300);
  return [hint, trimmed].filter(Boolean).join(' — ') || 'no response body';
}

/** Header lookup that tolerates whatever casing the broker hands back. */
export function header(headers: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}
