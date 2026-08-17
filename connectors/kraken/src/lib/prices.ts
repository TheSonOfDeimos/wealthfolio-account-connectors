/**
 * Kraken's own published daily closes, for the rows Kraken prices in nothing.
 *
 * Two kinds of ledger row arrive with quantities but no money: a staking
 * reward, and a coin-for-coin exchange. Kraken states no fiat value for
 * either — not in `Ledgers`, not in `TradesHistory` (a Convert is not a
 * trade), not in `QueryTrades`. Verified on a live account: the two swaps on
 * record have exactly two ledger rows each, a `spend` and a `receive`, and
 * nothing else.
 *
 * Wealthfolio will not accept those rows unpriced. `DIVIDEND` with
 * `DIVIDEND_IN_KIND` is rejected outright — *"Asset-backed income activities
 * require an amount or FMV per unit"* — and a `BUY` at zero is accepted but
 * lands the position on `basisStatus: unknown`, which is what put 263
 * transactions on the data-health page and left Unrealized P&L at N/A.
 *
 * So a price is needed, and this is the one to use: `OHLC` is the same
 * endpoint the connector's own quote provider reads, so a reward is valued at
 * the number Wealthfolio will itself use to value the holding it created. It
 * is Kraken's published close for that asset on that day — a stated figure for
 * a known asset and date, not a guess about what a row might have been worth.
 *
 * It is still not what Kraken charged, so every row priced this way says so in
 * its comment. When no close is available the caller falls back to recording
 * the row at zero and flagging it, because a missing price is recoverable and
 * an invented one is not.
 */
import { CRYPTO_QUOTE_CURRENCY } from '../config';
import type { KrakenClient } from './client';

/** `YYYY-MM-DD` in UTC, which is the day an OHLC candle is stamped with. */
export type IsoDay = string;

/** Look up the close for one asset on one day, or `undefined` if unknown. */
export type PriceLookup = (symbol: string, day: IsoDay) => number | undefined;

/** Kraken stamps a daily candle at the start of its UTC day. */
export function dayOf(unixSeconds: number): IsoDay {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

/**
 * `[time, open, high, low, close, vwap, volume, count]`, close at index 4 —
 * the same positions the quote provider's field mapping uses.
 */
const CLOSE = 4;
const TIME = 0;

interface OhlcResponse {
  [pair: string]: unknown;
  /** Kraken appends a cursor beside the pair key; it is not a candle array. */
  last?: number;
}

/**
 * Daily closes for each symbol, keyed by UTC day.
 *
 * One public call per symbol. `OHLC` returns at most 720 daily candles —
 * about two years, which is more than any Kraken account opened recently can
 * use, and comfortably older than the oldest row this connector imports.
 *
 * A symbol Kraken does not quote against USD simply yields no entry; the
 * caller treats that the same as any other missing price. Failures are
 * swallowed per symbol so one delisted coin cannot fail a whole import.
 */
export async function fetchDailyCloses(
  client: KrakenClient,
  symbols: readonly string[],
  onProgress?: (symbol: string, days: number) => void,
): Promise<Map<string, Map<IsoDay, number>>> {
  const closes = new Map<string, Map<IsoDay, number>>();

  for (const symbol of [...new Set(symbols)].sort()) {
    try {
      const response = await client.publicCall<OhlcResponse>('OHLC', {
        pair: `${symbol}${CRYPTO_QUOTE_CURRENCY}`,
        interval: '1440',
      });

      // Kraken re-keys some pairs — `BTCUSD` comes back under `XXBTZUSD` — so
      // the candle array is found by shape rather than by name, exactly as the
      // quote provider's `$.result.*` wildcard does.
      const candles = Object.entries(response).find(
        ([key, value]) => key !== 'last' && Array.isArray(value),
      )?.[1] as unknown[][] | undefined;
      if (!candles) continue;

      const byDay = new Map<IsoDay, number>();
      for (const candle of candles) {
        const close = Number(candle[CLOSE]);
        if (Number.isFinite(close) && close > 0) byDay.set(dayOf(Number(candle[TIME])), close);
      }
      if (byDay.size > 0) {
        closes.set(symbol, byDay);
        onProgress?.(symbol, byDay.size);
      }
    } catch {
      // A symbol Kraken will not quote is not an error: the rows that needed
      // it are recorded unpriced and flagged, which is the same path a brand
      // new listing takes.
    }
  }

  return closes;
}

/** Turn a fetched table into the lookup the mapper takes. */
export function lookupFrom(closes: Map<string, Map<IsoDay, number>>): PriceLookup {
  return (symbol, day) => closes.get(symbol)?.get(day);
}
