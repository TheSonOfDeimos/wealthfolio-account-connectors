import type { ActivityImport, AddonContext } from '@wealthfolio/addon-sdk';
import { HISTORY_PAGE_LIMIT, MAX_HISTORY_ITEMS, T212_ENVIRONMENT } from '../config';
import { createBrokeredFetch } from './brokered-fetch';
import { buildAssetIndex, createRawGet, extractAll } from './extract';
import type { T212Dataset, T212Source } from './extract';
import { activityKeyOf, mapDataset } from './mapper';
import type { MappingIssue } from './mapper';
import { loadOverrides, reviewSymbols } from './symbols';
import type { SymbolReview } from './symbols';
import { T212 } from 't212-sdk';

/**
 * The three things the addon can do to your data, and the reporting they emit
 * while doing it.
 *
 * Every run is long — minutes, mostly spent waiting on Trading 212's rate
 * limiter — so each step announces itself. Nothing here decides anything on its
 * own: the caller chooses the mode and the account, and a wipe is only ever
 * reached through an explicit confirmation in the UI.
 */

export type LogLevel = 'info' | 'success' | 'warn' | 'error';

export interface LogEntry {
  at: string;
  level: LogLevel;
  message: string;
}

export interface Progress {
  /** Which stage of the run this is, for the progress bar's label. */
  phase: string;
  message: string;
  /** Set when the stage has countable work; drives the bar. */
  done?: number;
  total?: number;
}

export interface Reporter {
  log: (level: LogLevel, message: string) => void;
  progress: (progress: Progress) => void;
}

export type SyncMode =
  /** First run: walk the whole history. */
  | 'full'
  /** Routine run: stop as soon as Trading 212 shows something already held. */
  | 'incremental'
  /** Delete everything this addon imported into the account, then re-import. */
  | 'wipe';

export interface SyncResult {
  mode: SyncMode;
  imported: number;
  duplicates: number;
  deleted: number;
  /** Rows the host rejected during validation. */
  invalid: number;
  issues: MappingIssue[];
  dataset: T212Dataset;
  /** Per-holding symbol check, for the UI to surface anything that needs a look. */
  review: SymbolReview[];
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build both Trading 212 transports over the host's network broker.
 *
 * The credentials given to the SDK are placeholders it never gets to use:
 * `createBrokeredFetch` strips the `Authorization` header it builds, and the
 * host attaches the real one from the keyring. `rawGet` sends no
 * `Authorization` at all, for the same reason.
 */
export function source(ctx: AddonContext): T212Source {
  const fetch = createBrokeredFetch(ctx);
  return {
    client: new T212({
      apiKey: 'brokered',
      apiSecret: 'brokered',
      environment: T212_ENVIRONMENT,
      fetch,
    }),
    rawGet: createRawGet({ environment: T212_ENVIRONMENT, fetch }),
  };
}

/**
 * Run a sync end to end.
 *
 * The order is deliberate. Existing rows are read first so an incremental walk
 * knows where to stop; a wipe deletes before importing so a failure part way
 * through leaves an empty account rather than a doubled one; and prices are
 * updated last, because they depend on the holdings the import just created.
 */
export async function runSync(
  ctx: AddonContext,
  accountId: string,
  mode: SyncMode,
  reporter: Reporter,
): Promise<SyncResult> {
  const { log, progress } = reporter;

  progress({ phase: 'Reading Wealthfolio', message: 'Checking what is already imported…' });
  const existing = await readImportedKeys(ctx, accountId);
  log('info', `${existing.size} activities already imported into this account.`);

  let deleted = 0;
  if (mode === 'wipe') {
    deleted = await deleteImported(ctx, accountId, reporter);
    existing.clear();
  }

  // An incremental walk stops at the first row it already holds. A wipe has
  // just emptied the account, so it walks everything, exactly like a first run.
  const knownSourceIds = mode === 'incremental' ? sourceIdsOf(existing) : undefined;

  // The item cap is a safety net for a walk that expects to stop early. With
  // nothing already imported there is nothing to stop at, so an "incremental"
  // sync of an empty account has to behave like a first run — otherwise it
  // would quietly import the most recent 200 rows and call itself finished.
  const bounded = mode === 'incremental' && existing.size > 0;
  if (mode === 'incremental' && !bounded) {
    log('info', 'Nothing imported yet, so this run fetches the whole history.');
  }

  progress({ phase: 'Trading 212', message: 'Fetching history…' });
  const dataset = await extractAll(source(ctx), {
    streams: ['summary', 'positions', 'instruments', 'exchanges', 'orders', 'dividends', 'transactions'],
    maxItemsPerStream: bounded ? MAX_HISTORY_ITEMS : Infinity,
    pageLimit: HISTORY_PAGE_LIMIT,
    knownSourceIds,
    onProgress: (event) =>
      progress({ phase: 'Trading 212', message: `${event.stream}: ${event.message}` }),
  });

  for (const stat of dataset.stats) {
    if (stat.error) log('error', `${stat.stream} failed: ${stat.error}`);
    else if (stat.skipped) continue;
    else if (stat.truncated) log('warn', `${stat.stream}: stopped at the item limit, more exists.`);
    else log('info', `${stat.stream}: ${stat.items} items in ${(stat.elapsedMs / 1000).toFixed(1)}s.`);
  }

  progress({ phase: 'Mapping', message: 'Translating Trading 212 records…' });
  const assets = buildAssetIndex(dataset);
  const overrides = await loadOverrides(ctx, accountId);
  if (Object.keys(overrides).length > 0) {
    log('info', `${Object.keys(overrides).length} symbol override(s) applied.`);
  }
  const { activities, issues } = mapDataset(dataset, accountId, assets, overrides);
  log('info', `Mapped ${activities.length} activities.`);
  for (const issue of issues.slice(0, 50)) {
    log(issue.kind === 'skipped' ? 'info' : 'warn', issue.message);
  }
  if (issues.length > 50) log('info', `…and ${issues.length - 50} more notes.`);

  // Rows already present are dropped here rather than relying on the host's
  // duplicate detection, which matches on shape and would let a genuine repeat
  // trade through while blocking a legitimate second fill at the same price.
  const fresh = activities.filter((row) => {
    const key = activityKeyOf(row.comment);
    return key === undefined || !existing.has(key);
  });
  const duplicates = activities.length - fresh.length;
  if (duplicates > 0) log('info', `${duplicates} already imported, skipped.`);

  let imported = 0;
  let invalid = 0;
  if (fresh.length > 0) {
    // Sent in batches because the host rejects a large payload outright: a
    // single `checkImport` of ~1000 rows comes back 422 Unprocessable Entity,
    // with no indication which row was at fault, because none of them was.
    let done = 0;
    let size = IMPORT_BATCH;

    while (done < fresh.length) {
      const batch = fresh.slice(done, done + size);
      progress({
        phase: 'Importing',
        message: `Validating ${done + 1}–${done + batch.length} of ${fresh.length}…`,
        done,
        total: fresh.length,
      });

      let checked;
      try {
        checked = await ctx.api.activities.checkImport(batch);
      } catch (error) {
        // Almost always the request timing out on symbol resolution. Halving
        // and retrying costs one wasted call and gets the run moving again;
        // giving up would cost the whole import.
        if (size > MIN_BATCH) {
          size = Math.max(MIN_BATCH, Math.floor(size / 2));
          log('warn', `Validation failed for ${batch.length} rows, retrying in batches of ${size}.`);
          continue;
        }
        throw error;
      }

      const valid = checked.filter((row) => row.isValid);
      invalid += checked.length - valid.length;

      for (const row of checked.filter((candidate) => !candidate.isValid).slice(0, 3)) {
        log('warn', `Rejected ${row.symbol ?? row.activityType}: ${describeErrors(row)}`);
      }

      if (valid.length > 0) {
        progress({
          phase: 'Importing',
          message: `Writing ${valid.length} activities…`,
          done: done + batch.length,
          total: fresh.length,
        });
        const result = await ctx.api.activities.import(valid);
        imported += result.summary.imported;
      }

      done += batch.length;
    }
    log(
      imported > 0 ? 'success' : 'warn',
      imported > 0
        ? `Imported ${imported} activities${invalid > 0 ? `, ${invalid} rejected` : ''}.`
        : 'Nothing passed validation, so nothing was written.',
    );
  } else {
    log('success', 'Already up to date — nothing new on Trading 212.');
  }

  progress({ phase: 'Recalculating', message: 'Asking Wealthfolio to revalue the portfolio…' });
  await ctx.api.portfolio.recalculate();

  // Read back what Wealthfolio made of the symbols, so the UI can point at the
  // ones worth a second look rather than making you hunt for them.
  const review = await reviewSymbols(ctx, accountId, dataset, assets, overrides);
  const needsAttention = review.filter((row) => row.status !== 'ok');
  if (needsAttention.length > 0) {
    log('warn', `${needsAttention.length} holding(s) need a symbol check — see Symbols below.`);
  }
  log('success', 'Done.');

  return { mode, imported, duplicates, deleted, invalid, issues, dataset, review };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Recognising and removing our own rows
// ─────────────────────────────────────────────────────────────────────────────

/** Keys of the activities this addon has already written to an account. */
export async function readImportedKeys(
  ctx: AddonContext,
  accountId: string,
): Promise<Map<string, string>> {
  const activities = await ctx.api.activities.getAll(accountId);
  const keys = new Map<string, string>();
  for (const activity of activities) {
    const key = activityKeyOf(activity.comment);
    if (key) keys.set(key, activity.id);
  }
  return keys;
}

/**
 * The source ids behind a set of activity keys.
 *
 * A fill's charges carry keys derived from the fill's own — `…:charge:0` — so
 * the suffix is trimmed to recover the id the extractor will compare against.
 */
function sourceIdsOf(keys: Map<string, string>): Set<string> {
  const ids = new Set<string>();
  for (const key of keys.keys()) ids.add(key.replace(/:charge:\d+$/, ''));
  return ids;
}

/**
 * Delete every activity this addon imported into the account.
 *
 * Only rows whose comment carries a `t212:` key are touched, so anything you
 * entered by hand into the same account survives. The account itself cannot be
 * deleted — the host gives addons `getAll` and `create` and nothing else.
 */
export async function deleteImported(
  ctx: AddonContext,
  accountId: string,
  reporter: Reporter,
): Promise<number> {
  const keys = await readImportedKeys(ctx, accountId);
  const ids = [...keys.values()];
  if (ids.length === 0) {
    reporter.log('info', 'Nothing to remove — no imported activities found.');
    return 0;
  }

  reporter.progress({ phase: 'Wiping', message: `Removing ${ids.length} activities…` });
  const result = await ctx.api.activities.saveMany({ deleteIds: ids });
  const deleted = result.deleted.length;
  reporter.log('success', `Removed ${deleted} previously imported activities.`);
  if (deleted < ids.length) {
    reporter.log('warn', `${ids.length - deleted} could not be removed.`);
  }
  return deleted;
}



// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rows per `checkImport` / `import` call, and how far it will back off.
 *
 * Batch size is a compromise between two host limits pulling in opposite
 * directions. Too large and validation exceeds the server's request timeout —
 * 30 seconds by default — because every unfamiliar symbol in the batch is
 * resolved against market-data providers one at a time, which is slow and
 * slowest of all on the first run when nothing is cached. Too small and a
 * thousand activities become a hundred round trips.
 *
 * Rather than pick a number that happens to work on one machine, a batch that
 * fails is halved and retried until it succeeds or reaches `MIN_BATCH`. That
 * adapts to a slow provider, a cold cache, or a host configured with a shorter
 * timeout, without needing to know which.
 */
const IMPORT_BATCH = 50;
const MIN_BATCH = 5;


function describeErrors(row: ActivityImport): string {
  if (!row.errors) return 'no reason given';
  return Object.entries(row.errors)
    .map(([field, messages]) => `${field}: ${messages.join(', ')}`)
    .join('; ');
}
