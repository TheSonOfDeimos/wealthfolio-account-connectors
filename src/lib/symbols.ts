import type { TradableInstrument } from 't212-sdk';

/**
 * Trading 212 ticker → Wealthfolio symbol.
 *
 * Trading 212's `ticker` is an opaque id (`AAPL_US_EQ`, `VODl_EQ`) whose format
 * is undocumented — the API spec describes it only as "Unique identifier". So
 * the symbol comes from the instrument catalogue
 * (`GET /equity/metadata/instruments`), which states it outright.
 *
 * The ticker-parsing heuristic survives only as a fallback for instruments the
 * catalogue does not list — delisted names still present in your order history
 * — and anything resolved that way is flagged for review.
 */

/**
 * Manual corrections, applied before anything else. Use these when the
 * catalogue's `shortName` is not what Wealthfolio's market-data provider
 * expects — typically to add an exchange suffix (`VOD` → `VOD.L`).
 *
 * Keys are full Trading 212 tickers.
 */
export const SYMBOL_OVERRIDES: Record<string, string> = {
  // 'VODl_EQ': 'VOD.L',
  // 'AIRp_EQ': 'AIR.PA',
};

export interface ResolvedSymbol {
  symbol: string;
  source: 'override' | 'catalogue' | 'guess';
  /** True when the symbol was inferred rather than looked up. */
  needsReview: boolean;
}

export function resolveSymbol(
  t212Ticker: string,
  instrument: TradableInstrument | undefined,
): ResolvedSymbol {
  const override = SYMBOL_OVERRIDES[t212Ticker];
  if (override) return { symbol: override, source: 'override', needsReview: false };

  const shortName = instrument?.shortName?.trim();
  if (shortName) return { symbol: shortName, source: 'catalogue', needsReview: false };

  return { symbol: guessFromTicker(t212Ticker), source: 'guess', needsReview: true };
}

/** Trailing segment of a Trading 212 ticker describing the instrument class. */
const INSTRUMENT_CLASSES = ['EQ', 'ETF', 'ADR', 'REIT', 'FUND'];

/**
 * Last resort when the catalogue has no entry. Strips the class suffix, then
 * the country segment or the lowercase venue letter Trading 212 appends
 * (`VODl` → `VOD`). Every result is treated as unverified.
 */
function guessFromTicker(t212Ticker: string): string {
  const segments = t212Ticker.split('_');
  const last = segments[segments.length - 1];
  const body = last && INSTRUMENT_CLASSES.includes(last) ? segments.slice(0, -1) : segments;

  const base = body[0] ?? t212Ticker;
  const venue = /^([A-Z0-9.]{1,6})([a-z])$/.exec(base);
  return venue ? venue[1]! : base;
}
