/**
 * Replay a Kraken ledger into the Docker Wealthfolio and see if the balances
 * come out the same.
 *
 *   pnpm smoke:live -- --full --json=kraken-dataset.json
 *   pnpm reconcile -- --dataset=kraken-dataset.json
 *   pnpm reconcile -- --dataset=kraken-dataset.json --keep
 *
 * Balances are the sharpest test of the mapping, and a better one than the
 * Trading 212 connector gets. There, only cash could be checked, because
 * Trading 212 reports positions but not the arithmetic behind them. Kraken
 * reports the closing balance of **every asset**, so each holding has a
 * stated answer to compare against — and those answers depend on nothing but
 * the ledger this mapper consumed.
 *
 * A drift is not automatically a bug. Rows the mapper deliberately declines —
 * a purchase paid for in crypto, which Wealthfolio cannot price — must leave
 * the affected asset short, and the report says which assets those are.
 *
 * Written over the container's REST API rather than through the addon host, so
 * it proves the numbers rather than the addon's plumbing.
 */

import { readFileSync } from 'node:fs';
import { mapDataset, summarise, symbolsNeedingPrices } from '../src/lib/mapper';
import { fetchDailyCloses, lookupFrom } from '../src/lib/prices';
import { requireKrakenCredentials } from '../../../tools/credentials';
import { createKrakenClient } from '../src/lib/client';
import type { KrakenDataset } from '../src/lib/extract';
import { displaySymbol } from '../src/lib/extract';

const BASE = process.env.WF_URL ?? 'http://127.0.0.1:8088';
const BATCH = 100;
/** Kraken quotes to 8–10 decimals; anything under this is representation noise. */
const TOLERANCE = 1e-6;

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const match = args.find((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
  if (match === undefined) return undefined;
  return match.includes('=') ? match.slice(match.indexOf('=') + 1) : '';
};

const datasetPath = flag('dataset') || 'kraken-dataset.json';
const keep = flag('keep') !== undefined;
const currency = flag('currency') || 'GBP';

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${text.slice(0, 400)}`);
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

// ─────────────────────────────────────────────────────────────────────────────

const raw = JSON.parse(readFileSync(datasetPath, 'utf-8')) as Omit<KrakenDataset, 'assets' | 'pairs'> & {
  assets: Record<string, KrakenDataset['assets'] extends Map<string, infer V> ? V : never>;
  pairs: Record<string, unknown>;
};

// `--json` serialises the Maps as plain objects; rebuild them.
const dataset: KrakenDataset = {
  ...raw,
  assets: new Map(Object.entries(raw.assets)),
  pairs: new Map(Object.entries(raw.pairs)) as KrakenDataset['pairs'],
};

const truncated = dataset.stats.filter((stat) => stat.truncated).map((stat) => stat.stream);
if (truncated.length > 0) {
  console.log(
    `WARNING: ${truncated.join(', ')} truncated. Balances cannot reconcile from a partial\n` +
      'ledger — re-extract with --full for a meaningful result.\n',
  );
}

// Rewards and swaps are priced from Kraken's published closes, so the
// reconciliation has to fetch them too. Without this the tool exercises the
// unpriced fallback rather than what actually ships — the balances would still
// come out right, and the cost basis the connector really writes would never
// be tested at all.
const needPrices = symbolsNeedingPrices(dataset);
let priceOn;
if (needPrices.length > 0) {
  const { apiKey, apiSecret } = requireKrakenCredentials();
  const client = createKrakenClient({ apiKey, apiSecret, fetch: globalThis.fetch });
  const closes = await fetchDailyCloses(client, needPrices);
  const missing = needPrices.filter((symbol) => !closes.has(symbol));
  console.log(
    `\nDaily closes: ${closes.size}/${needPrices.length} asset(s)` +
      (missing.length > 0 ? ` — none published for ${missing.join(', ')}` : ''),
  );
  priceOn = lookupFrom(closes);
}

const { activities, issues } = mapDataset(dataset, 'pending', {
  accountCurrency: currency,
  priceOn,
});

console.log(`Mapped ${dataset.ledgers.length} ledger rows → ${activities.length} activities.`);
for (const [type, count] of [...summarise({ activities, issues })].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${type.padEnd(24)} ${count}`);
}
const skipped = issues.filter((issue) => issue.kind === 'skipped');
const warnings = issues.filter((issue) => issue.kind === 'warning');
console.log(`\n${skipped.length} skipped, ${warnings.length} flagged for review.`);
for (const issue of [...skipped, ...warnings].slice(0, 10)) {
  console.log(`    ${issue.kind}: ${issue.message}`);
}

// Assets a skipped row touched cannot be expected to reconcile.
const affected = new Set<string>();
for (const issue of skipped) {
  const row = dataset.ledgers.find((entry) => entry.id === issue.sourceId);
  if (row) affected.add(displaySymbol(dataset.assets, row.asset) ?? row.asset);
  // A purchase is keyed by refid, and both its legs matter.
  for (const entry of dataset.ledgers.filter((entry) => entry.refid === issue.sourceId)) {
    affected.add(displaySymbol(dataset.assets, entry.asset) ?? entry.asset);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

const account = await api<{ id: string; name: string }>('POST', '/accounts', {
  name: `Kraken reconcile ${new Date().toISOString().slice(0, 19)}`,
  accountType: 'SECURITIES',
  currency,
  isDefault: false,
  isActive: true,
  trackingMode: 'TRANSACTIONS',
  group: 'Reconciliation',
});
console.log(`\nCreated ${account.name} (${account.id})`);

let created = 0;
const errors: string[] = [];
for (let index = 0; index < activities.length; index += BATCH) {
  const batch = activities
    .slice(index, index + BATCH)
    .map((row) => ({ ...row, accountId: account.id }));
  const result = await api<{ created: unknown[]; errors: unknown[] }>('POST', '/activities/bulk', {
    creates: batch,
  });
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
  instrument?: { symbol: string } | null;
}

await api('POST', '/portfolio/recalculate');
process.stdout.write('  recalculating');
let holdings: Holding[] = [];
for (let attempt = 0; attempt < 40; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 4000));
  holdings = await api<Holding[]>('GET', `/holdings?accountId=${account.id}`);
  if (holdings.length > 0) break;
  process.stdout.write('.');
}
console.log(holdings.length > 0 ? ' done' : ' gave up waiting');

// ─────────────────────────────────────────────────────────────────────────────
//  The comparison
// ─────────────────────────────────────────────────────────────────────────────

const wealthfolio = new Map<string, number>();
for (const holding of holdings) {
  const symbol = holding.instrument?.symbol ?? (holding.holdingType === 'cash' ? currency : '?');
  wealthfolio.set(symbol, (wealthfolio.get(symbol) ?? 0) + holding.quantity);
}

const kraken = new Map<string, number>();
for (const [code, balance] of Object.entries(dataset.balances)) {
  const value = Number(balance);
  if (value === 0) continue;
  const symbol = displaySymbol(dataset.assets, code) ?? code;
  kraken.set(symbol, (kraken.get(symbol) ?? 0) + value);
}

const symbols = [...new Set([...kraken.keys(), ...wealthfolio.keys()])].sort();

console.log('\nBalances — Kraken states these, and the ledger alone should reproduce them');
console.log(
  `  ${'asset'.padEnd(9)}${'Kraken'.padStart(20)}${'Wealthfolio'.padStart(20)}${'drift'.padStart(18)}  verdict`,
);

let unexplained = 0;
let explained = 0;
let matched = 0;
for (const symbol of symbols) {
  const expected = kraken.get(symbol) ?? 0;
  const actual = wealthfolio.get(symbol) ?? 0;
  const drift = actual - expected;
  const ok = Math.abs(drift) < TOLERANCE;

  let verdict: string;
  if (ok) {
    verdict = 'reconciles';
    matched += 1;
  } else if (affected.has(symbol)) {
    verdict = 'expected — a skipped row touched this asset';
    explained += 1;
  } else {
    verdict = '← UNEXPLAINED';
    unexplained += 1;
  }

  console.log(
    `  ${symbol.padEnd(9)}${trim(expected).padStart(20)}${trim(actual).padStart(20)}` +
      `${trim(drift).padStart(18)}  ${verdict}`,
  );
}

console.log(
  `\n  ${matched} reconcile, ${explained} differ for a stated reason, ${unexplained} unexplained.`,
);

if (keep) {
  console.log(`\nAccount kept: open ${BASE} to inspect it.`);
} else {
  await api('DELETE', `/accounts/${account.id}`);
  console.log('\nProbe account deleted. Pass --keep to inspect it in the UI instead.');
}

function trim(value: number): string {
  return String(Number(value.toFixed(10)));
}

process.exit(unexplained === 0 && errors.length === 0 ? 0 : 1);
