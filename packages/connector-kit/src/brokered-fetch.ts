import type { AddonContext } from '@wealthfolio/addon-sdk';

/**
 * A `fetch`-shaped function that routes t212-sdk's requests through
 * Wealthfolio's network broker.
 *
 * Two host rules shape this adapter, both verified against Wealthfolio's
 * `crates/core/src/addons/network.rs`:
 *
 *  1. The sandbox is an opaque-origin iframe with no network egress. Only
 *     `ctx.api.network.request` reaches outside, and only to hosts declared in
 *     `manifest.json`.
 *  2. The broker **rejects** any addon-supplied `Authorization` header outright
 *     — "Addon network Authorization header must use request.auth.secretKey".
 *     It builds the header itself from a keyring secret named by `auth`.
 *
 * So the SDK's own `Authorization` header is dropped here and replaced by a
 * reference to the secret. The plaintext key and secret never enter the
 * addon's memory at request time; the SDK is constructed with placeholders it
 * never gets to use.
 */
export function createBrokeredFetch(ctx: AddonContext, auth?: string | BrokeredAuth): typeof fetch {
  // A bare string is the basic-auth keyring entry, which is how the first
  // connector called this and remains the common case.
  const descriptor: BrokeredAuth | undefined = typeof auth === 'string' ? { type: 'basic', secretKey: auth } : auth;

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

    const response = await ctx.api.network.request({
      url,
      method: (init?.method ?? 'GET') as 'GET',
      headers: withoutAuthorization(init?.headers),
      body: typeof init?.body === 'string' ? init.body : undefined,
      ...(descriptor ? { auth: descriptor } : {}),
    });

    return new Response(response.body ?? '', {
      status: response.status,
      headers: response.headers ?? {},
    });
  };
}

/**
 * What the host will build an `Authorization` header from.
 *
 * Only `basic` and `bearer` exist — verified in the host's `network.rs`, which
 * rejects anything else with "Addon network auth type is not supported".
 *
 * Omitting it entirely is a legitimate third case, and the one Kraken needs: an
 * exchange that signs each request cannot be served by either scheme, so the
 * connector computes its own `API-Sign` and sends it as an ordinary header.
 * The broker permits that — the header is not on its forbidden list — but the
 * secret then has to pass through addon memory, which is a real reduction in
 * what the keyring buys you and belongs in that connector's README.
 */
export interface BrokeredAuth {
  type: 'basic' | 'bearer';
  /** Names a keyring entry; the plaintext never enters the addon. */
  secretKey: string;
}

/**
 * Normalise whatever `HeadersInit` the SDK passed and strip `Authorization`.
 * Leaving it in would make the host refuse the request.
 */
function withoutAuthorization(headers: HeadersInit | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headers) return result;

  const entries: Iterable<[string, string]> =
    headers instanceof Headers
      ? headers.entries()
      : Array.isArray(headers)
        ? (headers as [string, string][])
        : Object.entries(headers);

  for (const [name, value] of entries) {
    if (name.toLowerCase() === 'authorization') continue;
    result[name] = value;
  }
  return result;
}
