/**
 * Real-credential smoke test.
 *
 * Run with `pnpm smoke:live` after filling in `.env`. It performs the same two
 * reads the addon performs and maps the result with the same mapper, then
 * prints what would be imported. Nothing is written anywhere: Wealthfolio is
 * not involved, and no Trading 212 order is placed or changed.
 *
 * Out here `t212-sdk` is used exactly as documented — Node has a real `fetch`,
 * so no broker adapter is needed.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { T212 } from 't212-sdk';
import type { HistoricalOrder } from 't212-sdk';
import { mapOrdersToActivities } from '../packages/core/src/index';

const env = loadEnv();
const apiKey = env.T212_API_KEY;
const apiSecret = env.T212_API_SECRET;
const environment = env.T212_ENVIRONMENT === 'demo' ? 'demo' : 'live';

if (!apiKey || !apiSecret) {
  console.error(
    'Missing credentials. Copy .env.example to .env and set T212_API_KEY and T212_API_SECRET.',
  );
  process.exit(1);
}

const client = new T212({ apiKey, apiSecret, environment });

console.log(`Trading 212: ${environment}\n`);

const summary = await client.account.getSummary();
console.log('Account summary');
console.log(`  account       ${summary.id}`);
console.log(`  free cash     ${summary.cash.availableToTrade} ${summary.currency}`);
console.log(`  investments   ${summary.investments.currentValue} ${summary.currency}`);
console.log(`  total value   ${summary.totalValue} ${summary.currency}\n`);

const entries: HistoricalOrder[] = [];
let pages = 0;
for await (const page of client.history.ordersPages()) {
  entries.push(...page.items);
  pages += 1;
  if (pages >= 2) break;
}
console.log(`Order history: ${entries.length} entries over ${pages} page(s)\n`);

const mapped = mapOrdersToActivities(entries, { accountId: '<wealthfolio-account-id>' });
console.log(`Mapped ${mapped.activities.length} activities, skipped ${mapped.skipped.length}:\n`);

for (const activity of mapped.activities) {
  console.log(
    `  ${String(activity.date).slice(0, 10)}  ${activity.activityType.padEnd(4)}  ` +
      `${String(activity.symbol).padEnd(8)}  qty ${activity.quantity}  @ ${activity.unitPrice} ` +
      `${activity.currency}  fee ${activity.fee}  tax ${activity.tax}`,
  );
}

for (const skip of mapped.skipped) {
  console.log(`  skipped ${skip.ticker ?? 'unknown'}: ${skip.reason}`);
}

for (const warning of mapped.warnings) {
  console.log(`  warning: ${warning}`);
}

console.log('\nNothing was written. This script only reads.');

/** Minimal .env reader — avoids a dependency for one file. */
function loadEnv(): Record<string, string> {
  const values: Record<string, string> = { ...(process.env as Record<string, string>) };
  try {
    const contents = readFileSync(resolve(process.cwd(), '.env'), 'utf-8');
    for (const line of contents.split('\n')) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (!key || values[key]) continue;
      values[key] = rawValue!.replace(/^["']|["']$/g, '').trim();
    }
  } catch {
    // No .env — fall back to the real environment.
  }
  return values;
}
