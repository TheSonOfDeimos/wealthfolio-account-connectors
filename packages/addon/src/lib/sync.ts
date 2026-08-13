import { Trading212Client, mapOrdersToActivities } from '@t212/core';
import type { SkippedFill, T212AccountSummary } from '@t212/core';
import type {
  ActivityImport,
  AddonContext,
  ImportActivitiesResult,
} from '@wealthfolio/addon-sdk';
import { SYNC_DEFAULTS, T212_BASE_URL } from '../config';
import { createNetworkTransport } from './transport';

/**
 * The whole Trading 212 → Wealthfolio pipeline, with no React in sight.
 *
 * Keeping it here rather than inside a component is what lets the test suite
 * drive the real code path against a fake AddonContext — there is no official
 * mock host, so this separation is how the addon gets verified without a
 * running Wealthfolio.
 */

export interface PreviewOptions {
  accountId: string;
  pageSize?: number;
  maxPages?: number;
  /** Set to 0 in tests to skip the rate-limit pacing. */
  minRequestIntervalMs?: number;
  onProgress?: (message: string) => void;
}

export interface PreviewResult {
  /** Rows as returned by `checkImport` — validated, with errors filled in. */
  activities: ActivityImport[];
  /** Fills the mapper deliberately did not convert. */
  skipped: SkippedFill[];
  /** Mapping observations worth reading before importing. */
  warnings: string[];
  /** True when more history exists beyond `maxPages`. */
  truncated: boolean;
  pagesFetched: number;
  validCount: number;
  invalidCount: number;
}

/** Read-only sanity check: proves the credentials and the broker both work. */
export async function fetchAccountSummary(ctx: AddonContext): Promise<T212AccountSummary> {
  return createClient(ctx).getAccountSummary();
}

/**
 * Fetch order history, map it, and ask Wealthfolio to validate the result.
 *
 * `checkImport` is read-only — it returns the rows annotated with errors,
 * warnings and duplicate markers, and writes nothing. Nothing reaches the
 * database until `commitImport` is called.
 */
export async function previewImport(
  ctx: AddonContext,
  options: PreviewOptions,
): Promise<PreviewResult> {
  const client = createClient(ctx, options.minRequestIntervalMs);
  const progress = options.onProgress ?? (() => {});

  progress('Fetching order history from Trading 212…');
  const { items, pagesFetched, truncated } = await client.getAllHistoricalOrders({
    limit: options.pageSize ?? SYNC_DEFAULTS.pageSize,
    maxPages: options.maxPages ?? SYNC_DEFAULTS.maxPages,
    onPage: (page, pageNumber) =>
      progress(`Fetched page ${pageNumber} (${page.items.length} fills)…`),
  });

  progress(`Mapping ${items.length} fills to Wealthfolio activities…`);
  const mapped = mapOrdersToActivities(items, { accountId: options.accountId });

  if (mapped.activities.length === 0) {
    return {
      activities: [],
      skipped: mapped.skipped,
      warnings: mapped.warnings,
      truncated,
      pagesFetched,
      validCount: 0,
      invalidCount: 0,
    };
  }

  progress('Validating against Wealthfolio…');
  const checked = await ctx.api.activities.checkImport(mapped.activities);

  return {
    activities: checked,
    skipped: mapped.skipped,
    warnings: mapped.warnings,
    truncated,
    pagesFetched,
    validCount: checked.filter((row) => row.isValid).length,
    invalidCount: checked.filter((row) => !row.isValid).length,
  };
}

/**
 * Write the validated rows. This is the only call in the addon that mutates
 * anything, and the UI puts it behind an explicit confirmation.
 */
export async function commitImport(
  ctx: AddonContext,
  activities: ActivityImport[],
): Promise<ImportActivitiesResult> {
  const importable = activities.filter((row) => row.isValid);
  if (importable.length === 0) {
    throw new Error('Nothing to import — no row passed validation.');
  }
  return ctx.api.activities.import(importable);
}

function createClient(ctx: AddonContext, minRequestIntervalMs?: number): Trading212Client {
  return new Trading212Client({
    transport: createNetworkTransport(ctx),
    baseUrl: T212_BASE_URL,
    minRequestIntervalMs: minRequestIntervalMs ?? SYNC_DEFAULTS.minRequestIntervalMs,
  });
}
