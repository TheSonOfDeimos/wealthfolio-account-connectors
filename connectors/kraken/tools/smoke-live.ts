/**
 * Real-credential extraction smoke test.
 *
 * Put `KRAKEN_API_KEY` and `KRAKEN_API_SECRET` in `.env`, then `pnpm
 * smoke:live`. It drives `src/lib/extract.ts` — the same module, the same
 * calls, the same order the addon uses inside Wealthfolio — and prints
 * everything Kraken hands back: the ledger with its own ids, a census of every
 * entry type, every asset the account has touched, and the checks that decide
 * whether Wealthfolio could ever show the same figures.
 *
 * Out here the client runs on Node's `fetch` and signs with Node's WebCrypto;
 * in the addon the same code runs on the brokered `fetch` and the sandbox's
 * WebCrypto. Nothing else differs — which is the point of running it.
 *
 * Every call is a query. Wealthfolio is not involved, no order is placed, and
 * nothing is moved between Earn strategies.
 *
 *   pnpm smoke:live                     # 500 rows per history stream
 *   pnpm smoke:live -- --full           # walk the whole history
 *   pnpm smoke:live -- --max-items=100
 *   pnpm smoke:live -- --streams=balance,ledgers
 *   pnpm smoke:live -- --json=out.json  # dump the raw dataset
 */

import { writeFileSync } from 'node:fs';
import { requireKrakenCredentials } from '../../../tools/credentials';
import { BALANCE_SUFFIXES, FIAT_CURRENCIES, MAX_HISTORY_ITEMS } from '../src/config';
import { createKrakenClient } from '../src/lib/client';
import {
  ALL_STREAMS,
  checkLedgerContinuity,
  displaySymbol,
  extractAll,
  findDuplicateIds,
  groupByRefid,
  ledgerKind,
  pairInstantBuys,
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

const maxItems = flag('full') !== undefined ? Infinity : Number(flag('max-items') || MAX_HISTORY_ITEMS);
const jsonPath = flag('json');
const streams = (flag('streams')?.split(',').filter(Boolean) ?? ALL_STREAMS) as readonly Stream[];

const unknownStreams = streams.filter((stream) => !ALL_STREAMS.includes(stream));
if (unknownStreams.length > 0) {
  console.error(`Unknown stream(s): ${unknownStreams.join(', ')}`);
  console.error(`Available: ${ALL_STREAMS.join(', ')}`);
  process.exit(1);
}

const { apiKey, apiSecret } = requireKrakenCredentials();

// ─────────────────────────────────────────────────────────────────────────────
//  Extract
// ─────────────────────────────────────────────────────────────────────────────

const client = createKrakenClient({
  apiKey,
  apiSecret,
  fetch: globalThis.fetch,
  onThrottle: (seconds) =>
    process.stdout.write(`\r  waiting ${seconds.toFixed(1)}s on Kraken's rate limiter…`.padEnd(78)),
});

heading('Extraction');
console.log(`  host          api.kraken.com`);
console.log(`  streams       ${streams.join(', ')}`);
console.log(`  max items     ${maxItems === Infinity ? 'unlimited' : maxItems} per history stream\n`);

const startedAt = Date.now();
const dataset = await extractAll(client, {
  streams,
  maxItemsPerStream: maxItems,
  // History endpoints cost 4 against a counter that decays 0.5/s, so a long
  // walk spends most of its time waiting and looks hung without this.
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
        ? 'truncated (more history available — try --full)'
        : '';
  console.log(
    `  ${stat.stream.padEnd(14)}${String(stat.items).padStart(7)}${String(stat.pages || '').padStart(7)}` +
      `${(stat.elapsedMs / 1000).toFixed(1).padStart(8)}s   ${note}`,
  );
}
console.log(`\n  total ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

const failed = dataset.stats.filter((stat) => stat.error);

// A local clock well off Kraken's produces nonce rejections that read exactly
// like a signing bug, so it is worth ruling out before anything else.
if (dataset.serverTime) {
  // Measured against the local clock as it was when Kraken answered, not as it
  // is now — otherwise a slow run reports its own duration as clock drift.
  const skew = Math.abs(dataset.serverTime.localAt / 1000 - dataset.serverTime.unixtime);
  console.log(
    `  clock         ${dataset.serverTime.rfc1123} — local clock ${skew.toFixed(1)}s off` +
      (skew > 30 ? '  ← nonce errors are likely' : ''),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Balances
// ─────────────────────────────────────────────────────────────────────────────

const held = Object.entries(dataset.balances).filter(([, amount]) => Number(amount) !== 0);

heading(`Balances (${held.length} non-zero of ${Object.keys(dataset.balances).length})`);
console.log(`  ${'code'.padEnd(12)}${'symbol'.padEnd(10)}${'class'.padEnd(17)}${'balance'.padStart(20)}  note`);
for (const [code, amount] of held.sort((a, b) => a[0].localeCompare(b[0]))) {
  const asset = dataset.assets.get(code);
  const symbol = displaySymbol(dataset.assets, code);
  const suffix = asset?.suffix;
  console.log(
    `  ${code.padEnd(12)}${(symbol ?? '—').padEnd(10)}${(asset?.aclass ?? '—').padEnd(17)}` +
      `${amount.padStart(20)}  ${
        suffix
          ? `${BALANCE_SUFFIXES[suffix] ?? `UNKNOWN SUFFIX .${suffix}`} — same asset as ${asset?.base}`
          : symbol
            ? ''
            : 'NOT IN CATALOGUE — needs a SYMBOL_OVERRIDES entry'
      }`,
  );
}

if (dataset.tradeBalance?.eb) {
  console.log(`\n  Combined balance (TradeBalance.eb, in ZUSD): ${dataset.tradeBalance.eb}`);
  console.log('  Kraken has no account currency — the connector must ask which one to use.');
}

// ─────────────────────────────────────────────────────────────────────────────
//  Ledger — the spine
// ─────────────────────────────────────────────────────────────────────────────

const duplicates = findDuplicateIds(dataset.ledgers);
const sorted = [...dataset.ledgers].sort((a, b) => a.time - b.time);

heading('Ledger');
console.log(`  ${dataset.ledgers.length} rows`);
if (sorted.length > 0) {
  console.log(`  ${date(sorted[0]!.time)} → ${date(sorted.at(-1)!.time)}`);
}
// Kraken states its own arithmetic on every row, so the extraction can be
// checked against it rather than trusted. This is the only check that catches
// a *missing* row, which otherwise looks exactly like a correct run.
const gaps = checkLedgerContinuity(dataset.ledgers);
const bounded = dataset.stats.some((stat) => stat.stream === 'ledgers' && stat.truncated);
console.log(
  `\n  continuity (balance = previous + amount - fee): ${
    gaps.length === 0
      ? 'OK — every row follows from the one before it'
      : `${gaps.length} gap(s)` + (bounded ? ' — expected, this walk was truncated' : ' ← ROWS ARE MISSING')
  }`,
);
for (const gap of gaps.slice(0, 8)) {
  console.log(
    `    ${gap.asset.padEnd(7)} ${date(gap.time)} expected ${gap.expected.toFixed(4)}, ` +
      `Kraken says ${gap.actual.toFixed(4)} — ${gap.missing.toFixed(4)} unaccounted for (${gap.id})`,
  );
}

console.log(
  `\n  id uniqueness: ${
    duplicates.size === 0
      ? `OK — ${dataset.ledgers.length} rows, ${dataset.ledgers.length} distinct ids`
      : `FAILED — ${duplicates.size} id(s) reused`
  }`,
);
for (const [id, count] of [...duplicates].slice(0, 10)) console.log(`    ${id} x${count}`);

heading('Ledger type census (the input to the mapping table)');
console.log('  Anything unrecognised here is a cash or asset movement the mapper cannot place yet.\n');
census(dataset.ledgers.map(ledgerKind));

// `transfer` is the row type that most needs its subtype read: it covers
// airdrops, the OTC desk, and internal moves between the spot, futures and
// staking wallets. Counting an internal move as a deposit doubles the
// portfolio, so the split is worth seeing explicitly.
const transfers = dataset.ledgers.filter((row) => row.type === 'transfer');
if (transfers.length > 0) {
  console.log(`\n  ${transfers.length} transfer row(s) — subtype decides deposit vs internal move:`);
  census(transfers.map((row) => row.subtype || '(no subtype)'));
}

heading('Ledger sample (oldest 5, newest 5)');
const sample = sorted.length <= 10 ? sorted : [...sorted.slice(0, 5), ...sorted.slice(-5)];
for (const row of sample) {
  console.log(
    `  ${date(row.time)}  ${ledgerKind(row).padEnd(22)} ${row.asset.padEnd(10)} ` +
      `${row.amount.padStart(18)}  fee ${(row.fee || '0').padStart(12)}`,
  );
  console.log(`  ${' '.repeat(12)}  id ${row.id}   refid ${row.refid}`);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Trades, and the join the mapper depends on
// ─────────────────────────────────────────────────────────────────────────────

// Kraken's Instant Buy never reaches TradesHistory. It is recorded as a
// `spend` of one asset and a `receive` of another sharing a refid, so an
// account that only bought that way reports zero trades while plainly holding
// what it bought. Neither type appears in Kraken's documented ledger list.
const instant = pairInstantBuys(dataset.ledgers);
if (instant.buys.length > 0 || instant.unpaired.length > 0) {
  heading(`Instant Buy purchases (${instant.buys.length})`);
  console.log('  Recorded as spend/receive pairs, not as trades. Both legs state their own');
  console.log('  asset, amount and fee; the pairing is Kraken\'s own refid, never proximity.\n');
  console.log(
    `  ${'date'.padEnd(12)}${'received'.padEnd(24)}${'for'.padEnd(20)}${'fee'.padStart(12)}` +
      `${'implied unit price'.padStart(22)}`,
  );
  for (const buy of instant.buys.slice(0, 14)) {
    const receivedSymbol = displaySymbol(dataset.assets, buy.received.asset) ?? buy.received.asset;
    const spentSymbol = displaySymbol(dataset.assets, buy.spent.asset) ?? buy.spent.asset;
    const unit = buy.received.amount === 0 ? 0 : buy.spent.amount / buy.received.amount;
    console.log(
      `  ${date(buy.time).padEnd(12)}${`${trim(buy.received.amount)} ${receivedSymbol}`.padEnd(24)}` +
        `${`${trim(buy.spent.amount)} ${spentSymbol}`.padEnd(20)}` +
        `${trim(buy.spent.fee).padStart(12)}${`${trim(unit)} ${spentSymbol}`.padStart(22)}`,
    );
  }
  if (instant.buys.length > 14) console.log(`    …and ${instant.buys.length - 14} more`);

  // The cost leg decides whether a purchase can be imported at all: a fiat
  // spend gives Wealthfolio a currency it can price, a crypto one does not.
  const costCurrencies = new Map<string, number>();
  for (const buy of instant.buys) {
    const symbol = displaySymbol(dataset.assets, buy.spent.asset) ?? buy.spent.asset;
    costCurrencies.set(symbol, (costCurrencies.get(symbol) ?? 0) + 1);
  }
  console.log('\n  Paid in:');
  for (const [symbol, count] of [...costCurrencies].sort((a, b) => b[1] - a[1])) {
    console.log(
      `    ${symbol.padEnd(8)} ${String(count).padStart(4)}  ${
        FIAT_CURRENCIES.has(symbol) ? 'importable — Wealthfolio can price this currency' : 'NOT IMPORTABLE — no FX rate exists for it'
      }`,
    );
  }
  if (instant.unpaired.length > 0) {
    console.log(
      `\n  ${instant.unpaired.length} spend/receive row(s) did not form a clean pair and are left` +
        ' for review rather than guessed at.',
    );
  }
}

heading(`Trades (${dataset.trades.length})`);
if (dataset.trades.length === 0) {
  console.log('  No rows from TradesHistory. On this account every purchase went through');
  console.log('  Instant Buy, which that endpoint does not report — see the section above.');
} else {
  console.log(
    `  ${'date'.padEnd(12)}${'pair'.padEnd(14)}${'side'.padEnd(6)}${'volume'.padStart(16)}` +
      `${'price'.padStart(14)}${'cost'.padStart(14)}${'fee'.padStart(12)}`,
  );
  for (const trade of [...dataset.trades].sort((a, b) => a.time - b.time).slice(0, 12)) {
    console.log(
      `  ${date(trade.time).padEnd(12)}${trade.pair.padEnd(14)}${trade.type.padEnd(6)}` +
        `${trade.vol.padStart(16)}${trade.price.padStart(14)}${trade.cost.padStart(14)}${trade.fee.padStart(12)}`,
    );
  }

  // A trade appears twice in the ledger — once for the base asset, once for
  // the quote — joined on refid. Proving that here means the mapper never has
  // to reconstruct a pair from two rows that happen to sit next to each other.
  const groups = groupByRefid(dataset.ledgers.filter((row) => row.type === 'trade'));
  const matched = dataset.trades.filter((trade) => groups.has(trade.id));
  console.log(
    `\n  Ledger join: ${matched.length}/${dataset.trades.length} trades have matching ledger rows` +
      ` (${[...groups.values()].filter((rows) => rows.length === 2).length} pairs of two, as expected).`,
  );

  heading('Pair composition (from AssetPairs — never split out of the pair name)');
  console.log(`  ${'pair'.padEnd(16)}${'wsname'.padEnd(14)}${'base'.padEnd(10)}${'quote'.padEnd(10)}  class`);
  for (const [name, pair] of dataset.pairs) {
    console.log(
      `  ${name.padEnd(16)}${(pair.wsname ?? '—').padEnd(14)}${pair.base.padEnd(10)}${pair.quote.padEnd(10)}` +
        `  ${pair.aclass_base}${pair.aclass_base === 'tokenized_asset' ? '  ← an xStock, not the equity' : ''}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  The currency question — what can actually be imported
// ─────────────────────────────────────────────────────────────────────────────

heading('Importable currencies');
console.log('  Wealthfolio resolves an activity currency as an FX pair in Yahoo\'s format —');
console.log('  BTC becomes a request for "BTCUSD=X", which does not exist. Such a row is');
console.log('  stored and then never priced, so it must be reported rather than written.\n');

const byCurrency = new Map<string, number>();
for (const row of dataset.ledgers) {
  const symbol = displaySymbol(dataset.assets, row.asset) ?? row.asset;
  byCurrency.set(symbol, (byCurrency.get(symbol) ?? 0) + 1);
}

const fiat: string[] = [];
const nonFiat: string[] = [];
for (const [symbol, count] of [...byCurrency].sort((a, b) => b[1] - a[1])) {
  (FIAT_CURRENCIES.has(symbol) ? fiat : nonFiat).push(`${symbol} (${count})`);
}
console.log(`  fiat-denominated rows:     ${fiat.join(', ') || '(none)'}`);
console.log(`  everything else:           ${nonFiat.slice(0, 14).join(', ')}${nonFiat.length > 14 ? ', …' : ''}`);

// Cash movements are the rows whose currency matters. A quantity of an asset
// carries its own symbol and is priced as a holding, which is a different path.
const cashKinds = new Set(['deposit', 'withdrawal', 'transfer', 'adjustment', 'credit']);
const cashRows = dataset.ledgers.filter((row) => cashKinds.has(row.type));
const cashUnpriceable = cashRows.filter(
  (row) => !FIAT_CURRENCIES.has(displaySymbol(dataset.assets, row.asset) ?? row.asset),
);
console.log(
  `\n  Of ${cashRows.length} cash-movement rows, ${cashUnpriceable.length} are denominated in a` +
    ' non-fiat asset.',
);

// ─────────────────────────────────────────────────────────────────────────────
//  Funding and Earn
// ─────────────────────────────────────────────────────────────────────────────

heading(`Funding (${dataset.deposits.length} deposits, ${dataset.withdrawals.length} withdrawals)`);
console.log('  Detail beyond the ledger row: method, network and the on-chain id.\n');
for (const [label, rows] of [
  ['deposit', dataset.deposits],
  ['withdrawal', dataset.withdrawals],
] as const) {
  for (const row of rows.slice(0, 6)) {
    console.log(
      `  ${date(row.time)}  ${label.padEnd(11)}${row.asset.padEnd(10)}${row.amount.padStart(18)}` +
        `  fee ${(row.fee ?? '0').padStart(10)}  ${row.status ?? ''}  ${row.method ?? ''}`,
    );
  }
}

if (dataset.earn?.items?.length) {
  heading(`Earn allocations (${dataset.earn.items.length})`);
  console.log('  Reachable on "Funds · Query" — the Earn permission is only for moving funds.\n');
  console.log(`  ${'asset'.padEnd(12)}${'strategy'.padEnd(40)}  allocated / rewarded`);
  for (const item of dataset.earn.items) {
    console.log(
      `  ${(item.native_asset ?? '—').padEnd(12)}${String(item.strategy_id ?? '—').slice(0, 38).padEnd(40)}` +
        `  ${compact(item.amount_allocated)} / ${compact(item.total_rewarded)}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Asset resolution
// ─────────────────────────────────────────────────────────────────────────────

const touched = touchedAssets(dataset);
const unresolved = [...touched].filter((code) => !displaySymbol(dataset.assets, code));

heading(`Asset resolution (${touched.size} codes touched)`);
console.log(
  `  ${touched.size - unresolved.length}/${touched.size} resolved to a display symbol Kraken states.`,
);
for (const code of unresolved) {
  console.log(`    ${code.padEnd(14)} UNRESOLVED — needs a SYMBOL_OVERRIDES entry`);
}

const tokenized = [...touched].filter((code) => dataset.assets.get(code)?.aclass === 'tokenized_asset');
if (tokenized.length > 0) {
  console.log(
    `\n  ${tokenized.length} tokenized asset(s): ${tokenized.join(', ')}` +
      '\n  These are xStocks — backed by an equity, but not the equity. Do not map AAPLx to AAPL.',
  );
}

const suffixed = [...touched].filter((code) => dataset.assets.get(code)?.suffix);
if (suffixed.length > 0) {
  console.log(`\n  ${suffixed.length} suffixed balance(s) — the same asset held in a different product:`);
  for (const code of suffixed) {
    const asset = dataset.assets.get(code)!;
    console.log(
      `    ${code.padEnd(14)} → ${displaySymbol(dataset.assets, code) ?? '?'}   ` +
        `${BALANCE_SUFFIXES[asset.suffix!] ?? `UNKNOWN SUFFIX .${asset.suffix}`}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────

if (jsonPath !== undefined) {
  const path = jsonPath || 'kraken-dataset.json';
  writeFileSync(
    path,
    JSON.stringify(dataset, (_key, value) => (value instanceof Map ? Object.fromEntries(value) : value), 2),
  );
  console.log(`\nRaw dataset written to ${path}`);
}

console.log('\nNothing was written to Kraken or Wealthfolio. This script only reads.');
if (failed.length > 0) {
  console.error(`\n${failed.length} stream(s) failed: ${failed.map((stat) => stat.stream).join(', ')}`);
  for (const stat of failed) {
    const auth = stat.error?.includes('Invalid key') || stat.error?.includes('Permission');
    if (auth) console.error(`  ${stat.stream}: check the key's permissions — ${stat.error}`);
  }
  process.exit(1);
}
if (duplicates.size > 0) {
  console.error('\nLedger ids are not unique — de-duplication would drop real rows.');
  process.exit(1);
}
if (gaps.length > 0 && !bounded) {
  console.error(
    `\nThe ledger does not reconcile against its own balance column in ${gaps.length} place(s):` +
      ' rows are missing from this extraction.',
  );
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Formatting
// ─────────────────────────────────────────────────────────────────────────────

function heading(title: string): void {
  console.log(`\n${title}\n${'─'.repeat(Math.max(title.length, 40))}`);
}

function date(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

/** A number without a wall of trailing zeros, but without rounding away detail. */
function trim(value: number): string {
  return String(Number(value.toFixed(8)));
}

function compact(value: unknown): string {
  if (value === undefined || value === null) return '—';
  if (typeof value === 'object') return JSON.stringify(value).slice(0, 44);
  return String(value);
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
