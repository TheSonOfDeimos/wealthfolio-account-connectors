/**
 * What Crypto.com actually returns, as far as this connector reads it.
 *
 * Written from its documentation and from ccxt's implementation, then corrected
 * against a live account — the only source that settles a disagreement. Fields
 * are optional wherever a real response has been seen to omit them, which is
 * more often than the documentation admits.
 *
 * Amounts arrive as strings on the newer `exchange/v1` endpoints and as JSON
 * numbers on the older funding ones. That inconsistency is Crypto.com's, and it
 * is reproduced here rather than smoothed over: a type that lies about which
 * one you are holding is how a string gets concatenated where it should have
 * been added.
 */

/**
 * Every response, public or private, arrives in this envelope.
 *
 * `code` is the one to read. It is `0` on success and non-zero on failure —
 * **including on an HTTP 200**, which Crypto.com returns for application-level
 * errors often enough that the status line proves nothing on its own.
 */
export interface CryptoComReply<T> {
  id: number;
  method: string;
  code: number;
  /** Present only on failure, and not always then. */
  message?: string;
  detail_code?: string;
  detail_message?: string;
  result?: T;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Public: the instrument catalogue
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One tradable instrument.
 *
 * The two fields that matter most are `base_ccy` and `quote_ccy`, because they
 * are the reason this connector never has to split `BTC_USD` on the underscore.
 * Crypto.com states the composition; the string is just a name.
 *
 * `inst_type` is the second: `CCY_PAIR` is spot, `PERPETUAL_SWAP` and `FUTURE`
 * are derivatives. Stated, again, rather than inferred from a `-PERP` suffix
 * that nothing guarantees.
 */
export interface CryptoComInstrument {
  symbol: string;
  inst_type: string;
  display_name: string;
  base_ccy: string;
  quote_ccy: string;
  quote_decimals: number;
  quantity_decimals: number;
  price_tick_size?: string;
  qty_tick_size?: string;
  max_leverage?: string;
  tradable: boolean;
  expiry_timestamp_ms?: number;
  beta_product?: boolean;
  underlying_symbol?: string;
  contract_size?: string;
  product_type?: string;
}

export interface CryptoComInstrumentsResult {
  data: CryptoComInstrument[];
}

// ─────────────────────────────────────────────────────────────────────────────
//  Private: balances
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One asset held, inside the account's balance.
 *
 * `market_value` is the field that makes this connector's reconciliation
 * sharper than the Kraken one's: Crypto.com states what it thinks each position
 * is worth, in the account's settlement currency, so a Wealthfolio holding has
 * a stated figure to be compared against rather than only a quantity.
 */
export interface CryptoComPositionBalance {
  instrument_name: string;
  quantity: string;
  reserved_qty?: string;
  collateral_weight?: string;
  collateral_amount?: string;
  market_value?: string;
  max_withdrawal_balance?: string;
  hourly_interest_rate?: string;
}

/**
 * The account-level balance.
 *
 * `instrument_name` here is the **settlement currency** of the whole account,
 * not an asset — the one place in this API where that field name means
 * something different, and worth a comment because reading it as an asset
 * produces a plausible and entirely wrong answer.
 *
 * Crypto.com, unlike Kraken, does have an account currency, which means the
 * connector does not have to ask the user to choose one.
 */
export interface CryptoComUserBalance {
  instrument_name: string;
  total_available_balance: string;
  total_margin_balance: string;
  total_initial_margin?: string;
  total_maintenance_margin?: string;
  total_position_cost?: string;
  total_cash_balance: string;
  total_collateral_value?: string;
  total_session_unrealized_pnl?: string;
  total_session_realized_pnl?: string;
  position_balances?: CryptoComPositionBalance[];
  total_effective_leverage?: string;
  position_limit?: string;
  used_position_limit?: string;
  total_borrow?: string;
  is_liquidating?: boolean;
  has_risk?: boolean;
}

export interface CryptoComUserBalanceResult {
  data: CryptoComUserBalance[];
}

/** `private/get-accounts` — the master account and any sub-accounts under it. */
export interface CryptoComAccount {
  uuid: string;
  master_account_uuid?: string;
  margin_account_uuid?: string;
  label?: string;
  enabled?: boolean;
  tradable?: boolean;
  name?: string;
  email?: string;
  mobile_number?: string;
  country_code?: string;
  create_time?: number;
  update_time?: number;
}

export interface CryptoComAccountsResult {
  master_account?: CryptoComAccount;
  sub_account_list?: CryptoComAccount[];
}

// ─────────────────────────────────────────────────────────────────────────────
//  Private: the ledger
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One row of `private/get-transactions` — the spine of the import.
 *
 * `journal_type` is the discriminator: `TRADING`, `TRADE_FEE`, `DEPOSIT`,
 * `WITHDRAW`, `WITHDRAW_FEE`, `AUTO_CONVERSION` and a long tail. The connector
 * takes a census of whatever arrives rather than checking against a fixed list,
 * for the reason the Kraken connector learned the hard way: a real account
 * returns types the documentation does not mention, and an unrecognised row
 * that is silently dropped is a hole in the portfolio nobody is prompted to
 * look for.
 *
 * `instrument_name` on a ledger row is a **currency** (`USD`, `BTC`), not a
 * pair — the opposite of what the same field means on a trade. Both spellings
 * appear in one API and only the endpoint tells you which you have.
 *
 * `transaction_qty` is signed: negative is money leaving.
 */
export interface CryptoComTransaction {
  account_id: string;
  event_date: string;
  journal_type: string;
  journal_id: string;
  transaction_qty: string;
  transaction_cost: string;
  realized_pnl?: string;
  order_id?: string;
  trade_id?: string;
  trade_match_id?: string;
  event_timestamp_ms: number;
  event_timestamp_ns?: string;
  client_oid?: string;
  taker_side?: string;
  side?: string;
  instrument_name: string;
}

export interface CryptoComTransactionsResult {
  data: CryptoComTransaction[];
}

// ─────────────────────────────────────────────────────────────────────────────
//  Private: fills
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One fill from `private/get-trades`.
 *
 * `fees` is **negative** when a fee was charged, and `fee_instrument_name` names
 * the asset it was taken in — which is frequently the coin just bought rather
 * than the currency paid with. A fee in BTC on a BTC purchase is not a cash
 * cost and must not be recorded as one.
 *
 * `instrument_name` here is a pair (`BTC_USD`), unlike on a ledger row.
 */
export interface CryptoComTrade {
  account_id?: string;
  event_date?: string;
  journal_type?: string;
  side: string;
  instrument_name: string;
  fees: string;
  trade_id: string;
  trade_match_id?: string;
  create_time: number;
  traded_price: string;
  traded_quantity: string;
  fee_instrument_name?: string;
  client_oid?: string;
  taker_side?: string;
  order_id?: string;
  create_time_ns?: string;
}

export interface CryptoComTradesResult {
  data: CryptoComTrade[];
}

// ─────────────────────────────────────────────────────────────────────────────
//  Private: funding
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A deposit or a withdrawal.
 *
 * Numbers here are JSON numbers, not strings — the older endpoint's convention,
 * kept rather than normalised so nothing pretends the API is more consistent
 * than it is.
 *
 * `status` is a numeric code in a string. For withdrawals `"1"` is pending and
 * `"5"` is completed; for deposits `"1"` is completed. The overlap is not a
 * typo, it is Crypto.com's, and it is why status is interpreted per endpoint
 * rather than through one shared table.
 */
export interface CryptoComFunding {
  currency: string;
  fee: number;
  create_time: number;
  id: string;
  update_time?: number;
  amount: number;
  address?: string;
  status: string;
  txid?: string;
  network_id?: string;
  client_wid?: string;
}

export interface CryptoComDepositResult {
  deposit_list?: CryptoComFunding[];
}

export interface CryptoComWithdrawalResult {
  withdrawal_list?: CryptoComFunding[];
}

/**
 * A fiat movement, which does not appear in the crypto funding lists.
 *
 * Shape is asserted loosely on purpose: this is the least documented corner of
 * the API and no account here has exercised it yet. The smoke test prints
 * whatever arrives verbatim, and this type gets tightened from that rather than
 * from a guess.
 */
export interface CryptoComFiatTransaction {
  id?: string;
  currency?: string;
  amount?: string | number;
  fee?: string | number;
  status?: string;
  create_time?: number;
  update_time?: number;
  [key: string]: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Private: staking
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A staking reward, a stake movement, or a liquid-staking conversion.
 *
 * One shape for all three because they overlap heavily and differ in which
 * fields are populated, which is exactly the sort of thing to confirm against a
 * live account before splitting into three types that may not need splitting.
 */
export interface CryptoComStakingRecord {
  staking_id?: string;
  instrument_name?: string;
  underlying_inst_name?: string;
  cycle_id?: string;
  reward_id?: string;
  status?: string;
  quantity?: string;
  staked_quantity?: string;
  reward_quantity?: string;
  reward_instrument_name?: string;
  create_time?: number;
  update_time?: number;
  [key: string]: unknown;
}

export interface CryptoComStakingResult {
  data?: CryptoComStakingRecord[];
}

// ─────────────────────────────────────────────────────────────────────────────
//  Private: the statement export, on the older v2 host
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One statement export request.
 *
 * This group exists only on `v2` and is the only candidate for history older
 * than the six months the regular endpoints serve. Whether it actually reaches
 * further is unknown here and is a question for a live account; the smoke test
 * asks it without creating anything unless told to.
 */
export interface CryptoComExportRequest {
  id?: string;
  status?: string;
  requested_data?: string;
  start_ts?: number;
  end_ts?: number;
  create_time?: number;
  download_url?: string;
  expiry_ts?: number;
  [key: string]: unknown;
}

export interface CryptoComExportRequestsResult {
  request_list?: CryptoComExportRequest[];
  [key: string]: unknown;
}
