/**
 * A sync end to end: fetch, map, write, revalue.
 *
 * Nothing here decides anything on its own — the caller chooses the mode and
 * the account, and a wipe is only ever reached through an explicit
 * confirmation in the UI.
 *
 * Every run is long, mostly spent waiting on Kraken's rate limiter: history
 * endpoints cost 4 against a counter of 20 that decays at 0.5/s, which is one
 * 50-row page every eight seconds sustained. So each stage announces itself.
 */
import type { AddonContext } from '@wealthfolio/addon-sdk';
import { clearKeyPair } from '@wealthfolio-connectors/connector-kit';
import {
  ACCOUNT_CURRENCY_STORAGE_KEY,
  LINKED_ACCOUNT_STORAGE_KEY,
  MAX_HISTORY_ITEMS,
} from '../config';
import { checkLedgerContinuity, extractAll } from './extract';
import type { KrakenDataset } from './extract';
import { isOurs, keyPrefixFor, mapDataset, summarise } from './mapper';
import type { MappedActivity, MappingIssue } from './mapper';
import { createSource, KRAKEN_KEYS } from './source';
import { reconcileAssetNames } from './assets';

export type LogLevel = 'info' | 'success' | 'warn' | 'error';

export interface LogEntry {
  at: string;
  level: LogLevel;
  message: string;
}

export interface Progress {
  phase: string;
  message: string;
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
  /** Routine run: stop as soon as Kraken shows something already held. */
  | 'incremental'
  /** Delete everything this connector imported, then re-import. */
  | 'wipe';

export interface SyncResult {
  mode: SyncMode;
  imported: number;
  duplicates: number;
  deleted: number;
  invalid: number;
  issues: MappingIssue[];
  dataset: KrakenDataset;
  counts: Map<string, number>;
}

/**
 * Rows per `saveMany`, and how far it will back off.
 *
 * Too large and validation exceeds the host's request timeout, because every
 * unfamiliar symbol is resolved against market-data providers one at a time.
 * Rather than pick a number that happens to work here, a batch that fails is
 * halved and retried.
 */
const IMPORT_BATCH = 50;
const MIN_BATCH = 5;

export async function runSync(
  ctx: AddonContext,
  accountId: string,
  accountCurrency: string,
  mode: SyncMode,
  reporter: Reporter,
): Promise<SyncResult> {
  const { log, progress } = reporter;

  const client = await createSource(ctx);
  if (!client) throw new Error('No Kraken credentials stored. Connect your account first.');

  progress({ phase: 'Reading Wealthfolio', message: 'Checking what is already imported…' });
  const existing = await readImportedKeys(ctx, accountId);
  log('info', `${existing.size} activities already imported into this account.`);

  let deleted = 0;
  if (mode === 'wipe') {
    deleted = await deleteImported(ctx, accountId, reporter);
    existing.clear();
  }

  // An incremental walk stops at the first row it already holds. A wipe has
  // just emptied the account, so it walks everything, like a first run.
  //
  // The stored keys are prefixed (`kraken:LXXXXX`) and the extractor compares
  // Kraken's own ids, so the prefix comes off here. Getting this wrong is not
  // a correctness bug — the later de-duplication still drops the rows — but it
  // silently turns every routine sync back into a full walk, which on Kraken's
  // rate limiter is minutes rather than seconds.
  //
  // Purchases are keyed by their `refid` rather than a ledger id, so they never
  // match and cannot stop the walk. That costs nothing in practice: rewards are
  // paid far more often than purchases are made, so the newest row is almost
  // always one that does match.
  const prefix = keyPrefixFor(accountId);
  const knownIds =
    mode === 'incremental'
      ? new Set(
          [...existing.keys()]
            .filter((key) => key.startsWith(prefix))
            .map((key) => key.slice(prefix.length)),
        )
      : undefined;
  const bounded = mode === 'incremental' && existing.size > 0;
  if (mode === 'incremental' && !bounded) {
    log('info', 'Nothing imported yet, so this run fetches the whole history.');
  }

  progress({ phase: 'Kraken', message: 'Fetching history…' });
  const dataset = await extractAll(client, {
    maxItemsPerStream: bounded ? MAX_HISTORY_ITEMS : Infinity,
    knownIds,
    onProgress: (event) => {
      progress({ phase: 'Kraken', message: `${event.stream}: ${event.message}` });
      log('info', `${event.stream}: ${event.message}`);
    },
  });

  for (const stat of dataset.stats) {
    if (stat.error) log('error', `${stat.stream} failed: ${stat.error}`);
    else if (stat.skipped) continue;
    else if (stat.truncated) log('warn', `${stat.stream}: stopped at the item limit, more exists.`);
    else log('info', `${stat.stream}: ${stat.items} items in ${(stat.elapsedMs / 1000).toFixed(1)}s.`);
  }

  // Kraken states its own arithmetic on every ledger row, so a missing row is
  // detectable rather than invisible. This is the check that caught a
  // pagination bug losing one row in 315 — worth running on every sync, since
  // what did arrive looks entirely correct.
  const gaps = checkLedgerContinuity(dataset.ledgers);
  const truncated = dataset.stats.some((stat) => stat.stream === 'ledgers' && stat.truncated);
  if (gaps.length > 0 && !truncated) {
    log(
      'error',
      `The ledger does not follow its own running balance in ${gaps.length} place(s) — rows are ` +
        'missing from this extraction. The import will be incomplete; please report this.',
    );
    for (const gap of gaps.slice(0, 3)) {
      log('error', `  ${gap.asset}: ${gap.missing.toFixed(8)} unaccounted for around ${gap.id}`);
    }
  } else if (gaps.length === 0) {
    log('success', 'Ledger reconciles against its own running balance — nothing is missing.');
  }

  progress({ phase: 'Mapping', message: 'Translating Kraken records…' });
  const { activities, issues } = mapDataset(dataset, accountId, { accountCurrency });
  log('info', `Mapped ${activities.length} activities.`);

  const skipped = issues.filter((issue) => issue.kind === 'skipped');
  const warnings = issues.filter((issue) => issue.kind === 'warning');
  if (skipped.length > 0) {
    log('warn', `${skipped.length} record(s) left out — Kraken does not state enough to import them.`);
  }
  for (const issue of [...skipped, ...warnings].slice(0, 30)) {
    log(issue.kind === 'skipped' ? 'info' : 'warn', issue.message);
  }
  if (issues.length > 30) log('info', `…and ${issues.length - 30} more notes.`);

  // Dropped here rather than relying on the host's own duplicate detection,
  // which matches on shape and would block a genuine second reward of the same
  // size on the same day.
  const fresh = activities.filter((row) => !existing.has(row.idempotencyKey));
  const duplicates = activities.length - fresh.length;
  if (duplicates > 0) log('info', `${duplicates} already imported, skipped.`);

  let imported = 0;
  let invalid = 0;
  if (fresh.length > 0) {
    let done = 0;
    let size = IMPORT_BATCH;

    while (done < fresh.length) {
      const batch = fresh.slice(done, done + size);
      progress({
        phase: 'Importing',
        message: `Writing ${done + 1}–${done + batch.length} of ${fresh.length}…`,
        done,
        total: fresh.length,
      });

      let result;
      try {
        result = await ctx.api.activities.saveMany({ creates: batch as never });
      } catch (error) {
        if (size > MIN_BATCH) {
          size = Math.max(MIN_BATCH, Math.floor(size / 2));
          log('warn', `Writing ${batch.length} rows failed, retrying in batches of ${size}.`);
          continue;
        }
        throw error;
      }

      imported += result.created.length;
      invalid += result.errors.length;
      for (const failure of result.errors.slice(0, 3)) {
        log('warn', `Rejected: ${JSON.stringify(failure).slice(0, 160)}`);
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
    log('success', 'Already up to date — nothing new on Kraken.');
  }

  // An import introduces assets Wealthfolio has never seen, and on a fresh
  // install it has fetched neither their prices nor the rates between their
  // currencies and yours. Left alone it reports both as data-health problems.
  //
  // Scoped to this account's holdings rather than `syncHistory()`, which
  // refreshes the whole portfolio and timed out at around two and a half
  // minutes on twenty assets — twice. A connector has no business refreshing
  // securities it did not import, and the unscoped call gets slower with every
  // account a user adds.
  progress({ phase: 'Market data', message: 'Fetching prices…' });
  try {
    const holdings = await ctx.api.portfolio.getHoldings(accountId);
    const assetIds = holdings
      .map((holding) => holding.instrument?.id)
      .filter((id): id is string => Boolean(id));

    if (assetIds.length > 0) {
      await ctx.api.market.sync(assetIds, false);
      log('success', `Prices refreshed for ${assetIds.length} asset(s).`);
    }
  } catch (error) {
    log('warn', `Could not refresh prices: ${describeError(error)}`);
  }

  progress({ phase: 'Recalculating', message: 'Asking Wealthfolio to revalue the portfolio…' });
  await ctx.api.portfolio.recalculate();
  await settle(ctx, accountId, progress);

  // Names Wealthfolio took from a market-data provider can belong to a
  // different coin entirely — Yahoo's `CC` is CloudCoin, not Kraken's Canton
  // Coin. Only names stated in `ASSET_NAMES` are corrected.
  progress({ phase: 'Assets', message: 'Checking asset names…' });
  await reconcileAssetNames(ctx, accountId, log);

  // Kraken values the whole account itself, in USD, and that is the only
  // outside opinion available on whether the prices Wealthfolio found are the
  // right ones. It matters because pointing crypto assets at USD gets them all
  // priced but not all priced *correctly* — Yahoo's tickers collide, and a
  // wrong price is worse than a missing one because nothing looks broken.
  //
  // Reported, never acted on: the two figures are in different currencies and
  // measured moments apart, so only a large gap means anything.
  await reportValuation(ctx, accountId, dataset, log);

  const counts = summarise({ activities, issues });

  log('success', 'Done.');
  return { mode, imported, duplicates, deleted, invalid, issues, dataset, counts };
}

/**
 * Compare the imported portfolio against Kraken's own valuation of it.
 *
 * `TradeBalance.eb` is Kraken's combined balance across every asset, converted
 * into one currency — USD by default. Wealthfolio's figure comes from a
 * different price source at a slightly different moment, so they will never
 * agree exactly and a small gap is meaningless. A large one is not: it is what
 * a mis-resolved ticker looks like from the outside.
 */
async function reportValuation(
  ctx: AddonContext,
  accountId: string,
  dataset: KrakenDataset,
  log: Reporter['log'],
): Promise<void> {
  const krakenUsd = Number(dataset.tradeBalance?.eb ?? NaN);
  if (!Number.isFinite(krakenUsd) || krakenUsd === 0) return;

  try {
    const holdings = await ctx.api.portfolio.getHoldings(accountId);
    const securities = holdings.filter((holding) => holding.holdingType !== 'cash');
    const unpriced = securities.filter((holding) => !((holding.price ?? 0) > 0));

    if (unpriced.length > 0) {
      log(
        'warn',
        `${unpriced.length} asset(s) have no price: ${unpriced
          .map((holding) => holding.instrument?.symbol ?? '?')
          .join(', ')}. Set a per-provider symbol on each asset's Market Data tab.`,
      );
    }

    const value = holdings.reduce(
      (total, holding) => total + (holding.marketValue?.base ?? 0),
      0,
    );
    log(
      'info',
      `Portfolio values at ${value.toFixed(2)} in your base currency; Kraken values the same ` +
        `account at ${krakenUsd.toFixed(2)} USD. These use different price sources, so only a ` +
        'large gap is worth investigating — most often a Kraken ticker that resolved to the ' +
        'wrong instrument.',
    );
  } catch (error) {
    log('info', `Could not compare against Kraken's own valuation: ${describeError(error)}`);
  }
}

/**
 * Wait until the portfolio stops changing.
 *
 * `recalculate` returns as soon as the work is queued, and holdings appear
 * gradually as each asset is priced.
 */
async function settle(
  ctx: AddonContext,
  accountId: string,
  progress: Reporter['progress'],
): Promise<void> {
  let previous = -1;
  let unchanged = 0;

  for (let attempt = 0; attempt < 40 && unchanged < 3; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 4000));
    const holdings = await ctx.api.portfolio.getHoldings(accountId);
    const count = holdings.length;
    unchanged = count === previous && count > 0 ? unchanged + 1 : 0;
    previous = count;
    progress({ phase: 'Recalculating', message: `${count} holdings valued…` });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Recognising and removing our own rows
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The idempotency keys of activities this connector has already written.
 *
 * Read from the field rather than a comment: the backend accepts and returns
 * `idempotencyKey` and `sourceSystem`, verified by `pnpm probe:host`, even
 * though the SDK type declares neither.
 */
export async function readImportedKeys(
  ctx: AddonContext,
  accountId: string,
): Promise<Map<string, string>> {
  const activities = (await ctx.api.activities.getAll(accountId)) as unknown as {
    id: string;
    sourceSystem?: string;
    idempotencyKey?: string;
  }[];
  const keys = new Map<string, string>();
  for (const activity of activities) {
    if (!isOurs(activity) || !activity.idempotencyKey) continue;
    keys.set(activity.idempotencyKey, activity.id);
  }
  return keys;
}

/**
 * Delete every activity this connector imported into the account.
 *
 * Only rows stamped `sourceSystem: KRAKEN` are touched, so anything you
 * entered by hand into the same account survives.
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

/**
 * Undo everything this connector has done, short of the one thing it cannot.
 *
 * **The account itself survives, and has to.** Wealthfolio gives an addon
 * `accounts.getAll` and `accounts.create` and nothing else; there is no delete.
 * Assets the import created also remain — they belong to Wealthfolio and are
 * shared with any other account holding the same one.
 */
export async function resetEverything(
  ctx: AddonContext,
  accountId: string | undefined,
  reporter: Reporter,
): Promise<{ deleted: number }> {
  const { log, progress } = reporter;
  let deleted = 0;

  if (accountId) {
    progress({ phase: 'Resetting', message: 'Removing imported activities…' });
    deleted = await deleteImported(ctx, accountId, reporter);
  }

  progress({ phase: 'Resetting', message: 'Forgetting the linked account…' });
  for (const key of [LINKED_ACCOUNT_STORAGE_KEY, ACCOUNT_CURRENCY_STORAGE_KEY]) {
    try {
      await ctx.api.storage.delete(key);
    } catch {
      // A key that was never written is not an error.
    }
  }

  // Credentials go last, so a failure earlier leaves the connector still able
  // to reach Kraken rather than half-reset and locked out.
  progress({ phase: 'Resetting', message: 'Clearing the saved API credentials…' });
  try {
    await clearKeyPair(ctx, KRAKEN_KEYS);
    log('info', 'API key and private key removed from the keyring.');
  } catch (error) {
    log('warn', `Could not clear the saved credentials: ${describeError(error)}`);
  }

  log('success', 'Connector reset. The account remains — delete it in Wealthfolio if you want it gone.');
  return { deleted };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type { MappedActivity };
