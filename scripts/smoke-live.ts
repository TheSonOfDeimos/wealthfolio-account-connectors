/**
 * Real-credential smoke test — the one thing the mock host cannot prove.
 *
 * Run with `pnpm smoke:live` after filling in `.env`. It performs the exact
 * two reads the addon performs, maps the result with the same mapper the addon
 * uses, and prints what would be imported. Nothing is written anywhere:
 * Wealthfolio is not involved, and no Trading 212 order is placed or changed.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  T212_LIVE_BASE_URL,
  Trading212Client,
  basicAuthHeader,
  mapOrdersToActivities,
} from '../packages/core/src/index';
import type { HttpTransport } from '../packages/core/src/index';

const env = loadEnv();
const apiKey = env.T212_API_KEY;
const apiSecret = env.T212_API_SECRET;
const baseUrl = env.T212_BASE_URL || T212_LIVE_BASE_URL;

if (!apiKey || !apiSecret) {
  console.error(
    'Missing credentials. Copy .env.example to .env and set T212_API_KEY and T212_API_SECRET.',
  );
  process.exit(1);
}

/** Node has real `fetch`, so out here the transport is trivial. */
const transport: HttpTransport = {
  async request(request) {
    const response = await fetch(request.url, {
      method: request.method ?? 'GET',
      headers: {
        ...request.headers,
        Authorization: basicAuthHeader(apiKey, apiSecret),
      },
      body: request.body,
    });
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: await response.text(),
    };
  },
};

const client = new Trading212Client({ transport, baseUrl });

console.log(`Trading 212: ${baseUrl}\n`);

const summary = await client.getAccountSummary();
console.log('Account summary');
console.log(`  account       ${summary.id}`);
console.log(`  free cash     ${summary.cash.availableToTrade} ${summary.currency}`);
console.log(`  investments   ${summary.investments.currentValue} ${summary.currency}`);
console.log(`  total value   ${summary.totalValue} ${summary.currency}`);
console.log(`  rate limit    ${describeRateLimit()}\n`);

const { items, pagesFetched, truncated } = await client.getAllHistoricalOrders({
  limit: 20,
  maxPages: 1,
});
console.log(`Order history: ${items.length} fills over ${pagesFetched} page(s)${truncated ? ' (more available)' : ''}\n`);

const mapped = mapOrdersToActivities(items, { accountId: '<wealthfolio-account-id>' });
console.log(`Mapped ${mapped.activities.length} activities, skipped ${mapped.skipped.length}:\n`);

for (const activity of mapped.activities) {
  console.log(
    `  ${String(activity.date).slice(0, 10)}  ${activity.activityType.padEnd(4)}  ` +
      `${String(activity.symbol).padEnd(8)}  qty ${activity.quantity}  @ ${activity.unitPrice} ` +
      `${activity.currency}  fee ${activity.fee}  tax ${activity.tax}`,
  );
}

for (const skip of mapped.skipped) {
  console.log(`  skipped ${skip.ticker}: ${skip.reason}`);
}

for (const warning of mapped.warnings) {
  console.log(`  warning: ${warning}`);
}

console.log('\nNothing was written. This script only reads.');

function describeRateLimit(): string {
  const { remaining, limit, period } = client.lastRateLimit;
  if (remaining === undefined) return 'not reported';
  return `${remaining}/${limit} left in a ${period}s window`;
}

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
