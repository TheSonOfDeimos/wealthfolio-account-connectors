/**
 * Which activity type records a position change that Wealthfolio does NOT
 * treat as an external cash flow?
 *
 * The question behind a real failure: 17 `TRANSFER_IN`/`TRANSFER_OUT` rows —
 * on-chain deposits, withdrawals and dust sweeps — put "17 incomplete
 * transfers detected" on the data-health page, and the host says why: "A
 * transfer is unpaired or missing its matching leg, so its flow was treated as
 * external and may distort returns." It did: TWR and IRR both came back N/A and
 * the account chart showed 674% volatility against a -100% drawdown.
 *
 * Wealthfolio reads a transfer as a move between two accounts. These are not —
 * they are coins entering or leaving the account with no counterpart anywhere
 * in the portfolio. There is no ADD_HOLDING in the SDK's list, so the candidate
 * types are ADJUSTMENT, a zero-priced BUY/SELL, or leaving them as transfers.
 *
 * This writes one of each into a throwaway account and reads back what the host
 * made of them. Nothing touches a real account, and nothing here talks to
 * Crypto.com.
 */
const BASE = process.env.WF_BASE ?? 'http://127.0.0.1:8088';

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${text.slice(0, 300)}`);
  return text ? (JSON.parse(text) as T) : ({} as T);
}

const stamp = Date.now();
const account = await api<{ id: string }>('POST', '/accounts', {
  name: `probe-transfer-${stamp}`,
  accountType: 'SECURITIES',
  currency: 'USD',
  isDefault: false,
  isActive: true,
  trackingMode: 'TRANSACTIONS',
});
console.log(`Throwaway account ${account.id}\n`);

const asset = { symbol: 'BTC', kind: 'CRYPTO', quoteCcy: 'USD', name: 'Bitcoin' };
const day = (n: number) => new Date(Date.now() - n * 86400000).toISOString();

// Fund it so there is a cash base, then try each shape of "units arrive".
const candidates = [
  { label: 'DEPOSIT (cash, the baseline)', row: { activityType: 'DEPOSIT', amount: '10000', currency: 'USD', activityDate: day(30) } },
  { label: 'TRANSFER_IN  qty, price 0', row: { activityType: 'TRANSFER_IN', asset, quantity: '0.01', unitPrice: '0', amount: '0', currency: 'USD', activityDate: day(20) } },
  { label: 'ADJUSTMENT   qty, price 0', row: { activityType: 'ADJUSTMENT', asset, quantity: '0.01', unitPrice: '0', amount: '0', currency: 'USD', activityDate: day(19) } },
  { label: 'BUY          qty, price 0', row: { activityType: 'BUY', asset, quantity: '0.01', unitPrice: '0', amount: '0', currency: 'USD', activityDate: day(18) } },
];

for (const [index, candidate] of candidates.entries()) {
  const row = {
    accountId: account.id,
    comment: candidate.label,
    sourceSystem: 'PROBE',
    sourceRecordId: `probe-${stamp}-${index}`,
    idempotencyKey: `probe:${stamp}:${index}`,
    ...candidate.row,
  };
  try {
    const result = await api<{ created: unknown[]; errors: unknown[] }>('POST', '/activities/bulk', {
      creates: [row],
    });
    console.log(
      `${candidate.label.padEnd(30)} created=${result.created.length} errors=${result.errors.length}` +
        (result.errors.length ? ` ${JSON.stringify(result.errors).slice(0, 180)}` : ''),
    );
  } catch (error) {
    console.log(`${candidate.label.padEnd(30)} REJECTED ${String(error).slice(0, 200)}`);
  }
}

await api('POST', '/portfolio/recalculate');
await new Promise((resolve) => setTimeout(resolve, 9000));

const holdings = await api<{ instrument?: { symbol?: string }; quantity?: unknown }[]>(
  'GET',
  `/holdings?accountId=${account.id}`,
);
console.log('\nHoldings the host ended up with:');
for (const holding of holdings) {
  console.log(`  ${String(holding.instrument?.symbol ?? 'cash').padEnd(8)} qty=${holding.quantity}`);
}

console.log(`\nAccount ${account.id} left in place — delete it from Settings → Accounts.`);

export {};
