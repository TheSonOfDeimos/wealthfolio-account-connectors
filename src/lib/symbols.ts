import type { AddonContext } from '@wealthfolio/addon-sdk';
import { toMajorUnits } from './extract';
import type { T212Asset, T212Dataset } from './extract';

/**
 * Turning a Trading 212 ticker into a symbol Wealthfolio can resolve.
 *
 * Three sources, in order of trust:
 *
 *  1. **An override you set**, stored in Wealthfolio's own per-account
 *     `symbolMappings`. Always wins.
 *  2. **The instrument catalogue's `shortName`** — correct by definition, but
 *     out of reach inside the addon: the catalogue is a 4 MB response and the
 *     host refuses anything that large through its network broker. Present only
 *     when something else supplied it, such as the smoke test.
 *  3. **A rule derived from the ticker itself.** Trading 212's ticker is an
 *     opaque, permanent id assigned at listing, and stripping its suffixes
 *     recovers the symbol for 15,282 of 17,400 instruments — 87.8%.
 *
 * The rule fails in one specific way, and it is worth knowing: when a company
 * renames, Trading 212 keeps the old ticker string and updates only
 * `shortName`. `TNP_US_EQ` is Tsakos, now trading as `TEN`; `ABML_US_EQ` is
 * American Battery Technology, now `ABAT`. Nothing in the ticker reveals this,
 * and Trading 212 reports no corporate action for it, so the rule cannot know.
 * That is what overrides are for.
 */

/** Suffixes Trading 212 appends for the listing country. */
const COUNTRY_SUFFIX =
  /_(US|CA|GB|DE|FR|NL|BE|PT|IT|ES|CH|AT|IE|SE|NO|DK|FI|PL)$/;

export function deriveSymbol(ticker: string): string {
  let symbol = ticker.replace(/_EQ$/, '');
  if (COUNTRY_SUFFIX.test(symbol)) {
    symbol = symbol.replace(COUNTRY_SUFFIX, '');
  } else {
    // European listings carry a single lowercase exchange letter instead —
    // `TGAl_EQ` on London, `MTa_EQ` on Amsterdam.
    symbol = symbol.replace(/[a-z]$/, '');
  }
  return symbol;
}

/**
 * Resolve one ticker, preferring an override, then the catalogue, then the rule.
 */
export function resolveSymbol(
  ticker: string,
  asset: T212Asset | undefined,
  overrides: Record<string, string>,
): { symbol: string; source: 'override' | 'catalogue' | 'derived' } {
  const override = overrides[ticker]?.trim();
  if (override) return { symbol: override, source: 'override' };

  const catalogued = asset?.shortName?.trim();
  if (catalogued) return { symbol: catalogued, source: 'catalogue' };

  return { symbol: deriveSymbol(ticker), source: 'derived' };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Storage — Wealthfolio's own, not ours
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Overrides live in `ImportMappingData.symbolMappings`, the per-account symbol
 * translation table Wealthfolio already keeps for its CSV importer.
 *
 * Using the host's store rather than the addon's own means the mappings survive
 * a reinstall, belong to the account they describe, and sit where a user would
 * expect to find them instead of in a second, addon-shaped place.
 */
export async function loadOverrides(
  ctx: AddonContext,
  accountId: string,
): Promise<Record<string, string>> {
  try {
    const mapping = await ctx.api.activities.getImportMapping(accountId);
    return { ...mapping.symbolMappings };
  } catch {
    // A brand new account has no mapping yet, which is not an error.
    return {};
  }
}

export async function saveOverrides(
  ctx: AddonContext,
  accountId: string,
  overrides: Record<string, string>,
): Promise<void> {
  // Read first so the other mapping kinds — field, activity, account — are
  // carried through untouched rather than blanked by our write.
  let existing = {
    accountId,
    fieldMappings: {},
    activityMappings: {},
    symbolMappings: {},
    accountMappings: {},
  } as Awaited<ReturnType<AddonContext['api']['activities']['getImportMapping']>>;

  try {
    existing = await ctx.api.activities.getImportMapping(accountId);
  } catch {
    // Keep the blank template.
  }

  await ctx.api.activities.saveImportMapping({
    ...existing,
    accountId,
    symbolMappings: trimmed(overrides),
  });
}

/** Drop blank entries so clearing a field in the UI removes the override. */
function trimmed(overrides: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [ticker, symbol] of Object.entries(overrides)) {
    const value = symbol.trim();
    if (value) result[ticker] = value;
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Review
// ─────────────────────────────────────────────────────────────────────────────

export type SymbolStatus =
  /** Resolved, priced, and the price agrees with Trading 212's. */
  | 'ok'
  /**
   * Resolved and priced, but to a *different security*.
   *
   * The dangerous case, and the reason this check exists. A symbol that no
   * longer belongs to the company Trading 212 means will still resolve, still
   * price, and still collect sectors and a logo — it just describes something
   * else. Only the price gives it away: a live account had `ESI` priced as
   * Element Solutions at 53.89 where Ensign Energy Services trades at 3.63, and
   * `NUAG` priced as a Nuveen bond fund rather than New Pacific Metals.
   */
  | 'mismatch'
  /** Resolved, but no provider has a price — it may be the wrong symbol. */
  | 'unpriced'
  /** No holding at all under that symbol; the import did not land. */
  | 'missing';

/**
 * How far a price may sit from Trading 212's before it is treated as a
 * different security.
 *
 * Generous on purpose. Two providers quoting the same instrument differ by
 * timing, venue and the bid-ask spread — fractions of a percent, occasionally
 * a few. Every genuine mismatch found so far was out by 2.8x or more, so the
 * gap between "noise" and "wrong company" is wide enough that 15% separates
 * them without argument.
 */
const PRICE_TOLERANCE = 0.15;

export interface SymbolReview {
  ticker: string;
  /** Trading 212's name for the instrument — the thing to sanity-check against. */
  name?: string;
  /** What Wealthfolio thinks it is. A disagreement here is the tell. */
  resolvedName?: string;
  symbol: string;
  source: 'override' | 'catalogue' | 'derived';
  status: SymbolStatus;
  quantity?: number;
  /** Trading 212's price, in the major units Wealthfolio stores. */
  brokerPrice?: number;
  wealthfolioPrice?: number;
  currency?: string;
}

/**
 * What the symbol rule produced, and whether Wealthfolio agreed.
 *
 * Only instruments currently held are reviewed — a position closed years ago
 * needs no symbol you would act on. Note the limit of this check: it catches a
 * symbol that fails, not one that succeeds *as the wrong company*. A rename
 * that happens to collide with another listing looks healthy here, which is why
 * Trading 212's own name is carried alongside for you to read.
 */
export async function reviewSymbols(
  ctx: AddonContext,
  accountId: string,
  dataset: T212Dataset,
  assets: Map<string, T212Asset>,
  overrides: Record<string, string>,
): Promise<SymbolReview[]> {
  const holdings = await ctx.api.portfolio.getHoldings(accountId);
  const held = new Map<string, { price: number; name?: string; currency?: string }>();
  for (const holding of holdings) {
    const symbol = holding.instrument?.symbol;
    if (!symbol) continue;
    held.set(symbol, {
      price: holding.price ?? 0,
      name: holding.instrument?.name ?? undefined,
      currency: holding.instrument?.currency,
    });
  }

  const reviews: SymbolReview[] = [];
  for (const position of dataset.positions) {
    const ticker = position.instrument.ticker;
    const asset = assets.get(ticker);
    const { symbol, source } = resolveSymbol(ticker, asset, overrides);
    const holding = held.get(symbol);

    // Trading 212 quotes some listings in pence; Wealthfolio stores them in
    // pounds. Comparing without that correction would flag every London
    // holding as a mismatch by a factor of exactly 100.
    const broker = asset?.price
      ? toMajorUnits(asset.price.value, asset.price.currency)
      : undefined;

    let status: SymbolStatus;
    if (!holding) status = 'missing';
    else if (!(holding.price > 0)) status = 'unpriced';
    else if (
      broker &&
      broker.majorValue > 0 &&
      // Only a same-currency comparison proves anything; otherwise the gap is
      // FX and says nothing about identity.
      broker.majorCurrency === holding.currency &&
      Math.abs(holding.price / broker.majorValue - 1) > PRICE_TOLERANCE
    ) {
      status = 'mismatch';
    } else status = 'ok';

    reviews.push({
      ticker,
      name: asset?.name ?? position.instrument.name,
      resolvedName: holding?.name,
      symbol,
      source,
      status,
      quantity: position.quantity,
      brokerPrice: broker?.majorValue,
      wealthfolioPrice: holding?.price,
      currency: broker?.majorCurrency,
    });
  }

  // Anything needing attention first; the rest alphabetically.
  const rank: Record<SymbolStatus, number> = { mismatch: 0, missing: 1, unpriced: 2, ok: 3 };
  return reviews.sort(
    (a, b) => rank[a.status] - rank[b.status] || a.symbol.localeCompare(b.symbol),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Exchange
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The venue a Trading 212 ticker trades on, from its suffix.
 *
 * Needed for the same reason `deriveSymbol` is: the instrument-to-exchange link
 * lives in `TradableInstrument.workingScheduleId`, and the catalogue that
 * carries it is too large for the addon to fetch. Without a venue the host
 * guesses, and guesses badly — every London ETF was looked up on Deutsche Börse
 * and came back unpriced.
 *
 * Measured against the whole catalogue: 9,788 correct against 622 wrong, 94%.
 * On the holdings of the account this was built for, 25 of 25 with none wrong.
 *
 * US listings are deliberately left without one. `_US_EQ` covers NYSE, NASDAQ
 * and OTC Markets with no way to tell them apart — the suffix picks the right
 * one only 46% of the time — and US symbols resolve perfectly well with no
 * venue at all. A guess there would replace something that works with something
 * that works half the time.
 */
const EXCHANGE_BY_SUFFIX: Record<string, string> = {
  l: 'XLON',
  d: 'XETR',
  p: 'XPAR',
  s: 'XSWX',
  m: 'XMIL',
  a: 'XAMS',
  e: 'XMAD',
  CA: 'XTSE',
  BE: 'XBRU',
  AT: 'XWBO',
  PT: 'XLIS',
  IE: 'XLON',
  DE: 'XETR',
  FR: 'XPAR',
  NL: 'XAMS',
  ES: 'XMAD',
  IT: 'XMIL',
  CH: 'XSWX',
};

export function deriveExchangeMic(ticker: string): string | undefined {
  const body = ticker.replace(/_EQ$/, '');

  const country = body.match(/_([A-Z]{2})$/);
  if (country) return EXCHANGE_BY_SUFFIX[country[1]!];

  // A trailing lowercase letter, optionally followed by a disambiguating
  // digit: `TGAl_EQ`, `V6Cd1_EQ`.
  const letter = body.match(/([a-z]+)[0-9]*$/);
  return letter ? EXCHANGE_BY_SUFFIX[letter[1]!] : undefined;
}
