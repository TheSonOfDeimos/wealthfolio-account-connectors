/**
 * Trading 212 Public API response types.
 *
 * Transcribed from https://docs.trading212.com/api (v0, beta). Only the parts
 * this adapter reads are modelled; unknown fields are simply ignored at runtime.
 */

/** `GET /equity/account/summary` */
export interface T212AccountSummary {
  /** Primary trading account number, as shown in the Trading 212 apps. */
  id: number;
  /** Primary account currency, ISO 4217. */
  currency: string;
  cash: {
    availableToTrade: number;
    inPies: number;
    reservedForOrders: number;
  };
  investments: {
    currentValue: number;
    totalCost: number;
    realizedProfitLoss: number;
    unrealizedProfitLoss: number;
  };
  totalValue: number;
}

export type T212OrderSide = 'BUY' | 'SELL';

/**
 * How a fill came about. Only `TRADE` is a genuine purchase/sale; the rest are
 * corporate actions that need their own activity types, so the mapper skips
 * them rather than guessing.
 */
export type T212FillType =
  | 'TRADE'
  | 'STOCK_SPLIT'
  | 'STOCK_DISTRIBUTION'
  | 'FOP'
  | 'FOP_CORRECTION'
  | 'CUSTOM_STOCK_DISTRIBUTION'
  | 'EQUITY_RIGHTS'
  | 'SCRIP_STOCK_DIVIDENDS'
  | 'STOCK_DIVIDENDS'
  | 'STOCK_ACQUISITION'
  | 'CASH_AND_STOCK_ACQUISITION'
  | 'SPIN_OFF';

/** Charge names Trading 212 attaches to a fill. */
export type T212TaxName =
  | 'COMMISSION_TURNOVER'
  | 'CURRENCY_CONVERSION_FEE'
  | 'FINRA_FEE'
  | 'FRENCH_TRANSACTION_TAX'
  | 'PTM_LEVY'
  | 'STAMP_DUTY'
  | 'STAMP_DUTY_RESERVE_TAX'
  | 'TRANSACTION_FEE';

export interface T212Tax {
  name: T212TaxName;
  /** Charge amount — the API calls this `quantity`. */
  quantity: number;
  currency: string;
  chargedAt: string;
}

export interface T212WalletImpact {
  currency: string;
  fxRate: number;
  netValue: number;
  realisedProfitLoss: number;
  taxes: T212Tax[];
}

export interface T212Instrument {
  ticker: string;
  name: string;
  isin: string;
  /** Instrument currency, ISO 4217. May differ from the account currency. */
  currency: string;
}

export interface T212Order {
  id: number;
  ticker: string;
  instrument: T212Instrument;
  side: T212OrderSide;
  status: string;
  type: 'LIMIT' | 'STOP' | 'MARKET' | 'STOP_LIMIT';
  strategy: 'QUANTITY' | 'VALUE';
  /** Order currency, ISO 4217. */
  currency: string;
  createdAt: string;
  quantity?: number;
  filledQuantity?: number;
  value?: number;
  filledValue?: number;
  limitPrice?: number;
  stopPrice?: number;
  timeInForce?: 'DAY' | 'GOOD_TILL_CANCEL';
  extendedHours?: boolean;
  initiatedFrom?: string;
}

export interface T212Fill {
  id: number;
  type: T212FillType;
  filledAt: string;
  price: number;
  quantity: number;
  tradingMethod?: 'TOTV' | 'OTC';
  walletImpact: T212WalletImpact;
}

/** One entry of `GET /equity/history/orders`. */
export interface T212HistoricalOrder {
  order: T212Order;
  fill: T212Fill;
}

/** Cursor-paginated envelope used by every Trading 212 list endpoint. */
export interface T212Page<T> {
  items: T[];
  /**
   * Full path (with query string) of the next page, or `null` on the last
   * page. Per the docs this should be followed verbatim rather than rebuilt.
   */
  nextPagePath: string | null;
}

/** Values parsed from the `x-ratelimit-*` response headers. */
export interface T212RateLimit {
  limit?: number;
  remaining?: number;
  used?: number;
  /** Window length in seconds. */
  period?: number;
  /** Unix timestamp (seconds) at which the window resets. */
  reset?: number;
}
