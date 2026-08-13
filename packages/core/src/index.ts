/**
 * Trading 212 → Wealthfolio mapping.
 *
 * The Trading 212 API itself is handled by `t212-sdk`; import types and the
 * `T212` client straight from there. What lives here is the part no Trading
 * 212 library covers: turning fills into Wealthfolio activities.
 */

export { mapOrdersToActivities } from './mapper';
export type { MapOptions, MapResult, SkippedFill } from './mapper';

export { SYMBOL_OVERRIDES, mapTicker } from './symbols';
export type { MappedSymbol } from './symbols';
