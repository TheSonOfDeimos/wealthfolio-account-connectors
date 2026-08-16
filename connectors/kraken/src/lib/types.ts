/**
 * What Kraken actually returns, as far as this connector reads it.
 *
 * Hand-written rather than taken from an SDK, because no Kraken client on npm
 * accepts an injected transport and the sandbox has no other way out. Every
 * numeric field arrives as a **string** — Kraken quotes decimals to avoid
 * float error, and this connector keeps them that way until the last moment
 * for the same reason.
 *
 * Fields are marked optional where Kraken omits them in practice rather than
 * where its documentation says it might. Where the two disagree, the account
 * wins.
 */

/** Every Kraken reply is this shape; `error` is empty on success. */
export interface KrakenReply<T> {
  error: string[];
  result?: T;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Public metadata — the only honest source for what an asset or pair is
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One asset from `/0/public/Assets`.
 *
 * The response is keyed by Kraken's own code (`XXBT`); `altname` is the short
 * form (`XBT`). Requested with `assetVersion=1` the whole response is re-keyed
 * by display name (`BTC`) instead — which is what Wealthfolio wants as a
 * canonical ticker. Both are fetched and joined on `altname`, so the mapping
 * from `XXBT` to `BTC` is stated by Kraken rather than parsed out of a prefix.
 */
export interface KrakenAsset {
  /** `currency` or `tokenized_asset` — the latter is an xStock, not an equity. */
  aclass: string;
  altname: string;
  decimals: number;
  display_decimals: number;
  status?: string;
  collateral_value?: number;
  margin_rate?: string;
}

/**
 * One tradeable pair from `/0/public/AssetPairs`.
 *
 * `base` and `quote` are the reason this is fetched: they state what a pair is
 * made of. Deriving them by splitting `XXBTZUSD` is exactly the inference this
 * project refuses — Kraken's own codes are not fixed-width and not all carry a
 * prefix.
 */
export interface KrakenAssetPair {
  altname: string;
  /** e.g. `XBT/USD`. Unique per pair, unlike the response key. */
  wsname?: string;
  aclass_base: string;
  base: string;
  aclass_quote: string;
  quote: string;
  lot?: string;
  pair_decimals?: number;
  lot_decimals?: number;
  cost_decimals?: number;
  status?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Private history
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One ledger row — the spine of the whole import.
 *
 * Every movement of every asset appears here, including both halves of a trade
 * (one row for the base asset, one for the quote), joined by `refid`.
 *
 * Documented `type` values: trade, deposit, withdrawal, transfer, margin,
 * adjustment, rollover, credit, settled, staking, dividend, sale, nft_rebate.
 *
 * The documented list is **not complete**. A live account also returns
 * `spend` and `receive` — the two halves of an Instant Buy, sharing a `refid`
 * and absent from `TradesHistory` entirely. An account that bought only that
 * way reports zero trades while visibly holding what it bought. This is why
 * the smoke test prints a census of whatever arrives instead of checking
 * against a fixed list.
 *
 * `subtype` qualifies a few types — most importantly `transfer`, where it
 * separates a genuine airdrop from an internal move between the spot, futures
 * and staking wallets. Treating the latter as a deposit would double the
 * portfolio, so the mapper must not guess here.
 */
export interface KrakenLedgerEntry {
  refid: string;
  /** Unix seconds, fractional. */
  time: number;
  type: string;
  subtype?: string;
  aclass: string;
  asset: string;
  amount: string;
  fee: string;
  balance?: string;
}

/**
 * One trade from `/0/private/TradesHistory`.
 *
 * Carries what the ledger cannot: the pair, the unit price and the volume. The
 * ledger says a quantity of an asset moved; only this says what it was bought
 * at. The two are joined on the trade id.
 */
export interface KrakenTrade {
  ordertxid: string;
  postxid?: string;
  pair: string;
  time: number;
  type: 'buy' | 'sell';
  ordertype: string;
  /** Unit price, in the quote currency. */
  price: string;
  /** Total consideration, in the quote currency. */
  cost: string;
  /** Charged in the quote currency. */
  fee: string;
  /** Volume, in the base currency. */
  vol: string;
  margin?: string;
  leverage?: string;
  misc?: string;
  trade_id?: number;
  maker?: boolean;
  /** Only present when the request asks for it; it slows the endpoint down. */
  ledgers?: string[];
}

/** Funding detail, richer than the matching ledger row but not required by it. */
export interface KrakenFunding {
  method?: string;
  network?: string;
  aclass?: string;
  asset: string;
  refid?: string;
  /** On-chain transaction id, or the payment network's reference. */
  txid?: string;
  info?: string;
  amount: string;
  fee?: string;
  time: number;
  status?: string;
  'status-prop'?: string;
}

/** One Earn position. Reachable on `Query Funds`; the Earn permission is for moving funds. */
export interface KrakenEarnAllocation {
  strategy_id: string;
  native_asset: string;
  amount_allocated?: unknown;
  total_rewarded?: unknown;
  payout?: unknown;
}

export interface KrakenEarnAllocations {
  converted_asset?: string;
  total_allocated?: string;
  total_rewarded?: string;
  items?: KrakenEarnAllocation[];
}

/** `/0/private/TradeBalance`, in one asset — Kraken has no account currency. */
export interface KrakenTradeBalance {
  /** Combined balance of all currencies. */
  eb?: string;
  /** Combined balance of all equity currencies. */
  tb?: string;
  /** Margin amount of open positions. */
  m?: string;
  /** Unrealised net profit/loss of open positions. */
  n?: string;
  /** Cost basis of open positions. */
  c?: string;
  /** Current floating valuation of open positions. */
  v?: string;
  /** Equity. */
  e?: string;
  /** Free margin. */
  mf?: string;
}

export type KrakenBalances = Record<string, string>;
export type KrakenLedgerPage = { ledger: Record<string, KrakenLedgerEntry>; count?: number };
export type KrakenTradesPage = { trades: Record<string, KrakenTrade>; count?: number };
