/**
 * Real-credential extraction smoke test.
 *
 * Fill in `DEV_CREDENTIALS` in src/config.ts, then `pnpm smoke:live`. It drives
 * `src/lib/extract.ts` — the same module, the same calls, the same order the
 * addon uses inside Wealthfolio — and prints everything Trading 212 hands back:
 * the ledger with its source ids, every instrument the account has touched,
 * current prices, and the reconciliation checks that decide whether a
 * Wealthfolio account could ever show the same total.
 *
 * Out here `t212-sdk` runs on Node's real `fetch`; in the addon the same client
 * runs on the brokered one. Nothing else differs.
 *
 * Every call is a GET. Wealthfolio is not involved and no order is placed,
 * amended or cancelled.
 *
 *   pnpm smoke:live                     # 200 items per history stream
 *   pnpm smoke:live -- --full           # walk the whole history
 *   pnpm smoke:live -- --max-items=50
 *   pnpm smoke:live -- --streams=summary,positions,instruments
 *   pnpm smoke:live -- --json=out.json  # dump the raw dataset
 */

import { writeFileSync } from 'node:fs';
import { T212 } from 't212-sdk';
import { DEV_CREDENTIALS, HISTORY_PAGE_LIMIT, MAX_HISTORY_ITEMS, T212_ENVIRONMENT } from '../src/config';
import {
  ALL_STREAMS,
  buildAssetIndex,
  checkAccountValue,
  checkFillPricing,
  checkPositionPricing,
  createRawGet,
  extractAll,
  findDuplicateSourceIds,
  isKnownTransactionType,
  toEvents,
} from '../src/lib/extract';
import { mapDataset } from '../src/lib/mapper';
import type {
  FillPricingVerdict,
  PricingVerdict,
  Stream,
  T212Asset,
  T212Event,
} from '../src/lib/extract';

// ─────────────────────────────────────────────────────────────────────────────
//  Options
// ─────────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const match = args.find((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
  if (match === undefined) return undefined;
  return match.includes('=') ? match.slice(match.indexOf('=') + 1) : '';
};

const maxItems = flag('full') !== undefined ? Infinity : Number(flag('max-items') || MAX_HISTORY_ITEMS);
const pageLimit = Number(flag('page-limit') || HISTORY_PAGE_LIMIT);
const jsonPath = flag('json');
const streams = (flag('streams')?.split(',').filter(Boolean) ?? ALL_STREAMS) as readonly Stream[];

const unknownStreams = streams.filter((stream) => !ALL_STREAMS.includes(stream));
if (unknownStreams.length > 0) {
  console.error(`Unknown stream(s): ${unknownStreams.join(', ')}`);
  console.error(`Available: ${ALL_STREAMS.join(', ')}`);
  process.exit(1);
}

const { apiKey, apiSecret } = DEV_CREDENTIALS;
if (!apiKey || !apiSecret) {
  console.error('Set DEV_CREDENTIALS in src/config.ts first.');
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Extract
// ─────────────────────────────────────────────────────────────────────────────

// Both transports the extractor needs. Inside the addon these are built over
// Wealthfolio's network broker instead; nothing else about the run differs.
const source = {
  client: new T212({ apiKey, apiSecret, environment: T212_ENVIRONMENT }),
  rawGet: createRawGet({
    environment: T212_ENVIRONMENT,
    headers: {
      Authorization: `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString('base64')}`,
    },
  }),
};

heading('Extraction');
console.log(`  environment   ${T212_ENVIRONMENT}`);
console.log(`  streams       ${streams.join(', ')}`);
console.log(`  max items     ${maxItems === Infinity ? 'unlimited' : maxItems} per history stream`);
console.log(`  page limit    ${pageLimit}\n`);

const startedAt = Date.now();
const dataset = await extractAll(source, {
  streams,
  maxItemsPerStream: maxItems,
  pageLimit,
  // The SDK sleeps between requests to respect the rate limit, so a full walk
  // looks hung without this.
  onProgress: (event) => process.stdout.write(`\r  ${event.stream}: ${event.message}`.padEnd(78)),
});
process.stdout.write('\r'.padEnd(80) + '\r');

console.log(`  ${'stream'.padEnd(14)}${'items'.padStart(7)}${'pages'.padStart(7)}${'time'.padStart(9)}   note`);
for (const stat of dataset.stats) {
  const note = stat.skipped
    ? 'skipped'
    : stat.error
      ? `FAILED — ${stat.error}`
      : stat.truncated
        ? 'truncated (more history available)'
        : '';
  console.log(
    `  ${stat.stream.padEnd(14)}${String(stat.items).padStart(7)}${String(stat.pages || '').padStart(7)}` +
      `${(stat.elapsedMs / 1000).toFixed(1).padStart(8)}s   ${note}`,
  );
}
console.log(`\n  total ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

const failed = dataset.stats.filter((stat) => stat.error);

// ─────────────────────────────────────────────────────────────────────────────
//  Account summary and value reconciliation
// ─────────────────────────────────────────────────────────────────────────────

const value = checkAccountValue(dataset);
if (dataset.summary && value) {
  heading('Account');
  const { summary } = dataset;
  console.log(`  account id    ${summary.id}`);
  console.log(`  currency      ${summary.currency}`);
  console.log(`  free cash     ${money(summary.cash.availableToTrade)}`);
  console.log(`  reserved      ${money(summary.cash.reservedForOrders)}`);
  console.log(`  in pies       ${money(summary.cash.inPies)}`);
  console.log(`  invested      ${money(summary.investments.totalCost)}`);
  console.log(`  current value ${money(summary.investments.currentValue)}`);
  console.log(`  unrealised    ${money(summary.investments.unrealizedProfitLoss)}`);
  console.log(`  realised      ${money(summary.investments.realizedProfitLoss)}`);
  console.log(`  TOTAL VALUE   ${money(summary.totalValue)}`);

  // The figure goal 2 has to reproduce. Worth knowing it reconciles on
  // Trading 212's own numbers before asking Wealthfolio to match it.
  heading('Value reconciliation (positions + cash vs reported total)');
  console.log(`  positions     ${money(value.positionsValue)}   (summed from /equity/positions)`);
  console.log(`  investments   ${money(value.reportedInvestments)}   (summary.investments.currentValue)`);
  console.log(`  cash          ${money(value.cash)}`);
  console.log(`  reported      ${money(value.reportedTotal)}`);
  console.log(
    `  residual      ${money(value.residual)}   ${
      Math.abs(value.residual) < 0.02 ? 'reconciles' : '← does not reconcile, investigate before mapping'
    }`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Ledger and identity
// ─────────────────────────────────────────────────────────────────────────────

const { events, undated } = toEvents(dataset);
const duplicates = findDuplicateSourceIds(events);

heading('Ledger');
console.log(`  ${events.length} dated events` + (undated.length > 0 ? `, ${undated.length} undated` : ''));
if (events.length > 0) {
  console.log(`  ${events[0]!.occurredAt.slice(0, 10)} → ${events.at(-1)!.occurredAt.slice(0, 10)}`);
}
for (const kind of ['order', 'dividend', 'transaction'] as const) {
  console.log(`    ${kind.padEnd(12)} ${events.filter((event) => event.kind === kind).length}`);
}

console.log(
  `\n  source id uniqueness: ${
    duplicates.size === 0
      ? `OK — ${events.length} events, ${events.length} distinct ids`
      : `FAILED — ${duplicates.size} id(s) reused`
  }`,
);
for (const [sourceId, count] of [...duplicates].slice(0, 10)) {
  console.log(`    ${sourceId} x${count}`);
}
if (undated.length > 0) {
  console.log(`\n  Undated events (no usable timestamp, excluded from the replay):`);
  for (const event of undated.slice(0, 10)) {
    console.log(`    ${event.sourceId}`);
  }
}

heading('Ledger sample (oldest 5, newest 5)');
const sample = events.length <= 10 ? events : [...events.slice(0, 5), ...events.slice(-5)];
for (const event of sample) {
  console.log(`  ${event.occurredAt.slice(0, 19).padEnd(20)} ${describeEvent(event)}`);
  console.log(`  ${' '.repeat(20)} ${event.sourceId}`);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Type census — the input to the mapping table
// ─────────────────────────────────────────────────────────────────────────────

heading('Event type census');
console.log('  Order fills by type and side — anything other than TRADE needs a corporate-action mapping:');
census(
  dataset.orders.map(({ order, fill }) =>
    fill
      ? `${fill.type} ${order?.side ?? 'no-side'}`
      : `unfilled (${order?.status ?? 'unknown status'})`,
  ),
);

// t212-sdk's `TransactionType` union is incomplete, so anything outside it is
// flagged rather than trusted — an unrecognised type here means a cash
// movement the mapper does not yet know how to place.
console.log('\n  Transactions by type:');
census(
  dataset.transactions.map((item) =>
    isKnownTransactionType(item.type) ? item.type : `${item.type}  ← unrecognised`,
  ),
);

console.log('\n  Dividends by type:');
census(dataset.dividends.map((item) => item.type));

console.log('\n  Charges seen on fills (fee vs tax split):');
census(
  dataset.orders.flatMap(({ fill }) =>
    (fill?.walletImpact?.taxes ?? []).map((charge) => `${charge.name} (${charge.currency})`),
  ),
);

// ─────────────────────────────────────────────────────────────────────────────
//  Assets
// ─────────────────────────────────────────────────────────────────────────────

const assets = buildAssetIndex(dataset);
const held = [...assets.values()].filter((asset) => asset.position);
const historic = [...assets.values()].filter((asset) => !asset.position);

heading(`Assets (${assets.size} touched: ${held.length} held, ${historic.length} history only)`);
console.log(
  `  ${'ticker'.padEnd(15)}${'symbol'.padEnd(10)}${'isin'.padEnd(14)}${'ccy'.padEnd(5)}` +
    `${'type'.padEnd(9)}${'qty'.padStart(12)}${'avg'.padStart(11)}${'price'.padStart(11)}  exchange`,
);
for (const asset of [...held, ...historic]) {
  console.log(
    `  ${asset.ticker.padEnd(15)}${(asset.shortName ?? '—').padEnd(10)}${(asset.isin ?? '—').padEnd(14)}` +
      `${(asset.currency ?? '—').padEnd(5)}${(asset.type ?? '—').padEnd(9)}` +
      `${num(asset.position?.quantity).padStart(12)}${num(asset.position?.averagePricePaid).padStart(11)}` +
      `${num(asset.price?.value).padStart(11)}  ${asset.exchange?.name ?? '—'}`,
  );
}

const uncatalogued = [...assets.values()].filter((asset) => !asset.inCatalogue);
console.log(
  `\n  Catalogue coverage: ${assets.size - uncatalogued.length}/${assets.size} instruments resolved`,
);
for (const asset of uncatalogued) {
  console.log(
    `    ${asset.ticker.padEnd(15)} NOT IN CATALOGUE — ${asset.counts.orders} order(s), ` +
      `${asset.counts.dividends} dividend(s). Needs a SYMBOL_OVERRIDES entry.`,
  );
}

heading('Full metadata for one held asset (everything Trading 212 offers)');
const specimen = held[0] ?? historic[0];
if (specimen) {
  console.log(JSON.stringify(withoutUndefined(specimen), null, 2).split('\n').map((line) => `  ${line}`).join('\n'));
}

// ─────────────────────────────────────────────────────────────────────────────
//  Prices
// ─────────────────────────────────────────────────────────────────────────────

const priceChecks = checkPositionPricing(dataset, assets);
const byVerdict = (verdict: PricingVerdict) => priceChecks.filter((check) => check.verdict === verdict);

heading('Price check (currentPrice x qty, in major units, vs the value Trading 212 reports)');
console.log(`  ok             ${byVerdict('ok').length}  quote and reported value agree in ${dataset.summary?.currency ?? 'the account currency'}`);
console.log(`  minor-units    ${byVerdict('minor-units').length}  quoted in pence; agree once divided by 100`);
console.log(`  cross-currency ${byVerdict('cross-currency').length}  ratio is the implied FX rate, not checkable here`);
console.log(`  mismatch       ${byVerdict('mismatch').length}  unexplained — must not reach Wealthfolio as-is`);

// The rows that prove the scaling rule, and the rows that break it. The
// cross-currency majority is noise here.
const notable = [...byVerdict('minor-units'), ...byVerdict('mismatch'), ...byVerdict('ok').slice(0, 3)];
if (notable.length > 0) {
  console.log(
    `\n  ${'ticker'.padEnd(15)}${'quoted'.padStart(14)}${'ccy'.padStart(5)}${'major'.padStart(12)}` +
      `${'reported'.padStart(12)}${'ccy'.padStart(5)}${'ratio'.padStart(9)}  verdict`,
  );
  for (const check of notable) {
    console.log(
      `  ${check.ticker.padEnd(15)}${check.quoted.toFixed(2).padStart(14)}${check.quoteCurrency.padStart(5)}` +
        `${check.quotedMajor.toFixed(2).padStart(12)}${check.reported.toFixed(2).padStart(12)}` +
        `${check.accountCurrency.padStart(5)}${check.ratio.toFixed(4).padStart(9)}  ${check.verdict}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Fill pricing — what `fill.price` is denominated in, and how `fxRate` applies
// ─────────────────────────────────────────────────────────────────────────────

const fillChecks = checkFillPricing(dataset, assets);
if (fillChecks.length > 0) {
  const byFillVerdict = (verdict: FillPricingVerdict) =>
    fillChecks.filter((check) => check.verdict === verdict);

  heading('Fill pricing (gross / fxRate vs the wallet impact)');
  console.log('  Tests two claims the mapper depends on: fill.price is quoted in the instrument\'s');
  console.log('  currency, and fxRate divides rather than multiplies.\n');
  console.log(`  exact            ${byFillVerdict('exact').length}  lands on the wallet impact outright`);
  console.log(`  charges-explain  ${byFillVerdict('charges-explain').length}  lands there once the fill's own charges are applied`);
  console.log(`  unexplained      ${byFillVerdict('unexplained').length}  cost basis not reproducible — do not import as-is`);

  const sameCcy = fillChecks.filter((check) => check.quoteCurrency === check.walletCurrency);
  const pence = fillChecks.filter((check) => check.quoteCurrency === 'GBX');
  const crossCcy = fillChecks.filter(
    (check) => check.quoteCurrency !== check.walletCurrency && check.quoteCurrency !== 'GBX',
  );
  console.log(
    `\n  ${sameCcy.length} fills quoted in the account currency, ${pence.length} in pence, ${crossCcy.length} in another currency.`,
  );
  console.log(
    `  Pence fills report fxRate ${[...new Set(pence.map((check) => check.fxRate))].join(', ') || '—'}` +
      ' — Trading 212 models minor units as an FX rate.',
  );

  const specimens = [sameCcy[0], pence[0], crossCcy[0], ...byFillVerdict('unexplained').slice(0, 3)].filter(
    (check): check is NonNullable<typeof check> => check !== undefined,
  );
  console.log(
    `\n  ${'ticker'.padEnd(14)}${'ccy'.padStart(4)}${'price'.padStart(11)}${'qty'.padStart(10)}` +
      `${'gross'.padStart(12)}${'fxRate'.padStart(11)}${'/fxRate'.padStart(11)}${'net'.padStart(11)}` +
      `${'charges'.padStart(9)}  verdict`,
  );
  for (const check of specimens) {
    console.log(
      `  ${check.ticker.padEnd(14)}${check.quoteCurrency.padStart(4)}${String(check.price).padStart(11)}` +
        `${String(check.quantity).padStart(10)}${check.gross.toFixed(2).padStart(12)}` +
        `${String(check.fxRate).padStart(11)}${check.converted.toFixed(2).padStart(11)}` +
        `${check.netValue.toFixed(2).padStart(11)}${check.charges.toFixed(2).padStart(9)}  ${check.verdict}`,
    );
  }
}

const sampleFx = byVerdict('cross-currency').slice(0, 4);
if (sampleFx.length > 0) {
  console.log('\n  Implied FX rates (cross-currency sample):');
  for (const check of sampleFx) {
    console.log(
      `    ${check.ticker.padEnd(15)} ${check.majorCurrency}/${check.accountCurrency} ≈ ${check.ratio.toFixed(4)}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Known gaps
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
//  Mapping
// ─────────────────────────────────────────────────────────────────────────────

const mapped = mapDataset(dataset, '<wealthfolio-account-id>', assets);
heading(`Mapping (${events.length} events → ${mapped.activities.length} activities)`);

const byType = new Map<string, number>();
for (const row of mapped.activities) {
  byType.set(row.activityType, (byType.get(row.activityType) ?? 0) + 1);
}
for (const [type, count] of [...byType].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${type.padEnd(14)} ${count}`);
}

// Every row keeps the currency it was quoted or charged in — the whole point
// of the contract, so it is worth seeing rather than trusting.
const currencies = new Map<string, number>();
for (const row of mapped.activities) {
  const key = `${row.activityType} in ${row.currency ?? '—'}`;
  currencies.set(key, (currencies.get(key) ?? 0) + 1);
}
console.log('\n  Currencies as recorded (nothing is converted):');
for (const [key, count] of [...currencies].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`    ${key.padEnd(28)} ${count}`);
}

console.log('\n  Sample rows:');
const sampleRows = [
  mapped.activities.find((row) => row.activityType === 'BUY' && row.currency === 'GBX'),
  mapped.activities.find((row) => row.activityType === 'BUY' && row.currency === 'USD'),
  mapped.activities.find((row) => row.activityType === 'FEE'),
  mapped.activities.find((row) => row.activityType === 'DIVIDEND'),
  mapped.activities.find((row) => row.activityType === 'DEPOSIT'),
  mapped.activities.find((row) => row.activityType === 'INTEREST'),
].filter((row): row is NonNullable<typeof row> => row !== undefined);
for (const row of sampleRows) {
  console.log(
    `    ${String(row.date).slice(0, 10)}  ${row.activityType.padEnd(9)} ${String(row.symbol ?? '—').padEnd(9)}` +
      ` qty ${String(row.quantity ?? '—').padEnd(12)} @ ${String(row.unitPrice ?? '—').padEnd(9)}` +
      ` amt ${String(row.amount ?? '—').padEnd(8)} ${(row.currency ?? '—').padEnd(4)}` +
      ` fx ${row.fxRate ?? '—'}`,
  );
}

// The reciprocal is the one place a number is transformed, so it gets checked
// against the source rate it came from.
const fxRows = mapped.activities.filter(
  (row) => typeof row.fxRate === 'number' && row.fxRate !== 1,
);
console.log(
  `\n  fxRate: ${fxRows.length} rows carry a converted rate, ${
    mapped.activities.filter((row) => row.fxRate === 1).length
  } carry 1 (pence, handled by the host).`,
);

if (mapped.issues.length > 0) {
  const skipped = mapped.issues.filter((issue) => issue.kind === 'skipped');
  const warnings = mapped.issues.filter((issue) => issue.kind === 'warning');
  console.log(`\n  ${skipped.length} skipped, ${warnings.length} warnings:`);
  for (const issue of [...skipped.slice(0, 6), ...warnings.slice(0, 6)]) {
    console.log(`    ${issue.kind}: ${issue.message}`);
  }
}

heading('Coverage gaps (what this extraction cannot reach)');
console.log('  price history   no candles endpoint — currentPrice is a single live point per poll');
console.log('  pie attribution order history carries no pie id');
console.log(
  `  interest        reachable after all — ${
    dataset.transactions.filter((item) => item.type === 'INTEREST_ON_FREE_CASH').length
  } INTEREST_ON_FREE_CASH rows on /history/transactions, no CSV export needed`,
);

if (jsonPath !== undefined) {
  const path = jsonPath || 't212-dataset.json';
  writeFileSync(path, JSON.stringify(dataset, null, 2));
  console.log(`\nRaw dataset written to ${path}`);
}

console.log('\nNothing was written to Trading 212 or Wealthfolio. This script only reads.');
if (failed.length > 0) {
  console.error(`\n${failed.length} stream(s) failed: ${failed.map((stat) => stat.stream).join(', ')}`);
  process.exit(1);
}
if (duplicates.size > 0) {
  console.error('\nSource ids are not unique — duplicate detection would drop real rows.');
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Formatting
// ─────────────────────────────────────────────────────────────────────────────

function heading(title: string): void {
  console.log(`\n${title}\n${'─'.repeat(Math.max(title.length, 40))}`);
}

function money(amount: number): string {
  return `${amount.toFixed(2).padStart(14)} ${dataset.summary?.currency ?? ''}`;
}

function num(value: number | undefined): string {
  return value === undefined ? '—' : String(Number(value.toFixed(6)));
}

function census(values: string[]): void {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  if (counts.size === 0) {
    console.log('    (none)');
    return;
  }
  for (const [value, count] of [...counts].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${value.padEnd(34)} ${count}`);
  }
}

function describeEvent(event: T212Event): string {
  if (event.kind === 'order') {
    const { order, fill } = event.record;
    return fill
      ? `${(order?.side ?? '?').padEnd(4)} ${fill.type.padEnd(12)} ${String(event.ticker).padEnd(14)} ` +
          `qty ${fill.quantity} @ ${fill.price} ${order?.currency ?? ''}`
      : `ORDER ${order?.status ?? '?'} ${event.ticker}`;
  }
  if (event.kind === 'dividend') {
    const item = event.record;
    return `DIV  ${item.type.padEnd(12)} ${String(event.ticker).padEnd(14)} ${item.amount} ${item.currency}`;
  }
  const item = event.record;
  return `${item.type.padEnd(17)} ${' '.repeat(14)} ${item.amount} ${item.currency}`;
}

/**
 * Trim a `T212Asset` for printing: drop empty fields, and reduce the exchange
 * to its identity. Its `workingSchedules` carry every session open and close
 * for the coming weeks, which is hundreds of lines of noise here.
 */
function withoutUndefined(asset: T212Asset): Record<string, unknown> {
  const entries = Object.entries(asset).filter(([, value]) => value !== undefined);
  return Object.fromEntries(
    entries.map(([key, value]) =>
      key === 'exchange' && asset.exchange
        ? [
            key,
            {
              id: asset.exchange.id,
              name: asset.exchange.name,
              workingSchedules: `${asset.exchange.workingSchedules?.length ?? 0} schedules (elided)`,
            },
          ]
        : [key, value],
    ),
  );
}
