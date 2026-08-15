import type { ActivityImport, ActivityType } from '@wealthfolio/addon-sdk';
import type { Fill, HistoryDividendItem, Order, Tax, TaxName } from 't212-sdk';
import { EXCHANGE_MIC } from '../config';
import { exchangeMicFor, resolveSymbol } from './symbols';
import { isKnownTransactionType, toEvents } from './extract';
import type { T212Asset, T212Dataset, T212Event, T212Transaction } from './extract';

/**
 * Trading 212 events → Wealthfolio activities.
 *
 * One rule governs everything here: **record what Trading 212 recorded, and
 * convert nothing.** Prices keep the currency they were quoted in, charges keep
 * the currency they were charged in, and no exchange rate is ever derived,
 * inverted for convenience, or applied to an amount. Where Trading 212 does not
 * report a figure — withholding tax on a foreign dividend, for instance — none
 * is invented.
 *
 * Three behaviours of the Wealthfolio host shape the output. All three were
 * verified against a real 3.6.3 instance rather than assumed:
 *
 *  1. **`fxRate` multiplies.** Wealthfolio computes `base = local x fxRate`;
 *     Trading 212 reports a rate that divides. The two conventions are
 *     reciprocal, so a rate copied across unchanged is wrong by its own square
 *     — 1.3469 became £1346.90 where £742.45 was correct.
 *  2. **Pence is *not* normalised on the import path.** `activities.create`
 *     converts `GBX` to pounds on its own; `checkImport`/`import`, which this
 *     addon uses, takes the row's currency at face value. The pence-to-pounds
 *     conversion therefore has to travel in `fxRate` like any other rate —
 *     which is exactly what Trading 212 already reports it as.
 *  3. **`fee` is read in the row's currency.** A GBP charge attached to a USD
 *     row is silently counted as USD, which is why charges leave here as their
 *     own activities instead.
 */

/**
 * Charges Trading 212 reports per fill, split the way Wealthfolio models them:
 * `tax` is government-imposed, `fee` is broker or venue cost. Anything
 * unrecognised is treated as a fee and reported, so a new charge type can never
 * silently vanish from the ledger.
 */
const TAX_CHARGES: string[] = [
  'STAMP_DUTY',
  'STAMP_DUTY_RESERVE_TAX',
  'FRENCH_TRANSACTION_TAX',
] satisfies TaxName[];

const FEE_CHARGES: string[] = [
  'COMMISSION_TURNOVER',
  'CURRENCY_CONVERSION_FEE',
  'FINRA_FEE',
  'PTM_LEVY',
  'TRANSACTION_FEE',
] satisfies TaxName[];

/**
 * The symbol a cash movement carries.
 *
 * Wealthfolio's `ActivityImport` types `symbol` as optional, and its backend
 * requires it — on every row, including deposits, interest and charges, which
 * have no instrument. A single cash row without one fails the whole batch with
 * a bare "422 Unprocessable Entity" naming no field, which is what stalled
 * every import until the request was replayed outside the sandbox and the host
 * finally said `missing field \`symbol\``.
 *
 * `$CASH-<CCY>` is the host's own convention: a `DEPOSIT` sent this way becomes
 * a cash holding, and the response echoes the symbol back as empty, confirming
 * it was understood as cash rather than as a security by that name.
 */
function cashSymbol(currency: string): string {
  return `$CASH-${currency}`;
}

/**
 * How Trading 212 reports a share split, and how it becomes one activity.
 *
 * A split arrives as a *pair* of fills sharing a ticker and a `filledAt` to the
 * second: one leg removes the old shares at the old price, the other adds the
 * new shares at the new price, and both carry the same wallet value because no
 * money moves. The ratio is therefore not a guess — it is
 * `|added| / |removed|`, and it agrees with the price ratio to the last
 * decimal. Verified on two real splits: 0.34766073/0.11588691 = 3 exactly,
 * with prices 316.66 and 949.98; and 11.9019281/1.19019281 = 10.
 *
 * Wealthfolio takes that ratio in `amount` — `quantity` is refused outright
 * with "Split activities require a positive amount ratio" — and applies it by
 * multiplying the holding while preserving cost basis. Confirmed against a
 * live host: 10 shares at 100, `amount: 3`, gives 30 shares with the basis
 * still 1000.
 */
const SPLIT_FILL_TYPES = ['STOCK_SPLIT'];

interface SplitPair {
  added: Fill;
  removed: Fill;
  ticker: string;
  order: Order;
}

/**
 * Every row this mapper produces starts its comment with a key unique to that
 * row, and `activityKeyOf` reads it back.
 *
 * This is the addon's only way to recognise its own work. Wealthfolio's
 * `ActivityImport` has no field for a foreign record id — `sourceRecordId` and
 * `idempotencyKey` exist on stored activities but not on the import shape — so
 * the comment carries it. Everything downstream depends on this: an
 * incremental sync skips rows whose key is already present, and a wipe deletes
 * exactly the rows whose key it recognises, leaving anything you entered by
 * hand untouched.
 */
export function activityKeyOf(comment: string | null | undefined): string | undefined {
  if (!comment) return undefined;
  const first = comment.split(' ', 1)[0];
  return first?.startsWith('t212:') ? first : undefined;
}

/**
 * Something the user should see about an entry.
 *
 * `skipped` means no activity was produced; `warning` means one was, but it
 * deserves a look. One channel, because the UI renders them identically.
 */
export interface MappingIssue {
  kind: 'skipped' | 'warning';
  message: string;
}

export interface MapResult {
  activities: ActivityImport[];
  issues: MappingIssue[];
}

/**
 * Map a whole extraction into activities, in the order the events happened.
 *
 * Chronological order is not cosmetic: it is what a future split mapping will
 * need to recover a ratio from Trading 212's share delta, and it makes the
 * output diffable between runs.
 */
export function mapDataset(
  dataset: T212Dataset,
  accountId: string,
  assets: Map<string, T212Asset>,
  /** Ticker → symbol corrections, from Wealthfolio's own per-account store. */
  overrides: Record<string, string> = {},
  /** Symbols found by searching this run, for tickers the table lacks. */
  searched: Record<string, string> = {},
): MapResult {
  const activities: ActivityImport[] = [];
  const issues: MappingIssue[] = [];
  const skip = (message: string) => issues.push({ kind: 'skipped', message });
  const warn = (message: string) => issues.push({ kind: 'warning', message });

  const { events, undated } = toEvents(dataset);
  for (const event of undated) {
    skip(`${event.sourceId}: no usable timestamp, so it cannot be placed in the ledger.`);
  }

  // Reported once per instrument rather than once per trade — a heavily traded
  // uncatalogued ticker would otherwise bury every other issue.
  const symbolWarned = new Set<string>();
  const splits = pairSplits(dataset, warn);
  const context = { accountId, assets, warn, symbolWarned, splits, overrides, searched };

  for (const event of events) {
    const line = activities.length + 1;
    if (event.kind === 'order') {
      activities.push(...mapOrder(event, context, line));
    } else if (event.kind === 'dividend') {
      activities.push(...mapDividend(event, context, line));
    } else {
      activities.push(...mapTransaction(event, context, line));
    }

    if (event.kind === 'order' && event.record.fill?.type !== 'TRADE' && event.record.order) {
      const { order, fill } = event.record;
      if (!fill) {
        skip(`${order.ticker} (order ${order.id}): not filled, status ${order.status ?? 'unknown'}.`);
      } else if (!SPLIT_FILL_TYPES.includes(fill.type)) {
        // Splits are handled above. The rest — spin-offs, acquisitions, share
        // distributions — each need their own rule, and this account has never
        // produced one to derive it from. Reported by name rather than forced
        // into a shape that would put invented numbers in the ledger.
        skip(
          `${order.ticker} (order ${order.id}): ${fill.type} is a corporate action with no mapping yet. ` +
            'Enter it by hand, and send me the record so it can be handled properly.',
        );
      }
    }
  }

  return { activities, issues };
}

interface Context {
  accountId: string;
  assets: Map<string, T212Asset>;
  warn: (message: string) => void;
  symbolWarned: Set<string>;
  splits: Map<string, SplitPair>;
  overrides: Record<string, string>;
  searched: Record<string, string>;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Trades
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Match up the two legs of each split.
 *
 * Keyed on ticker and the exact `filledAt`, which Trading 212 sets identically
 * on both legs. A leg without a partner cannot yield a ratio — usually because
 * the walk stopped between them — so it is reported rather than approximated.
 */
function pairSplits(
  dataset: T212Dataset,
  warn: (message: string) => void,
): Map<string, SplitPair> {
  const legs = new Map<string, { added?: Fill; removed?: Fill; order?: Order; ticker: string }>();

  for (const { order, fill } of dataset.orders) {
    if (!order || !fill || !SPLIT_FILL_TYPES.includes(fill.type)) continue;
    const ticker = order.instrument?.ticker ?? order.ticker;
    const key = `${ticker}|${fill.filledAt}`;
    const entry = legs.get(key) ?? { ticker };
    if (fill.quantity >= 0) {
      entry.added = fill;
      // The adding leg carries the identity, because it is the one that
      // becomes an activity.
      entry.order = order;
    } else {
      entry.removed = fill;
    }
    legs.set(key, entry);
  }

  const pairs = new Map<string, SplitPair>();
  for (const [key, entry] of legs) {
    if (entry.added && entry.removed && entry.order) {
      pairs.set(key, {
        added: entry.added,
        removed: entry.removed,
        order: entry.order,
        ticker: entry.ticker,
      });
    } else {
      warn(
        `${entry.ticker}: a share split at ${key.split('|')[1]} is missing its ` +
          `${entry.added ? 'removal' : 'addition'} leg, so its ratio cannot be derived. ` +
          'Fetch the whole history and try again.',
      );
    }
  }

  return pairs;
}

/**
 * One split, as a single `SPLIT` activity.
 *
 * Emitted from the adding leg so it lands in the right place chronologically;
 * the removing leg produces nothing. No cash is recorded, because Trading 212
 * moves none — both legs carry the same wallet value.
 */
function mapSplit(
  pair: SplitPair,
  event: T212Event,
  context: Context,
  line: number,
): ActivityImport[] {
  const removed = Math.abs(pair.removed.quantity);
  const added = Math.abs(pair.added.quantity);
  if (!(removed > 0) || !(added > 0)) {
    context.warn(`${pair.ticker}: split has a zero quantity leg, skipped.`);
    return [];
  }

  // Rounded only to shed floating-point noise: 11.9019281 / 1.19019281 comes
  // out as 9.999999999999998, which is the arithmetic's error rather than
  // Trading 212's. Nine decimals is far finer than any real split ratio.
  const ratio = Math.round((added / removed) * 1e9) / 1e9;
  // The price ratio is the same number arrived at independently, so a
  // disagreement means the pairing is wrong rather than the arithmetic.
  const priceRatio = pair.removed.price / pair.added.price;
  if (Math.abs(ratio - priceRatio) / ratio > 0.01) {
    context.warn(
      `${pair.ticker}: split quantities imply ${ratio.toFixed(6)}:1 but prices imply ` +
        `${priceRatio.toFixed(6)}:1. Skipped rather than guess which is right.`,
    );
    return [];
  }

  return [
    {
      ...base(context.accountId, event, line),
      activityType: 'SPLIT',
      symbol: symbolFor(pair.ticker, context),
      symbolName: pair.order.instrument?.name,
      // Wealthfolio takes the ratio here; `quantity` is refused.
      amount: ratio,
      currency: context.assets.get(pair.ticker)?.currency ?? pair.order.instrument?.currency,
      comment:
        `${event.sourceId} split=${ratio}:1 removed=${removed}@${pair.removed.price} ` +
        `added=${added}@${pair.added.price} ticker=${pair.ticker}`,
    },
  ];
}

function mapOrder(
  event: Extract<T212Event, { kind: 'order' }>,
  context: Context,
  line: number,
): ActivityImport[] {
  const { order, fill } = event.record;
  if (!order || !fill) return [];

  // A split is two fills but one event, so it is emitted from the adding leg
  // and the removing leg is passed over.
  if (SPLIT_FILL_TYPES.includes(fill.type)) {
    const ticker = order.instrument?.ticker ?? order.ticker;
    const pair = context.splits.get(`${ticker}|${fill.filledAt}`);
    if (!pair || pair.added.id !== fill.id) return [];
    return mapSplit(pair, event, context, line);
  }

  if (fill.type !== 'TRADE') return [];

  const quantity = Math.abs(fill.quantity);
  if (!(quantity > 0)) return [];

  const ticker = order.instrument?.ticker ?? order.ticker;
  const asset = context.assets.get(ticker);
  const symbol = symbolFor(ticker, context);

  // The currency `fill.price` is quoted in — the instrument's, never the
  // wallet's. Verified across every trade in a live account: price x quantity,
  // divided by the fill's own rate, reproduces the wallet impact exactly.
  const currency = asset?.currency ?? order.instrument?.currency;
  if (!currency) {
    context.warn(`${ticker} (order ${order.id}): no quote currency, so the row was left unlabelled.`);
  }
  if (order.side !== 'BUY' && order.side !== 'SELL') {
    // Guessing the direction of a trade would be the worst possible assumption
    // to make quietly: a buy recorded as a sell inverts the position.
    context.warn(
      `${ticker} (order ${order.id}): Trading 212 reported no side, so the trade was skipped ` +
        'rather than guessed. Enter it by hand.',
    );
    return [];
  }

  const trade: ActivityImport = {
    ...base(context.accountId, event, line),
    activityType: order.side,
    symbol,
    symbolName: order.instrument?.name,
    quantity,
    unitPrice: fill.price,
    currency,
    // The quote currency, carried as a hint for asset resolution. It does not
    // trigger any conversion on the import path — `fxRate` does that.
    quoteCcy: currency,
    instrumentType: asset?.type,
    // Without this the host guesses the venue from the bare symbol, and guesses
    // wrong — a London ETF was looked up on Deutsche Börse and not found.
    exchangeMic: micFor(ticker, asset),
    fxRate: hostFxRate(currency, fill.walletImpact?.fxRate),
    comment: describeTrade(order, fill, ticker),
  };

  // Charges ride the wallet in the wallet's own currency and carry their own
  // timestamp, so they are separate events in Trading 212's model too. Emitting
  // them separately keeps both currencies honest; folding them into the trade
  // would mean converting one into the other.
  return [trade, ...mapCharges(fill, event, context, line, ticker, order.id)];
}

function mapCharges(
  fill: Fill,
  event: T212Event,
  context: Context,
  line: number,
  ticker: string,
  orderId: number,
): ActivityImport[] {
  const charges = fill.walletImpact?.taxes ?? [];
  const rows: ActivityImport[] = [];

  charges.forEach((charge: Tax, index) => {
    const amount = Math.abs(charge.quantity ?? 0);
    if (amount === 0) return;

    if (!TAX_CHARGES.includes(charge.name) && !FEE_CHARGES.includes(charge.name)) {
      context.warn(`${ticker} (order ${orderId}): unrecognised charge ${charge.name}, recorded as a fee.`);
    }

    rows.push({
      ...base(context.accountId, event, line),
      activityType: TAX_CHARGES.includes(charge.name) ? 'TAX' : 'FEE',
      amount,
      currency: charge.currency,
      symbol: cashSymbol(charge.currency),
      // The charge's own timestamp, which can differ from the fill's by
      // minutes. Trading 212 treats them as distinct events; so do we.
      date: charge.chargedAt || event.occurredAt,
      // A fill can carry several charges, so the key extends the fill's own
      // with the charge's position. Without that they would collide and a
      // sync would drop all but the first.
      comment: `${event.sourceId}:charge:${index} name=${charge.name} ticker=${ticker}`,
    });
  });

  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Dividends
// ─────────────────────────────────────────────────────────────────────────────

function mapDividend(
  event: Extract<T212Event, { kind: 'dividend' }>,
  context: Context,
  line: number,
): ActivityImport[] {
  const item: HistoryDividendItem = event.record;
  const ticker = item.instrument?.ticker ?? item.ticker;

  // `amount` is what reached the wallet: net of withholding tax *and* of a
  // currency conversion, with no rate reported and `tickerCurrency` absent from
  // the response entirely. The two effects cannot be separated, so no `tax` is
  // set — a figure here would be a guess wearing a number's clothes. The gross
  // per share is preserved in the comment instead.
  return [
    {
      ...base(context.accountId, event, line),
      activityType: 'DIVIDEND',
      symbol: symbolFor(ticker, context),
      symbolName: item.instrument?.name,
      amount: item.amount,
      currency: item.currency,
      comment:
        `${event.sourceId} ticker=${ticker} grossPerShare=${item.grossAmountPerShare} ` +
        `qty=${item.quantity} type=${item.type}`,
    },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
//  Cash movements
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Trading 212 transaction types to Wealthfolio activity types.
 *
 * `INTEREST_ON_FREE_CASH` is the one `t212-sdk` does not know about and the
 * only route to interest — there is no interest endpoint.
 */
const TRANSACTION_ACTIVITY: Record<string, ActivityType> = {
  DEPOSIT: 'DEPOSIT',
  WITHDRAW: 'WITHDRAWAL',
  FEE: 'FEE',
  INTEREST_ON_FREE_CASH: 'INTEREST',
};

/**
 * A Trading 212 `TRANSFER` becomes a deposit or a withdrawal, not a transfer.
 *
 * Wealthfolio's `TRANSFER_IN` means a move *between two of your accounts* and
 * expects a matching `TRANSFER_OUT` to pair with. Trading 212 reports no
 * counterparty at all, so the pair never exists: the host logs "unresolved
 * transfer activity … marking scoped flow as unknown" and the money simply
 * never lands. On this account that lost £6,126 of cash — the entire remaining
 * discrepancy after everything else reconciled.
 *
 * From the account's point of view the money came in from outside, which is
 * what `DEPOSIT` means here. The original type is preserved in the comment, so
 * a transfer is still distinguishable from a genuine deposit after the fact.
 */
function transferActivity(amount: number): ActivityType {
  return amount < 0 ? 'WITHDRAWAL' : 'DEPOSIT';
}

function mapTransaction(
  event: Extract<T212Event, { kind: 'transaction' }>,
  context: Context,
  line: number,
): ActivityImport[] {
  const item: T212Transaction = event.record;
  const amount = Math.abs(item.amount);

  // A transfer's direction lives in the sign of its amount; every other type
  // names its own direction.
  const activityType =
    item.type === 'TRANSFER' ? transferActivity(item.amount) : TRANSACTION_ACTIVITY[item.type];

  if (!activityType) {
    context.warn(
      `${event.sourceId}: transaction type ${item.type} is not mapped${
        isKnownTransactionType(item.type) ? '' : ' and is not one Trading 212 documents'
      }. The cash movement of ${amount} ${item.currency} was left out.`,
    );
    return [];
  }

  return [
    {
      ...base(context.accountId, event, line),
      activityType,
      amount,
      currency: item.currency,
      symbol: cashSymbol(item.currency),
      comment: `${event.sourceId} type=${item.type}`,
    },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
//  Shared
// ─────────────────────────────────────────────────────────────────────────────

/** Fields every row carries, whatever it represents. */
function base(accountId: string, event: T212Event, line: number) {
  return {
    accountId,
    date: event.occurredAt,
    lineNumber: line,
    // The neutral starting values the host expects on an unvalidated row;
    // `checkImport` decides validity.
    isValid: true,
    isDraft: false,
  };
}

/**
 * Convert Trading 212's rate to Wealthfolio's convention.
 *
 * Trading 212 divides by its rate to reach the wallet currency; Wealthfolio
 * multiplies. The reciprocal expresses the same rate in the other convention —
 * it converts nothing that was not already converted.
 *
 * One rule covers minor units too, and must. Trading 212 reports `fxRate: 100`
 * for a pence instrument in a sterling account, treating the unit change as an
 * exchange rate, so the reciprocal 0.01 turns 9,678 GBX into the £96.78 that
 * actually left the wallet.
 *
 * An earlier version special-cased pence to `1`, on the strength of watching
 * the host normalise `GBX` by itself. It does — but only on `activities.create`,
 * where the currency arrives inside an asset. The import path this addon uses
 * takes the row's currency at face value, so a rate of 1 charged every London
 * trade a hundred times over: an account whose cash should have been £182 came
 * out at minus £270,749.
 */
function hostFxRate(_currency: string | undefined, t212Rate: number | undefined): number | undefined {
  if (!t212Rate) return undefined;
  return 1 / t212Rate;
}

/**
 * The market identifier code for an instrument's venue, where we have one.
 *
 * Resolved through the instrument's working schedule to a Trading 212 exchange
 * name, then through `EXCHANGE_MIC`. Returns undefined rather than a guess for
 * venues with no MIC — over-the-counter chiefly — because a wrong code sends
 * the lookup somewhere the instrument certainly is not.
 */
function micFor(ticker: string, asset: T212Asset | undefined): string | undefined {
  // The live catalogue when something fetched it, otherwise the captured one.
  // Both are Trading 212's own answer; neither is inferred from the ticker.
  const name = asset?.exchange?.name;
  if (name) return EXCHANGE_MIC[name] || undefined;
  return exchangeMicFor(ticker);
}

/**
 * Trading 212's opaque ticker to a symbol Wealthfolio can resolve.
 *
 * The order and its reasoning live in `symbols.ts`. Only the derived case is
 * reported here, once per instrument, because it is the one that can be wrong
 * without anything failing.
 */
function symbolFor(ticker: string, context: Context): string {
  const { symbol, source } = resolveSymbol(
    ticker,
    context.assets.get(ticker),
    context.overrides,
    context.searched,
  );

  if (source === 'unknown' && !context.symbolWarned.has(ticker)) {
    context.symbolWarned.add(ticker);
    context.warn(
      `${ticker}: Trading 212's catalogue has no entry for this ticker, so no symbol is known ` +
        'for it. Run `pnpm symbols:generate` to refresh the table, or set the symbol under ' +
        'Symbols. The raw ticker was sent, which Wealthfolio will reject rather than mis-resolve.',
    );
  }

  return symbol;
}

/**
 * The Trading 212 identity of a trade, and the arithmetic behind it.
 *
 * Carrying the rate and the wallet impact makes an imported row auditable
 * against the broker without going back to the API.
 */
function describeTrade(order: Order, fill: Fill, ticker: string): string {
  const wallet = fill.walletImpact;
  return (
    `t212:order:${order.id}:fill:${fill.id} ticker=${ticker}` +
    (order.instrument?.isin ? ` isin=${order.instrument.isin}` : '') +
    (wallet ? ` t212FxRate=${wallet.fxRate} netValue=${wallet.netValue}${wallet.currency}` : '')
  );
}
