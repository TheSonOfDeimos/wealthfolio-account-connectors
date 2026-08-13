import type { ActivityImport } from '@wealthfolio/addon-sdk';
import { mapTicker } from './symbols';
import type { T212HistoricalOrder, T212Tax, T212TaxName } from './types';

/**
 * Charges Trading 212 reports per fill, split the way Wealthfolio models them:
 * `fee` is broker/venue cost, `tax` is government-imposed. Anything not listed
 * is counted as a fee and flagged, so a new charge type can never silently
 * vanish from the cost basis.
 */
const TAX_CHARGES = new Set<T212TaxName>([
  'STAMP_DUTY',
  'STAMP_DUTY_RESERVE_TAX',
  'FRENCH_TRANSACTION_TAX',
]);

const FEE_CHARGES = new Set<T212TaxName>([
  'COMMISSION_TURNOVER',
  'CURRENCY_CONVERSION_FEE',
  'FINRA_FEE',
  'PTM_LEVY',
  'TRANSACTION_FEE',
]);

export interface MapOptions {
  /** Wealthfolio account the activities belong to. */
  accountId: string;
}

/** A fill that was deliberately not turned into an activity. */
export interface SkippedFill {
  orderId: number;
  fillId: number;
  ticker: string;
  reason: string;
}

export interface MapResult {
  activities: ActivityImport[];
  skipped: SkippedFill[];
  /** Non-fatal observations worth showing before the user commits an import. */
  warnings: string[];
}

/**
 * Turn Trading 212 historical order fills into Wealthfolio import rows.
 *
 * Pure and synchronous: no I/O, no host calls. That is what makes the whole
 * pipeline testable without a running Wealthfolio.
 */
export function mapOrdersToActivities(
  orders: T212HistoricalOrder[],
  options: MapOptions,
): MapResult {
  const activities: ActivityImport[] = [];
  const skipped: SkippedFill[] = [];
  const warnings: string[] = [];

  orders.forEach((entry, index) => {
    const { order, fill } = entry;

    // Corporate actions arrive on the same endpoint but are not trades. They
    // need SPLIT/DIVIDEND handling with their own rules, so this hello-world
    // reports them instead of forcing them into a BUY/SELL.
    if (fill.type !== 'TRADE') {
      skipped.push({
        orderId: order.id,
        fillId: fill.id,
        ticker: order.ticker,
        reason: `fill type ${fill.type} is a corporate action, not a trade`,
      });
      return;
    }

    const quantity = Math.abs(fill.quantity);
    if (!(quantity > 0)) {
      skipped.push({
        orderId: order.id,
        fillId: fill.id,
        ticker: order.ticker,
        reason: `fill quantity is ${fill.quantity}`,
      });
      return;
    }

    // The wallet currency is what actually moved through the account; the
    // order currency is the instrument's. Prefer the wallet, fall back.
    const currency = fill.walletImpact?.currency ?? order.currency;
    const mapped = mapTicker(order.instrument?.ticker ?? order.ticker);
    const charges = splitCharges(fill.walletImpact?.taxes ?? [], currency);

    if (charges.foreignCurrencyCharges.length > 0) {
      const names = charges.foreignCurrencyCharges.join(', ');
      warnings.push(
        `Order ${order.id}: charges in a currency other than ${currency} were left out of fee/tax (${names}). Check the cost basis for this trade.`,
      );
    }
    if (charges.unknownCharges.length > 0) {
      warnings.push(
        `Order ${order.id}: unrecognised charge type(s) ${charges.unknownCharges.join(', ')} counted as fees.`,
      );
    }
    if (mapped.needsReview) {
      warnings.push(
        `Order ${order.id}: symbol "${mapped.symbol}" was guessed from Trading 212 ticker "${order.instrument?.ticker ?? order.ticker}". Add an entry to SYMBOL_OVERRIDES if it is wrong.`,
      );
    }

    activities.push({
      accountId: options.accountId,
      activityType: order.side === 'SELL' ? 'SELL' : 'BUY',
      date: fill.filledAt,
      symbol: mapped.symbol,
      symbolName: order.instrument?.name,
      quantity,
      unitPrice: fill.price,
      currency,
      fee: charges.fee,
      tax: charges.tax,
      // 1 when the trade settled in the account currency; kept so Wealthfolio
      // can reconcile cross-currency trades.
      fxRate: fill.walletImpact?.fxRate,
      // Carries the Trading 212 identity of the row. Lets you trace a
      // Wealthfolio activity back to the exact fill, and gives duplicate
      // detection something stable to look at on re-import.
      comment: buildComment(entry),
      lineNumber: index + 1,
      // The host decides validity in checkImport(); these are the neutral
      // starting values it expects on an unvalidated row.
      isValid: true,
      isDraft: false,
    });
  });

  return { activities, skipped, warnings };
}

interface SplitCharges {
  fee: number;
  tax: number;
  foreignCurrencyCharges: string[];
  unknownCharges: string[];
}

function splitCharges(taxes: T212Tax[], targetCurrency: string): SplitCharges {
  const result: SplitCharges = {
    fee: 0,
    tax: 0,
    foreignCurrencyCharges: [],
    unknownCharges: [],
  };

  for (const charge of taxes) {
    const amount = Math.abs(charge.quantity ?? 0);
    if (amount === 0) continue;

    // Summing across currencies would quietly corrupt the cost basis, so
    // mismatches are reported rather than converted.
    if (charge.currency && charge.currency !== targetCurrency) {
      result.foreignCurrencyCharges.push(`${charge.name} ${amount} ${charge.currency}`);
      continue;
    }

    if (TAX_CHARGES.has(charge.name)) {
      result.tax += amount;
    } else {
      if (!FEE_CHARGES.has(charge.name)) result.unknownCharges.push(charge.name);
      result.fee += amount;
    }
  }

  result.fee = round(result.fee);
  result.tax = round(result.tax);
  return result;
}

function buildComment(entry: T212HistoricalOrder): string {
  const { order, fill } = entry;
  const parts = [`t212:order=${order.id}`, `fill=${fill.id}`, `ticker=${order.ticker}`];
  if (order.instrument?.isin) parts.push(`isin=${order.instrument.isin}`);
  return parts.join(' ');
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
