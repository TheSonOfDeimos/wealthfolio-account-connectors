/**
 * Trading 212 ticker → Wealthfolio symbol.
 *
 * Trading 212 uses its own instrument ids rather than plain exchange tickers:
 *
 *   AAPL_US_EQ   Apple, US listing
 *   VODl_EQ      Vodafone, London (lowercase suffix letter = venue)
 *   AIRp_EQ      Airbus, Paris
 *
 * There is no published rule for the venue letters, so this is a best-effort
 * normalisation plus an override table. It is deliberately conservative: when
 * the result looks doubtful it says so rather than hiding the guess, and the
 * ISIN always travels along in the activity comment so a wrong symbol stays
 * traceable.
 */

/**
 * Hand-maintained overrides, applied before any heuristic. Add entries here
 * whenever the preview shows a symbol Wealthfolio cannot resolve.
 *
 * Keys are full Trading 212 tickers; values are the symbol Wealthfolio should
 * store (Yahoo-style suffixes such as `.L` or `.PA` are what the default
 * market-data provider expects).
 */
export const SYMBOL_OVERRIDES: Record<string, string> = {
  // 'VODl_EQ': 'VOD.L',
  // 'AIRp_EQ': 'AIR.PA',
};

/** Trailing segment of a Trading 212 ticker describing the instrument class. */
const INSTRUMENT_CLASSES = ['EQ', 'ETF', 'ADR', 'REIT', 'FUND'];

/** `needsReview` marks a heuristic guess worth eyeballing in the preview. */
export function mapTicker(t212Ticker: string): { symbol: string; needsReview: boolean } {
  const override = SYMBOL_OVERRIDES[t212Ticker];
  if (override) return { symbol: override, needsReview: false };

  const segments = t212Ticker.split('_');
  const last = segments[segments.length - 1];
  const body = last && INSTRUMENT_CLASSES.includes(last) ? segments.slice(0, -1) : segments;

  // AAPL_US_EQ → ["AAPL", "US"]: an explicit US listing maps straight through.
  if (body.length === 2 && body[1] === 'US') {
    return { symbol: body[0]!, needsReview: false };
  }

  const base = body[0] ?? t212Ticker;

  // VODl → VOD. A single trailing lowercase letter on an otherwise uppercase
  // ticker is Trading 212's venue marker, and Wealthfolio wants the bare
  // symbol (often with an exchange suffix added via SYMBOL_OVERRIDES).
  const venue = /^([A-Z0-9.]{1,6})([a-z])$/.exec(base);
  if (venue) return { symbol: venue[1]!, needsReview: true };

  return { symbol: base, needsReview: body.length > 1 };
}
