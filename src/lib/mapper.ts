import type { ActivityImport } from '@wealthfolio/addon-sdk';
import type { HistoricalOrder, Tax, TaxName, TradableInstrument } from 't212-sdk';
import { SYMBOL_OVERRIDES } from '../config';

/**
 * Trading 212 fills → Wealthfolio activities.
 *
 * This is the part `t212-sdk` cannot do for us: it encodes how Wealthfolio
 * models a transaction, not how Trading 212 reports one. Pure and synchronous
 * — no I/O, no host calls.
 */

/**
 * Charges Trading 212 reports per fill, split the way Wealthfolio models them:
 * `fee` is broker/venue cost, `tax` is government-imposed. Anything not listed
 * is counted as a fee and reported, so a new charge type can never silently
 * vanish from the cost basis.
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

export function mapOrdersToActivities(
  entries: HistoricalOrder[],
  accountId: string,
  /**
   * Trading 212's instrument catalogue, keyed by ticker. Its `ticker` is an
   * opaque id (`AAPL_US_EQ`) with no published grammar, so the catalogue is
   * the only sound way to get a real symbol out of one.
   */
  instruments: Map<string, TradableInstrument> = new Map(),
): MapResult {
  const activities: ActivityImport[] = [];
  const issues: MappingIssue[] = [];
  const skip = (message: string) => issues.push({ kind: 'skipped', message });
  const warn = (message: string) => issues.push({ kind: 'warning', message });

  entries.forEach((entry, index) => {
    const { order, fill } = entry;

    // The API schema marks both `order` and `fill` optional, and history
    // includes orders that never filled (cancelled, rejected). Neither can be
    // dereferenced without checking.
    if (!order) {
      skip('A history entry had no order attached.');
      return;
    }

    const label = `${order.ticker} (order ${order.id})`;

    if (!fill) {
      skip(`${label}: not filled, status ${order.status ?? 'unknown'}.`);
      return;
    }
    // Corporate actions arrive on the same endpoint but are not trades. They
    // need SPLIT/DIVIDEND handling with their own rules, so this reports them
    // instead of forcing them into a BUY/SELL.
    if (fill.type !== 'TRADE') {
      skip(`${label}: fill type ${fill.type} is a corporate action, not a trade.`);
      return;
    }
    const quantity = Math.abs(fill.quantity);
    if (!(quantity > 0)) {
      skip(`${label}: fill quantity is ${fill.quantity}.`);
      return;
    }
    // The wallet currency is what actually moved through the account; the
    // order currency is the instrument's. Prefer the wallet, fall back.
    const currency = fill.walletImpact?.currency ?? order.currency;
    if (!currency) {
      skip(`${label}: no currency on either the fill or the order.`);
      return;
    }

    const ticker = order.instrument?.ticker ?? order.ticker;
    const catalogued = instruments.get(ticker)?.shortName?.trim();
    // Falling back to the raw Trading 212 ticker is deliberate: Wealthfolio
    // will fail to resolve it and say so, which beats inventing a symbol that
    // silently creates the wrong asset.
    const symbol = SYMBOL_OVERRIDES[ticker] ?? catalogued ?? ticker;
    const charges = splitCharges(fill.walletImpact?.taxes ?? [], currency, warn, label);

    if (!SYMBOL_OVERRIDES[ticker] && !catalogued) {
      warn(
        `${label}: not in the instrument catalogue, so the raw ticker was used as the symbol. Add "${ticker}" to SYMBOL_OVERRIDES in config.ts.`,
      );
    }
    if (!order.side) {
      warn(`${label}: no side reported, treated as a BUY.`);
    }

    activities.push({
      accountId,
      activityType: order.side === 'SELL' ? 'SELL' : 'BUY',
      date: fill.filledAt,
      symbol,
      symbolName: order.instrument?.name,
      quantity,
      unitPrice: fill.price,
      currency,
      fee: charges.fee,
      tax: charges.tax,
      // 1 when the trade settled in the account currency; kept so Wealthfolio
      // can reconcile cross-currency trades.
      fxRate: fill.walletImpact?.fxRate,
      // The Trading 212 identity of the row: traces an activity back to the
      // exact fill, and gives duplicate detection a stable key on re-import.
      comment: `t212:order=${order.id} fill=${fill.id} ticker=${ticker}${
        order.instrument?.isin ? ` isin=${order.instrument.isin}` : ''
      }`,
      lineNumber: index + 1,
      // The host decides validity in checkImport(); these are the neutral
      // starting values it expects on an unvalidated row.
      isValid: true,
      isDraft: false,
    });
  });

  return { activities, issues };
}

function splitCharges(
  taxes: Tax[],
  currency: string,
  warn: (message: string) => void,
  label: string,
): { fee: number; tax: number } {
  let fee = 0;
  let tax = 0;

  for (const charge of taxes) {
    const amount = Math.abs(charge.quantity ?? 0);
    if (amount === 0) continue;

    // Summing across currencies would quietly corrupt the cost basis, so
    // mismatches are reported rather than converted.
    if (charge.currency && charge.currency !== currency) {
      warn(
        `${label}: ${charge.name} of ${amount} ${charge.currency} was left out of fee/tax, which is in ${currency}. Check the cost basis.`,
      );
      continue;
    }

    if (TAX_CHARGES.includes(charge.name)) {
      tax += amount;
    } else {
      if (!FEE_CHARGES.includes(charge.name)) {
        warn(`${label}: unrecognised charge ${charge.name} counted as a fee.`);
      }
      fee += amount;
    }
  }

  return { fee: round(fee), tax: round(tax) };
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
