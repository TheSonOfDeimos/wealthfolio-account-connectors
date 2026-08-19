/**
 * Does the mapping preserve what Crypto.com says you hold?
 *
 * The sharpest test this connector has, and it needs neither Wealthfolio nor a
 * Docker container: run the real dataset through the real mapper, add up the
 * quantities the activities would create, and compare against the balances
 * Crypto.com states. Anything that does not match is a mapping bug, in a place
 * this can name.
 *
 * It is a stronger check than the smoke test's. That one asks whether the
 * *extraction* is complete — whether the ledger reproduces the balances. This
 * asks whether the *translation* is faithful, which is the half where a fee
 * counted twice or a staked balance split in two would hide.
 *
 *   pnpm reconcile                          # fetch live, then check
 *   pnpm reconcile -- --dataset=out.json    # replay a saved smoke-test dump
 *
 * Nothing is written anywhere. This only reads.
 */

import { readFileSync } from 'node:fs';
import { requireCryptoComCredentials } from '../../../tools/credentials';
import { CRYPTO_QUOTE_CURRENCY, DEFAULT_LOOKBACK_DAYS, FIAT_CURRENCIES } from '../src/config';
import { createCryptoComClient } from '../src/lib/client';
import { extractAll, statedBalances } from '../src/lib/extract';
import type { CryptoComDataset } from '../src/lib/extract';
import { mapDataset, summarise, symbolsNeedingPrices, underlyingSymbol } from '../src/lib/mapper';
import { fetchDailyCloses, lookupFrom } from '../src/lib/prices';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const match = args.find((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
  if (match === undefined) return undefined;
  return match.includes('=') ? match.slice(match.indexOf('=') + 1) : '';
};

const datasetPath = flag('dataset');

const { apiKey, apiSecret } = requireCryptoComCredentials();
const client = createCryptoComClient({ apiKey, apiSecret, fetch: globalThis.fetch });

// ─────────────────────────────────────────────────────────────────────────────

let dataset: CryptoComDataset;
if (datasetPath) {
  const raw = JSON.parse(readFileSync(datasetPath, 'utf-8')) as CryptoComDataset & {
    instruments: Record<string, unknown>;
    derivatives: Record<string, unknown>;
  };
  // `JSON.stringify` turned the two Maps into objects on the way out.
  dataset = {
    ...raw,
    instruments: new Map(Object.entries(raw.instruments ?? {})) as CryptoComDataset['instruments'],
    derivatives: new Map(Object.entries(raw.derivatives ?? {})) as CryptoComDataset['derivatives'],
  };
  console.log(`Replaying ${datasetPath}\n`);
} else {
  console.log('Fetching live history — this takes a couple of minutes on the trade limiter…\n');
  dataset = await extractAll(client, {
    since: Date.now() - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
    onProgress: (event) => process.stdout.write(`\r  ${event.stream}: ${event.message}`.padEnd(78)),
  });
  process.stdout.write('\r'.padEnd(80) + '\r');
}

// Rewards are the only rows needing a price, and an unpriced reward still
// creates the right quantity — so the lookup is fetched but a failure here
// cannot change the answer this tool reports.
const needed = symbolsNeedingPrices(dataset);
const closes = needed.length > 0 ? await fetchDailyCloses(client, needed, dataset.window.since) : new Map();

const accountCurrency = dataset.balance?.instrument_name ?? CRYPTO_QUOTE_CURRENCY;
const { activities, issues } = mapDataset(dataset, 'reconcile', {
  accountCurrency,
  priceOn: lookupFrom(closes),
});

// ─────────────────────────────────────────────────────────────────────────────
//  What the activities would leave you holding
// ─────────────────────────────────────────────────────────────────────────────

/** Quantity effect of each activity type, as Wealthfolio applies it. */
const ADDS = new Set(['BUY', 'TRANSFER_IN', 'DIVIDEND']);
const REMOVES = new Set(['SELL', 'TRANSFER_OUT']);

const mapped = new Map<string, number>();
for (const activity of activities) {
  const symbol = activity.asset?.symbol;
  if (!symbol || !activity.quantity) continue;
  const quantity = Number(activity.quantity);
  if (!Number.isFinite(quantity)) continue;

  const signed = ADDS.has(activity.activityType)
    ? quantity
    : REMOVES.has(activity.activityType)
      ? -quantity
      : 0;
  mapped.set(symbol, (mapped.get(symbol) ?? 0) + signed);
}

// Crypto.com holds staked balances under their own code; the mapper folds them
// into the underlying coin, so the comparison has to fold them too.
const stated = new Map<string, number>();
for (const [code, quantity] of statedBalances(dataset)) {
  const symbol = underlyingSymbol(code);
  stated.set(symbol, (stated.get(symbol) ?? 0) + quantity);
}

heading('Holdings: Crypto.com vs what the mapping would create');
console.log(`  ${'asset'.padEnd(12)}${'Crypto.com'.padStart(20)}${'mapped'.padStart(20)}   difference`);

const codes = [...new Set([...stated.keys(), ...mapped.keys()])].sort();
let exact = 0;
const off: { symbol: string; stated: number; mapped: number }[] = [];

for (const symbol of codes) {
  const theirs = stated.get(symbol) ?? 0;
  const ours = mapped.get(symbol) ?? 0;
  if (theirs === 0 && ours === 0) continue;
  // Cash is not a holding. A fiat balance is built from DEPOSIT and WITHDRAWAL
  // rows, which carry an `amount` and no `quantity`, so it can never appear in
  // the quantity totals and comparing it here would report a false failure on
  // every run.
  if (FIAT_CURRENCIES.has(symbol)) {
    console.log(`  ${symbol.padEnd(12)}${trim(theirs).padStart(20)}${'—'.padStart(20)}   cash, not a holding`);
    continue;
  }

  const gap = theirs - ours;
  // Proportional, because a SHIB balance of 36,864,796.5 cannot be compared to
  // a BTC one of 0.01085429 on the same absolute tolerance.
  const relative = theirs === 0 ? (ours === 0 ? 0 : 1) : Math.abs(gap) / Math.abs(theirs);
  const ok = Math.abs(gap) < 1e-8 || relative < 1e-9;
  if (ok) exact += 1;
  else off.push({ symbol, stated: theirs, mapped: ours });

  console.log(
    `  ${symbol.padEnd(12)}${trim(theirs).padStart(20)}${trim(ours).padStart(20)}   ` +
      (ok ? 'exact' : `${trim(gap)}  ← ${(relative * 100).toFixed(4)}%`),
  );
}

// ─────────────────────────────────────────────────────────────────────────────

heading('What the mapping produced');
for (const [type, count] of [...summarise({ activities, issues })].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${type.padEnd(28)} ${count}`);
}
console.log(`  ${'—'.padEnd(28)} ${activities.length} activities`);

const skipped = issues.filter((issue) => issue.kind === 'skipped');
const warnings = issues.filter((issue) => issue.kind === 'warning');
console.log(`\n  ${skipped.length} row(s) left out, ${warnings.length} flagged for review.`);

const reasons = new Map<string, number>();
for (const issue of skipped) {
  // Group by the shape of the message rather than its numbers, so a hundred
  // near-identical skips read as one line instead of a hundred.
  const key = issue.message.replace(/[\d.,-]+/g, 'N').slice(0, 90);
  reasons.set(key, (reasons.get(key) ?? 0) + 1);
}
for (const [reason, count] of [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`    ${String(count).padStart(4)} × ${reason}`);
}

// ─────────────────────────────────────────────────────────────────────────────

heading('Verdict');
if (off.length === 0) {
  console.log(
    `  All ${exact} holdings reproduce exactly. Every unit Crypto.com says you own is\n` +
      '  accounted for by an activity this connector would write.',
  );
} else {
  console.log(`  ${exact} exact, ${off.length} off:\n`);
  for (const entry of off) {
    console.log(
      `    ${entry.symbol.padEnd(10)} Crypto.com ${trim(entry.stated)}, mapped ${trim(entry.mapped)}`,
    );
  }
  console.log('\n  A difference here is a mapping bug, not missing history — the smoke test');
  console.log('  already established that the ledger reproduces these balances.');
}

console.log('\nNothing was written to Crypto.com or Wealthfolio. This tool only reads.');
if (off.length > 0) process.exit(1);

// ─────────────────────────────────────────────────────────────────────────────

function heading(title: string): void {
  console.log(`\n${title}\n${'─'.repeat(Math.max(title.length, 40))}`);
}

function trim(value: number): string {
  return String(Number(value.toFixed(10)));
}
