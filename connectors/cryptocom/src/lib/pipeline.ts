/**
 * A sync end to end: fetch, map, write, revalue.
 *
 * Nothing here decides anything on its own — the caller chooses the mode and
 * the account, and a wipe is only ever reached through an explicit
 * confirmation in the UI.
 *
 * A full run takes a couple of minutes, and almost all of it is one endpoint:
 * `get-trades` is limited to one request per second, and the ledger answers
 * seven days per request however wide a range it is given, so a backfill is one
 * request per week of history. Eighteen months is about 105 of them. Every
 * stage announces itself for that reason.
 */
import type { AddonContext } from '@wealthfolio/addon-sdk';
import { clearKeyPair, pinDefaultProvider, settleCashQuoteMode } from '@wealthfolio-connectors/connector-kit';
import {
  ACCOUNT_CURRENCY_STORAGE_KEY,
  CRYPTO_QUOTE_CURRENCY,
  DEFAULT_LOOKBACK_DAYS,
  LINKED_ACCOUNT_STORAGE_KEY,
  QUOTE_PROVIDER,
} from '../config';
import { extractAll, reconstructBalances, statedBalances } from './extract';
import type { CryptoComDataset } from './extract';
import {
  isOurs,
  keyPrefixFor,
  mapDataset,
  summarise,
  symbolsNeedingPrices,
  allCryptoSymbols,
  underlyingSymbol,
} from './mapper';
import type { MappedActivity, MappingIssue } from './mapper';
import { fetchDailyCloses, lookupFrom, backfillQuotes } from './prices';
import { createSource, CRYPTOCOM_KEYS } from './source';
import { applyCryptoComPricing, readPricing, reconcileAssetNames } from './assets';

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
  /** Routine run: stop as soon as Crypto.com shows something already held. */
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
  dataset: CryptoComDataset;
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
  if (!client) throw new Error('No Crypto.com credentials stored. Connect your account first.');

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
  // The stored keys are prefixed and the extractor compares Crypto.com's own
  // ids, so the prefix comes off here. Getting this wrong is not a correctness
  // bug — the later de-duplication still drops the rows — but it silently turns
  // every routine sync back into a full walk, which is minutes rather than
  // seconds.
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

  progress({ phase: 'Crypto.com', message: 'Fetching history…' });
  const dataset = await extractAll(client, {
    since: Date.now() - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
    knownIds,
    onProgress: (event) => {
      progress({ phase: 'Crypto.com', message: `${event.stream}: ${event.message}` });
      log('info', `${event.stream}: ${event.message}`);
    },
  });

  for (const stat of dataset.stats) {
    if (stat.error) {
      // Three streams answer with an error rather than an empty list on an
      // account that has never used them. Failing a sync over that would fail
      // most first runs.
      const optional = stat.stream === 'fiat' || stat.stream === 'staking' || stat.stream === 'export';
      log(optional ? 'info' : 'error', `${stat.stream}: ${stat.error}`);
    } else if (stat.skipped) continue;
    else if (stat.truncated) log('warn', `${stat.stream}: stopped at the item limit, more exists.`);
    else log('info', `${stat.stream}: ${stat.items} items in ${(stat.elapsedMs / 1000).toFixed(1)}s.`);

    if (stat.saturated) {
      log(
        'info',
        `${stat.stream}: ${stat.saturated} window(s) came back full and were split, so no rows ` +
          'were lost to the page limit.',
      );
    }
  }

  // ── A failed ledger is fatal, and has to be ────────────────────────────────
  //
  // `get-transactions` is the spine: every activity is mapped from it. When it
  // failed mid-walk with "Failed to fetch" — a transient network error — the
  // sync carried on regardless, mapped nothing, and reported "Already up to
  // date". Nothing was wrong with the account; the run had simply lost its only
  // source and said so in the log while announcing success in the summary.
  //
  // Silence about a failure is the one thing a sync must not do, so this stops.
  // Nothing has been written at this point, so stopping costs only the run.
  const ledgerFailure = dataset.stats.find((stat) => stat.stream === 'transactions' && stat.error);
  if (ledgerFailure) {
    throw new Error(
      `Could not read your Crypto.com ledger: ${ledgerFailure.error}. Nothing was imported — ` +
        'the ledger is the source every activity comes from, so a partial read would silently ' +
        'produce a partial portfolio. Run it again; this is usually a passing network error.',
    );
  }

  // Crypto.com states no running balance per row, so the ledger cannot be
  // checked against itself the way Kraken's can. What it does state is the
  // closing balance of every asset, and that is a stronger check than it
  // sounds: on a complete extraction the two agree exactly.
  reportExtraction(dataset, log);

  // Staking rewards and coin-for-coin trades arrive with quantities and no
  // money — `transaction_cost` is only the quantity again — and Wealthfolio
  // will not give a position a cost basis without a price. Crypto.com states
  // none per row but publishes a daily close per instrument, so those are
  // fetched for the assets that need one: the same candles the connector's own
  // quote provider reads, so a reward is valued at the number the host will
  // itself use to value the holding.
  progress({ phase: 'Crypto.com', message: 'Fetching daily closes…' });
  // Two different needs, one fetch. `symbolsNeedingPrices` lists the coins whose
  // rows cannot be written without a price; `allCryptoSymbols` lists every coin
  // the account has held, because each one's *chart* wants a daily close that
  // the quote provider's single un-paged URL cannot reach back far enough to
  // supply. Fetching the union costs one paged walk per coin either way.
  const needPrices = symbolsNeedingPrices(dataset);
  const wantHistory = [...new Set([...needPrices, ...allCryptoSymbols(dataset)])].sort();
  const closes =
    wantHistory.length > 0
      ? await fetchDailyCloses(client, wantHistory, dataset.window.since, (symbol, days) =>
          progress({ phase: 'Crypto.com', message: `${symbol}: ${days} daily closes…` }),
        )
      : new Map();
  if (needPrices.length > 0) {
    const missing = needPrices.filter((symbol) => !closes.has(symbol));
    log(
      missing.length === 0 ? 'info' : 'warn',
      missing.length === 0
        ? `Daily closes fetched for ${closes.size} asset(s).`
        : `Daily closes fetched for ${closes.size} of ${needPrices.length} asset(s); ` +
          `Crypto.com publishes none for ${missing.join(', ')}, whose rows stay at zero cost.`,
    );
  }

  progress({ phase: 'Mapping', message: 'Translating Crypto.com records…' });
  const { activities, issues } = mapDataset(dataset, accountId, {
    accountCurrency,
    priceOn: lookupFrom(closes),
  });
  log('info', `Mapped ${activities.length} activities.`);

  const skipped = issues.filter((issue) => issue.kind === 'skipped');
  const warnings = issues.filter((issue) => issue.kind === 'warning');
  if (skipped.length > 0) {
    log(
      'warn',
      `${skipped.length} record(s) left out — either internal moves, or rows Crypto.com does not ` +
        'state enough about to import.',
    );
  }
  for (const issue of [...skipped, ...warnings].slice(0, 30)) {
    log(issue.kind === 'skipped' ? 'info' : 'warn', issue.message);
  }
  if (issues.length > 30) log('info', `…and ${issues.length - 30} more notes.`);

  // Dropped here rather than relying on the host's own duplicate detection,
  // which matches on shape and would block a genuine second reward of the same
  // size on the same day — and this account receives one almost daily.
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
    log('success', 'Already up to date — nothing new on Crypto.com.');
  }

  // An import introduces assets Wealthfolio has never seen, and on a fresh
  // install it has fetched neither their prices nor the rates between their
  // currencies and yours. Left alone it reports both as data-health problems.
  //
  // Scoped to this account's holdings rather than `syncHistory()`, which
  // refreshes the whole portfolio: a connector has no business refreshing
  // securities it did not import, and the unscoped call gets slower with every
  // account a user adds.
  progress({ phase: 'Market data', message: 'Fetching prices…' });
  try {
    const holdings = await ctx.api.portfolio.getHoldings(accountId);

    // ⚠ Cash is not a security, and asking the host to price it is an error it
    // remembers. `getHoldings` returns the cash line alongside the securities,
    // and passing its id to `market.sync` makes Wealthfolio try to fetch a
    // quote for `$CASH` from a market-data provider. There is no such
    // instrument anywhere, so it fails, and it keeps failing — the data-health
    // page reports "Quotes sync failing for $CASH · These assets have
    // repeatedly failed to sync prices", which reads like a broken provider
    // rather than a connector asking for something that cannot exist.
    //
    // The same filter already existed a hundred lines below, for the valuation
    // comparison. It was simply never applied here.
    //
    // FX pairs are excluded for the same reason: a symbol like `BTCGBP` or
    // anything carrying `=` is a rate, not a holding this connector imported.
    const assetIds = holdings
      .filter((holding) => (holding as { holdingType?: string }).holdingType !== 'cash')
      .map((holding) => holding.instrument?.symbol ? holding : undefined)
      .filter((holding): holding is NonNullable<typeof holding> => Boolean(holding))
      .filter((holding) => {
        const symbol = holding.instrument?.symbol ?? '';
        return !symbol.startsWith('$CASH') && !symbol.includes('=');
      })
      .map((holding) => holding.instrument?.id)
      .filter((id): id is string => Boolean(id));

    if (assetIds.length > 0) {
      await ctx.api.market.sync(assetIds, false);
      log('success', `Prices refreshed for ${assetIds.length} asset(s).`);
    }
  } catch (error) {
    log('warn', `Could not refresh prices: ${describeError(error)}`);
  }


  // Cash carries no market price; see `settleCashQuoteMode`.
  try {
    await settleCashQuoteMode(ctx, accountId, log);
  } catch (error) {
    log('info', `Could not settle the cash asset: ${describeError(error)}`);
  }

  progress({ phase: 'Recalculating', message: 'Asking Wealthfolio to revalue the portfolio…' });
  await ctx.api.portfolio.recalculate();
  await settle(ctx, accountId, progress);

  progress({ phase: 'Assets', message: 'Checking asset names…' });
  await reconcileAssetNames(ctx, accountId, log);

  // ── Point the new assets at our own price source ──────────────────────────
  //
  // Not a convenience, and not something to leave behind a button. An import
  // creates assets Wealthfolio has never seen, and it resolves each bare ticker
  // through Yahoo, whose symbol space is not this venue's. On a live account
  // that gave `USDG` — a dollar stablecoin — a price of $5.45, and named one
  // coin after a different coin entirely. A wrong price is worse than a missing
  // one because nothing looks broken.
  //
  // This used to wait for the Prices panel, which meant a clean install showed
  // wrong numbers until someone happened to click it. The provider was already
  // made a required step of setup, so the honest completion of that step is to
  // use it.
  //
  // Skipped entirely when every holding is already on it, so a routine sync
  // pays nothing. Assets another connector claimed are left alone by
  // `applyCryptoComPricing` itself — Wealthfolio shares one asset across accounts.
  try {
    const pricing = await readPricing(ctx, accountId);
    if (pricing.offProvider.length > 0) {
      progress({ phase: 'Prices', message: `Pointing ${pricing.offProvider.length} asset(s) at Crypto.com…` });
      const applied = await applyCryptoComPricing(ctx, accountId, log);
      if (applied.providerMissing) {
        log(
          'warn',
          `No Crypto.com price provider is configured, so these assets keep whatever Yahoo matched — ` +
            'which for some coins is a different instrument at a confidently wrong price. Add it ' +
            'under Settings → Market Data, then use the Prices panel below.',
        );
      }
    }
  } catch (error) {
    log('warn', `Could not set the price source: ${describeError(error)}`);
  }
  // Closed positions need a provider too, and `readPricing` cannot see them:
  // it reads *holdings*, so a coin sold down to zero keeps no provider and
  // stays a candidate for whatever else is enabled. That is the same fallback
  // that had Kraken's provider pricing London ETPs, seen from the other side.
  try {
    await pinDefaultProvider(
      ctx,
      accountId,
      (comment) => Boolean(comment?.startsWith('Crypto.com')),
      { preferred: 'CUSTOM_SCRAPER', customCode: QUOTE_PROVIDER.id },
      log,
    );
  } catch (error) {
    log('info', `Could not pin a price source on closed positions: ${describeError(error)}`);
  }

  // Fill in the history the quote provider cannot reach: its single URL returns
  // 300 daily candles, about ten months, and this connector routinely imports
  // eighteen.
  //
  // Both inputs come from what is already in Wealthfolio rather than from the
  // batch this run fetched. An incremental sync normally returns nothing new,
  // so `dataset` is empty and `dataset.window.since` is only days old — driving
  // the backfill from either meant it did nothing on every run but a full
  // reload, which is how 205 days of this account stayed unpriced.
  try {
    const imported = (await ctx.api.activities.getAll(accountId)) as unknown as {
      comment?: string | null;
      assetId?: string | null;
      assetSymbol?: string | null;
      date?: string | null;
    }[];
    const assetIds = new Map<string, string>();
    let earliest = Date.now();
    for (const activity of imported) {
      if (!activity.comment?.startsWith('Crypto.com')) continue;
      const when = Date.parse(String(activity.date ?? ''));
      if (Number.isFinite(when) && when < earliest) earliest = when;
      const symbol = activity.assetSymbol;
      if (!symbol || !activity.assetId || symbol.startsWith('$CASH')) continue;
      assetIds.set(symbol, activity.assetId);
    }
    await backfillQuotes(
      ctx,
      client,
      assetIds,
      earliest,
      `CUSTOM_SCRAPER:${QUOTE_PROVIDER.id}`,
      log,
      (symbol) => progress({ phase: 'Prices', message: `${symbol}: filling missing days…` }),
    );
  } catch (error) {
    log('info', `Could not write daily price history: ${describeError(error)}`);
  }


  // Crypto.com values every position itself, in the account's own currency, and
  // that is the only outside opinion available on whether the prices
  // Wealthfolio found are the right ones. It matters because pointing crypto
  // assets at USD gets them all priced but not all priced *correctly* — tickers
  // collide across venues, and a wrong price is worse than a missing one
  // because nothing looks broken.
  await reportValuation(ctx, accountId, dataset, log);

  const counts = summarise({ activities, issues });

  log('success', 'Done.');
  return { mode, imported, duplicates, deleted, invalid, issues, dataset, counts };
}

/**
 * Whether the ledger accounts for every unit Crypto.com says you hold.
 *
 * The sharpest check available on this API, and the one that decides whether an
 * import can be trusted at all. Crypto.com states the closing balance of every
 * asset, and the ledger states every movement — so on a complete extraction the
 * second reproduces the first exactly. On a live account all ten holdings did,
 * to the last decimal.
 *
 * A gap means the walk stopped short of the start of history. That is worth
 * saying plainly, because the resulting import looks entirely correct: the
 * right assets, plausible quantities, and a cost basis that quietly begins
 * mid-history.
 */
function reportExtraction(dataset: CryptoComDataset, log: Reporter['log']): void {
  const rebuilt = reconstructBalances(dataset.transactions);
  const folded = new Map<string, number>();
  for (const [code, quantity] of rebuilt) {
    const symbol = underlyingSymbol(code);
    folded.set(symbol, (folded.get(symbol) ?? 0) + quantity);
  }

  const off: string[] = [];
  let checked = 0;
  for (const [code, stated] of statedBalances(dataset)) {
    if (stated === 0) continue;
    checked += 1;
    const symbol = underlyingSymbol(code);
    const ours = folded.get(symbol) ?? 0;
    const relative = Math.abs(stated - ours) / Math.abs(stated);
    if (Math.abs(stated - ours) > 1e-8 && relative > 1e-9) {
      off.push(`${symbol} (Crypto.com ${stated}, ledger ${ours.toFixed(8)})`);
    }
  }

  if (checked === 0) return;
  if (off.length === 0) {
    log('success', `All ${checked} balances reproduce from the ledger — nothing is missing.`);
    return;
  }
  log(
    'warn',
    `${off.length} of ${checked} balances do not reproduce from the ledger: ${off
      .slice(0, 6)
      .join(', ')}. That is history older than this walk reached, so those holdings will import ` +
      'with the right units and an incomplete cost basis.',
  );
}

/**
 * Compare the imported portfolio against Crypto.com's own valuation of it.
 *
 * `user-balance` states a `market_value` per position, which makes this a
 * sharper comparison than the Kraken connector's — there the only figure
 * available was one combined balance. Wealthfolio's number comes from a
 * different price source at a slightly different moment, so the two will never
 * agree exactly and a small gap is meaningless. A large one is not: it is what
 * a mis-resolved ticker looks like from the outside.
 */
async function reportValuation(
  ctx: AddonContext,
  accountId: string,
  dataset: CryptoComDataset,
  log: Reporter['log'],
): Promise<void> {
  const theirs = (dataset.balance?.position_balances ?? []).reduce(
    (total, position) => total + (Number(position.market_value) || 0),
    0,
  );
  if (!Number.isFinite(theirs) || theirs === 0) return;

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

    // ⚠ `marketValue.local`, never `.base`.
    //
    // `.base` is the user's *base currency* — GBP on a UK setup — and
    // Crypto.com states its valuation in the account's settlement currency,
    // USD. Comparing the two logged "2346 vs 3175" on a perfectly correct
    // import and called it a gap worth investigating. A check that cries wolf
    // on every sync is worse than no check, because it teaches you to skip the
    // one line that would have caught a real problem.
    //
    // `.local` is the holding's own currency, and every asset this connector
    // creates is quoted in CRYPTO_QUOTE_CURRENCY, so the sum is directly
    // comparable to what Crypto.com states.
    const settlement = dataset.balance?.instrument_name ?? CRYPTO_QUOTE_CURRENCY;
    const value = holdings.reduce((total, holding) => total + (holding.marketValue?.local ?? 0), 0);
    const gap = theirs === 0 ? 0 : Math.abs(value - theirs) / theirs;

    log(
      gap > 0.05 ? 'warn' : 'info',
      `Portfolio values at ${value.toFixed(2)} ${settlement}; Crypto.com values the same positions ` +
        `at ${theirs.toFixed(2)} ${settlement} — ${(gap * 100).toFixed(2)}% apart. ` +
        (gap > 0.05
          ? 'That is more than price drift between two sources would explain, and usually means a ' +
            'ticker resolved to the wrong instrument. Check each asset on its Market Data tab.'
          : 'The two use different price feeds read moments apart, so a small difference is ' +
            'expected and this one is within it.'),
    );
  } catch (error) {
    log('info', `Could not compare against Crypto.com's own valuation: ${describeError(error)}`);
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
 * `idempotencyKey` and `sourceSystem` even though the SDK type declares
 * neither — established against a running host by the Kraken connector.
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
 * Only rows stamped `sourceSystem: CRYPTOCOM` are touched, so anything you
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
  // to reach Crypto.com rather than half-reset and locked out.
  progress({ phase: 'Resetting', message: 'Clearing the saved API credentials…' });
  try {
    await clearKeyPair(ctx, CRYPTOCOM_KEYS);
    log('info', 'API key and secret removed from the keyring.');
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
