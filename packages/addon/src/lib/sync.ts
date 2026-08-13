import { mapOrdersToActivities } from '@t212/core';
import type { SkippedFill } from '@t212/core';
import type {
  ActivityImport,
  AddonContext,
  ImportActivitiesResult,
} from '@wealthfolio/addon-sdk';
import { T212 } from 't212-sdk';
import type { AccountSummary, HistoricalOrder } from 't212-sdk';
import { SYNC_DEFAULTS, T212_ENVIRONMENT } from '../config';
import { createBrokeredFetch } from './brokered-fetch';

/**
 * The whole Trading 212 → Wealthfolio pipeline, with no React in sight.
 *
 * Trading 212 itself is handled by `t212-sdk`; this module wires it to the
 * sandbox, maps the result, and drives Wealthfolio's two-phase import.
 */

export interface PreviewOptions {
  accountId: string;
  maxPages?: number;
  onProgress?: (message: string) => void;
}

export interface PreviewResult {
  /** Rows as returned by `checkImport` — validated, with errors filled in. */
  activities: ActivityImport[];
  /** Entries the mapper deliberately did not convert. */
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
export async function fetchAccountSummary(ctx: AddonContext): Promise<AccountSummary> {
  return createClient(ctx).account.getSummary();
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
  const client = createClient(ctx);
  const progress = options.onProgress ?? (() => {});
  const maxPages = options.maxPages ?? SYNC_DEFAULTS.maxPages;

  progress('Fetching order history from Trading 212…');

  // The SDK's page iterator handles the cursor and paces itself against the
  // endpoint's rate limit; we only decide how far back to walk.
  const entries: HistoricalOrder[] = [];
  let pagesFetched = 0;
  let truncated = false;

  for await (const page of client.history.ordersPages()) {
    entries.push(...page.items);
    pagesFetched += 1;
    progress(`Fetched page ${pagesFetched} (${page.items.length} entries)…`);
    if (pagesFetched >= maxPages) {
      truncated = page.nextPagePath !== null;
      break;
    }
  }

  progress(`Mapping ${entries.length} entries to Wealthfolio activities…`);
  const mapped = mapOrdersToActivities(entries, { accountId: options.accountId });

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

/**
 * Build the Trading 212 client.
 *
 * The credentials passed here are placeholders and are never used: the SDK
 * builds an `Authorization` header from them, and `createBrokeredFetch` drops
 * it in favour of `auth.secretKey`, which the host resolves from the keyring.
 * The SDK's constructor rejects empty strings, hence the filler values.
 */
function createClient(ctx: AddonContext): T212 {
  return new T212({
    apiKey: 'brokered',
    apiSecret: 'brokered',
    environment: T212_ENVIRONMENT,
    fetch: createBrokeredFetch(ctx),
  });
}
