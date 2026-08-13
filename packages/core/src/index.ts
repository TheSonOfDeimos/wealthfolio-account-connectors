export {
  Trading212Client,
  basicAuthHeader,
  toBasicSecret,
  T212_DEMO_BASE_URL,
  T212_LIVE_BASE_URL,
} from './client';
export type {
  FetchAllOrdersOptions,
  FetchOrdersPage,
  Trading212ClientOptions,
} from './client';

export { T212ApiError, T212RateLimitError, header } from './http';
export type { HttpRequest, HttpResponse, HttpTransport } from './http';

export { mapOrdersToActivities } from './mapper';
export type { MapOptions, MapResult, SkippedFill } from './mapper';

export { SYMBOL_OVERRIDES, mapTicker } from './symbols';
export type { MappedSymbol } from './symbols';

export type * from './types';
