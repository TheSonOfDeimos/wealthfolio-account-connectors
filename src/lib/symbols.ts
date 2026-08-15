import type { AddonContext } from '@wealthfolio/addon-sdk';
import { toMajorUnits } from './extract';
import { SYMBOL_TABLE } from './symbol-table';
import type { T212Asset, T212Dataset } from './extract';

/**
 * What a Trading 212 ticker actually is.
 *
 * Nothing here parses the ticker. Trading 212's ticker is an opaque id, and it
 * only looks like it encodes the answer: `ABML_US_EQ` is ABAT, not ABML,
 * because the company renamed and Trading 212 kept the original code. A rule
 * that stripped the suffixes agreed with Trading 212 for 87.8% of instruments
 * and silently mapped the rest to other companies — including, in a live
 * account, pricing Ensign Energy Services as Element Solutions.
 *
 * So every value comes from a field Trading 212 states:
 *
 *  1. **An override you set**, in Wealthfolio's per-account `symbolMappings`.
 *  2. **The live catalogue**, when something has already fetched it — the smoke
 *     test does, the addon cannot.
 *  3. **`SYMBOL_TABLE`**, that same catalogue captured by
 *     `pnpm symbols:generate`. The catalogue is 4.2 MB in one response, over
 *     the addon network broker's limit, and the endpoint ignores every filter
 *     parameter, so the answer is bundled rather than fetched.
 *
 * A ticker in none of them is **unknown**, and is reported as such. The raw
 * ticker is passed through so Wealthfolio fails to resolve it visibly, which is
 * the point: a loud failure beats a plausible wrong answer.
 */


/**
 * Resolve one ticker, preferring an override, then the catalogue, then the rule.
 */
export type SymbolSource =
  /** You set it. */
  | 'override'
  /** Trading 212's live catalogue, when something has fetched it. */
  | 'catalogue'
  /** The captured catalogue bundled with the addon. */
  | 'table'
  /**
   * Found by searching Wealthfolio's market data for the instrument *name*
   * Trading 212 gave — the fallback for a listing newer than the table.
   */
  | 'searched'
  /** Nothing knows it. Reported, never guessed. */
  | 'unknown';

export function resolveSymbol(
  ticker: string,
  asset: T212Asset | undefined,
  overrides: Record<string, string>,
  /** Symbols found by search this run, kept apart so they are not mistaken
   *  for corrections you made. */
  searched: Record<string, string> = {},
): { symbol: string; source: SymbolSource } {
  const override = overrides[ticker]?.trim();
  if (override) return { symbol: override, source: 'override' };

  const found = searched[ticker]?.trim();
  if (found) return { symbol: found, source: 'searched' };

  const catalogued = asset?.shortName?.trim();
  if (catalogued) return { symbol: catalogued, source: 'catalogue' };

  const entry = SYMBOL_TABLE[ticker];
  if (entry) return { symbol: entry.split('|')[0]!, source: 'table' };

  // Not a guess — the raw ticker, so the failure is Wealthfolio's to report
  // rather than ours to hide.
  return { symbol: ticker, source: 'unknown' };
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
  source: SymbolSource;
  status: SymbolStatus;
  quantity?: number;
  /** The venue we told Wealthfolio to look on, and the one it settled on. */
  exchangeMic?: string;
  resolvedExchange?: string;
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
  searched: Record<string, string> = {},
): Promise<SymbolReview[]> {
  const holdings = await ctx.api.portfolio.getHoldings(accountId);
  const held = new Map<
    string,
    { price: number; name?: string; currency?: string; exchange?: string }
  >();
  for (const holding of holdings) {
    const symbol = holding.instrument?.symbol;
    if (!symbol) continue;
    held.set(symbol, {
      price: holding.price ?? 0,
      name: holding.instrument?.name ?? undefined,
      currency: holding.instrument?.currency,
      // The response carries `exchangeMic` on the instrument; the SDK's
      // `Instrument` type does not declare it. Read it defensively rather than
      // trust either side outright.
      exchange: (holding.instrument as { exchangeMic?: string } | null | undefined)?.exchangeMic,
    });
  }

  const reviews: SymbolReview[] = [];
  for (const position of dataset.positions) {
    const ticker = position.instrument.ticker;
    const asset = assets.get(ticker);
    const { symbol, source } = resolveSymbol(ticker, asset, overrides, searched);
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
      exchangeMic: exchangeMicFor(ticker),
      resolvedExchange: holding?.exchange,
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
 * The venue Trading 212 lists an instrument on, as a market identifier code.
 *
 * Read from `SYMBOL_TABLE`, where it was captured from the exchange Trading 212
 * links each instrument to through `workingScheduleId`. Undefined means either
 * an unknown ticker or a venue with no MIC — over-the-counter chiefly — and in
 * both cases nothing is sent, because a wrong venue sends the lookup somewhere
 * the instrument is not.
 */
export function exchangeMicFor(ticker: string): string | undefined {
  const entry = SYMBOL_TABLE[ticker];
  if (!entry) return undefined;
  const [, mic] = entry.split('|');
  return mic || undefined;
}

/**
 * Resolve tickers the bundled table has never heard of.
 *
 * The table is captured at build time, so anything Trading 212 lists afterwards
 * is unknown to it — and an addon that needs a release to recognise a new
 * holding would be a poor thing. Trading 212 does state the instrument's
 * `name` on every order and position, though, and Wealthfolio's own market-data
 * search resolves that reliably: on the seven renamed holdings that defeated
 * every other approach, searching the name returned the right symbol seven
 * times out of seven.
 *
 * The result is still someone else's opinion rather than Trading 212's, so it
 * is marked `searched` and shown for confirmation instead of being trusted
 * silently. Nothing is parsed out of the ticker at any point.
 */
export async function resolveUnknownSymbols(
  ctx: AddonContext,
  tickers: { ticker: string; name?: string }[],
  log: (level: 'info' | 'warn', message: string) => void,
): Promise<Record<string, string>> {
  const found: Record<string, string> = {};

  for (const { ticker, name } of tickers) {
    if (!name?.trim()) {
      log('warn', `${ticker}: unknown to the bundled table and Trading 212 gave no name to search.`);
      continue;
    }

    try {
      const results = await ctx.api.market.searchTicker(name.trim());
      const best = results[0];
      if (!best) {
        log('warn', `${ticker}: "${name}" matched nothing in Wealthfolio's market data.`);
        continue;
      }
      const symbol = best.canonicalSymbol ?? best.symbol;
      found[ticker] = symbol;
      log(
        'info',
        `${ticker}: not in the bundled table, resolved "${name}" to ${symbol} ` +
          `(${best.longName || best.shortName}) by search. Confirm it under Symbols.`,
      );
    } catch (error) {
      log('warn', `${ticker}: search for "${name}" failed (${describe(error)}).`);
    }
  }

  return found;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
