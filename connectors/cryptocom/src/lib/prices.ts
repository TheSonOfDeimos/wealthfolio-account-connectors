/**
 * Crypto.com's own published daily closes, for the rows it prices in nothing.
 *
 * One ledger field settles why this module has to exist: **`transaction_cost`
 * is always identical to `transaction_qty`**. Verified across 622 rows on a
 * live account — 0 differed. It is not a cost in money; it is the quantity
 * again, in the row's own asset. So a staking reward of 0.98649888 CRO states
 * 0.98649888 and nothing about what that was worth.
 *
 * Wealthfolio will not give a position a cost basis without a price, and the
 * Kraken connector already established what the alternatives cost:
 * `DIVIDEND` with `DIVIDEND_IN_KIND` is rejected outright without an amount,
 * and a `BUY` at zero is accepted but leaves the holding on
 * `basisStatus: unknown`, which is what put 263 transactions on the host's
 * data-health page.
 *
 * So a price is needed, and this is the right one: `get-candlestick` is the
 * same endpoint the connector's own quote provider reads, so a reward is valued
 * at the number Wealthfolio will itself use to value the holding it created.
 * It is Crypto.com's published close for that asset on that day — a stated
 * figure for a known asset and date, not a guess about what a row was worth.
 *
 * It is still not what Crypto.com credited, so every row priced this way says
 * so in its comment. Where no close exists the caller records the row at zero
 * and flags it: a missing price is recoverable, an invented one is not.
 */
import type { AddonContext } from '@wealthfolio/addon-sdk';
import { CRYPTO_QUOTE_CURRENCY, CANDLE_PAGE_SIZE } from '../config';
import type { CryptoComClient } from './client';

/** `YYYY-MM-DD` in UTC, which is the day a daily candle is stamped with. */
export type IsoDay = string;

/** Look up the close for one asset on one day, or `undefined` if unknown. */
export type PriceLookup = (symbol: string, day: IsoDay) => number | undefined;

/** Crypto.com stamps a daily candle at the start of its UTC day, in ms. */
export function dayOf(unixMs: number): IsoDay {
  return new Date(unixMs).toISOString().slice(0, 10);
}

const DAY_MS = 24 * 60 * 60 * 1000;

interface Candle {
  t: number;
  o?: string;
  h?: string;
  l?: string;
  c: string;
  v?: string;
}

interface CandlestickResult {
  interval?: string;
  instrument_name?: string;
  data?: Candle[];
}

/**
 * Daily closes for each symbol, covering the range the caller actually needs.
 *
 * ⚠ **300 candles per request, and no more.** Verified live: `count=5000`
 * returns 300, as does every larger number. Daily candles therefore reach back
 * about ten months in one call — and this connector routinely imports eighteen,
 * because Crypto.com's ledger goes back further than its own documentation
 * claims. A single call would have left the older half of every reward
 * unpriced, and nothing in the response would have said so.
 *
 * So the window is paged: `start_ts`/`end_ts` position the 300-candle page
 * anywhere in the past, and this walks backwards until the requested range is
 * covered. That is the one thing the *quote provider* cannot do — its form
 * takes a single URL — which is why the provider carries ten months of history
 * while the import prices every row it writes.
 *
 * A symbol Crypto.com does not quote against USD simply yields no entry; the
 * caller treats that like any other missing price. Failures are swallowed per
 * symbol so one delisted coin cannot fail a whole import.
 */
export async function fetchDailyCloses(
  client: CryptoComClient,
  symbols: readonly string[],
  since: number,
  onProgress?: (symbol: string, days: number) => void,
): Promise<Map<string, Map<IsoDay, number>>> {
  const closes = new Map<string, Map<IsoDay, number>>();
  const pageMs = CANDLE_PAGE_SIZE * DAY_MS;

  for (const symbol of [...new Set(symbols)].sort()) {
    const byDay = new Map<IsoDay, number>();

    try {
      // Walk backwards a page at a time. One extra day of overlap per page
      // guards the boundary: a candle exactly on the seam would otherwise be
      // claimed by neither window, and a single missing day is precisely the
      // kind of gap that shows up later as one unpriced reward.
      for (let end = Date.now(); end > since; end -= pageMs) {
        const start = Math.max(since, end - pageMs - DAY_MS);
        const result = await client.publicCall<CandlestickResult>('public/get-candlestick', {
          instrument_name: `${symbol}_${CRYPTO_QUOTE_CURRENCY}`,
          timeframe: '1D',
          count: String(CANDLE_PAGE_SIZE),
          start_ts: String(start),
          end_ts: String(end),
        });

        const candles = result.data ?? [];
        // An empty page means this symbol has no history that far back, so
        // there is nothing older to walk towards either.
        if (candles.length === 0) break;

        for (const candle of candles) {
          const close = Number(candle.c);
          if (Number.isFinite(close) && close > 0) byDay.set(dayOf(candle.t), close);
        }
      }
    } catch {
      // A symbol Crypto.com will not quote is not an error: the rows that
      // needed it are recorded unpriced and flagged, the same path a brand new
      // listing takes.
    }

    if (byDay.size > 0) {
      closes.set(symbol, byDay);
      onProgress?.(symbol, byDay.size);
    }
  }

  return closes;
}

/**
 * Turn a fetched table into the lookup the mapper takes.
 *
 * A day with no candle falls back to the most recent earlier one, within a
 * short window. Crypto.com publishes no candle for a day a pair did not trade,
 * and a staking reward still lands on those days — so an exact-match-only
 * lookup left rewards unpriced for a reason that has nothing to do with the
 * reward. The fallback is bounded at a week so a long delisting gap is
 * reported as missing rather than papered over with a stale number, and the
 * mapper's comment names the day the price actually came from.
 */
export function lookupFrom(closes: Map<string, Map<IsoDay, number>>): PriceLookup {
  const MAX_BACKFILL_DAYS = 7;

  return (symbol, day) => {
    const byDay = closes.get(symbol);
    if (!byDay) return undefined;

    const exact = byDay.get(day);
    if (exact !== undefined) return exact;

    let cursor = Date.parse(`${day}T00:00:00Z`);
    for (let back = 0; back < MAX_BACKFILL_DAYS; back += 1) {
      cursor -= DAY_MS;
      const earlier = byDay.get(dayOf(cursor));
      if (earlier !== undefined) return earlier;
    }
    return undefined;
  };
}

/**
 * Fill the days Wealthfolio has no price for.
 *
 * The quote provider's historical URL returns 300 candles and the Add Provider
 * form takes a single URL with no way to page, so at daily resolution it
 * reaches back about ten months — and this connector routinely imports
 * eighteen. Weekly candles covered the span but dated every refresh to the
 * start of the current week, which the host reads as a stale price.
 *
 * So the provider stays daily and merely recent, and the gap behind it is
 * filled here, where `start_ts`/`end_ts` can page as far back as needed.
 *
 * ⚠ Driven by what is already imported, not by the rows a sync just fetched.
 * An incremental sync usually returns nothing new, and an earlier version took
 * its symbol list from that empty batch — so it silently did nothing on every
 * run except a full reload, and left 205 days of the account unpriced. What
 * needs filling is a property of the account's history, not of the last batch.
 *
 * Self-limiting: each symbol's existing quote days are read first and only the
 * missing ones are fetched and written, so a second run costs a handful of
 * reads and no writes at all.
 */
export async function backfillQuotes(
  ctx: AddonContext,
  client: CryptoComClient,
  assetIds: ReadonlyMap<string, string>,
  since: number,
  dataSource: string,
  log: (level: 'info' | 'warn' | 'error' | 'success', message: string) => void,
  onProgress?: (symbol: string) => void,
): Promise<{ written: number; failed: number; filled: string[] }> {
  let written = 0;
  let failed = 0;
  let firstError: string | undefined;
  const filled: string[] = [];

  // Every day from the first activity to today. A day with no candle — a pair
  // that did not trade — stays missing rather than being invented, which is
  // why the gap is measured again after writing rather than assumed closed.
  const wanted: IsoDay[] = [];
  for (let t = since; t <= Date.now(); t += DAY_MS) wanted.push(dayOf(t));

  for (const [symbol, assetId] of assetIds) {
    let have: Set<IsoDay>;
    try {
      const history = (await ctx.api.quotes.getHistory(assetId)) as unknown as {
        timestamp?: string;
      }[];
      have = new Set(history.map((q) => String(q.timestamp ?? '').slice(0, 10)));
    } catch {
      // Cannot tell what is there, so do not guess at what is missing.
      continue;
    }

    const missing = wanted.filter((day) => !have.has(day));
    if (missing.length === 0) continue;

    onProgress?.(symbol);
    const closes = await fetchDailyCloses(client, [symbol], since);
    const byDay = closes.get(symbol);
    if (!byDay) continue;

    let wroteHere = 0;
    for (const day of missing) {
      const close = byDay.get(day);
      if (close === undefined) continue;
      try {
        // Shape copied from what the host writes itself, because guessing at
        // it returned `Unprocessable Entity` for every one of 1908 rows and
        // said nothing else. `id` is `{assetId}_{day}_{source}` and is what
        // makes the write idempotent — the same day fetched twice updates one
        // row rather than adding a second. The timestamp is midday, not
        // midnight, matching the host's own rows so a backfilled day sorts
        // beside a provider-fetched one instead of a few hours before it.
        const id = `${assetId}_${day}_${dataSource}`;
        await ctx.api.quotes.update(assetId, {
          id,
          assetId,
          timestamp: `${day}T12:00:00+00:00`,
          createdAt: new Date().toISOString(),
          dataSource,
          open: close,
          high: close,
          low: close,
          close,
          adjclose: close,
          volume: 0,
          currency: CRYPTO_QUOTE_CURRENCY,
        } as never);
        wroteHere += 1;
      } catch (error) {
        // Keep the first reason. Counting failures without saying why is what
        // let a flat permission denial masquerade as "nothing to do" once
        // already in this connector.
        firstError ??= error instanceof Error ? error.message : String(error);
        failed += 1;
      }
    }
    written += wroteHere;
    if (wroteHere > 0) filled.push(`${symbol} (${wroteHere})`);
  }

  if (written > 0) {
    log(
      'info',
      `Filled ${written} missing daily price(s) the quote provider cannot reach back to: ` +
        `${filled.join(', ')}.`,
    );
  }
  if (failed > 0) {
    log(
      'warn',
      `${failed} daily price(s) could not be written; those days stay unpriced. ${firstError ?? ''}`,
    );
  }

  return { written, failed, filled };
}
