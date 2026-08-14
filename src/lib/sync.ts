import type {
  ActivityImport,
  AddonContext,
  ImportActivitiesResult,
} from '@wealthfolio/addon-sdk';
import { T212 } from 't212-sdk';
import type { AccountSummary, HistoricalOrder, TradableInstrument } from 't212-sdk';
import { MAX_HISTORY_PAGES, T212_ENVIRONMENT } from '../config';
import { createBrokeredFetch } from './brokered-fetch';
import { mapOrdersToActivities } from './mapper';
import type { MappingIssue } from './mapper';

/** The Trading 212 → Wealthfolio pipeline, with no React in sight. */

export interface PreviewResult {
  /** Rows as returned by `checkImport` — validated, with errors filled in. */
  activities: ActivityImport[];
  issues: MappingIssue[];
  /** True when more history exists beyond the page limit. */
  truncated: boolean;
  pagesFetched: number;
  validCount: number;
}

/** Read-only sanity check: proves the credentials and the broker both work. */
export async function fetchAccountSummary(ctx: AddonContext): Promise<AccountSummary> {
  return client(ctx).account.getSummary();
}

/**
 * Fetch order history, map it, and ask Wealthfolio to validate the result.
 *
 * `checkImport` is read-only — it returns the rows annotated with errors and
 * duplicate markers, and writes nothing. Nothing reaches the database until
 * `commitImport` is called.
 */
export async function previewImport(
  ctx: AddonContext,
  accountId: string,
  onProgress: (message: string) => void = () => {},
): Promise<PreviewResult> {
  const t212 = client(ctx);
  const loadIssues: MappingIssue[] = [];

  // Resolves Trading 212's opaque tickers to real symbols. One request returns
  // the whole catalogue, so it is fetched once and reused for every row.
  onProgress('Loading the Trading 212 instrument catalogue…');
  let instruments = new Map<string, TradableInstrument>();
  try {
    const list = await t212.instruments.list();
    instruments = new Map(list.map((item) => [item.ticker, item]));
  } catch (error) {
    // A missing catalogue costs symbol resolution, not the whole import.
    loadIssues.push({
      kind: 'warning',
      message: `Could not load the instrument catalogue (${
        error instanceof Error ? error.message : String(error)
      }). Raw Trading 212 tickers were used as symbols.`,
    });
  }

  onProgress('Fetching order history from Trading 212…');

  // The SDK's iterator handles the cursor and paces itself against the
  // endpoint's rate limit; we only decide how far back to walk.
  const entries: HistoricalOrder[] = [];
  let pagesFetched = 0;
  let truncated = false;

  for await (const page of t212.history.ordersPages()) {
    entries.push(...page.items);
    pagesFetched += 1;
    onProgress(`Fetched page ${pagesFetched} (${page.items.length} entries)…`);
    if (pagesFetched >= MAX_HISTORY_PAGES) {
      truncated = page.nextPagePath !== null;
      break;
    }
  }

  onProgress(`Mapping ${entries.length} entries…`);
  const { activities, issues } = mapOrdersToActivities(entries, accountId, instruments);

  onProgress('Validating against Wealthfolio…');
  const checked = activities.length > 0 ? await ctx.api.activities.checkImport(activities) : [];

  return {
    activities: checked,
    issues: [...loadIssues, ...issues],
    truncated,
    pagesFetched,
    validCount: checked.filter((row) => row.isValid).length,
  };
}

/**
 * Write the validated rows. The only call in the addon that mutates anything,
 * and the UI puts it behind an explicit confirmation.
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
function client(ctx: AddonContext): T212 {
  return new T212({
    apiKey: 'brokered',
    apiSecret: 'brokered',
    environment: T212_ENVIRONMENT,
    fetch: createBrokeredFetch(ctx),
  });
}
