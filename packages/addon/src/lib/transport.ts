import type { HttpRequest, HttpResponse, HttpTransport } from '@t212/core';
import type { AddonContext } from '@wealthfolio/addon-sdk';
import { CREDENTIALS_SECRET_KEY } from '../config';

/**
 * Routes Trading 212 calls through Wealthfolio's network broker.
 *
 * The addon runs in a sandboxed, opaque-origin iframe where `fetch` to an
 * external host is blocked outright. `ctx.api.network.request` is the way out,
 * and it only reaches hosts declared in `manifest.json`.
 *
 * `auth` is the important part: the broker reads the named secret from the OS
 * keyring and builds the `Authorization: Basic …` header host-side. The API
 * key and secret therefore never enter the addon's JavaScript at request time.
 */
export function createNetworkTransport(ctx: AddonContext): HttpTransport {
  return {
    async request(request: HttpRequest): Promise<HttpResponse> {
      const response = await ctx.api.network.request({
        url: request.url,
        method: request.method ?? 'GET',
        headers: request.headers,
        body: request.body,
        auth: { type: 'basic', secretKey: CREDENTIALS_SECRET_KEY },
      });
      return {
        status: response.status,
        headers: response.headers ?? {},
        body: response.body ?? '',
      };
    },
  };
}
