import type { T212, TradableInstrument } from 't212-sdk';

/**
 * Trading 212's instrument catalogue, keyed by its opaque ticker id.
 *
 * `AAPL_US_EQ` is documented only as "Unique identifier" — there is no
 * published grammar for it — so the catalogue is the authoritative way to get
 * a real symbol, ISIN and currency out of one. Parsing the string is guesswork
 * by comparison.
 */
export type InstrumentIndex = Map<string, TradableInstrument>;

/**
 * Fetch the catalogue and index it.
 *
 * One request returns every instrument Trading 212 offers, so this is called
 * once per sync and reused for every row. The endpoint allows 1 request per
 * 50 seconds and refreshes every 10 minutes; `t212-sdk` paces itself.
 *
 * Deliberately never throws: a missing catalogue degrades symbol resolution to
 * a guess, which is worth a warning but not a failed import.
 */
export async function loadInstrumentIndex(
  client: T212,
  onWarning: (message: string) => void = () => {},
): Promise<InstrumentIndex> {
  try {
    const instruments = await client.instruments.list();
    return new Map(instruments.map((instrument) => [instrument.ticker, instrument]));
  } catch (error) {
    onWarning(
      `Could not load the Trading 212 instrument catalogue (${
        error instanceof Error ? error.message : String(error)
      }). Symbols were guessed from tickers instead.`,
    );
    return new Map();
  }
}
