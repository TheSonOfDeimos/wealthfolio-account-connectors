import { requireCryptoComCredentials } from '../../../tools/credentials';
import { createCryptoComClient } from '../src/lib/client';
import { underlyingSymbol } from '../src/lib/mapper';

const ACCOUNT = '918a7d52-0db9-4286-9d4c-c4e8a5cbecf6';
const WF = 'http://127.0.0.1:8088/api/v1';

const { apiKey, apiSecret } = requireCryptoComCredentials();
const client = createCryptoComClient({ apiKey, apiSecret, fetch: globalThis.fetch });

// Both reads back to back, so price drift between them is seconds not minutes.
const [balance, holdings] = await Promise.all([
  client.privateCall<{ data?: { instrument_name: string; total_cash_balance: string; position_balances?: { instrument_name: string; quantity: string; market_value?: string }[] }[] }>(
    'private/user-balance',
  ),
  fetch(`${WF}/holdings?accountId=${ACCOUNT}`).then((r) => r.json()) as Promise<
    { instrument?: { symbol?: string }; holdingType?: string; quantity?: unknown; price?: unknown; marketValue?: { local?: number; base?: number } }[]
  >,
]);

const account = balance.data?.[0];
if (!account) throw new Error('no balance');

// Crypto.com, folding staked balances into the coin they are.
const theirs = new Map<string, { qty: number; value: number }>();
for (const p of account.position_balances ?? []) {
  const q = Number(p.quantity);
  if (!Number.isFinite(q) || q === 0) continue;
  const s = underlyingSymbol(p.instrument_name);
  const prev = theirs.get(s) ?? { qty: 0, value: 0 };
  theirs.set(s, { qty: prev.qty + q, value: prev.value + (Number(p.market_value) || 0) });
}

const ours = new Map<string, { qty: number; usd: number; gbp: number; price: number }>();
for (const h of holdings) {
  const s = h.instrument?.symbol ?? (h.holdingType === 'cash' ? 'USD' : undefined);
  if (!s) continue;
  ours.set(s, {
    qty: Number(h.quantity) || 0,
    usd: Number(h.marketValue?.local) || 0,
    gbp: Number(h.marketValue?.base) || 0,
    price: Number(h.price) || 0,
  });
}

const pct = (a: number, b: number) => (b === 0 ? (a === 0 ? 0 : 100) : Math.abs(a - b) / Math.abs(b) * 100);
const n = (v: number, d = 8) => String(Number(v.toFixed(d)));

console.log('QUANTITIES — must be exact\n');
console.log(`  ${'asset'.padEnd(8)}${'Crypto.com'.padStart(22)}${'Wealthfolio'.padStart(22)}   verdict`);
let qtyBad = 0;
for (const s of [...new Set([...theirs.keys(), ...ours.keys()])].sort()) {
  const t = theirs.get(s)?.qty ?? 0;
  const o = ours.get(s)?.qty ?? 0;
  const ok = Math.abs(t - o) < 1e-8 || (t !== 0 && Math.abs(t - o) / Math.abs(t) < 1e-9);
  if (!ok) qtyBad += 1;
  console.log(`  ${s.padEnd(8)}${n(t).padStart(22)}${n(o).padStart(22)}   ${ok ? 'exact' : `OFF by ${n(t - o)}`}`);
}

console.log('\nVALUATION (USD) — price feeds differ, so small gaps are expected\n');
console.log(`  ${'asset'.padEnd(8)}${'Crypto.com'.padStart(14)}${'Wealthfolio'.padStart(14)}${'diff'.padStart(11)}${'%'.padStart(9)}`);
let tT = 0, tO = 0;
for (const s of [...theirs.keys()].sort()) {
  const t = theirs.get(s)!.value;
  const o = ours.get(s)?.usd ?? 0;
  tT += t; tO += o;
  console.log(`  ${s.padEnd(8)}${t.toFixed(2).padStart(14)}${o.toFixed(2).padStart(14)}${(o - t).toFixed(2).padStart(11)}${pct(o, t).toFixed(2).padStart(8)}%`);
}
console.log(`  ${'—'.padEnd(8)}${tT.toFixed(2).padStart(14)}${tO.toFixed(2).padStart(14)}${(tO - tT).toFixed(2).padStart(11)}${pct(tO, tT).toFixed(2).padStart(8)}%`);

console.log(`\n  Crypto.com total_cash_balance: ${account.total_cash_balance} ${account.instrument_name}`);
console.log(`  Wealthfolio account total:     ${[...ours.values()].reduce((a, b) => a + b.gbp, 0).toFixed(2)} GBP`);
console.log(`\n  quantities off: ${qtyBad}`);
