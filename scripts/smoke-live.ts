/**
 * Real-credential smoke test.
 *
 * Fill in `DEV_CREDENTIALS` in src/config.ts, then `pnpm smoke:live`. It makes
 * the same two reads the addon makes and maps the result with the same mapper,
 * then prints what would be imported. Nothing is written anywhere: Wealthfolio
 * is not involved, and no Trading 212 order is placed or changed.
 *
 * Out here `t212-sdk` is used exactly as documented — Node has a real `fetch`,
 * so no broker adapter is needed.
 */

import { T212 } from 't212-sdk';
import type { HistoricalOrder, TradableInstrument } from 't212-sdk';
import { DEV_CREDENTIALS, T212_ENVIRONMENT } from '../src/config';
import { mapOrdersToActivities } from '../src/lib/mapper';

const { apiKey, apiSecret } = DEV_CREDENTIALS;
if (!apiKey || !apiSecret) {
  console.error('Set DEV_CREDENTIALS in src/config.ts first.');
  process.exit(1);
}

const client = new T212({ apiKey, apiSecret, environment: T212_ENVIRONMENT });

console.log(`Trading 212: ${T212_ENVIRONMENT}\n`);

const summary = await client.account.getSummary();
console.log('Account summary');
console.log(`  account       ${summary.id}`);
console.log(`  free cash     ${summary.cash.availableToTrade} ${summary.currency}`);
console.log(`  investments   ${summary.investments.currentValue} ${summary.currency}`);
console.log(`  total value   ${summary.totalValue} ${summary.currency}\n`);

const entries: HistoricalOrder[] = [];
for await (const page of client.history.ordersPages()) {
  entries.push(...page.items);
  break; // one page is enough to see the shape
}

const list = await client.instruments.list();
const instruments = new Map<string, TradableInstrument>(
  list.map((item) => [item.ticker, item]),
);

// What the catalogue actually says about the instruments in your history —
// the check that decides whether `shortName` is a usable symbol.
console.log('Instrument catalogue (ticker → shortName / isin / currency / type):');
const seen = new Set<string>();
for (const { order } of entries) {
  const ticker = order?.instrument?.ticker ?? order?.ticker;
  if (!ticker || seen.has(ticker)) continue;
  seen.add(ticker);
  const found = instruments.get(ticker);
  console.log(
    found
      ? `  ${ticker.padEnd(14)} ${String(found.shortName).padEnd(10)} ${found.isin}  ` +
          `${found.currencyCode}  ${found.type}`
      : `  ${ticker.padEnd(14)} NOT IN CATALOGUE`,
  );
}
console.log(`  (${instruments.size} instruments indexed)\n`);

const { activities, issues } = mapOrdersToActivities(
  entries,
  '<wealthfolio-account-id>',
  instruments,
);
console.log(`${entries.length} history entries → ${activities.length} activities\n`);

for (const activity of activities) {
  console.log(
    `  ${String(activity.date).slice(0, 10)}  ${activity.activityType.padEnd(4)}  ` +
      `${String(activity.symbol).padEnd(8)}  qty ${activity.quantity}  @ ${activity.unitPrice} ` +
      `${activity.currency}  fee ${activity.fee}  tax ${activity.tax}`,
  );
}

for (const issue of issues) {
  console.log(`  ${issue.kind}: ${issue.message}`);
}

// Settles which currency `fill.price` is quoted in — see the currency note in
// the README. If price x quantity x fxRate matches the wallet's netValue, the
// price is in the instrument's currency and the mapper's `currency` is wrong.
console.log('\nCurrency check (price x qty x fxRate vs wallet netValue):');
for (const { order, fill } of entries.slice(0, 5)) {
  if (!order || !fill || fill.type !== 'TRADE') continue;
  const gross = Math.abs(fill.price * fill.quantity);
  const wallet = fill.walletImpact;
  console.log(
    `  ${order.ticker.padEnd(12)} gross ${gross.toFixed(2)}  ` +
      `xFx ${(gross * (wallet?.fxRate ?? 1)).toFixed(2)}  ` +
      `netValue ${Math.abs(wallet?.netValue ?? 0).toFixed(2)} ${wallet?.currency ?? '?'}`,
  );
}

console.log('\nNothing was written. This script only reads.');
