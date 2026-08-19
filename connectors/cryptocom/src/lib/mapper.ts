/**
 * Crypto.com ledger entries → Wealthfolio activities.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  The rule
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Record what Crypto.com recorded, and convert nothing. Where it does not state
 * a figure, none is invented — the row is reported instead of written.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  Why the ledger is the only source, and `get-trades` is corroboration
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `private/get-transactions` describes every movement, and it balances. On a
 * live account all ten holdings reproduced from it **exactly** — not to a
 * tolerance, to the last decimal. Nothing else here can make that claim, so
 * everything is mapped from the ledger and `get-trades` is used only to carry
 * the price Crypto.com stated for a fill.
 *
 * The join is unusually clean. Every trade is exactly three ledger rows sharing
 * one `trade_id` — verified, 126 of 126 groups:
 *
 *     TRADING    USD   -199.93925   side=SELL     the money leaving
 *     TRADING    CRO    2657        side=BUY      the coin arriving
 *     TRADE_FEE  CRO      -6.6425                 the fee, in the coin bought
 *
 * No pairing by proximity, no reconstruction. Crypto.com states the grouping.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  The field that is not what it looks like
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * **`transaction_cost` is always identical to `transaction_qty`.** 0 of 622
 * rows differed. The name suggests a cost in money and it is the quantity
 * again, in the row's own asset — so it can never be read as a valuation, and
 * anything needing one gets it from `prices.ts`.
 *
 * `instrument_name` is also two different things depending on where it appears:
 * a **currency** on a ledger row (`USD`, `BTC`) and a **pair** on a trade
 * (`BTC_USD`). Only the endpoint tells you which you are holding.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  Host behaviours this relies on, established by the Kraken connector
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * | Verified against a running 3.6.3           | Consequence here                |
 * | ------------------------------------------ | ------------------------------- |
 * | A BUY without `unitPrice` stores a null     | The price is computed, and the  |
 * | price — not derived, not rejected.          | comment carries the operands.   |
 * | `asset.kind` beats the host's own guess.    | Always send `CRYPTO`.           |
 * | `sourceSystem`, `sourceRecordId`, `subtype`,| Provenance goes in fields, not  |
 * | `needsReview` and `idempotencyKey` are all  | stamped into a comment.         |
 * | stored, though the SDK declares none.       |                                 |
 * | An activity in a crypto currency is         | Fiat-quoted rows only; the rest |
 * | accepted silently and then never priced.    | are reported.                   |
 * | `DIVIDEND`/`DIVIDEND_IN_KIND` adds quantity | Staking rewards go there. A     |
 * | and basis without touching cash.            | priced BUY would spend cash.    |
 */
import {
  ASSET_NAMES,
  CRYPTOCOM_PROVIDER,
  CRYPTO_QUOTE_CURRENCY,
  FIAT_CURRENCIES,
  STAKED_SUFFIX,
  SYMBOL_OVERRIDES,
} from '../config';
import { pairComposition } from './extract';
import type { CryptoComDataset } from './extract';
import { dayOf } from './prices';
import type { PriceLookup } from './prices';
import type { CryptoComTransaction } from './types';

/** An activity as `saveMany` accepts it, including the fields the SDK omits. */
export interface MappedActivity {
  accountId: string;
  activityType: string;
  activityDate: string;
  subtype?: string;
  asset?: { symbol: string; kind: 'CRYPTO'; quoteCcy: string; name?: string };
  quantity?: string;
  unitPrice?: string;
  amount?: string;
  currency: string;
  fee?: string;
  comment: string;
  /** Undeclared by the SDK, accepted by the backend. Verified. */
  sourceSystem: string;
  sourceRecordId: string;
  idempotencyKey: string;
  needsReview?: boolean;
}

export interface MappingIssue {
  kind: 'skipped' | 'warning';
  /** The Crypto.com row this is about, for the UI to point at. */
  sourceId: string;
  message: string;
}

export interface MapResult {
  activities: MappedActivity[];
  issues: MappingIssue[];
}

export interface MapOptions {
  /**
   * Crypto.com's published daily close for an asset, when there is one.
   *
   * Supplied rather than fetched here so the mapper stays a pure function of
   * the dataset it is handed. Absent, every row needing a price falls back to
   * being recorded at zero and flagged.
   */
  priceOn?: PriceLookup;
  /**
   * The currency the Wealthfolio account is denominated in.
   *
   * Unlike Kraken, Crypto.com states one — `user-balance.instrument_name`, USD
   * on every account seen — so this is normally that rather than a user's
   * guess. It denominates rows with no money in them, which is what stops them
   * creating an FX pair nobody can price.
   */
  accountCurrency: string;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Identity
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How this connector recognises its own rows.
 *
 * `journal_id` is unique per ledger row — 622 rows, 622 distinct ids on a live
 * account — so it is the key, with no hashing. `order_id` is deliberately not:
 * a partly filled order produces several rows sharing one, and keying on it
 * would collapse real movements into a single activity.
 *
 * Scoped to the Wealthfolio account, because the host treats an idempotency key
 * as globally unique rather than unique per account. Without the account in the
 * key, importing the same history into a second account is refused outright.
 */
export function idempotencyKeyFor(accountId: string, sourceId: string): string {
  return `cryptocom:${accountId}:${sourceId}`;
}

/** The prefix every key for one account shares, for stripping it back off. */
export function keyPrefixFor(accountId: string): string {
  return `cryptocom:${accountId}:`;
}

/** True when an activity came from this connector. */
export function isOurs(activity: { sourceSystem?: string; idempotencyKey?: string }): boolean {
  return (
    activity.sourceSystem === CRYPTOCOM_PROVIDER ||
    Boolean(activity.idempotencyKey?.startsWith('cryptocom:'))
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Numbers and symbols
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A number as a string the backend will accept, without float noise.
 *
 * Crypto.com quotes everything as a decimal string precisely to avoid binary
 * float error, so the arithmetic here is kept to the minimum and trimmed back
 * to something exact enough to survive a round trip.
 */
function decimal(value: number, places = 12): string {
  if (!Number.isFinite(value)) return '0';
  return String(Number(value.toFixed(places)));
}

/**
 * The coin behind a ledger code.
 *
 * `CRO.staked` is CRO. Crypto.com holds staked balances under their own code
 * and states the relationship outright in `get-staking-position`
 * (`underlying_inst_name`), so this is a stated fact rather than a suffix being
 * parsed off hopefully — the same shape as Kraken's `XBT.S`, and the same
 * reason to fold it: a holding must not be split across two symbols when the
 * exchange considers it one asset.
 *
 * Folding them also makes the `STAKING` rows net to zero, which is what they
 * are: a move between your own products, not a change in what you own.
 */
export function underlyingSymbol(code: string): string {
  const override = SYMBOL_OVERRIDES[code];
  if (override) return override;
  const suffix = code.indexOf(STAKED_SUFFIX);
  return suffix === -1 ? code : code.slice(0, suffix);
}

/** True when a code names money Wealthfolio can price as a currency. */
function isFiat(code: string): boolean {
  return FIAT_CURRENCIES.has(underlyingSymbol(code));
}

// ─────────────────────────────────────────────────────────────────────────────
//  Mapping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The assets whose daily close the mapper will need.
 *
 * Two row shapes carry quantities and no money: a staking reward, and a trade
 * paid for in another coin. A trade settled in fiat states its own price and
 * needs nothing here.
 *
 * So one paged lookup per coin that is either rewarded or spent, and none at
 * all for an account that neither stakes nor trades one coin for another.
 */
export function symbolsNeedingPrices(dataset: CryptoComDataset): string[] {
  const wanted = new Set<string>();

  for (const row of dataset.transactions) {
    if (row.journal_type !== 'STAKING_REWARDS') continue;
    const symbol = underlyingSymbol(row.instrument_name);
    if (!isFiat(symbol)) wanted.add(symbol);
  }

  // The coin given up in a coin-for-coin trade is what values the exchange.
  for (const rows of tradeGroupsOf(dataset).values()) {
    const legs = rows.filter((row) => row.journal_type === 'TRADING');
    if (legs.length !== 2 || legs.some((row) => isFiat(row.instrument_name))) continue;
    const given = legs.find((row) => Number(row.transaction_qty) < 0);
    if (given) wanted.add(underlyingSymbol(given.instrument_name));
  }

  // Coins crossing the chain, and coins swept as dust. Both move units with no
  // money attached, and both are now written as a priced disposal or
  // acquisition rather than a transfer — see `movement` below for why.
  for (const row of dataset.transactions) {
    if (!MOVEMENT_TYPES.has(row.journal_type)) continue;
    const symbol = underlyingSymbol(row.instrument_name);
    if (!isFiat(symbol)) wanted.add(symbol);
  }

  return [...wanted].sort();
}

/**
 * Every coin the account has ever touched.
 *
 * Wider than `symbolsNeedingPrices`, and for a different purpose: that one
 * lists the coins whose *rows* cannot be written without a price, this one
 * lists the coins whose *history* should be filled in. A coin bought and held
 * in a fiat trade states its own price on every row, so it needs nothing to
 * import — but its chart still wants a close for each day, and the quote
 * provider can only reach back about ten months.
 *
 * Staked balances fold into the coin they are, the same way they do everywhere
 * else here, because `CRO.staked` has no pair on the venue.
 */
export function allCryptoSymbols(dataset: CryptoComDataset): string[] {
  const seen = new Set<string>();
  for (const row of dataset.transactions) {
    const symbol = underlyingSymbol(row.instrument_name);
    if (symbol && !isFiat(symbol)) seen.add(symbol);
  }
  return [...seen].sort();
}

/**
 * Ledger rows grouped by the `trade_id` Crypto.com states on all three legs.
 *
 * Shared by the mapper and the price lookup so the two can never disagree
 * about what counts as a trade.
 */
function tradeGroupsOf(dataset: CryptoComDataset): Map<string, CryptoComTransaction[]> {
  const groups = new Map<string, CryptoComTransaction[]>();
  for (const row of dataset.transactions) {
    if (row.journal_type !== 'TRADING' && row.journal_type !== 'TRADE_FEE') continue;
    const id = row.trade_id;
    if (!id || id === '0') continue;
    const group = groups.get(id);
    if (group) group.push(row);
    else groups.set(id, [row]);
  }
  return groups;
}

/**
 * Ledger types that move units without money: coins crossing the chain, and
 * coins swept as dust.
 */
const MOVEMENT_TYPES = new Set(['ONCHAIN_DEPOSIT', 'ONCHAIN_WITHDRAWAL', 'CRYPTO_DUSTING']);

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  Why these are not `TRANSFER_IN` / `TRANSFER_OUT`
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Because Wealthfolio reads a transfer as a move between two *accounts* and
 * expects to find the other leg. These have no other leg — the coins came from,
 * or went to, a wallet the portfolio does not track. The host says exactly what
 * it does with them: "A transfer is unpaired or missing its matching leg, so
 * its flow was treated as external and may distort returns."
 *
 * It did distort them. On a live import 17 such rows put an error on the
 * data-health page, and the account's own chart came out at 674% volatility
 * against a -100% drawdown with both TWR and IRR unavailable — while the
 * holdings and the total were perfectly correct. The Kraken connector documents
 * this trap in a comment and this one inherited it anyway.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  What replaces it, and why the cash leg is there
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Measured against a running 3.6.3, one type at a time in its own account:
 *
 *     ADJUSTMENT       creates no position at all — it adjusts cash
 *     BUY  @0          +units, cash untouched
 *     BUY  @price      +units, cash falls by the amount
 *     SELL @price      -units, cash rises by the amount
 *     TRANSFER_OUT     -units, cash untouched, and flagged as unpaired
 *
 * So units in are a `BUY` and units out are a `SELL`, priced at Crypto.com's
 * published close for that day — the same series that already values staking
 * rewards and coin-for-coin trades, and a stated figure for a known asset and
 * date rather than a guess.
 *
 * A priced BUY or SELL moves cash, and no cash moved: nothing was paid for a
 * deposit and nothing was received for a withdrawal. So each is paired with an
 * equal and opposite cash movement, which nets the cash effect to exactly zero
 * and leaves the account's balance as Crypto.com reports it. That is also what
 * the movement *is*: value entering or leaving the account in kind, at the
 * market price of the day it happened.
 *
 * Where no close exists the pair falls back to `BUY`/`SELL` at zero, which
 * still moves the units and still touches no cash — the position simply carries
 * no basis, and says so.
 */
function movement(
  row: CryptoComTransaction,
  context: {
    accountId: string;
    options: MapOptions;
    assetFor: (code: string) => MappedActivity['asset'];
    base: (row: CryptoComTransaction, sourceId: string) => Omit<MappedActivity, 'activityType' | 'currency' | 'comment'>;
  },
  describe: string,
): { activities: MappedActivity[]; issue?: MappingIssue } {
  const { options, assetFor, base } = context;
  const quantity = Number(row.transaction_qty);
  const arriving = quantity > 0;
  const units = Math.abs(quantity);
  const symbol = underlyingSymbol(row.instrument_name);
  const day = dayOf(row.event_timestamp_ms);
  const close = options.priceOn?.(symbol, day);

  const asset = assetFor(row.instrument_name);
  const security = base(row, row.journal_id);

  if (close === undefined) {
    return {
      activities: [
        {
          ...security,
          activityType: arriving ? 'BUY' : 'SELL',
          asset,
          quantity: decimal(units),
          unitPrice: '0',
          amount: '0',
          currency: options.accountCurrency,
          comment: `${describe} · Crypto.com publishes no close for ${symbol} on ${day}, so this carries no cost basis`,
          needsReview: true,
        },
      ],
      issue: {
        kind: 'warning',
        sourceId: row.journal_id,
        message:
          `${decimal(units)} ${symbol} ${arriving ? 'arrived' : 'left'} with no published close for ` +
          `${day}, so the quantity is exact and the value is unknown.`,
      },
    };
  }

  const value = units * close;
  // Two activities, so two keys — an idempotency key must be unique per row.
  const cash = base(row, `${row.journal_id}:cash`);
  cash.idempotencyKey = idempotencyKeyFor(context.accountId, `${row.journal_id}:cash`);

  const note =
    `${describe} · valued at Crypto.com's ${day} close of ${decimal(close)} ` +
    `${CRYPTO_QUOTE_CURRENCY}; the matching cash line offsets it so the balance is unchanged, ` +
    'because no money moved — only the coins did';

  return {
    activities: [
      {
        ...security,
        activityType: arriving ? 'BUY' : 'SELL',
        asset,
        quantity: decimal(units),
        unitPrice: decimal(close),
        amount: decimal(value),
        currency: CRYPTO_QUOTE_CURRENCY,
        comment: note,
      },
      {
        ...cash,
        // Mirrors the security leg: a BUY spends cash, so the pair deposits it.
        activityType: arriving ? 'DEPOSIT' : 'WITHDRAWAL',
        amount: decimal(value),
        currency: CRYPTO_QUOTE_CURRENCY,
        comment: note,
      },
    ],
  };
}

export function mapDataset(
  dataset: CryptoComDataset,
  accountId: string,
  options: MapOptions,
): MapResult {
  const activities: MappedActivity[] = [];
  const issues: MappingIssue[] = [];

  const base = (row: CryptoComTransaction, sourceId: string) => ({
    accountId,
    activityDate: new Date(row.event_timestamp_ms).toISOString(),
    sourceSystem: CRYPTOCOM_PROVIDER,
    sourceRecordId: sourceId,
    idempotencyKey: idempotencyKeyFor(accountId, sourceId),
  });

  /**
   * The asset record for a code.
   *
   * `quoteCcy` names the *price feed*, never the trade. Passing a purchase
   * currency through here is what left seven of twenty Kraken holdings
   * unpriced, and the reasoning transfers unchanged: Crypto.com quotes 421 of
   * its 577 spot pairs against USD, so USD is the venue's own reference rather
   * than a convenient default.
   *
   * `kind` is not advisory — without it the host classifies an unrecognised
   * coin as an EQUITY. `name` is supplied for the same class of reason: left
   * unset, the host names the asset from whatever its provider matched, and
   * those tickers collide across venues. Crypto.com's own code is the only
   * name this connector can state, so it is the default.
   */
  const assetFor = (code: string): MappedActivity['asset'] => {
    const symbol = underlyingSymbol(code);
    return {
      symbol,
      kind: 'CRYPTO' as const,
      quoteCcy: CRYPTO_QUOTE_CURRENCY,
      name: ASSET_NAMES[symbol] ?? symbol,
    };
  };

  // ── Trades ────────────────────────────────────────────────────────────────
  //
  // Grouped by `trade_id`, which Crypto.com states on all three legs.
  const tradeGroups = tradeGroupsOf(dataset);

  // The fill list carries the price Crypto.com stated, which the ledger does
  // not. Looked up rather than recomputed wherever it is available.
  const fills = new Map(dataset.trades.map((trade) => [trade.trade_id, trade]));

  for (const [tradeId, rows] of tradeGroups) {
    const result = mapTrade(tradeId, rows, {
      accountId,
      dataset,
      options,
      fill: fills.get(tradeId),
      assetFor,
      base,
    });
    activities.push(...result.activities);
    if (result.issue) issues.push(result.issue);
  }

  // ── Currency conversions ──────────────────────────────────────────────────
  //
  // Crypto.com calls a GBP → USD conversion a STABLECOIN_CONVERSION, which is
  // its name and not a description. Both legs share an `order_id`, so the pair
  // is stated rather than inferred, and the rate is the two stated amounts
  // divided — Crypto.com's own rate, not one this connector looked up.
  const conversionGroups = new Map<string, CryptoComTransaction[]>();
  for (const row of dataset.transactions) {
    if (row.journal_type !== 'STABLECOIN_CONVERSION') continue;
    const id = row.order_id;
    if (!id || id === '0') continue;
    const group = conversionGroups.get(id);
    if (group) group.push(row);
    else conversionGroups.set(id, [row]);
  }

  for (const [orderId, rows] of conversionGroups) {
    const out = rows.find((row) => Number(row.transaction_qty) < 0);
    const into = rows.find((row) => Number(row.transaction_qty) > 0);

    if (!out || !into || rows.length !== 2) {
      for (const row of rows) {
        issues.push({
          kind: 'skipped',
          sourceId: row.journal_id,
          message:
            `Conversion ${orderId} has ${rows.length} legs rather than two, so what was exchanged ` +
            'for what is not stated. Left out.',
        });
      }
      continue;
    }

    const sent = Math.abs(Number(out.transaction_qty));
    const received = Number(into.transaction_qty);
    const outSymbol = underlyingSymbol(out.instrument_name);
    const intoSymbol = underlyingSymbol(into.instrument_name);
    const rate = sent === 0 ? 0 : received / sent;
    const note =
      `Crypto.com conversion ${orderId} · ${decimal(sent)} ${outSymbol} → ` +
      `${decimal(received)} ${intoSymbol} at ${decimal(rate, 6)}, which is Crypto.com's own rate ` +
      'derived from the two amounts it states';

    // Both sides are fiat on every account seen, so both are cash movements.
    // Anything else is a coin changing hands and belongs on the trade path,
    // which is why a non-fiat leg is reported rather than forced through here.
    if (!isFiat(out.instrument_name) || !isFiat(into.instrument_name)) {
      for (const row of rows) {
        issues.push({
          kind: 'skipped',
          sourceId: row.journal_id,
          message:
            `Conversion ${orderId} moves between ${outSymbol} and ${intoSymbol}, at least one of ` +
            'which is not a currency Wealthfolio can price. Left out rather than valued at a ' +
            'made-up rate.',
        });
      }
      continue;
    }

    activities.push(
      {
        ...base(out, out.journal_id),
        activityType: 'WITHDRAWAL',
        amount: decimal(sent),
        currency: outSymbol,
        comment: note,
      },
      {
        ...base(into, into.journal_id),
        activityType: 'DEPOSIT',
        amount: decimal(received),
        currency: intoSymbol,
        comment: note,
      },
    );
  }

  // ── Staking moves ─────────────────────────────────────────────────────────
  //
  // `STAKING` rows come in pairs — CRO out, CRO.staked in, same instant, equal
  // and opposite. Because `CRO.staked` folds to `CRO`, the pair nets to zero
  // and both sides are internal: staking does not change what you own, only
  // which Crypto.com product holds it. Writing them would add and remove the
  // same units, which is harmless but noisy, and writing only one side would
  // corrupt the balance.
  const stakingRows = dataset.transactions.filter((row) => row.journal_type === 'STAKING');
  for (const row of stakingRows) {
    const symbol = underlyingSymbol(row.instrument_name);
    issues.push({
      kind: 'skipped',
      sourceId: row.journal_id,
      message:
        `${decimal(Math.abs(Number(row.transaction_qty)))} ${symbol} moved ` +
        `${Number(row.transaction_qty) > 0 ? 'into' : 'out of'} staking. Both sides are the same ` +
        'asset, so this is a move between Crypto.com products rather than a change in holdings.',
    });
  }

  // ── Everything else, row by row ───────────────────────────────────────────
  const handledByGroup = new Set<string>();
  for (const rows of tradeGroups.values()) for (const row of rows) handledByGroup.add(row.journal_id);
  for (const rows of conversionGroups.values()) for (const row of rows) handledByGroup.add(row.journal_id);
  for (const row of stakingRows) handledByGroup.add(row.journal_id);

  for (const row of dataset.transactions) {
    if (handledByGroup.has(row.journal_id)) continue;

    const symbol = underlyingSymbol(row.instrument_name);
    const quantity = Number(row.transaction_qty);
    if (!Number.isFinite(quantity) || quantity === 0) continue;
    const fiat = isFiat(row.instrument_name);

    switch (row.journal_type) {
      case 'FIAT_DEPOSIT': {
        activities.push({
          ...base(row, row.journal_id),
          activityType: quantity > 0 ? 'DEPOSIT' : 'WITHDRAWAL',
          amount: decimal(Math.abs(quantity)),
          currency: symbol,
          comment: `Crypto.com fiat deposit · ${decimal(quantity)} ${symbol}`,
        });
        break;
      }

      case 'FIAT_WITHDRAWAL': {
        activities.push({
          ...base(row, row.journal_id),
          activityType: 'WITHDRAWAL',
          amount: decimal(Math.abs(quantity)),
          currency: symbol,
          comment: `Crypto.com fiat withdrawal · ${decimal(quantity)} ${symbol}`,
        });
        break;
      }

      case 'ONCHAIN_DEPOSIT':
      case 'ONCHAIN_WITHDRAWAL': {
        if (fiat) {
          activities.push({
            ...base(row, row.journal_id),
            activityType: quantity > 0 ? 'DEPOSIT' : 'WITHDRAWAL',
            amount: decimal(Math.abs(quantity)),
            currency: symbol,
            comment: `Crypto.com ${row.journal_type.toLowerCase()} · ${decimal(quantity)} ${symbol}`,
          });
          break;
        }
        // Coins crossing the chain. The ledger amount is gross — a withdrawal
        // of 1303.63896 USDT with a 10 USDT fee is recorded as -1313.63896 —
        // so it needs no fee arithmetic of its own.
        //
        // Crypto.com states nothing about what they cost, because they were not
        // bought here. What it does publish is a close for the day they moved,
        // and that is the value of what entered or left the account.
        const onchain = movement(
          row,
          { accountId, options, assetFor, base },
          `Crypto.com ${row.journal_type.toLowerCase()} · ${decimal(Math.abs(quantity))} ` +
            `${symbol} ${quantity > 0 ? 'received from' : 'sent to'} a wallet outside Crypto.com`,
        );
        activities.push(...onchain.activities);
        if (onchain.issue) issues.push(onchain.issue);
        if (quantity > 0) {
          issues.push({
            kind: 'warning',
            sourceId: row.journal_id,
            message:
              `${decimal(quantity)} ${symbol} arrived from outside Crypto.com, which cannot say ` +
              'what you originally paid for it. Its basis is the market value on the day it ' +
              'arrived, not your true cost.',
          });
        }
        break;
      }

      case 'STAKING_REWARDS': {
        const day = dayOf(row.event_timestamp_ms);
        const close = options.priceOn?.(symbol, day);
        const rewardBase = `Crypto.com staking reward · ${decimal(quantity)} ${symbol}`;

        if (close === undefined) {
          // No published close for this asset on this day, so the reward is
          // recorded at zero rather than at a number this connector made up.
          // Wealthfolio leaves the position's cost basis unknown and says so
          // on its data-health page, which is the honest outcome.
          activities.push({
            ...base(row, row.journal_id),
            activityType: 'BUY',
            subtype: 'STAKING_REWARD',
            asset: assetFor(row.instrument_name),
            quantity: decimal(quantity),
            unitPrice: '0',
            amount: '0',
            currency: options.accountCurrency,
            comment: `${rewardBase} · Crypto.com publishes no close for ${symbol} on ${day}, so this is recorded at zero cost`,
            needsReview: true,
          });
          issues.push({
            kind: 'warning',
            sourceId: row.journal_id,
            message:
              `No Crypto.com close for ${symbol} on ${day}, so this reward carries no cost basis.`,
          });
          break;
        }

        // Income received as units, not a purchase. `DIVIDEND` with
        // `DIVIDEND_IN_KIND` adds the quantity and a cost basis while leaving
        // cash alone; a priced `BUY` would also deduct cash the user never
        // spent.
        activities.push({
          ...base(row, row.journal_id),
          activityType: 'DIVIDEND',
          subtype: 'DIVIDEND_IN_KIND',
          asset: assetFor(row.instrument_name),
          quantity: decimal(quantity),
          unitPrice: decimal(close),
          amount: decimal(quantity * close),
          currency: CRYPTO_QUOTE_CURRENCY,
          comment:
            `${rewardBase} · valued at Crypto.com's ${day} close of ${decimal(close)} ` +
            `${CRYPTO_QUOTE_CURRENCY}, which it publishes for the asset but not for this row`,
        });
        break;
      }

      case 'CRYPTO_DUSTING': {
        // Crypto.com sweeps small balances into CRO, and states nothing that
        // ties one leg to another: nine rows landed on a single timestamp with
        // `order_id` and `trade_id` both zero. So the legs cannot be paired
        // without guessing which coin became which CRO — exactly the inference
        // this project refuses.
        //
        // Each row is therefore recorded on its own. The quantities are exact
        // and the balances reconcile; only the value is withheld, and flagged.
        //
        // Each leg is therefore valued on its own at Crypto.com's published
        // close, which needs no pairing: the coin swept is disposed of at that
        // day's price and the CRO received is acquired at that day's price.
        // Because both sides are valued from the same series on the same day,
        // the cash they imply very nearly cancels, and what remains is the
        // sweep's own spread rather than an invented number.
        const dust = movement(
          row,
          { accountId, options, assetFor, base },
          `Crypto.com dust sweep · ${decimal(quantity)} ${symbol} · Crypto.com states no link ` +
            'between the coins swept and the CRO received, so each leg is valued on its own',
        );
        activities.push(...dust.activities);
        if (dust.issue) issues.push(dust.issue);
        break;
      }

      default: {
        issues.push({
          kind: 'skipped',
          sourceId: row.journal_id,
          message:
            `Ledger type "${row.journal_type}" is not mapped (${decimal(quantity)} ${symbol}). ` +
            'Left out rather than guessed at — report it so it can be handled.',
        });
      }
    }
  }

  activities.sort((a, b) => a.activityDate.localeCompare(b.activityDate));
  return { activities, issues };
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * One trade, from its three ledger rows, as a single BUY or SELL.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  Why the quantity is net of the fee
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Because that is what arrived, and because the balances have to reconcile.
 * Crypto.com charges the fee in the asset **bought** — 126 of 126 fills on a
 * live account — so a purchase of 2657 CRO with a 6.6425 CRO fee credits
 * 2650.3575 CRO. Recording 2657 and putting the fee in Wealthfolio's `fee`
 * field would be wrong twice over: the holding would be 6.6425 too high, and
 * the fee would be read as money when no money was charged.
 *
 * The unit price therefore comes out slightly above the price on the ticket,
 * because it is the price actually paid per unit received. The comment carries
 * Crypto.com's own `traded_price` alongside it so the difference is visible
 * rather than mysterious.
 */
function mapTrade(
  tradeId: string,
  rows: CryptoComTransaction[],
  context: {
    accountId: string;
    dataset: CryptoComDataset;
    options: MapOptions;
    fill: CryptoComDataset['trades'][number] | undefined;
    assetFor: (code: string) => MappedActivity['asset'];
    base: (row: CryptoComTransaction, sourceId: string) => Omit<MappedActivity, 'activityType' | 'currency' | 'comment'>;
  },
): { activities: MappedActivity[]; issue?: MappingIssue } {
  const { dataset, fill, assetFor, base } = context;

  const legs = rows.filter((row) => row.journal_type === 'TRADING');
  const feeRow = rows.find((row) => row.journal_type === 'TRADE_FEE');
  const anchor = legs[0] ?? rows[0]!;

  if (legs.length !== 2) {
    return {
      activities: [],
      issue: {
        kind: 'skipped',
        sourceId: tradeId,
        message:
          `Trade ${tradeId} has ${legs.length} TRADING rows rather than two, so what was ` +
          'exchanged for what is not stated. Left out.',
      },
    };
  }

  // Which leg is the coin and which is the money is decided by the pair's
  // stated composition where the catalogue has it, and otherwise by the sign —
  // never by splitting the symbol on its underscore.
  const composition = fill ? pairComposition(dataset, fill.instrument_name) : undefined;

  let baseLeg: CryptoComTransaction | undefined;
  let quoteLeg: CryptoComTransaction | undefined;
  if (composition) {
    baseLeg = legs.find((row) => underlyingSymbol(row.instrument_name) === composition.base);
    quoteLeg = legs.find((row) => underlyingSymbol(row.instrument_name) === composition.quote);
  }
  if (!baseLeg || !quoteLeg) {
    // Without the catalogue, the money is the fiat leg. Both legs being fiat,
    // or neither, is handled below.
    quoteLeg = legs.find((row) => isFiat(row.instrument_name));
    baseLeg = legs.find((row) => row !== quoteLeg);
  }

  if (!baseLeg || !quoteLeg) {
    return {
      activities: [],
      issue: {
        kind: 'skipped',
        sourceId: tradeId,
        message:
          `Trade ${tradeId} is between ${legs
            .map((row) => underlyingSymbol(row.instrument_name))
            .join(' and ')}, and which side is the money is not stated. Left out.`,
      },
    };
  }

  const quoteSymbol = underlyingSymbol(quoteLeg.instrument_name);
  const baseSymbol = underlyingSymbol(baseLeg.instrument_name);

  // ── Paid for in another coin ──────────────────────────────────────────────
  //
  // Wealthfolio resolves an activity's currency as an FX pair in Yahoo's
  // format, so a `USDT`-denominated row becomes a request for `USDTUSD=X`,
  // which does not exist. Nothing rejects it; it is stored and then silently
  // never priced. So a coin can never be named as the *currency* of an
  // activity.
  //
  // Skipping the trade because of that is the obvious answer and it is wrong —
  // the Kraken connector learned this and this one reproduced the mistake
  // before its own reconciliation caught it. Dropping the pair trades a cost
  // that is unknown for quantities that are *stated*: three USDT-quoted trades
  // left CRO 173.13 low, SOL 0.749235 low and USDT 185.69854 high, while every
  // other holding matched exactly.
  //
  // So the movement is recorded and only the cost is withheld. A swap is a
  // disposal funding an acquisition, so it is modelled as one: sell the coin
  // that left at its published close, and buy the coin that arrived for exactly
  // those proceeds. Pricing the buy from the proceeds rather than its own close
  // is what keeps the pair cash-neutral — two independent closes would leave a
  // cash residue the account never had.
  if (!isFiat(quoteLeg.instrument_name)) {
    return mapCoinForCoin(tradeId, { given: quoteLeg, got: baseLeg, feeRow, anchor }, context);
  }

  const baseQty = Number(baseLeg.transaction_qty);
  const quoteQty = Number(quoteLeg.transaction_qty);
  const feeQty = feeRow ? Number(feeRow.transaction_qty) : 0;
  const buying = baseQty > 0;

  // The fee is charged in the asset bought, so it reduces what arrived on a
  // buy and what was received on a sell. Applied to whichever leg it names,
  // rather than assumed onto the base — a sell's fee is taken in the currency.
  const feeOnBase = feeRow
    ? underlyingSymbol(feeRow.instrument_name) === baseSymbol
    : false;

  const quantity = Math.abs(baseQty) - (feeOnBase ? Math.abs(feeQty) : 0);
  const amount = Math.abs(quoteQty) - (feeOnBase ? 0 : Math.abs(feeQty));

  if (quantity <= 0 || amount <= 0) {
    return {
      activities: [],
      issue: {
        kind: 'skipped',
        sourceId: tradeId,
        message: `Trade ${tradeId} nets nothing after its fee. Left out.`,
      },
    };
  }

  const stated = fill?.traded_price;
  const effective = amount / quantity;

  return {
    activities: [
      {
        ...base(anchor, tradeId),
        activityType: buying ? 'BUY' : 'SELL',
        asset: assetFor(baseLeg.instrument_name),
        quantity: decimal(quantity),
        unitPrice: decimal(effective),
        amount: decimal(amount),
        currency: quoteSymbol,
        comment:
          `Crypto.com trade ${tradeId} · ${buying ? 'bought' : 'sold'} ${decimal(
            Math.abs(baseQty),
          )} ${baseSymbol} for ${decimal(Math.abs(quoteQty))} ${quoteSymbol}` +
          (feeRow
            ? ` · fee ${decimal(Math.abs(feeQty))} ${underlyingSymbol(feeRow.instrument_name)}, ` +
              `taken in the asset ${feeOnBase ? 'traded, so the quantity here is net of it' : 'paid with'}`
            : '') +
          (stated
            ? ` · Crypto.com's own price was ${stated} ${quoteSymbol}; the ${decimal(
                effective,
              )} recorded here is what was paid per unit actually received`
            : ''),
      },
    ],
  };
}

/**
 * A trade settled in another coin, as a disposal funding an acquisition.
 *
 * Direction is taken from the signs rather than from base/quote: whichever leg
 * went negative is what left, and that is the one whose published close values
 * the exchange. Crypto.com states no fiat figure for either side — its
 * `transaction_cost` is only the quantity again — so this is the daily close
 * for a known asset on a known date, which is a real number and still not the
 * rate on the ticket. Every row written this way says so.
 */
function mapCoinForCoin(
  tradeId: string,
  legs: {
    given: CryptoComTransaction;
    got: CryptoComTransaction;
    feeRow: CryptoComTransaction | undefined;
    anchor: CryptoComTransaction;
  },
  context: {
    accountId: string;
    options: MapOptions;
    assetFor: (code: string) => MappedActivity['asset'];
    base: (row: CryptoComTransaction, sourceId: string) => Omit<MappedActivity, 'activityType' | 'currency' | 'comment'>;
  },
): { activities: MappedActivity[]; issue?: MappingIssue } {
  const { options, assetFor, base } = context;
  const { given, got, feeRow, anchor } = legs;

  const givenSymbol = underlyingSymbol(given.instrument_name);
  const gotSymbol = underlyingSymbol(got.instrument_name);
  const feeSymbol = feeRow ? underlyingSymbol(feeRow.instrument_name) : undefined;
  const feeQty = feeRow ? Math.abs(Number(feeRow.transaction_qty)) : 0;

  // The fee lands on whichever asset it names, so it is added to what left or
  // taken off what arrived — never assumed onto one of them.
  const disposed = Math.abs(Number(given.transaction_qty)) + (feeSymbol === givenSymbol ? feeQty : 0);
  const acquired = Math.abs(Number(got.transaction_qty)) - (feeSymbol === gotSymbol ? feeQty : 0);

  if (disposed <= 0 || acquired <= 0) {
    return {
      activities: [],
      issue: {
        kind: 'skipped',
        sourceId: tradeId,
        message: `Trade ${tradeId} nets nothing after its fee. Left out.`,
      },
    };
  }

  const day = dayOf(anchor.event_timestamp_ms);
  const close = options.priceOn?.(givenSymbol, day);

  const exchanged =
    `Crypto.com trade ${tradeId} · exchanged ${decimal(disposed)} ${givenSymbol} for ` +
    `${decimal(acquired)} ${gotSymbol}` +
    (feeRow ? `, fee ${decimal(feeQty)} ${feeSymbol}` : '');

  // Two activities, so two keys: an idempotency key must be unique per
  // activity and both legs share one Crypto.com trade id.
  const out = base(anchor, tradeId);
  const into = base(anchor, tradeId);
  out.idempotencyKey = idempotencyKeyFor(context.accountId, `${tradeId}:out`);
  out.sourceRecordId = `${tradeId}:out`;
  into.idempotencyKey = idempotencyKeyFor(context.accountId, `${tradeId}:in`);
  into.sourceRecordId = `${tradeId}:in`;

  if (close === undefined) {
    // No published close for the coin that left, so the quantities are
    // recorded and the value is not. Both sides are flagged; the holdings stay
    // exact and what is unknown is marked unknown rather than being allowed to
    // corrupt what is known.
    const note =
      `${exchanged} · Crypto.com states no value for this exchange and publishes no close for ` +
      `${givenSymbol} on ${day}, so it is recorded at zero cost`;
    return {
      activities: [
        {
          ...out,
          // SELL rather than TRANSFER_OUT even here: at zero it moves the units
          // and touches no cash, exactly as a transfer would, without being
          // read as an unpaired move between accounts.
          activityType: 'SELL',
          asset: assetFor(given.instrument_name),
          quantity: decimal(disposed),
          unitPrice: '0',
          amount: '0',
          currency: options.accountCurrency,
          comment: note,
          needsReview: true,
        },
        {
          ...into,
          activityType: 'BUY',
          asset: assetFor(got.instrument_name),
          quantity: decimal(acquired),
          unitPrice: '0',
          amount: '0',
          currency: options.accountCurrency,
          comment: note,
          needsReview: true,
        },
      ],
      issue: {
        kind: 'warning',
        sourceId: tradeId,
        message:
          `${decimal(acquired)} ${gotSymbol} was bought with ${givenSymbol}, not with money, and ` +
          `Crypto.com publishes no close for ${givenSymbol} on ${day}. The quantities are exact; ` +
          'both sides carry a zero cost and are flagged for review.',
      },
    };
  }

  const proceeds = disposed * close;
  const note =
    `${exchanged} · Crypto.com states no fiat value for the exchange, so the coin that left is ` +
    `valued at its ${day} close of ${decimal(close)} ${CRYPTO_QUOTE_CURRENCY} and the coin that ` +
    'arrived is priced from those proceeds';

  return {
    activities: [
      {
        ...out,
        activityType: 'SELL',
        asset: assetFor(given.instrument_name),
        quantity: decimal(disposed),
        unitPrice: decimal(close),
        amount: decimal(proceeds),
        currency: CRYPTO_QUOTE_CURRENCY,
        comment: note,
      },
      {
        ...into,
        activityType: 'BUY',
        asset: assetFor(got.instrument_name),
        quantity: decimal(acquired),
        unitPrice: decimal(proceeds / acquired),
        amount: decimal(proceeds),
        currency: CRYPTO_QUOTE_CURRENCY,
        comment: note,
      },
    ],
    issue: {
      kind: 'warning',
      sourceId: tradeId,
      message:
        `${decimal(acquired)} ${gotSymbol} was bought with ${givenSymbol}, not with money. ` +
        `Crypto.com states no value for the exchange, so it is valued at the ${day} close of ` +
        `${givenSymbol} — the quantities are exact, the value is a published close rather than ` +
        'the rate you were given.',
    },
  };
}

/** A census of what a mapping produced, for the smoke test and the UI. */
export function summarise(result: MapResult): Map<string, number> {
  const counts = new Map<string, number>();
  for (const activity of result.activities) {
    const key = activity.subtype
      ? `${activity.activityType}/${activity.subtype}`
      : activity.activityType;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
