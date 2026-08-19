/**
 * Everything tunable about the Crypto.com Exchange connector, and no secrets.
 *
 * The addon asks for the key pair in its own setup form and keeps it in
 * Wealthfolio's keyring; the Node tools read `.env`, which git ignores. Nothing
 * in this file is a credential, and nothing in this file should ever become one
 * — the first connector in this repo put a live key pair in its `config.ts` and
 * compiled it into every shipped bundle.
 */

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  Which Crypto.com this is
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The **Exchange** (crypto.com/exchange), not the mobile app. They are separate
 * products with separate balances, and the distinction is not pedantry: the app
 * has no API of any kind — no keys, no endpoints, a CSV export and nothing else.
 * Every tax and portfolio tool that claims a "Crypto.com API import" means the
 * Exchange.
 *
 * If a user's holdings are in the app, this connector cannot see them, and the
 * setup form says so rather than failing with an authentication error that
 * suggests they typed something wrong.
 */
export const CRYPTOCOM_BASE_URL = 'https://api.crypto.com/exchange/v1';

/**
 * The older Spot API, still the only home of the statement export.
 *
 * `exchange/v1` replaced `v2` for everything this connector reads except one
 * group: `private/export/*` was never carried over. It is kept reachable as the
 * fallback for an account whose ledger genuinely does stop short — this one's
 * does not — so the client can address both hosts, and the export path names
 * its base explicitly rather than being reachable by accident.
 *
 * Same host, so `manifest.json` needs one entry for both.
 */
export const CRYPTOCOM_V2_BASE_URL = 'https://api.crypto.com/v2';

/**
 * ⚠ The single most dangerous number in this connector.
 *
 * `get-transactions` and `get-trades` **silently clamp every request to the
 * most recent 7 days before `end_time`**, whatever range you actually ask for.
 * Measured against a live account, with `end_time` fixed and only the span
 * varied:
 *
 *     span   3d  →  24 rows, oldest 2.0 days before end
 *     span   7d  →  26 rows, oldest 6.0 days before end
 *     span  14d  →  26 rows, oldest 6.0 days before end
 *     span  30d  →  26 rows, oldest 6.0 days before end
 *     span  90d  →  26 rows, oldest 6.0 days before end
 *
 * A 90-day request returns the same 26 rows as a 7-day one. It does not error,
 * it does not warn, and it does not set a "truncated" flag — it just answers
 * for one week and lets you believe you asked for a quarter.
 *
 * So this is a hard ceiling, not a tuning knob. Raising it does not fetch more
 * per request; it makes the walk *skip* everything between the windows it
 * thinks it is covering. Setting it to 30 would have dropped roughly three
 * quarters of this account's ledger while every count in the smoke test still
 * looked plausible.
 *
 * The page limit is a separate and much safer constraint: a window that comes
 * back full is split in half and re-read, because a full page is the one signal
 * this API does give that rows were cut off.
 */
export const MAX_HISTORY_WINDOW_DAYS = 7;

/**
 * How far back a full backfill walks before giving up.
 *
 * Crypto.com's documentation says history is kept for six months — "For records
 * over 6 months, please contact our support team" — and on a live account that
 * is **not what the ledger does**. Rows from 13 and 15 months ago come back
 * without complaint, and the funding endpoints go back further still.
 *
 * The documented limit was taken at face value here first, and it produced a
 * connector that stopped at 180 days and reported the gap as Crypto.com's
 * refusal. It was this connector's own default, and it was wrong. The lesson is
 * the one already written into CONTRIBUTING.md: check against the running
 * backend, not the documentation, and not the types.
 *
 * Three years is generous enough to cover any account this is likely to meet,
 * and the walk stops early on a long enough silence anyway — so the cost of the
 * number being too large is nothing, while the cost of it being too small is a
 * portfolio missing its oldest and usually largest purchases.
 */
export const DEFAULT_LOOKBACK_DAYS = 1095;

/**
 * Consecutive empty windows that end a backwards walk.
 *
 * Six months of silence. An account genuinely dormant for longer than that
 * exists, which is why this is not set to something eager like four weeks — the
 * whole point of the walk is to find the *first* purchase, and stopping just
 * short of it is the failure that matters.
 *
 * It exists at all because `get-trades` costs a second per window: without it,
 * every sync on a young account would spend two and a half minutes proving
 * there is nothing in 2023.
 */
export const QUIET_WINDOWS_BEFORE_STOP = 26;

/**
 * Rows per page for the funding and fiat endpoints.
 *
 * These are paged rather than windowed, and — unlike the ledger — they honour
 * it: one request with `page: 0` returns this account's whole withdrawal
 * history back to 2025-05, and its fiat deposits back to 2025-02. Walking them
 * by time window was the first approach and it returned strictly less: 2 of 6
 * withdrawals, because the other four predated the window.
 *
 * `page` is **mandatory** on the fiat pair. Omitting it does not default to
 * zero; it returns `BAD_REQUEST (10004)`, which reads exactly like a malformed
 * request and cost a debugging round.
 */
export const FUNDING_PAGE_SIZE = 100;

/**
 * Daily candles per `public/get-candlestick` request.
 *
 * Verified live: the endpoint returns **300 candles whatever `count` asks for**
 * — 5000 gets 300, as does every larger number. Daily candles therefore cover
 * about ten months per call, and this connector routinely imports eighteen, so
 * `prices.ts` pages backwards with `start_ts`/`end_ts` rather than trusting one
 * call to cover the range.
 *
 * The quote provider cannot do that — Wealthfolio's Add Provider form takes a
 * single URL with no paging — which is why a configured provider carries ten
 * months of history while an import prices every row it writes.
 */
export const CANDLE_PAGE_SIZE = 300;

/**
 * Rows per request.
 *
 * Crypto.com documents the maximum for these endpoints inconsistently across
 * its own pages, so this is deliberately below every number any of them
 * mentions. Being wrong in this direction costs an extra request; being wrong
 * in the other direction costs rows, silently, which is not a trade worth
 * making. The smoke test reports what actually came back so the number can be
 * raised on evidence.
 */
export const PAGE_LIMIT = 100;

/**
 * Rate limits, which Crypto.com applies **per method**, not per key overall.
 *
 * Most private endpoints allow 100 requests/second. Two do not, and they are
 * precisely the two a backfill leans on hardest:
 *
 *   private/get-trades         1/second
 *   private/get-order-history  1/second
 *
 * So the limiter is a minimum interval per method rather than one shared
 * counter — Kraken's model would be wrong here, because a slow `get-trades`
 * must not throttle the deposit walk running beside it.
 *
 * Milliseconds between calls to the same method.
 */
export const METHOD_INTERVAL_MS: Record<string, number> = {
  'private/get-trades': 1000,
  'private/get-order-history': 1000,
};

/** What a method not listed above waits: 100/second, with headroom. */
export const DEFAULT_INTERVAL_MS = 15;

/**
 * Timestamp unit per endpoint, because Crypto.com is not consistent about it.
 *
 * `get-transactions` and `get-trades` document their `start_time`/`end_time` in
 * **nanoseconds** and show nanosecond examples, while accepting milliseconds.
 * The funding endpoints take `start_ts`/`end_ts` in **milliseconds** and have no
 * nanosecond form at all. Sending the wrong magnitude does not error — it is
 * read as a date in 1970 or in the far future, and returns an empty page that
 * looks exactly like "you have no history".
 *
 * That failure is silent and total, which is why the unit is stated per stream
 * here and why the smoke test checks that returned rows actually fall inside
 * the window it asked for.
 */
export const NANOSECOND_ENDPOINTS = new Set(['private/get-transactions', 'private/get-trades']);

/**
 * Currencies an activity can be denominated in and still be valued.
 *
 * The same ceiling the Kraken connector ran into, for the same reason, and it
 * belongs in both files rather than in a shared one: it is a statement about
 * *this venue's* currencies, and the two lists are not the same.
 *
 * Wealthfolio resolves an activity's currency as an FX pair in Yahoo's format —
 * `format!("{}{}=X", from, to)` — so a `BTC`-denominated activity becomes a
 * request for `BTCUSD=X`, which does not exist. Nothing rejects the row. It is
 * stored, and then silently never priced.
 *
 * This does not forbid importing a coin. It forbids naming a coin as the
 * *currency* of a movement, which is a different thing: a coin-for-coin trade
 * is written as a sell and a buy denominated in `CRYPTO_QUOTE_CURRENCY`.
 *
 * Crypto.com's fiat rails are narrower than Kraken's — it settles spot in USD,
 * EUR, GBP and a handful more — but the extra entries cost nothing and a
 * missing one costs a dropped row.
 */
export const FIAT_CURRENCIES = new Set([
  'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'CHF', 'JPY',
  'SGD', 'HKD', 'NZD', 'PLN', 'DKK', 'SEK', 'NOK', 'BRL', 'TRY', 'ZAR',
]);

/**
 * Stablecoins Crypto.com quotes pairs against, which are *not* fiat.
 *
 * Kept apart from `FIAT_CURRENCIES` deliberately. A `USDT_USD` trade is a real
 * trade between two assets and treating USDT as if it were dollars would
 * invent a 1:1 rate this project has no business inventing — it is close to one
 * and it is not one, and the difference is exactly what a stablecoin
 * de-pegging looks like in a portfolio.
 *
 * Listed rather than inferred: nothing about the string `USDT` says stablecoin.
 * Crypto.com quotes 124 spot pairs against USDT, 5 against PYUSD.
 */
export const STABLECOIN_QUOTES = new Set(['USDT', 'USDC', 'PYUSD', 'DAI', 'TUSD']);

/**
 * The currency a crypto asset's *price feed* quotes in — not what you paid.
 *
 * Two different facts, and the second cannot be derived from the first. This
 * cost the Kraken connector a full debugging session and the lesson transfers
 * intact: an activity keeps the currency the exchange charged, while the asset's
 * price feed is named separately, and setting the feed from the purchase leaves
 * every coin without a major fiat pair unpriced.
 *
 * USD is right here for an additional reason Kraken did not have: Crypto.com
 * quotes 421 of its 577 spot pairs against USD directly, so USD is the venue's
 * own reference currency rather than a convenient default.
 */
export const CRYPTO_QUOTE_CURRENCY = 'USD';

/**
 * A custom Wealthfolio quote provider reading Crypto.com's own public endpoints.
 *
 * The same argument as Kraken's, reached independently: Wealthfolio prices
 * crypto through Yahoo, whose symbol space is not this exchange's, and it fails
 * in two directions — no entry at all for the smaller listings, and a
 * confidently wrong number for tickers that collide with another instrument. A
 * wrong price is worse than a missing one, because nothing looks broken.
 *
 * Crypto.com's public market data needs no API key and prices every coin
 * Crypto.com sells, which makes it the right authority for what a holding on
 * Crypto.com is worth.
 *
 * The addon cannot create the provider itself — the SDK has no custom-provider
 * API and the host's REST API is unreachable from the sandbox — so it detects
 * absence by trying, and offers each field with a copy button for a one-time
 * setup under Settings → Market Data → Custom Providers.
 */
export interface QuoteSource {
  kind: 'latest' | 'historical';
  format: 'json';
  url: string;
  pricePath: string;
  datePath?: string;
  openPath?: string;
  highPath?: string;
  lowPath?: string;
  volumePath?: string;
}

export const QUOTE_PROVIDER: {
  id: string;
  name: string;
  sources: QuoteSource[];
  priority: number;
} = {
  /**
   * ⚠ This must equal the code Wealthfolio derives from `name`, not a code of
   * our own choosing.
   *
   * The Add Provider form generates `code` from the provider name and will not
   * let it be edited — "Crypto.com Ticker" becomes `crypto-com-ticker`, because
   * the dot is punctuation and becomes a separator like the spaces. The obvious
   * spelling, `cryptocom-ticker`, is what this held first, and it was wrong in
   * the worst way available: the provider is created, prices arrive, and the
   * addon keeps reporting it missing because it is comparing against a code
   * nothing has. Caught by creating the provider through the real form rather
   * than reasoning about it.
   */
  id: 'crypto-com-ticker',
  name: 'Crypto.com Ticker',
  sources: [
    {
      kind: 'latest',
      format: 'json',
      /**
       * Pinned to `USD`, never `{CURRENCY}`. That placeholder expands to the
       * *asset's* currency, so a GBP-quoted asset would ask for a `X_GBP` pair
       * that does not exist on this venue — the mistake that took out eight
       * Kraken assets at once.
       */
      url: `${CRYPTOCOM_BASE_URL}/public/get-tickers?instrument_name={SYMBOL}_${CRYPTO_QUOTE_CURRENCY}`,
      /**
       * `a` is the latest trade price. `b` and `k` are the bid and ask, which
       * are the wrong things to value a holding at.
       *
       * Indexed with `*` rather than `[0]` for the same reason Kraken's paths
       * carry a wildcard, though not the same cause: filtered by
       * `instrument_name` the array holds exactly one entry, and a path that
       * does not care how the venue arranges its response is one less thing to
       * break on a change nobody announces.
       */
      pricePath: '$.result.data[*].a',
    },
    {
      kind: 'historical',
      format: 'json',
      /**
       * Daily, and paired with a backfill the import performs itself.
       *
       * The endpoint returns **300 candles whatever `count` asks for**;
       * verified, `count=5000` gets 300. At `timeframe=1D` that is about ten
       * months, and this connector routinely imports eighteen — so this URL
       * alone cannot cover the history.
       *
       * It is not asked to. `fetchDailyCloses` in `prices.ts` already pages
       * `start_ts`/`end_ts` backwards to fetch every daily close the import
       * needs, and `backfillQuotes` writes them into Wealthfolio's own quote
       * history. The provider's job is therefore only to keep the recent
       * stretch current, which ten months does comfortably.
       *
       * This was `timeframe=7D` for exactly one reason: weekly candles fit 5.6
       * years into the same 300, which filled the history but dated every
       * refresh to the start of the current week. Wealthfolio reads that as a
       * stale price and reported "Price updates needed for 5 holdings" against
       * coins that were being quoted correctly — the valuations were right,
       * because the `latest` source above is separate and always current, but
       * the series behind them crawled forward a week at a time.
       *
       * Paging here is still not possible: the Add Provider form takes one URL,
       * and Crypto.com's `start_ts`/`end_ts` want epoch milliseconds while
       * Wealthfolio's `{FROM}`/`{TO}` expand to dates — verified, an ISO date
       * returns `code 50001`. Hence the split: one URL for what is recent, the
       * import for what is old.
       *
       * ⚠ Changing this string does not change an installed provider. The addon
       * cannot create or edit a custom provider — the user pastes this URL in
       * during onboarding — so an existing install keeps whatever it was set up
       * with until the URL is edited by hand.
       */
      url: `${CRYPTOCOM_BASE_URL}/public/get-candlestick?instrument_name={SYMBOL}_${CRYPTO_QUOTE_CURRENCY}&timeframe=1D&count=300`,
      pricePath: '$.result.data[*].c',
      datePath: '$.result.data[*].t',
      openPath: '$.result.data[*].o',
      highPath: '$.result.data[*].h',
      lowPath: '$.result.data[*].l',
      volumePath: '$.result.data[*].v',
    },
  ],
  /** Above Yahoo, so Crypto.com wins wherever it can answer. */
  priority: 1,
};

/**
 * Instrument types, as Crypto.com states them in `public/get-instruments`.
 *
 * `CCY_PAIR` is spot. The other two are derivatives, and the reason this is a
 * stated field rather than a guess about the symbol is that `BTCUSD-PERP` is a
 * perpetual swap on Bitcoin and is not Bitcoin — mapping one to the other would
 * be the `ABML_US_EQ` mistake wearing a different hat.
 *
 * A derivatives position is not silently dropped; it is reported by name, which
 * is what this project does when it cannot represent something honestly.
 */
export const SPOT_INSTRUMENT_TYPE = 'CCY_PAIR';

/**
 * The suffix Crypto.com puts on a staked balance, and what it means.
 *
 * `CRO.staked` is CRO. Crypto.com states the relationship outright rather than
 * leaving it to be parsed: `get-staking-position` returns
 * `{ instrument_name: "CRO.staked", underlying_inst_name: "CRO" }`, so folding
 * the two is reading a stated fact, not stripping a suffix hopefully.
 *
 * They must be folded, for the same reason Kraken's `XBT.S` is: a holding split
 * across two symbols is one holding reported as two, and neither half prices —
 * there is no `CRO.staked_USD` pair on the venue or anywhere else. Folding also
 * makes the `STAKING` ledger rows net to zero, which is what they are: a move
 * between Crypto.com products, not a change in what you own.
 */
export const STAKED_SUFFIX = '.staked';

/** Keyring entries. Two, because Crypto.com signs rather than sending a header. */
export const API_KEY_SECRET_KEY = 'cryptocom-api-key';
export const API_SECRET_SECRET_KEY = 'cryptocom-api-secret';

/** Addon storage keys. */
export const LINKED_ACCOUNT_STORAGE_KEY = 'linked-account-id';
export const ACCOUNT_CURRENCY_STORAGE_KEY = 'account-currency';
export const PROVIDER_STEP_STORAGE_KEY = 'provider-step';

/**
 * Stamped on accounts this connector creates, alongside the Crypto.com account
 * id. Together they survive a rename and a cleared addon storage.
 */
export const CRYPTOCOM_PROVIDER = 'CRYPTOCOM';

export const CRYPTOCOM_LINK = {
  provider: CRYPTOCOM_PROVIDER,
  storageKey: LINKED_ACCOUNT_STORAGE_KEY,
  label: 'Crypto.com',
} as const;

/**
 * Human-readable names for currency codes.
 *
 * Better supplied than Kraken's, but still not a name. `public/get-instruments`
 * states `base_ccy` and `quote_ccy` outright — so `BTC_USD` is BTC against USD
 * because Crypto.com says so, never because a string was split on the
 * underscore — but its `display_name` is only `"BTC/USD"`. Nothing in the API
 * serves "Bitcoin".
 *
 * So the default is Crypto.com's own code, which is plain and never wrong. An
 * entry here is your knowledge stated explicitly in the source, which is a
 * different thing from the code guessing.
 */
export const ASSET_NAMES: Record<string, string> = {
  /**
   * Yahoo resolves `PEPE` to **PEPEGOLD**, a different coin, and Wealthfolio
   * took the name from it — the holding and its price were right, only the
   * label belonged to another asset. Exactly the failure the Kraken connector
   * hit with `CC`/CloudCoin, on a different venue.
   *
   * Observed on a live import: the position showed as "PEPEGOLD USD" while
   * pricing correctly from Crypto.com's own `PEPE_USD`.
   */
  PEPE: 'Pepe',
};

/**
 * Symbol corrections, keyed by Crypto.com's currency code.
 *
 * Codes normally need no correction: `base_ccy` is what both Crypto.com and
 * Wealthfolio's providers call the coin. Add an entry when that turns out to be
 * false for one, rather than adding a rule that rewrites them all.
 */
export const SYMBOL_OVERRIDES: Record<string, string> = {};
