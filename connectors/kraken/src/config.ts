/**
 * Everything tunable about the Kraken connector, and no secrets.
 *
 * The Trading 212 connector once kept a live key pair in its own `config.ts`,
 * which put it into the git history and every built bundle. Nothing here holds
 * a credential: the addon asks for the pair in its setup form and keeps it in
 * Wealthfolio's keyring, and the Node tools read `.env`, which git ignores.
 */

/**
 * Kraken has one production host and no sandbox.
 *
 * There is no demo environment to rehearse against, which is why the connector
 * asks for a key with three read-only permissions and never requests any
 * endpoint that could move funds. Every call it makes is a query.
 */
export const KRAKEN_BASE_URL = 'https://api.kraken.com';

/**
 * Kraken's private counter, as its rate-limit documentation describes it.
 *
 * The counter starts at zero, each call adds its cost, and it decays
 * continuously. Overshooting locks the key out temporarily, so the client
 * waits instead. History endpoints cost four, which is the number that decides
 * how long a backfill takes: 50 rows per call, one call per eight seconds
 * sustained on a standard account.
 */
export const RATE_LIMIT = {
  max: 20,
  decayStandard: 0.5,
  decayHigher: 1,
} as const;

/** What each endpoint adds to the counter. Anything unlisted costs 1. */
export const CALL_COST = {
  Ledgers: 4,
  TradesHistory: 4,
  ClosedOrders: 4,
  QueryLedgers: 4,
  QueryTrades: 4,
} as const;

/**
 * Rows per page for the history endpoints.
 *
 * `Ledgers` is fixed at 50 and ignores a larger request. `TradesHistory`
 * accepts 1–100, so it is asked for the maximum: the counter cost is the same
 * either way, which makes a bigger page strictly cheaper.
 */
export const LEDGER_PAGE_SIZE = 50;
export const TRADES_PAGE_SIZE = 100;

/**
 * How far one extraction walks, per history stream.
 *
 * The only cost of a bigger number is wall-clock time against the rate
 * limiter. Raise it — or pass `Infinity` — for a full backfill; keep it small
 * while iterating on mapping, where the shape of the data matters more than
 * its volume. Staking rewards pay often enough that an account's ledger is
 * mostly reward rows, so this cap is reached sooner than it looks.
 */
export const MAX_HISTORY_ITEMS = 500;

/**
 * Currencies an activity can be denominated in and still be valued.
 *
 * Not a stylistic choice. Wealthfolio resolves an activity's currency as an FX
 * pair in Yahoo's format — `format!("{}{}=X", from, to)` — so a `BTC` activity
 * becomes a request for `BTCUSD=X`, which does not exist. Verified: `BTC-USD`
 * and `USDT-USD` both resolve as *crypto assets*, while `BTCUSD=X` and
 * `USDTUSD=X` are 404. Nothing rejects the activity; it is stored and then
 * silently never priced.
 *
 * So a trade quoted in crypto or in a stablecoin cannot be imported honestly,
 * and Kraken states no fiat equivalent for one. Those rows are reported by name
 * rather than written — which on Kraken is a large exclusion, not an edge case.
 *
 * ISO 4217 codes as Kraken's display names give them, after the `Z` prefix is
 * resolved through `/0/public/Assets`.
 */
export const FIAT_CURRENCIES = new Set([
  'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'CHF', 'JPY',
  'AED', 'PLN', 'DKK', 'SEK', 'NOK', 'NZD', 'SGD', 'HKD',
]);

/**
 * The currency a crypto asset's *price feed* quotes in — not what you paid.
 *
 * These are two different facts and the second cannot be derived from the
 * first. A purchase's currency is whatever fiat left your Kraken account; an
 * asset's quote currency belongs to whoever supplies its prices.
 *
 * Setting it from the purchase looked right and was not. Wealthfolio resolves a
 * crypto asset to Yahoo as `SYMBOL-QUOTECCY`, and Yahoo carries GBP pairs only
 * for the majors: `BTC-GBP`, `ETH-GBP` and `ADA-GBP` resolve, while `GRT-GBP`,
 * `TAO-GBP`, `ARKM-GBP` and `RENDER-GBP` are all 404. Seven of twenty holdings
 * went unpriced on a live account for exactly that reason. Every one of them
 * resolves against USD.
 *
 * This does not convert anything. The activity keeps the currency Kraken
 * charged; only the asset's price feed is named, which is the one thing USD is
 * actually right about.
 *
 * ⚠ It does not make every price *correct*. Yahoo's crypto tickers collide with
 * other instruments — its `USDG-USD` quotes about $5.45 for a dollar
 * stablecoin, and its `TAO-USD` is plainly not Bittensor. A wrong price is
 * worse than a missing one, so each sync compares the resulting portfolio
 * against Kraken's own valuation and reports the gap rather than letting it
 * pass. Correct an individual asset with a per-provider symbol override on its
 * Market Data tab in Wealthfolio.
 */
export const CRYPTO_QUOTE_CURRENCY = 'USD';

/**
 * A custom Wealthfolio quote provider that reads Kraken's own public Ticker.
 *
 * Yahoo is the default and it is the wrong tool for this job. It has no price
 * at all for `GRT`, `TAO`, `BABY` or `CC`, and for two others it resolves a
 * *different instrument* and returns a confidently wrong number — `USDG-USD`
 * quotes about $5.45 for a dollar stablecoin, and `TAO-USD` is off by nine
 * orders of magnitude. A wrong price is worse than a missing one.
 *
 * Kraken prices every coin Kraken sells, needs no API key, and is the venue the
 * holding actually sits on, which makes it the right authority for what that
 * holding is worth.
 *
 * The addon cannot create this itself: the SDK has no custom-provider API, and
 * the host's own REST API is not reachable from the sandbox. So the connector
 * detects its absence by trying it, and shows these values for a one-time
 * setup in Settings → Market Data. Wealthfolio's Add Provider dialog is a form
 * rather than a JSON import, so each value is offered with its own copy button
 * instead of one blob.
 */
/** One source of a custom provider, as Wealthfolio's Add Provider form takes it. */
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
  id: 'kraken-ticker',
  name: 'Kraken Ticker',
  /**
   * Two sources, and both are needed.
   *
   * `latest` alone gives today's price and nothing else, which leaves every
   * chart empty and every return figure meaningless — a portfolio with one
   * quote per asset has no past to plot. Kraken's OHLC endpoint supplies 721
   * daily candles, about two years, which is more history than any account
   * opened recently can use.
   */
  sources: [
    {
      kind: 'latest',
      format: 'json',
      url: `${KRAKEN_BASE_URL}/0/public/Ticker?pair={SYMBOL}${CRYPTO_QUOTE_CURRENCY}`,
      /**
       * The wildcard is load-bearing. Kraken re-keys some pairs in its
       * response — a request for `XBTUSD` comes back under `XXBTZUSD`, `ETHUSD`
       * under `XETHZUSD` — so an exact key match works for most assets and
       * silently fails on the majors, which are the worst ones to miss.
       */
      pricePath: '$.result.*.c[0]',
    },
    {
      kind: 'historical',
      format: 'json',
      url: `${KRAKEN_BASE_URL}/0/public/OHLC?pair={SYMBOL}${CRYPTO_QUOTE_CURRENCY}&interval=1440`,
      /** `[time, open, high, low, close, vwap, volume, count]` per candle. */
      pricePath: '$.result.*[*][4]',
      datePath: '$.result.*[*][0]',
      openPath: '$.result.*[*][1]',
      highPath: '$.result.*[*][2]',
      lowPath: '$.result.*[*][3]',
      volumePath: '$.result.*[*][6]',
    },
  ],
  /** Above Yahoo, so Kraken wins wherever it can answer. */
  priority: 1,
};

/**
 * Kraken balance suffixes, and what they mean.
 *
 * `XBT.S` is Bitcoin. These are the same underlying asset held in a different
 * product, so a holding must not be split across them — but the provenance is
 * worth keeping, which is why the mapper records the source code rather than
 * discarding it. A suffix outside this table is surfaced rather than assumed.
 */
export const BALANCE_SUFFIXES: Record<string, string> = {
  S: 'staked on-chain',
  M: 'opt-in rewards',
  P: 'parachain-bonded',
  F: 'Kraken Rewards',
  B: 'yield-bearing',
};

/** Keyring entries. Two, because Kraken signs rather than sending the pair. */
export const API_KEY_SECRET_KEY = 'kraken-api-key';
export const API_SECRET_SECRET_KEY = 'kraken-api-secret';

/** Addon storage keys. */
export const LINKED_ACCOUNT_STORAGE_KEY = 'linked-account-id';
export const ACCOUNT_CURRENCY_STORAGE_KEY = 'account-currency';
/**
 * That the price-provider step has been dealt with, and how.
 *
 * Held because the step cannot be verified when it is shown. An addon can ask
 * Wealthfolio for its market-data providers and gets back the built-in
 * *types* — `YAHOO`, `CUSTOM_SCRAPER` — never a configured custom one; proven
 * by creating a provider and watching the list not change. Testing it for real
 * means assigning it to an asset and seeing whether a quote comes back, and
 * during onboarding there are no assets yet.
 *
 * So this records a decision, not a fact. The fact is checked after the first
 * import, when there is finally something to check it with.
 */
export const PROVIDER_STEP_STORAGE_KEY = 'provider-step';

/**
 * Stamped on accounts this connector creates, alongside the Kraken account id.
 * Together they survive a rename and a cleared addon storage.
 */
export const KRAKEN_PROVIDER = 'KRAKEN';

export const KRAKEN_LINK = {
  provider: KRAKEN_PROVIDER,
  storageKey: LINKED_ACCOUNT_STORAGE_KEY,
  label: 'Kraken',
} as const;

/**
 * Human-readable names for Kraken's asset codes.
 *
 * Kraken's API speaks only in codes. `/0/public/Assets` returns `aclass`,
 * `altname`, `decimals`, `status` and `margin_rate`; `AssetPairs` gets as far
 * as `wsname: "CC/USD"`; the private Earn endpoints report `asset: "ADA"`.
 * Nothing anywhere serves "Canton Coin" — that name exists on Kraken's website
 * and in its app, and in no response this connector can make.
 *
 * Left to itself, Wealthfolio names a new asset from whatever its market-data
 * provider matched, and Yahoo's crypto tickers collide with Kraken's: `CC-USD`
 * is **CloudCoin**, a different coin trading at roughly twice Canton Coin's
 * price. The holding and its price were right; only the label was another
 * asset's.
 *
 * So the default is Kraken's own code — plain, and never wrong. Add an entry
 * here to give one a proper name; it is your knowledge stated explicitly in
 * the source, which is a different thing from the code guessing.
 */
export const ASSET_NAMES: Record<string, string> = {
  CC: 'Canton Coin',
};

/**
 * Symbol corrections, keyed by Kraken's display name.
 *
 * Symbols normally come from `/0/public/Assets?assetVersion=1`, which states
 * the display name outright — `XXBT` is `BTC` because Kraken says so, not
 * because a prefix was stripped. Add an entry here when that name is not what
 * Wealthfolio's market-data provider expects.
 */
export const SYMBOL_OVERRIDES: Record<string, string> = {
  // 'XDG': 'DOGE',
};
