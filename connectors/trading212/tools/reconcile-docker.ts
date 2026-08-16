/**
 * Replay a Trading 212 ledger into the Docker Wealthfolio and see if the cash
 * balance comes out the same.
 *
 * Cash is the sharpest test of the mapping. It depends on nothing but the
 * ledger — every deposit, trade, charge, dividend and interest payment, each in
 * the currency it happened in — and Trading 212 tells us what the answer should
 * be. Market value, by contrast, depends on Wealthfolio resolving symbols and
 * fetching prices, so it is reported but not treated as a verdict.
 *
 *   pnpm smoke:live -- --full --json=full.json   # capture a ledger first
 *   pnpm reconcile -- --dataset=full.json
 *   pnpm reconcile -- --dataset=full.json --keep  # leave the account behind
 *
 * This talks to the container's REST API, not to the addon host, so it proves
 * the *numbers* rather than the addon's plumbing. The activities it writes come
 * from the same `mapDataset` the addon uses; only the transport differs.
 */

import { readFileSync } from 'node:fs';
import type { ActivityImport } from '@wealthfolio/addon-sdk';
import { buildAssetIndex } from '../src/lib/extract';
import type { T212Dataset } from '../src/lib/extract';
import { mapDataset } from '../src/lib/mapper';

const BASE = process.env.WF_URL ?? 'http://127.0.0.1:8088';
const BATCH = 100;

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const match = args.find((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
  if (match === undefined) return undefined;
  return match.includes('=') ? match.slice(match.indexOf('=') + 1) : '';
};

const datasetPath = flag('dataset');
if (!datasetPath) {
  console.error('Pass --dataset=<path>, produced by: pnpm smoke:live -- --full --json=<path>');
  process.exit(1);
}
const keep = flag('keep') !== undefined;

// ─────────────────────────────────────────────────────────────────────────────

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${text.slice(0, 300)}`);
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

/**
 * `ActivityImport` (what the addon hands the host) to `ActivityCreate` (what
 * the REST API takes). The host normally does this itself during an import;
 * here it is done by hand because we are going in the back door.
 *
 * `quoteCcy` carries the row's currency so the host can recognise pence and
 * normalise it — the behaviour the whole mapping contract leans on.
 */
function toCreate(row: ActivityImport, accountId: string) {
  return {
    accountId,
    activityType: row.activityType,
    activityDate: row.date,
    ...(row.symbol
      ? {
          asset: {
            symbol: row.symbol,
            quoteCcy: row.currency,
            name: row.symbolName,
            ...(row.exchangeMic ? { exchangeMic: row.exchangeMic } : {}),
          },
        }
      : {}),
    quantity: row.quantity ?? null,
    unitPrice: row.unitPrice ?? null,
    amount: row.amount ?? null,
    currency: row.currency,
    fee: row.fee ?? null,
    tax: row.tax ?? null,
    fxRate: row.fxRate ?? null,
    comment: row.comment ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

const dataset = JSON.parse(readFileSync(datasetPath, 'utf-8')) as T212Dataset;
if (!dataset.summary) {
  console.error('That dataset has no account summary, so there is nothing to reconcile against.');
  process.exit(1);
}

const { summary } = dataset;
const expectedCash =
  summary.cash.availableToTrade + summary.cash.reservedForOrders + summary.cash.inPies;

console.log(`Trading 212 account ${summary.id} (${summary.currency})`);
console.log(`  cash          ${expectedCash.toFixed(2)}`);
console.log(`  investments   ${summary.investments.currentValue.toFixed(2)}`);
console.log(`  total         ${summary.totalValue.toFixed(2)}`);

const truncated = dataset.stats.filter((stat) => stat.truncated).map((stat) => stat.stream);
if (truncated.length > 0) {
  console.log(
    `\n  WARNING: ${truncated.join(', ')} truncated. Cash cannot reconcile from a partial\n` +
      '  ledger — re-extract with --full for a meaningful result.',
  );
}

const assets = buildAssetIndex(dataset);
const { activities, issues } = mapDataset(dataset, 'pending', assets);
console.log(`\nMapped ${activities.length} activities, ${issues.length} issues.`);

const account = await api<{ id: string; name: string }>('POST', '/accounts', {
  name: `T212 reconcile ${new Date().toISOString().slice(0, 19)}`,
  accountType: 'SECURITIES',
  currency: summary.currency,
  isDefault: false,
  isActive: true,
  trackingMode: 'TRANSACTIONS',
  group: 'Reconciliation',
});
console.log(`Created ${account.name} (${account.id})`);

let created = 0;
const errors: string[] = [];
for (let index = 0; index < activities.length; index += BATCH) {
  const batch = activities.slice(index, index + BATCH).map((row) => toCreate(row, account.id));
  const result = await api<{ created: unknown[]; errors: unknown[] }>(
    'POST',
    '/activities/bulk',
    { creates: batch },
  );
  created += result.created.length;
  for (const error of result.errors) errors.push(JSON.stringify(error).slice(0, 200));
  process.stdout.write(`\r  written ${created}/${activities.length}`.padEnd(40));
}
console.log();

if (errors.length > 0) {
  console.log(`\n  ${errors.length} row(s) rejected:`);
  for (const error of errors.slice(0, 8)) console.log(`    ${error}`);
}

interface Holding {
  holdingType: string;
  quantity: number;
  instrument?: { symbol: string; currency?: string } | null;
  marketValue?: { local: number; base: number } | null;
  price?: number | null;
}

// `recalculate` returns 202 and finishes in the background, so the answer is
// not ready when the call returns. A thousand activities take appreciably
// longer than the handful this was first tried with.
await api('POST', '/portfolio/recalculate');
process.stdout.write('  recalculating');

let holdings: Holding[] = [];
for (let attempt = 0; attempt < 30; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 4000));
  holdings = await api<Holding[]>('GET', `/holdings?accountId=${account.id}`);
  if (holdings.length > 0) break;
  process.stdout.write('.');
}
console.log(holdings.length > 0 ? ' done' : ' gave up waiting');
const cash = holdings.find((holding) => holding.holdingType === 'cash');
const securities = holdings.filter((holding) => holding.holdingType !== 'cash');
const priced = securities.filter((holding) => (holding.price ?? 0) > 0);
const securitiesValue = securities.reduce(
  (total, holding) => total + (holding.marketValue?.base ?? 0),
  0,
);

const actualCash = cash?.quantity ?? 0;
const drift = actualCash - expectedCash;

console.log('\nCash (the ledger alone decides this)');
console.log(`  Trading 212   ${expectedCash.toFixed(2)} ${summary.currency}`);
console.log(`  Wealthfolio   ${actualCash.toFixed(2)} ${summary.currency}`);
console.log(
  `  drift         ${drift.toFixed(2)}   ${
    Math.abs(drift) < 0.02 ? 'RECONCILES' : '← investigate'
  }`,
);

console.log('\nSecurities (needs Wealthfolio to resolve symbols and fetch prices)');
console.log(`  positions     ${securities.length}, of which ${priced.length} priced`);
console.log(`  market value  ${securitiesValue.toFixed(2)} ${summary.currency}`);
console.log(`  Trading 212   ${summary.investments.currentValue.toFixed(2)} ${summary.currency}`);

const unpriced = securities.filter((holding) => !((holding.price ?? 0) > 0));
if (unpriced.length > 0) {
  console.log(`\n  Unpriced (symbol did not resolve): ${unpriced.length}`);
  console.log(
    '    ' + unpriced.slice(0, 15).map((holding) => holding.instrument?.symbol).join(' '),
  );
}

if (keep) {
  console.log(`\nAccount kept: ${BASE} → ${account.name}`);
} else {
  await api('DELETE', `/accounts/${account.id}`);
  console.log('\nProbe account deleted. Pass --keep to inspect it in the UI instead.');
}

process.exit(Math.abs(drift) < 0.02 ? 0 : 1);
