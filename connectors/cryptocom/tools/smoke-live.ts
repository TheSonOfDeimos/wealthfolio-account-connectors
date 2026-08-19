/**
 * Real-credential extraction smoke test.
 *
 * Put `CRYPTOCOM_API_KEY` and `CRYPTOCOM_API_SECRET` in `.env`, then
 * `pnpm smoke:live`. It drives `src/lib/extract.ts` — the same module, the same
 * calls, the same order the addon uses inside Wealthfolio — and prints
 * everything Crypto.com hands back, plus the checks that decide whether
 * Wealthfolio could ever show the same figures.
 *
 * Out here the client runs on Node's `fetch` and signs with Node's WebCrypto;
 * in the addon the same code runs on the brokered `fetch` and the sandbox's
 * WebCrypto. Nothing else differs — which is the point of running it.
 *
 * Every call is a query. Wealthfolio is not involved, no order is placed, and
 * nothing is staked, converted or withdrawn.
 *
 *   pnpm smoke:live                        # walk back until the history runs out
 *   pnpm smoke:live -- --days=30           # a shorter walk, for iterating
 *   pnpm smoke:live -- --streams=balance,transactions
 *   pnpm smoke:live -- --max-items=200
 *   pnpm smoke:live -- --json=out.json     # dump the raw dataset
 */

import { writeFileSync } from 'node:fs';
import { requireCryptoComCredentials } from '../../../tools/credentials';
import {
  CRYPTO_QUOTE_CURRENCY,
  DEFAULT_LOOKBACK_DAYS,
  FIAT_CURRENCIES,
  STABLECOIN_QUOTES,
} from '../src/config';
import { createCryptoComClient } from '../src/lib/client';
import {
  ALL_STREAMS,
  extractAll,
  findDuplicateIds,
  pairComposition,
  reconstructBalances,
  statedBalances,
  touchedAssets,
} from '../src/lib/extract';
import type { Stream } from '../src/lib/extract';

// ─────────────────────────────────────────────────────────────────────────────
//  Options
// ─────────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const match = args.find((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
  if (match === undefined) return undefined;
  return match.includes('=') ? match.slice(match.indexOf('=') + 1) : '';
};

const days = Number(flag('days') || DEFAULT_LOOKBACK_DAYS);
const maxItems = Number(flag('max-items') || Infinity);
const jsonPath = flag('json');
const streams = (flag('streams')?.split(',').filter(Boolean) ?? ALL_STREAMS) as readonly Stream[];

const unknownStreams = streams.filter((stream) => !ALL_STREAMS.includes(stream));
if (unknownStreams.length > 0) {
  console.error(`Unknown stream(s): ${unknownStreams.join(', ')}`);
  console.error(`Available: ${ALL_STREAMS.join(', ')}`);
  process.exit(1);
}

const { apiKey, apiSecret } = requireCryptoComCredentials();

// ─────────────────────────────────────────────────────────────────────────────
//  Extract
// ─────────────────────────────────────────────────────────────────────────────

const client = createCryptoComClient({
  apiKey,
  apiSecret,
  fetch: globalThis.fetch,
  onThrottle: (method, seconds) =>
    process.stdout.write(`\r  waiting ${seconds.toFixed(1)}s on ${method}…`.padEnd(78)),
});

heading('Extraction');
console.log('  host          api.crypto.com  (the Exchange — the mobile app has no API)');
console.log(`  streams       ${streams.join(', ')}`);
console.log(`  window        walking back up to ${days} days, in 7-day windows (the widest the API honours)`);
console.log(`  max items     ${maxItems === Infinity ? 'unlimited' : maxItems} per history stream\n`);

const startedAt = Date.now();
const dataset = await extractAll(client, {
  streams,
  since: Date.now() - days * 24 * 60 * 60 * 1000,
  maxItemsPerStream: maxItems,
  onProgress: (event) => process.stdout.write(`\r  ${event.stream}: ${event.message}`.padEnd(78)),
});
process.stdout.write('\r'.padEnd(80) + '\r');

console.log(`  ${'stream'.padEnd(14)}${'items'.padStart(7)}${'reqs'.padStart(7)}${'time'.padStart(9)}   note`);
for (const stat of dataset.stats) {
  const notes: string[] = [];
  if (stat.skipped) notes.push('skipped');
  if (stat.error) notes.push(`FAILED — ${stat.error}`);
  if (stat.truncated) notes.push('truncated — raise --max-items');
  if (stat.saturated) notes.push(`${stat.saturated} window(s) split to avoid losing rows`);
  console.log(
    `  ${stat.stream.padEnd(14)}${String(stat.items).padStart(7)}${String(stat.requests).padStart(7)}` +
      `${(stat.elapsedMs / 1000).toFixed(1).padStart(8)}s   ${notes.join('; ')}`,
  );
}
console.log(`\n  total ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

/**
 * Streams whose failure is information rather than a fault.
 *
 * An account that has never staked, never moved fiat through Crypto.com's own
 * rails, or never requested a statement gets an error from these rather than an
 * empty list — that is the API's habit, not a broken extraction. Exiting
 * non-zero on them would fail the first run on most accounts and train whoever
 * reads it to ignore the exit code, which is the one thing it must not become.
 */
const OPTIONAL_STREAMS = new Set<Stream>(['fiat', 'staking', 'export']);

const failed = dataset.stats.filter((stat) => stat.error);
const fatal = failed.filter((stat) => !OPTIONAL_STREAMS.has(stat.stream));
const authFailures = failed.filter((stat) =>
  /Authentication failure|UNAUTHORIZED|code 40101/i.test(stat.error ?? ''),
);

// ─────────────────────────────────────────────────────────────────────────────
//  The window actually reached — the first thing to know on an older account
// ─────────────────────────────────────────────────────────────────────────────

heading('History reach');
console.log('  Crypto.com DOCUMENTS a 6-month retention limit. On a live account the ledger');
console.log('  does not honour it — rows well over a year old come back fine — so this');
console.log('  measures where the history actually starts rather than trusting either claim.\n');

const ledgerTimes = dataset.transactions.map((row) => row.event_timestamp_ms).sort((a, b) => a - b);
const tradeTimes = dataset.trades.map((row) => row.create_time).sort((a, b) => a - b);
const fundingTimes = [...dataset.deposits, ...dataset.withdrawals]
  .map((row) => row.create_time)
  .sort((a, b) => a - b);
const fiatTimes = [...dataset.fiatDeposits, ...dataset.fiatWithdrawals]
  .map((row) => Number(row.created_at ?? row.create_time ?? 0))
  .filter((value) => value > 0)
  .sort((a, b) => a - b);

console.log(`  asked back to   ${date(dataset.window.since)}`);
if (dataset.window.reachedLedger) {
  console.log(`  ledger walked to ${date(dataset.window.reachedLedger)}`);
}
if (ledgerTimes.length > 0) {
  console.log(`  ledger rows     ${date(ledgerTimes[0]!)} → ${date(ledgerTimes.at(-1)!)}`);
}
if (tradeTimes.length > 0) {
  console.log(`  fills           ${date(tradeTimes[0]!)} → ${date(tradeTimes.at(-1)!)}`);
}
if (fundingTimes.length > 0) {
  console.log(`  crypto funding  ${date(fundingTimes[0]!)} → ${date(fundingTimes.at(-1)!)}`);
}
if (fiatTimes.length > 0) {
  console.log(`  fiat funding    ${date(fiatTimes[0]!)} → ${date(fiatTimes.at(-1)!)}`);
}

// The walk stops on a long silence rather than on the bound, so reaching well
// past the oldest row is what a COMPLETE history looks like. Stopping at the
// bound with rows right up against it is what a truncated one looks like.
if (ledgerTimes.length > 0 && dataset.window.reachedLedger !== undefined) {
  const marginDays = (ledgerTimes[0]! - dataset.window.reachedLedger) / (24 * 60 * 60 * 1000);
  console.log(
    marginDays > 30
      ? `\n  The walk searched ${marginDays.toFixed(0)} days further back than the oldest row it found,\n` +
          '  and found nothing there. That is what a complete history looks like.'
      : '\n  ⚠ The oldest row sits close to where the walk stopped, so this may be where the\n' +
          '    search ended rather than where your history begins. Re-run with a larger --days.',
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Balances, and whether the ledger explains them
// ─────────────────────────────────────────────────────────────────────────────

const stated = statedBalances(dataset);
const held = [...stated].filter(([, quantity]) => quantity !== 0);
const rebuilt = reconstructBalances(dataset.transactions);

heading(`Balances (${held.length} non-zero)`);
if (dataset.balance) {
  console.log(`  Account settlement currency: ${dataset.balance.instrument_name}`);
  console.log(`  Total cash balance:          ${dataset.balance.total_cash_balance}`);
  console.log('  Unlike Kraken, Crypto.com states an account currency — nothing to ask the user.\n');
}
console.log(
  `  ${'asset'.padEnd(12)}${'stated qty'.padStart(20)}${'market value'.padStart(16)}` +
    `${'from ledger'.padStart(20)}   difference`,
);
for (const [asset, quantity] of held.sort((a, b) => a[0].localeCompare(b[0]))) {
  const position = dataset.balance?.position_balances?.find(
    (entry) => entry.instrument_name === asset,
  );
  const fromLedger = rebuilt.get(asset);
  const gap = fromLedger === undefined ? undefined : quantity - fromLedger;
  console.log(
    `  ${asset.padEnd(12)}${trim(quantity).padStart(20)}${(position?.market_value ?? '—').padStart(16)}` +
      `${(fromLedger === undefined ? '—' : trim(fromLedger)).padStart(20)}   ` +
      `${gap === undefined ? 'no ledger rows in window' : Math.abs(gap) < 1e-8 ? 'exact' : trim(gap)}`,
  );
}
// Only worth saying when something actually differs. Printing the caveat under a
// table of exact matches taught the reader to skip it, which is the opposite of
// what a warning is for.
const mismatched = held.filter(([asset, quantity]) => {
  const fromLedger = rebuilt.get(asset);
  return fromLedger === undefined || Math.abs(quantity - fromLedger) >= 1e-8;
});
console.log(
  mismatched.length === 0
    ? `\n  All ${held.length} balances reproduce exactly from the ledger. The extraction accounts\n` +
        '  for every unit the account holds — there is no unexplained history.'
    : `\n  ${mismatched.length} of ${held.length} balances do not reproduce from the ledger. That is either\n` +
        '  history older than this walk reached, or rows it missed. Re-run with a larger --days\n' +
        '  before assuming the former: a walk that stopped early looks exactly the same.',
);

// The figure the whole import has to agree with, and the one to compare against
// Wealthfolio's portfolio total once anything has been written.
const totalMarketValue = (dataset.balance?.position_balances ?? []).reduce(
  (sum, position) => sum + (Number(position.market_value) || 0),
  0,
);
if (totalMarketValue > 0) {
  console.log(
    `\n  Portfolio value per Crypto.com: ${trim(totalMarketValue)} ${dataset.balance?.instrument_name}` +
      '\n  ← this is the number Wealthfolio has to reproduce.',
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  The ledger
// ─────────────────────────────────────────────────────────────────────────────

const duplicates = findDuplicateIds(dataset.transactions);

heading('Ledger');
console.log(`  ${dataset.transactions.length} rows`);
console.log(
  `\n  id uniqueness: ${
    duplicates.size === 0
      ? `OK — ${dataset.transactions.length} rows, ${dataset.transactions.length} distinct journal_ids`
      : `FAILED — ${duplicates.size} id(s) reused`
  }`,
);
for (const [id, count] of [...duplicates].slice(0, 10)) console.log(`    ${id} x${count}`);

heading('Ledger type census (the input to the mapping table)');
console.log('  Anything unrecognised here is a movement the mapper cannot place yet. Crypto.com');
console.log('  documents this list incompletely, so this counts what arrives rather than');
console.log('  checking against a fixed set — the mistake that hid two whole purchase types');
console.log('  on Kraken until an account produced them.\n');
census(dataset.transactions.map((row) => row.journal_type));

heading('Ledger sample (oldest 5, newest 5)');
const sorted = [...dataset.transactions].sort((a, b) => a.event_timestamp_ms - b.event_timestamp_ms);
const sample = sorted.length <= 10 ? sorted : [...sorted.slice(0, 5), ...sorted.slice(-5)];
for (const row of sample) {
  console.log(
    `  ${date(row.event_timestamp_ms)}  ${row.journal_type.padEnd(18)} ${row.instrument_name.padEnd(8)} ` +
      `${row.transaction_qty.padStart(20)}  cost ${row.transaction_cost.padStart(16)}`,
  );
  console.log(`  ${' '.repeat(12)}  journal ${row.journal_id}   order ${row.order_id ?? '—'}`);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Fills, and what each pair is made of
// ─────────────────────────────────────────────────────────────────────────────

heading(`Fills (${dataset.trades.length})`);
if (dataset.trades.length === 0) {
  console.log('  No rows from get-trades in this window.');
} else {
  console.log(
    `  ${'date'.padEnd(12)}${'pair'.padEnd(14)}${'side'.padEnd(6)}${'quantity'.padStart(16)}` +
      `${'price'.padStart(14)}${'fee'.padStart(16)}  fee asset`,
  );
  for (const trade of [...dataset.trades].sort((a, b) => a.create_time - b.create_time).slice(0, 14)) {
    console.log(
      `  ${date(trade.create_time).padEnd(12)}${trade.instrument_name.padEnd(14)}${trade.side.padEnd(6)}` +
        `${trade.traded_quantity.padStart(16)}${trade.traded_price.padStart(14)}${trade.fees.padStart(16)}` +
        `  ${trade.fee_instrument_name ?? '—'}`,
    );
  }
  if (dataset.trades.length > 14) console.log(`    …and ${dataset.trades.length - 14} more`);

  // A fee taken in the coin just bought is not a cash cost, and recording it as
  // one would overstate what was spent while understating what was received.
  const feeInBase = dataset.trades.filter((trade) => {
    const composition = pairComposition(dataset, trade.instrument_name);
    return composition && trade.fee_instrument_name === composition.base;
  });
  console.log(
    `\n  ${feeInBase.length}/${dataset.trades.length} fills were charged a fee in the asset bought` +
      ' rather than in the currency paid.',
  );

  heading('Pair composition (from get-instruments — never split out of the symbol)');
  console.log(`  ${'pair'.padEnd(16)}${'base'.padEnd(10)}${'quote'.padEnd(10)}  note`);
  const pairs = [...new Set(dataset.trades.map((trade) => trade.instrument_name))].sort();
  for (const pair of pairs) {
    const composition = pairComposition(dataset, pair);
    if (!composition) {
      console.log(`  ${pair.padEnd(16)}${'?'.padEnd(10)}${'?'.padEnd(10)}  NOT IN CATALOGUE — cannot be mapped safely`);
      continue;
    }
    const notes: string[] = [];
    if (!composition.spot) notes.push('DERIVATIVE — not the underlying coin');
    if (STABLECOIN_QUOTES.has(composition.quote)) notes.push('quoted in a stablecoin, not fiat');
    else if (!FIAT_CURRENCIES.has(composition.quote)) notes.push('quoted in a coin');
    console.log(
      `  ${pair.padEnd(16)}${composition.base.padEnd(10)}${composition.quote.padEnd(10)}  ${notes.join('; ')}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  The currency question — what can actually be imported
// ─────────────────────────────────────────────────────────────────────────────

heading('Importable currencies');
console.log("  Wealthfolio resolves an activity currency as an FX pair in Yahoo's format —");
console.log('  BTC becomes a request for "BTCUSD=X", which does not exist. Such a row is stored');
console.log('  and then never priced, so it has to be reported rather than written.\n');

const byCurrency = new Map<string, number>();
for (const row of dataset.transactions) {
  byCurrency.set(row.instrument_name, (byCurrency.get(row.instrument_name) ?? 0) + 1);
}
const fiat: string[] = [];
const stable: string[] = [];
const other: string[] = [];
for (const [code, count] of [...byCurrency].sort((a, b) => b[1] - a[1])) {
  const entry = `${code} (${count})`;
  if (FIAT_CURRENCIES.has(code)) fiat.push(entry);
  else if (STABLECOIN_QUOTES.has(code)) stable.push(entry);
  else other.push(entry);
}
console.log(`  fiat-denominated rows:  ${fiat.join(', ') || '(none)'}`);
console.log(`  stablecoin-denominated: ${stable.join(', ') || '(none)'}`);
console.log(`  everything else:        ${other.slice(0, 14).join(', ')}${other.length > 14 ? ', …' : ''}`);
if (stable.length > 0) {
  console.log(
    '\n  Stablecoins are listed apart from fiat on purpose. A USDT balance is an asset held,\n' +
      '  not dollars — treating one as the other invents a 1:1 rate nothing here has the\n' +
      '  right to invent, and hides exactly what a de-pegging looks like.',
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Funding
// ─────────────────────────────────────────────────────────────────────────────

heading(
  `Funding (${dataset.deposits.length} deposits, ${dataset.withdrawals.length} withdrawals, ` +
    `${dataset.fiatDeposits.length} fiat in, ${dataset.fiatWithdrawals.length} fiat out)`,
);
for (const [label, rows] of [
  ['deposit', dataset.deposits],
  ['withdrawal', dataset.withdrawals],
] as const) {
  for (const row of rows.slice(0, 6)) {
    console.log(
      `  ${date(row.create_time)}  ${label.padEnd(11)}${row.currency.padEnd(8)}` +
        `${String(row.amount).padStart(18)}  fee ${String(row.fee ?? 0).padStart(10)}  ` +
        `status ${row.status}  ${row.network_id ?? ''}`,
    );
  }
}
if (dataset.fiatDeposits.length > 0 || dataset.fiatWithdrawals.length > 0) {
  console.log('\n  Fiat rows, verbatim — this endpoint is barely documented and the type is');
  console.log('  written from whatever real responses show rather than from a guess:');
  for (const row of [...dataset.fiatDeposits, ...dataset.fiatWithdrawals].slice(0, 4)) {
    console.log(`    ${JSON.stringify(row).slice(0, 150)}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Staking
// ─────────────────────────────────────────────────────────────────────────────

const stakingTotal =
  dataset.stakingRewards.length + dataset.stakingPositions.length + dataset.stakingConversions.length;
if (stakingTotal > 0) {
  heading(`Staking (${dataset.stakingRewards.length} rewards, ${dataset.stakingPositions.length} positions, ${dataset.stakingConversions.length} conversions)`);
  for (const row of [...dataset.stakingRewards, ...dataset.stakingPositions].slice(0, 8)) {
    console.log(`    ${JSON.stringify(row).slice(0, 150)}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  The statement export — the only route past the 6-month wall
// ─────────────────────────────────────────────────────────────────────────────

heading('Statement export (read-only probe)');
const exportStat = dataset.stats.find((stat) => stat.stream === 'export');
if (exportStat?.error) {
  console.log(`  Not reachable with this key: ${exportStat.error}`);
  console.log('  If this is a permissions or host error, the 6-month wall is the hard limit and');
  console.log('  older history has to come from a CSV the user exports by hand.');
} else {
  console.log(`  Reachable. ${dataset.exports?.request_list?.length ?? 0} existing export request(s).`);
  console.log('  Nothing was created — this only lists what is already there.');
  console.log('  Kept as a fallback rather than a plan: the ledger walk above reaches the start');
  console.log('  of this history on its own, so nothing needs the export. It matters only for an');
  console.log('  account whose balances genuinely fail to reconcile from the ledger.');
  for (const request of (dataset.exports?.request_list ?? []).slice(0, 5)) {
    console.log(`    ${JSON.stringify(request).slice(0, 150)}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Asset resolution
// ─────────────────────────────────────────────────────────────────────────────

const touched = touchedAssets(dataset);
const priceable = [...touched].filter((code) =>
  dataset.instruments.has(`${code}_${CRYPTO_QUOTE_CURRENCY}`),
);
const unpriceable = [...touched].filter(
  (code) => !FIAT_CURRENCIES.has(code) && !dataset.instruments.has(`${code}_${CRYPTO_QUOTE_CURRENCY}`),
);

heading(`Asset resolution (${touched.size} codes touched)`);
console.log(
  `  ${priceable.length}/${touched.size} have a ${CRYPTO_QUOTE_CURRENCY} spot pair on Crypto.com,` +
    ' so the custom quote provider can price them.',
);
for (const code of unpriceable) {
  console.log(`    ${code.padEnd(12)} no ${code}_${CRYPTO_QUOTE_CURRENCY} pair — would fall back to Yahoo`);
}

// ─────────────────────────────────────────────────────────────────────────────

if (jsonPath !== undefined) {
  const path = jsonPath || 'cryptocom-dataset.json';
  writeFileSync(
    path,
    JSON.stringify(dataset, (_key, value) => (value instanceof Map ? Object.fromEntries(value) : value), 2),
  );
  console.log(`\nRaw dataset written to ${path}`);
}

console.log('\nNothing was written to Crypto.com or Wealthfolio. This script only reads.');

if (authFailures.length > 0) {
  console.error(
    `\n${authFailures.length} stream(s) came back UNAUTHORIZED. In order of likelihood:\n` +
      '  1. The secret is wrong, or was pasted with whitespace — it is shown once at creation.\n' +
      '  2. This is an App account, not an Exchange one. The app issues no API keys at all.\n' +
      '  3. Your clock is more than 60 seconds off — Crypto.com rejects a stale nonce.\n' +
      '  4. The key has an IP whitelist, which happens automatically if Trading or\n' +
      '     Withdrawal was enabled on it. A read-only key needs none.',
  );
}
const optionalFailures = failed.filter((stat) => OPTIONAL_STREAMS.has(stat.stream));
if (optionalFailures.length > 0) {
  console.log(
    `\n${optionalFailures.length} optional stream(s) returned an error rather than an empty list: ` +
      `${optionalFailures.map((stat) => stat.stream).join(', ')}.\n` +
      'Expected on an account that has never used those products, and not treated as a failure.',
  );
}
if (fatal.length > 0) {
  console.error(`\n${fatal.length} stream(s) failed: ${fatal.map((stat) => stat.stream).join(', ')}`);
  process.exit(1);
}
if (duplicates.size > 0) {
  console.error('\nLedger ids are not unique — de-duplication would drop real rows.');
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Formatting
// ─────────────────────────────────────────────────────────────────────────────

function heading(title: string): void {
  console.log(`\n${title}\n${'─'.repeat(Math.max(title.length, 40))}`);
}

function date(unixMs: number): string {
  return new Date(unixMs).toISOString().slice(0, 10);
}

/** A number without a wall of trailing zeros, but without rounding away detail. */
function trim(value: number): string {
  return String(Number(value.toFixed(8)));
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
