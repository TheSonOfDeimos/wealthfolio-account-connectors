/**
 * Everything read from Crypto.com, and the pagination its endpoints need.
 *
 * The same module runs under `pnpm smoke:live` on Node's `fetch` and inside the
 * addon on the brokered one. Nothing here knows about Wealthfolio; mapping
 * lives next door.
 *
 * Every call is a query. Nothing in this file can place an order, move staked
 * funds, or withdraw. The one endpoint that creates anything server-side — the
 * statement export — is behind an explicit opt-in and is never reached by a
 * default run.
 */
import {
  DEFAULT_LOOKBACK_DAYS,
  FUNDING_PAGE_SIZE,
  MAX_HISTORY_WINDOW_DAYS,
  NANOSECOND_ENDPOINTS,
  PAGE_LIMIT,
  QUIET_WINDOWS_BEFORE_STOP,
  SPOT_INSTRUMENT_TYPE,
} from '../config';
import type { CryptoComClient } from './client';
import type {
  CryptoComAccountsResult,
  CryptoComDepositResult,
  CryptoComExportRequestsResult,
  CryptoComFiatTransaction,
  CryptoComFunding,
  CryptoComInstrument,
  CryptoComInstrumentsResult,
  CryptoComStakingRecord,
  CryptoComStakingResult,
  CryptoComTrade,
  CryptoComTradesResult,
  CryptoComTransaction,
  CryptoComTransactionsResult,
  CryptoComUserBalance,
  CryptoComUserBalanceResult,
  CryptoComWithdrawalResult,
} from './types';

export const ALL_STREAMS = [
  'instruments',
  'accounts',
  'balance',
  'transactions',
  'trades',
  'deposits',
  'withdrawals',
  'fiat',
  'staking',
  'export',
] as const;
export type Stream = (typeof ALL_STREAMS)[number];

const DAY_MS = 24 * 60 * 60 * 1000;

export interface StreamStat {
  stream: Stream;
  items: number;
  /** Requests made — the honest unit, since some streams window and others page. */
  requests: number;
  elapsedMs: number;
  skipped?: boolean;
  truncated?: boolean;
  /**
   * Windows that came back full and had to be split.
   *
   * Worth surfacing rather than hiding: a saturated window means the page limit
   * was reached, and the only reason no rows were lost is that the walk noticed
   * and asked again for two smaller windows.
   */
  saturated?: number;
  error?: string;
}

export interface CryptoComDataset {
  /** The spot catalogue, keyed by pair symbol. Derivatives are kept out. */
  instruments: Map<string, CryptoComInstrument>;
  /** Non-spot instruments seen, so a derivatives position can be named rather than dropped. */
  derivatives: Map<string, CryptoComInstrument>;
  accounts?: CryptoComAccountsResult;
  balance?: CryptoComUserBalance;
  transactions: CryptoComTransaction[];
  trades: CryptoComTrade[];
  deposits: CryptoComFunding[];
  withdrawals: CryptoComFunding[];
  fiatDeposits: CryptoComFiatTransaction[];
  fiatWithdrawals: CryptoComFiatTransaction[];
  stakingRewards: CryptoComStakingRecord[];
  stakingPositions: CryptoComStakingRecord[];
  stakingConversions: CryptoComStakingRecord[];
  exports?: CryptoComExportRequestsResult;
  /**
   * The window the walk asked for, and how far back it actually got.
   *
   * The two differ whenever a walk stopped on a long silence rather than on the
   * `since` bound, and telling them apart is the difference between "your
   * history starts here" and "we stopped looking here".
   */
  window: { since: number; until: number; reachedLedger?: number; reachedTrades?: number };
  stats: StreamStat[];
}

export interface ExtractOptions {
  streams?: readonly Stream[];
  /**
   * The oldest instant worth walking back to.
   *
   * A bound, not a target: the walk stops earlier if it finds a long enough
   * silence, so a generous value costs nothing on a young account. Defaults to
   * `DEFAULT_LOOKBACK_DAYS`.
   */
  since?: number;
  /** Per history stream. `Infinity` walks the whole window. */
  maxItemsPerStream?: number;
  /**
   * Stop as soon as a row already imported is seen. The connector's incremental
   * sync; unused by a first run or after a wipe.
   */
  knownIds?: Set<string>;
  onProgress?: (event: { stream: Stream; message: string }) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Pagination
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Walk a history endpoint by time window, newest first.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  Why windows, rather than offsets or a descending cursor
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Because the ledger and trade endpoints offer nothing else: they take
 * `start_time`/`end_time` and no page cursor at all. (The funding endpoints are
 * the opposite — page numbers and no useful range — which is why they are
 * walked by `walkPages` instead. Two shapes in one API, and each has to be
 * asked in its own language.)
 *
 * Windows also sidestep the failure that cost the Kraken connector a missing
 * £49.50 purchase. Descending by the timestamp of the oldest row on a page
 * loses every remaining row sharing that instant, and Crypto.com's ledger has
 * plenty of same-millisecond clusters. A fixed window has no such boundary:
 * every row in it is asked for at once.
 *
 * The window is capped at `MAX_HISTORY_WINDOW_DAYS` and that cap is load
 * bearing — the server answers for seven days however many you ask for, so a
 * wider window does not fetch more, it skips what it claims to cover.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  The one thing a window can get wrong, and what is done about it
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A window holding more rows than `PAGE_LIMIT` would be truncated, and would
 * look exactly like a window that happened to hold that many. So a full page is
 * treated as evidence of overflow rather than as a coincidence: the window is
 * split in half and both halves are re-read.
 *
 * The recursion bottoms out at one second. A single second holding more than a
 * full page is not something this can subdivide its way out of, so it is
 * counted and reported rather than passed off as complete.
 */
async function walkWindows<T>(
  fetchWindow: (startMs: number, endMs: number) => Promise<T[]>,
  options: {
    since: number;
    until: number;
    windowDays: number;
    idOf: (row: T) => string;
    maxItems: number;
    knownIds?: Set<string>;
    onProgress?: (count: number, requests: number) => void;
  },
): Promise<{
  rows: T[];
  requests: number;
  truncated: boolean;
  stoppedEarly: boolean;
  saturated: number;
  /** The oldest instant actually asked for, so the caller can say where it stopped. */
  reached: number;
}> {
  const rows: T[] = [];
  const seen = new Set<string>();
  let requests = 0;
  let saturated = 0;
  let truncated = false;
  let stoppedEarly = false;

  /** Read one window, splitting it if it comes back full. */
  async function readWindow(startMs: number, endMs: number, depth: number): Promise<void> {
    if (stoppedEarly || truncated) return;

    const page = await fetchWindow(startMs, endMs);
    requests += 1;

    // A full page means rows may have been cut off the end of this window.
    // Halving is only useful while the window is wider than the resolution the
    // endpoint filters at, which is one second.
    if (page.length >= PAGE_LIMIT && endMs - startMs > 1000 && depth < 12) {
      saturated += 1;
      const middle = startMs + Math.floor((endMs - startMs) / 2);
      // Newer half first, so an incremental sync still stops at the first
      // already-imported row rather than reading the older half needlessly.
      await readWindow(middle, endMs, depth + 1);
      await readWindow(startMs, middle, depth + 1);
      return;
    }

    if (page.length >= PAGE_LIMIT) {
      // Bottomed out: more rows in one second than a page holds. Counted, not
      // hidden — the alternative is a silently short import.
      saturated += 1;
    }

    for (const row of page) {
      const id = options.idOf(row);
      if (seen.has(id)) continue;
      seen.add(id);
      if (options.knownIds?.has(id)) {
        stoppedEarly = true;
        continue;
      }
      rows.push(row);
    }

    options.onProgress?.(rows.length, requests);
    if (rows.length >= options.maxItems) truncated = true;
  }

  // Never wider than the server will honour. A larger window is not a bigger
  // request, it is a *skipped* one — see MAX_HISTORY_WINDOW_DAYS.
  const windowMs = Math.min(options.windowDays, MAX_HISTORY_WINDOW_DAYS) * DAY_MS;
  let quiet = 0;
  let reached = options.until;

  for (let end = options.until; end > options.since; end -= windowMs) {
    const start = Math.max(options.since, end - windowMs);
    const before = rows.length;
    await readWindow(start, end, 0);
    reached = start;

    if (stoppedEarly || truncated) break;

    // A long enough silence is taken as the start of the account rather than a
    // gap in it. Six months by default: long enough that a dormant year is the
    // only thing this can cut short, and that is a trade made explicitly rather
    // than by an eager guess.
    quiet = rows.length === before ? quiet + 1 : 0;
    if (quiet >= QUIET_WINDOWS_BEFORE_STOP) break;
  }

  return {
    rows: rows.slice(0, options.maxItems),
    requests,
    truncated,
    stoppedEarly,
    saturated,
    reached,
  };
}

/**
 * Walk a page-numbered endpoint from the newest page backwards.
 *
 * The funding and fiat endpoints work completely differently from the ledger:
 * they take `page`/`page_size` and no time range worth using, and — unlike the
 * ledger — they answer for the whole of an account's history in one or two
 * requests.
 *
 * Walking them by time window was the first approach and it quietly returned
 * less. Six withdrawals exist on the account this was built against; the
 * windowed walk found two, because the other four predated the window it was
 * given. Nothing about that result looked wrong.
 *
 * `page` is mandatory on the fiat pair. Leaving it out returns `BAD_REQUEST`
 * rather than defaulting to the first page.
 */
async function walkPages<T>(
  fetchPage: (page: number) => Promise<T[]>,
  options: { idOf: (row: T) => string; maxItems: number; knownIds?: Set<string>; maxPages?: number },
): Promise<{ rows: T[]; requests: number; truncated: boolean }> {
  const rows: T[] = [];
  const seen = new Set<string>();
  let requests = 0;
  let truncated = false;

  for (let page = 0; page < (options.maxPages ?? 50); page += 1) {
    const items = await fetchPage(page);
    requests += 1;

    for (const row of items) {
      const id = options.idOf(row);
      if (seen.has(id)) continue;
      seen.add(id);
      if (options.knownIds?.has(id)) continue;
      rows.push(row);
    }

    if (rows.length >= options.maxItems) {
      truncated = true;
      break;
    }
    // A short page is the end of the history; a full one means there is more.
    if (items.length < FUNDING_PAGE_SIZE) break;
  }

  return { rows: rows.slice(0, options.maxItems), requests, truncated };
}

/**
 * A timestamp in the unit the endpoint expects.
 *
 * Crypto.com takes nanoseconds on its newer history endpoints and milliseconds
 * on the funding ones, and sending the wrong magnitude does not fail — it is
 * read as a date in 1970 or centuries hence, and answers with an empty page
 * that is indistinguishable from an empty account. Which is why this is decided
 * from a table rather than from whatever the last endpoint wanted.
 *
 * Nanoseconds are passed as a decimal **string**. As a number, `1.7e18` exceeds
 * `Number.MAX_SAFE_INTEGER` and the last few digits are quietly wrong — enough
 * to shift a window boundary by a fraction of a second, which is exactly the
 * kind of error that drops one row and nothing else.
 */
function stamp(method: string, ms: number): string | number {
  return NANOSECOND_ENDPOINTS.has(method) ? `${ms}000000` : ms;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Streams
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read everything, one stream at a time, and never let one failure hide the
 * rest.
 *
 * Each stream records its own error rather than throwing, because the useful
 * output of a first run against a new account is the whole picture: knowing
 * that staking failed *and* trades returned 40 rows is worth far more than an
 * exception thrown at the first endpoint the key cannot reach.
 */
export async function extractAll(
  client: CryptoComClient,
  options: ExtractOptions = {},
): Promise<CryptoComDataset> {
  const streams = options.streams ?? ALL_STREAMS;
  const maxItems = options.maxItemsPerStream ?? Infinity;
  const until = Date.now();
  const since = options.since ?? until - DEFAULT_LOOKBACK_DAYS * DAY_MS;

  const dataset: CryptoComDataset = {
    instruments: new Map(),
    derivatives: new Map(),
    transactions: [],
    trades: [],
    deposits: [],
    withdrawals: [],
    fiatDeposits: [],
    fiatWithdrawals: [],
    stakingRewards: [],
    stakingPositions: [],
    stakingConversions: [],
    window: { since, until },
    stats: [],
  };

  const wanted = (stream: Stream) => streams.includes(stream);
  const report = (stream: Stream, message: string) => options.onProgress?.({ stream, message });

  /** Run one stream, timing it and turning a throw into a recorded error. */
  async function run(
    stream: Stream,
    body: () => Promise<Omit<StreamStat, 'stream' | 'elapsedMs'>>,
  ): Promise<void> {
    if (!wanted(stream)) {
      dataset.stats.push({ stream, items: 0, requests: 0, elapsedMs: 0, skipped: true });
      return;
    }
    const startedAt = Date.now();
    try {
      const outcome = await body();
      dataset.stats.push({ stream, ...outcome, elapsedMs: Date.now() - startedAt });
    } catch (error) {
      dataset.stats.push({
        stream,
        items: 0,
        requests: 0,
        elapsedMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ── The catalogue ──────────────────────────────────────────────────────────
  // First, and unauthenticated. It answers what every later stream needs — what
  // a pair is made of — and it does so before any signature has to be correct,
  // which makes it a clean check that the host is reachable at all.
  await run('instruments', async () => {
    report('instruments', 'reading the spot catalogue…');
    const result = await client.publicCall<CryptoComInstrumentsResult>('public/get-instruments');
    for (const instrument of result.data ?? []) {
      const target =
        instrument.inst_type === SPOT_INSTRUMENT_TYPE ? dataset.instruments : dataset.derivatives;
      target.set(instrument.symbol, instrument);
    }
    return { items: dataset.instruments.size + dataset.derivatives.size, requests: 1 };
  });

  await run('accounts', async () => {
    report('accounts', 'reading account structure…');
    dataset.accounts = await client.privateCall<CryptoComAccountsResult>('private/get-accounts');
    return { items: 1 + (dataset.accounts.sub_account_list?.length ?? 0), requests: 1 };
  });

  await run('balance', async () => {
    report('balance', 'reading balances…');
    const result = await client.privateCall<CryptoComUserBalanceResult>('private/user-balance');
    dataset.balance = result.data?.[0];
    return { items: dataset.balance?.position_balances?.length ?? 0, requests: 1 };
  });

  // ── The ledger ─────────────────────────────────────────────────────────────
  await run('transactions', async () => {
    const method = 'private/get-transactions';
    const walk = await walkWindows<CryptoComTransaction>(
      async (startMs, endMs) => {
        const result = await client.privateCall<CryptoComTransactionsResult>(method, {
          start_time: stamp(method, startMs),
          end_time: stamp(method, endMs),
          limit: PAGE_LIMIT,
        });
        return result.data ?? [];
      },
      {
        since,
        until,
        windowDays: MAX_HISTORY_WINDOW_DAYS,
        // `journal_id` is unique per ledger row. `order_id` is not — a partly
        // filled order produces several rows sharing one, and keying on it
        // would collapse them into a single movement.
        idOf: (row) => row.journal_id,
        maxItems,
        knownIds: options.knownIds,
        onProgress: (count, requests) =>
          report('transactions', `${count} ledger rows in ${requests} requests`),
      },
    );
    dataset.transactions = walk.rows;
    dataset.window.reachedLedger = walk.reached;
    return {
      items: walk.rows.length,
      requests: walk.requests,
      truncated: walk.truncated,
      saturated: walk.saturated,
    };
  });

  // ── Fills ──────────────────────────────────────────────────────────────────
  // One request per second, enforced by the client. This is the slowest stream
  // by a wide margin and the reason a full backfill reports progress per window.
  await run('trades', async () => {
    const method = 'private/get-trades';
    const walk = await walkWindows<CryptoComTrade>(
      async (startMs, endMs) => {
        const result = await client.privateCall<CryptoComTradesResult>(method, {
          start_time: stamp(method, startMs),
          end_time: stamp(method, endMs),
          limit: PAGE_LIMIT,
        });
        return result.data ?? [];
      },
      {
        since,
        until,
        windowDays: MAX_HISTORY_WINDOW_DAYS,
        idOf: (row) => row.trade_id,
        maxItems,
        knownIds: options.knownIds,
        onProgress: (count, requests) =>
          report('trades', `${count} fills in ${requests} requests (rate limited to 1/s)`),
      },
    );
    dataset.trades = walk.rows;
    dataset.window.reachedTrades = walk.reached;
    return {
      items: walk.rows.length,
      requests: walk.requests,
      truncated: walk.truncated,
      saturated: walk.saturated,
    };
  });

  // ── Funding ────────────────────────────────────────────────────────────────
  // Paged, not windowed. These endpoints return the whole history regardless of
  // how far back it goes, which makes them the only streams here not bounded by
  // the seven-day clamp.
  await run('deposits', async () => {
    report('deposits', 'reading deposit history…');
    const walk = await walkPages<CryptoComFunding>(
      async (page) => {
        const result = await client.privateCall<CryptoComDepositResult>(
          'private/get-deposit-history',
          { page, page_size: FUNDING_PAGE_SIZE },
        );
        return result.deposit_list ?? [];
      },
      { idOf: (row) => row.id, maxItems, knownIds: options.knownIds },
    );
    dataset.deposits = walk.rows;
    return { items: walk.rows.length, requests: walk.requests, truncated: walk.truncated };
  });

  await run('withdrawals', async () => {
    report('withdrawals', 'reading withdrawal history…');
    const walk = await walkPages<CryptoComFunding>(
      async (page) => {
        const result = await client.privateCall<CryptoComWithdrawalResult>(
          'private/get-withdrawal-history',
          { page, page_size: FUNDING_PAGE_SIZE },
        );
        return result.withdrawal_list ?? [];
      },
      { idOf: (row) => row.id, maxItems, knownIds: options.knownIds },
    );
    dataset.withdrawals = walk.rows;
    return { items: walk.rows.length, requests: walk.requests, truncated: walk.truncated };
  });

  // ── Fiat rails ─────────────────────────────────────────────────────────────
  // Separate endpoints entirely: a bank transfer never appears in the crypto
  // funding lists, so an account funded by card or transfer shows deposits of
  // nothing at all without these.
  await run('fiat', async () => {
    let requests = 0;
    for (const [method, sink] of [
      ['private/fiat/fiat-deposit-history', dataset.fiatDeposits],
      ['private/fiat/fiat-withdraw-history', dataset.fiatWithdrawals],
    ] as const) {
      report('fiat', `reading ${method.split('/').pop()}…`);
      const walk = await walkPages<CryptoComFiatTransaction>(
        async (page) => {
          // `page` is mandatory here. Without it this returns BAD_REQUEST, and
          // a time range is not accepted at all — the two habits that make this
          // pair look broken when it is only being asked wrongly.
          const result = await client.privateCall<{
            transaction_history_list?: CryptoComFiatTransaction[];
          }>(method, { page, page_size: FUNDING_PAGE_SIZE });
          return result.transaction_history_list ?? [];
        },
        { idOf: (row) => String(row.id), maxItems, knownIds: options.knownIds },
      );
      sink.push(...walk.rows);
      requests += walk.requests;
    }
    return { items: dataset.fiatDeposits.length + dataset.fiatWithdrawals.length, requests };
  });

  // ── Staking ────────────────────────────────────────────────────────────────
  await run('staking', async () => {
    let requests = 0;
    for (const [method, sink] of [
      ['private/staking/get-reward-history', dataset.stakingRewards],
      ['private/staking/get-staking-position', dataset.stakingPositions],
      ['private/staking/get-convert-history', dataset.stakingConversions],
    ] as const) {
      report('staking', `reading ${method.split('/').pop()}…`);
      try {
        const result = await client.privateCall<CryptoComStakingResult>(method, {
          start_time: since,
          end_time: until,
          limit: PAGE_LIMIT,
        });
        sink.push(...(result.data ?? []));
      } catch (error) {
        // An account that has never staked answers some of these with an error
        // rather than an empty list. That is not a failure of the extraction,
        // and treating it as one would fail every run for most accounts.
        report('staking', `${method.split('/').pop()}: ${error instanceof Error ? error.message : error}`);
      }
      requests += 1;
    }
    return {
      items:
        dataset.stakingRewards.length +
        dataset.stakingPositions.length +
        dataset.stakingConversions.length,
      requests,
    };
  });

  // ── The statement export ───────────────────────────────────────────────────
  // Read-only: this lists export requests that already exist and creates
  // nothing. It is here to answer one question — whether this account can reach
  // history older than the six months the endpoints above serve — and the
  // creating half of that API is deliberately not called from anywhere in this
  // module.
  await run('export', async () => {
    report('export', 'checking the statement export (read-only)…');
    dataset.exports = await client.legacyCall<CryptoComExportRequestsResult>(
      'private/export/get-export-requests',
      { start_ts: since, end_ts: until },
    );
    return { items: dataset.exports.request_list?.length ?? 0, requests: 1 };
  });

  return dataset;
}

// ─────────────────────────────────────────────────────────────────────────────
//  What the mapper and the smoke test both need
// ─────────────────────────────────────────────────────────────────────────────

/** Ledger rows keyed by the id that is actually unique per row. */
export function findDuplicateIds(rows: { journal_id: string }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.journal_id, (counts.get(row.journal_id) ?? 0) + 1);
  return new Map([...counts].filter(([, count]) => count > 1));
}

/**
 * Every currency code the account has touched.
 *
 * Taken from the ledger and the balance rather than from the trades, because a
 * coin can arrive by deposit or reward and never be traded — and it still has
 * to be priced.
 */
export function touchedAssets(dataset: CryptoComDataset): Set<string> {
  const codes = new Set<string>();
  for (const row of dataset.transactions) codes.add(row.instrument_name);
  for (const position of dataset.balance?.position_balances ?? []) {
    codes.add(position.instrument_name);
  }
  for (const row of dataset.deposits) codes.add(row.currency);
  for (const row of dataset.withdrawals) codes.add(row.currency);
  return codes;
}

/**
 * What a pair is made of, as Crypto.com states it.
 *
 * Returns undefined for a pair not in the catalogue rather than splitting the
 * symbol on its underscore. That split would be right almost every time, and
 * the almost is the whole problem: `ABML_US_EQ` is not `ABML`, and a rule that
 * works 90% of the time leaves nothing to prompt a check on the other 10%.
 */
export function pairComposition(
  dataset: CryptoComDataset,
  symbol: string,
): { base: string; quote: string; spot: boolean } | undefined {
  const spot = dataset.instruments.get(symbol);
  if (spot) return { base: spot.base_ccy, quote: spot.quote_ccy, spot: true };

  const derivative = dataset.derivatives.get(symbol);
  if (derivative) return { base: derivative.base_ccy, quote: derivative.quote_ccy, spot: false };

  return undefined;
}

/**
 * Rebuild each balance from the ledger, to compare against the stated one.
 *
 * The sharpest check available here, and weaker than the equivalent Kraken one
 * in a way worth stating: Kraken puts a running balance on every ledger row, so
 * a gap can be located exactly. Crypto.com does not, so all this can do is sum
 * the movements and compare the total.
 *
 * On an account younger than the retention window the two should agree. On an
 * older one they will not, and the difference is precisely the history the API
 * refuses to serve — which makes this a measurement of the wall rather than a
 * failed check, and the caller is expected to say so.
 */
export function reconstructBalances(transactions: CryptoComTransaction[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const row of transactions) {
    const quantity = Number(row.transaction_qty);
    if (!Number.isFinite(quantity)) continue;
    totals.set(row.instrument_name, (totals.get(row.instrument_name) ?? 0) + quantity);
  }
  return totals;
}

/** The stated balances, as a comparable map. */
export function statedBalances(dataset: CryptoComDataset): Map<string, number> {
  const totals = new Map<string, number>();
  for (const position of dataset.balance?.position_balances ?? []) {
    totals.set(position.instrument_name, Number(position.quantity));
  }
  return totals;
}
