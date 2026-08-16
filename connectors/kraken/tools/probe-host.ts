/**
 * What does Wealthfolio actually do with the rows this connector wants to send?
 *
 *   pnpm docker:up          # from the repo root
 *   pnpm probe:host
 *   pnpm probe:host -- --keep     # leave the probe account behind to inspect
 *
 * The repository's rule is that compiling is not evidence and the SDK types
 * describe their backend inaccurately in places. Six behaviours decide the
 * shape of the Kraken mapper, and every one of them is cheaper to settle here —
 * against a real host, in seconds — than to discover after a mapper has been
 * written around a guess.
 *
 * It writes a handful of activities into a throwaway account over the
 * container's REST API and reads them back. Nothing touches Kraken, and the
 * account is deleted unless `--keep`.
 */

export {};

const BASE = process.env.WF_URL ?? 'http://127.0.0.1:8088';

const args = process.argv.slice(2);
const keep = args.includes('--keep');

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
//  The cases
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Each probe sends one row and states what we want to learn from it. `comment`
 * is the handle used to find the row again, since the host assigns its own id.
 */
interface Probe {
  key: string;
  question: string;
  row: Record<string, unknown>;
  /** What to read off the stored row. */
  read: (stored: Record<string, unknown> | undefined) => string;
}

const PROBES: Probe[] = [
  {
    key: 'no-unit-price',
    question: 'BUY with quantity + amount but NO unitPrice — accepted? derived?',
    row: {
      activityType: 'BUY',
      asset: { symbol: 'BTC', kind: 'CRYPTO', quoteCcy: 'GBP' },
      quantity: '0.00513309',
      amount: '297.03',
      currency: 'GBP',
      fee: '2.97',
    },
    read: (stored) =>
      stored === undefined
        ? 'REJECTED — the host requires unitPrice'
        : `stored unitPrice=${fmt(stored.unitPrice)} quantity=${fmt(stored.quantity)} amount=${fmt(stored.amount)}`,
  },
  {
    key: 'with-unit-price',
    question: 'The same BUY with unitPrice computed as amount / quantity — baseline',
    row: {
      activityType: 'BUY',
      asset: { symbol: 'BTC', kind: 'CRYPTO', quoteCcy: 'GBP' },
      quantity: '0.00513309',
      unitPrice: '57865.72999889',
      amount: '297.03',
      currency: 'GBP',
      fee: '2.97',
    },
    read: (stored) =>
      stored === undefined
        ? 'REJECTED'
        : `stored unitPrice=${fmt(stored.unitPrice)} amount=${fmt(stored.amount)}`,
  },
  {
    key: 'crypto-kind',
    question: "asset.kind 'CRYPTO' on an unknown coin — does it beat the host's guess?",
    row: {
      activityType: 'BUY',
      // Deliberately not in Wealthfolio's hardcoded list of 28 known coins. Sent
      // bare, without a -USD suffix, it would otherwise be filed as an equity.
      asset: { symbol: 'TAO', kind: 'CRYPTO', quoteCcy: 'GBP' },
      quantity: '0.38329290',
      unitPrice: '250.00',
      amount: '95.82',
      currency: 'GBP',
    },
    read: (stored) =>
      stored === undefined
        ? 'REJECTED'
        : `instrumentType=${stored.instrumentType} symbol=${stored.assetSymbol}`,
  },
  {
    key: 'no-kind',
    question: 'The same coin with NO kind — confirms the misclassification is real',
    row: {
      activityType: 'BUY',
      asset: { symbol: 'GRT', quoteCcy: 'GBP' },
      quantity: '1030.82',
      unitPrice: '0.08',
      amount: '82.47',
      currency: 'GBP',
    },
    read: (stored) =>
      stored === undefined ? 'REJECTED' : `instrumentType=${stored.instrumentType}`,
  },
  {
    key: 'provenance',
    question: 'sourceSystem / sourceRecordId / idempotencyKey / needsReview — forwarded?',
    row: {
      activityType: 'INTEREST',
      asset: { symbol: 'ADA', kind: 'CRYPTO', quoteCcy: 'GBP' },
      quantity: '4.27462489',
      amount: '0.75',
      currency: 'GBP',
      subtype: 'STAKING_REWARD',
      sourceSystem: 'KRAKEN',
      sourceRecordId: 'LMTTMW-R5HOR-6NT4KJ',
      idempotencyKey: 'kraken:LMTTMW-R5HOR-6NT4KJ',
      needsReview: true,
    },
    read: (stored) =>
      stored === undefined
        ? 'REJECTED'
        : `sourceSystem=${stored.sourceSystem} sourceRecordId=${stored.sourceRecordId} ` +
          `idempotencyKey=${String(stored.idempotencyKey).slice(0, 24)} ` +
          `needsReview=${stored.needsReview} subtype=${stored.subtype}`,
  },
  {
    // A staking reward arrives as a quantity of an asset, and Kraken states no
    // fiat value for it. Zero cost is the only figure that is not invented —
    // but only if the host actually creates a holding from it rather than
    // discarding a row whose consideration is nothing.
    key: 'zero-cost-buy',
    question: 'BUY at unitPrice 0 (a staking reward) — does it create a holding?',
    row: {
      activityType: 'BUY',
      asset: { symbol: 'SOL', kind: 'CRYPTO', quoteCcy: 'GBP' },
      quantity: '1.5',
      unitPrice: '0',
      amount: '0',
      currency: 'GBP',
    },
    read: (stored) =>
      stored === undefined
        ? 'REJECTED'
        : `stored quantity=${fmt(stored.quantity)} unitPrice=${fmt(stored.unitPrice)}`,
  },
  {
    // The alternative shape for acquiring an asset without paying for it.
    key: 'transfer-in',
    question: 'TRANSFER_IN with a quantity — accepted, and what does it do?',
    row: {
      activityType: 'TRANSFER_IN',
      asset: { symbol: 'LTC', kind: 'CRYPTO', quoteCcy: 'GBP' },
      quantity: '2.5',
      unitPrice: '0',
      amount: '0',
      currency: 'GBP',
    },
    read: (stored) =>
      stored === undefined
        ? 'REJECTED'
        : `stored quantity=${fmt(stored.quantity)} amount=${fmt(stored.amount)}`,
  },
  {
    key: 'crypto-currency',
    question: "currency 'BTC' — accepted, and does anything object?",
    row: {
      activityType: 'BUY',
      asset: { symbol: 'ETH', kind: 'CRYPTO', quoteCcy: 'BTC' },
      quantity: '1.0',
      unitPrice: '0.05',
      amount: '0.05',
      currency: 'BTC',
    },
    read: (stored) =>
      stored === undefined
        ? 'REJECTED — a crypto currency is refused outright'
        : `ACCEPTED, stored currency=${stored.currency} — nothing objects at write time`,
  },
];

function fmt(value: unknown): string {
  return value === null || value === undefined ? 'null' : String(value);
}

// ─────────────────────────────────────────────────────────────────────────────

const account = await api<{ id: string; name: string }>('POST', '/accounts', {
  name: `Kraken probe ${new Date().toISOString().slice(0, 19)}`,
  accountType: 'SECURITIES',
  currency: 'GBP',
  isDefault: false,
  isActive: true,
  trackingMode: 'TRANSACTIONS',
  group: 'Probe',
});

console.log(`\nProbing ${BASE}`);
console.log(`Account ${account.name} (${account.id})\n`);

const creates = PROBES.map((probe) => ({
  ...probe.row,
  accountId: account.id,
  activityDate: '2026-01-31T12:00:00.000Z',
  comment: `probe:${probe.key}`,
}));

const result = await api<{ created: unknown[]; errors: { message?: string }[] }>(
  'POST',
  '/activities/bulk',
  { creates },
);

console.log(`Wrote ${result.created.length}/${creates.length} rows, ${result.errors.length} rejected.`);
for (const error of result.errors) {
  console.log(`  rejected: ${JSON.stringify(error).slice(0, 220)}`);
}

// Read back what the host actually stored, which is the only thing that counts.
//
// `/activities/search` ignores every filter tried against it — `accountId`,
// `accountIds`, `filters.accountId` and `searchQuery` all return the same
// unfiltered total — so the whole set is pulled and narrowed here. Believing
// the filter worked is how the first version of this probe reported all six
// rows rejected while the host had written every one of them.
// A second trap: `pageSize` has an undocumented ceiling, and exceeding it
// returns an empty page rather than an error. 500 works, 1000 silently yields
// nothing. Paged at 100 for that reason.
const byKey = new Map<string, Record<string, unknown>>();
let scanned = 0;
for (let page = 1; page <= 50; page += 1) {
  const search = await api<{ data: Record<string, unknown>[] }>('POST', '/activities/search', {
    page,
    pageSize: 100,
  });
  if (search.data.length === 0) break;
  scanned += search.data.length;
  for (const row of search.data) {
    if (row.accountId !== account.id) continue;
    const comment = String(row.comment ?? '');
    if (comment.startsWith('probe:')) byKey.set(comment.slice('probe:'.length), row);
  }
  if (byKey.size === PROBES.length) break;
}
console.log(`Read back ${byKey.size}/${PROBES.length} probe rows, scanning ${scanned} activities.\n`);

console.log('');
for (const probe of PROBES) {
  const stored = byKey.get(probe.key);
  console.log(`  ${probe.question}`);
  console.log(`    → ${probe.read(stored)}\n`);
}

// The quote currency a crypto asset ends up with is part of its identity —
// `CRYPTO:SYMBOL/QUOTECCY` — so sending the wrong one creates a different
// asset rather than mislabelling one. Worth seeing what was actually stored.
const assets = await api<Record<string, unknown>[]>('GET', '/assets');
const touched = assets.filter((asset) =>
  ['BTC', 'TAO', 'GRT', 'ADA', 'ETH'].includes(String(asset.displayCode ?? asset.symbol ?? '')),
);
if (touched.length > 0) {
  console.log('  Assets created by this probe:');
  console.log(`    ${'symbol'.padEnd(10)}${'kind'.padEnd(13)}${'instrumentType'.padEnd(16)}${'quoteCcy'.padEnd(10)}id`);
  for (const asset of touched) {
    console.log(
      `    ${String(asset.displayCode ?? asset.symbol ?? '?').padEnd(10)}` +
        `${String(asset.kind ?? '—').padEnd(13)}${String(asset.instrumentType ?? '—').padEnd(16)}` +
        `${String(asset.quoteCcy ?? '—').padEnd(10)}${String(asset.id).slice(0, 8)}`,
    );
  }
}

// Whether a row was *stored* and whether it *became a holding* are different
// questions, and only the second one matters for a staking reward. The host
// recalculates in the background, so this waits rather than reading too early.
await api('POST', '/portfolio/recalculate');
process.stdout.write('  recalculating');
let holdings: { holdingType?: string; quantity?: number; instrument?: { symbol?: string } | null }[] = [];
for (let attempt = 0; attempt < 20; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 3000));
  holdings = await api('GET', `/holdings?accountId=${account.id}`);
  if (holdings.length > 0) break;
  process.stdout.write('.');
}
console.log(holdings.length > 0 ? ' done' : ' gave up waiting');

console.log(`\n  Holdings produced (${holdings.length}):`);
console.log(`    ${'symbol'.padEnd(12)}${'type'.padEnd(12)}quantity`);
for (const holding of holdings) {
  console.log(
    `    ${String(holding.instrument?.symbol ?? '—').padEnd(12)}` +
      `${String(holding.holdingType ?? '—').padEnd(12)}${holding.quantity ?? '—'}`,
  );
}
console.log(
  '\n    SOL 1.5 present ⇒ a zero-cost BUY is a usable shape for a staking reward.\n' +
    '    LTC 2.5 present ⇒ TRANSFER_IN works too; cash impact is the deciding difference.',
);

if (keep) {
  console.log(`\nAccount kept: open ${BASE} to inspect it.`);
} else {
  await api('DELETE', `/accounts/${account.id}`);
  console.log('\nProbe account deleted. Pass --keep to inspect it in the UI instead.');
  console.log('Assets it created remain — the host gives no way to remove those.');
}
