/**
 * Everything read from Kraken, and the pagination its endpoints need.
 *
 * The same module runs under `pnpm smoke:live` on Node's `fetch` and inside the
 * addon on the brokered one. Nothing here knows about Wealthfolio; mapping
 * lives next door.
 *
 * Every call is a query. Nothing in this file can place an order, move funds
 * between Earn strategies, or withdraw.
 */
import { CALL_COST, LEDGER_PAGE_SIZE, TRADES_PAGE_SIZE } from '../config';
import type { KrakenClient } from './client';
import type {
  KrakenAsset,
  KrakenAssetPair,
  KrakenBalances,
  KrakenEarnAllocations,
  KrakenFunding,
  KrakenLedgerEntry,
  KrakenLedgerPage,
  KrakenTrade,
  KrakenTradeBalance,
  KrakenTradesPage,
} from './types';

export const ALL_STREAMS = [
  'time',
  'assets',
  'balance',
  'tradeBalance',
  'ledgers',
  'trades',
  'pairs',
  'deposits',
  'withdrawals',
  'earn',
] as const;
export type Stream = (typeof ALL_STREAMS)[number];

/** One ledger row, with the id Kraken keys it by folded in. */
export type LedgerRow = KrakenLedgerEntry & { id: string };
/** One trade, with its Kraken transaction id folded in. */
export type TradeRow = KrakenTrade & { id: string };

/**
 * One asset, as Kraken states it — never as parsed from its code.
 *
 * `code` is what the ledger uses (`XXBT`), `display` is what Wealthfolio wants
 * (`BTC`), and Kraken supplies both: the same catalogue requested with
 * `assetVersion=1` is keyed by display name. The two responses are joined on
 * `altname`, which is the only field common to both.
 */
export interface AssetInfo {
  code: string;
  altname: string;
  /** Kraken's own display name. Undefined when the join found no counterpart. */
  display?: string;
  /** `currency`, or `tokenized_asset` for an xStock — which is not an equity. */
  aclass: string;
  decimals: number;
  /** Set when the code carries a balance suffix: `XBT.S` is staked Bitcoin. */
  suffix?: string;
  /** The asset the suffix hangs off, e.g. `XBT` for `XBT.S`. */
  base?: string;
}

export interface StreamStat {
  stream: Stream;
  items: number;
  pages: number;
  elapsedMs: number;
  skipped?: boolean;
  truncated?: boolean;
  error?: string;
}

export interface KrakenDataset {
  /**
   * Kraken's clock, and the local clock at the moment it was read.
   *
   * Both, because the skew between them is only meaningful if measured at the
   * same instant — comparing Kraken's reading against `Date.now()` at the end
   * of a run reports the run's own duration as clock drift, which is a false
   * alarm on every extraction that takes more than a moment.
   */
  serverTime?: { unixtime: number; rfc1123: string; localAt: number };
  assets: Map<string, AssetInfo>;
  pairs: Map<string, KrakenAssetPair>;
  balances: KrakenBalances;
  tradeBalance?: KrakenTradeBalance;
  ledgers: LedgerRow[];
  trades: TradeRow[];
  deposits: KrakenFunding[];
  withdrawals: KrakenFunding[];
  earn?: KrakenEarnAllocations;
  stats: StreamStat[];
}

export interface ExtractOptions {
  streams?: readonly Stream[];
  /** Per history stream. `Infinity` walks everything. */
  maxItemsPerStream?: number;
  /**
   * Stop as soon as a row already imported is seen. The connector's
   * incremental sync; unused by a first run or a wipe.
   */
  knownIds?: Set<string>;
  onProgress?: (event: { stream: Stream; message: string }) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Pagination
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Walk a history endpoint by offset, inside a window fixed when the walk began.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  Why not descend by `end`, which is what this did first
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Because it silently loses rows, and did. Kraken's timestamps are fractional
 * but `end` behaves as whole seconds, so when a page boundary falls inside a
 * cluster of rows sharing one second, everything left in that second is
 * skipped: the next request asks for `end = oldest`, and the rows between the
 * truncated boundary and `oldest` are neither on the page just read nor on the
 * page about to be.
 *
 * That is not hypothetical. A live account lost `LOK362-UMTRX-6RWOG4`, a £49.50
 * purchase, out of the middle of a run of same-second rows — 314 of 315 rows
 * arrived, every asset balance reconciled except sterling, and the ledger's own
 * running balance was the only thing that gave it away.
 *
 * Offset paging has the failure mode this trades for: a row arriving at the
 * head mid-walk shifts every later offset by one. Anchoring `end` to the
 * moment the walk started closes that off — the window cannot grow underneath
 * it — and ids are de-duplicated regardless.
 */
async function walkHistory<T extends { time: number }>(
  fetchPage: (offset: number, end: number) => Promise<Record<string, T>>,
  options: {
    maxItems: number;
    pageSize: number;
    knownIds?: Set<string>;
    onProgress?: (count: number, pages: number) => void;
  },
): Promise<{ rows: (T & { id: string })[]; pages: number; truncated: boolean; stoppedEarly: boolean }> {
  const rows: (T & { id: string })[] = [];
  const seen = new Set<string>();
  // Fixed for the whole walk, so later offsets cannot shift under it.
  const end = Math.ceil(Date.now() / 1000) + 1;
  let offset = 0;
  let pages = 0;
  let truncated = false;
  let stoppedEarly = false;

  for (;;) {
    const page = await fetchPage(offset, end);
    pages += 1;

    const entries = Object.entries(page);
    if (entries.length === 0) break;

    let hitKnown = false;
    for (const [id, row] of entries) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (options.knownIds?.has(id)) {
        hitKnown = true;
        continue;
      }
      rows.push({ ...row, id });
    }

    options.onProgress?.(rows.length, pages);

    if (hitKnown) {
      stoppedEarly = true;
      break;
    }
    if (rows.length >= options.maxItems) {
      truncated = true;
      break;
    }
    // A short page is the end of the history; a full one means there is more.
    if (entries.length < options.pageSize) break;

    offset += entries.length;
  }

  return { rows: rows.slice(0, options.maxItems), pages, truncated, stoppedEarly };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Assets
// ─────────────────────────────────────────────────────────────────────────────

/** `XBT.S` → base `XBT`, suffix `S`. A code without a dot is its own base. */
function splitSuffix(code: string): { base: string; suffix?: string } {
  const dot = code.indexOf('.');
  return dot === -1
    ? { base: code }
    : { base: code.slice(0, dot), suffix: code.slice(dot + 1) };
}

/**
 * Kraken's asset catalogue, with its own display names attached.
 *
 * Both versions of the same endpoint are fetched — the default keyed by
 * Kraken's code, `assetVersion=1` keyed by display name — and joined on
 * `altname`. Where two display names claim one `altname` the entry is dropped
 * rather than guessed at, so an ambiguous asset surfaces as unresolved instead
 * of resolving to the wrong thing.
 *
 * 830 assets came back in 95 KB when this was written, comfortably inside the
 * host's 2 MB response ceiling, so nothing needs bundling ahead of time — the
 * problem that forced Trading 212's generated symbol table does not arise.
 */
export async function fetchAssets(client: KrakenClient): Promise<Map<string, AssetInfo>> {
  const [byCode, byDisplay] = await Promise.all([
    client.publicCall<Record<string, KrakenAsset>>('Assets'),
    client.publicCall<Record<string, KrakenAsset>>('Assets', { assetVersion: '1' }),
  ]);

  const displayByAltname = new Map<string, string | null>();
  for (const [display, asset] of Object.entries(byDisplay)) {
    const key = asset.altname;
    // null marks a collision: two display names for one altname is not a
    // mapping we can act on.
    displayByAltname.set(key, displayByAltname.has(key) ? null : display);
  }

  const assets = new Map<string, AssetInfo>();
  for (const [code, asset] of Object.entries(byCode)) {
    const { base, suffix } = splitSuffix(code);
    const display = displayByAltname.get(asset.altname);
    assets.set(code, {
      code,
      altname: asset.altname,
      display: display ?? undefined,
      aclass: asset.aclass,
      decimals: asset.decimals,
      ...(suffix ? { suffix, base } : {}),
    });
  }
  return assets;
}

/**
 * The pairs an account actually traded, and only those.
 *
 * Unfiltered this endpoint returns 1.13 MB against a 2 MB host ceiling and is
 * growing as Kraken lists tokenized equities. Kraken honours a `pair=` filter
 * properly — two pairs come back in 1.7 KB — so there is no reason to ask for
 * the rest.
 */
export async function fetchPairs(
  client: KrakenClient,
  names: readonly string[],
): Promise<Map<string, KrakenAssetPair>> {
  const pairs = new Map<string, KrakenAssetPair>();
  if (names.length === 0) return pairs;

  // Chunked so a heavily traded account cannot build a URL the host rejects.
  for (let index = 0; index < names.length; index += 40) {
    const chunk = names.slice(index, index + 40);
    const page = await client.publicCall<Record<string, KrakenAssetPair>>('AssetPairs', {
      pair: chunk.join(','),
    });
    // Kraken returns some pairs under two keys — an internal code and an
    // altname — for one instrument. `wsname` is the stable identity.
    for (const [key, pair] of Object.entries(page)) {
      if (!pairs.has(key)) pairs.set(key, pair);
    }
  }
  return pairs;
}

// ─────────────────────────────────────────────────────────────────────────────
//  The whole extraction
// ─────────────────────────────────────────────────────────────────────────────

export async function extractAll(
  client: KrakenClient,
  options: ExtractOptions = {},
): Promise<KrakenDataset> {
  const streams = options.streams ?? ALL_STREAMS;
  const maxItems = options.maxItemsPerStream ?? Infinity;
  const report = options.onProgress ?? (() => {});

  const dataset: KrakenDataset = {
    assets: new Map(),
    pairs: new Map(),
    balances: {},
    ledgers: [],
    trades: [],
    deposits: [],
    withdrawals: [],
    stats: [],
  };

  const run = async (stream: Stream, work: () => Promise<{ items: number; pages?: number; truncated?: boolean }>) => {
    if (!streams.includes(stream)) {
      dataset.stats.push({ stream, items: 0, pages: 0, elapsedMs: 0, skipped: true });
      return;
    }
    const startedAt = Date.now();
    try {
      const { items, pages = 1, truncated } = await work();
      dataset.stats.push({ stream, items, pages, elapsedMs: Date.now() - startedAt, truncated });
    } catch (error) {
      dataset.stats.push({
        stream,
        items: 0,
        pages: 0,
        elapsedMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  // Server clock first: a local clock more than a few seconds out produces
  // nonce rejections that read as a signing bug.
  await run('time', async () => {
    const reply = await client.publicCall<{ unixtime: number; rfc1123: string }>('Time');
    dataset.serverTime = { ...reply, localAt: Date.now() };
    return { items: 1 };
  });

  await run('assets', async () => {
    report({ stream: 'assets', message: 'reading the asset catalogue…' });
    dataset.assets = await fetchAssets(client);
    return { items: dataset.assets.size, pages: 2 };
  });

  await run('balance', async () => {
    dataset.balances = await client.privateCall<KrakenBalances>('Balance');
    return { items: Object.keys(dataset.balances).length };
  });

  await run('tradeBalance', async () => {
    dataset.tradeBalance = await client.privateCall<KrakenTradeBalance>('TradeBalance');
    return { items: 1 };
  });

  await run('ledgers', async () => {
    const walk = await walkHistory<KrakenLedgerEntry>(
      async (offset, end) => {
        const page = await client.privateCall<KrakenLedgerPage>(
          'Ledgers',
          { without_count: 'true', end: String(end), ofs: String(offset) },
          CALL_COST.Ledgers,
        );
        return page.ledger ?? {};
      },
      {
        maxItems,
        pageSize: LEDGER_PAGE_SIZE,
        knownIds: options.knownIds,
        onProgress: (count, pages) =>
          report({ stream: 'ledgers', message: `${count} rows over ${pages} page(s)…` }),
      },
    );
    dataset.ledgers = walk.rows;
    return { items: walk.rows.length, pages: walk.pages, truncated: walk.truncated };
  });

  await run('trades', async () => {
    const walk = await walkHistory<KrakenTrade>(
      async (offset, end) => {
        const page = await client.privateCall<KrakenTradesPage>(
          'TradesHistory',
          {
            // Kraken charges the same counter cost per call whatever the page
            // size, so the largest page is strictly the cheapest.
            limit: String(TRADES_PAGE_SIZE),
            end: String(end),
            ofs: String(offset),
          },
          CALL_COST.TradesHistory,
        );
        return page.trades ?? {};
      },
      {
        maxItems,
        pageSize: TRADES_PAGE_SIZE,
        knownIds: options.knownIds,
        onProgress: (count, pages) =>
          report({ stream: 'trades', message: `${count} trades over ${pages} page(s)…` }),
      },
    );
    dataset.trades = walk.rows;
    return { items: walk.rows.length, pages: walk.pages, truncated: walk.truncated };
  });

  // Only the pairs the account touched, which is why this follows the trades.
  await run('pairs', async () => {
    const names = [...new Set(dataset.trades.map((trade) => trade.pair))];
    dataset.pairs = await fetchPairs(client, names);
    return { items: dataset.pairs.size };
  });

  await run('deposits', async () => {
    dataset.deposits = await client.privateCall<KrakenFunding[]>('DepositStatus');
    return { items: dataset.deposits.length };
  });

  await run('withdrawals', async () => {
    dataset.withdrawals = await client.privateCall<KrakenFunding[]>('WithdrawStatus');
    return { items: dataset.withdrawals.length };
  });

  await run('earn', async () => {
    dataset.earn = await client.privateCall<KrakenEarnAllocations>('Earn/Allocations');
    return { items: dataset.earn.items?.length ?? 0 };
  });

  return dataset;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Reading a dataset
// ─────────────────────────────────────────────────────────────────────────────

/** `trade`, or `transfer/spotfromfutures` where a subtype qualifies the type. */
export function ledgerKind(row: KrakenLedgerEntry): string {
  return row.subtype ? `${row.type}/${row.subtype}` : row.type;
}

/**
 * Ledger rows grouped by `refid`.
 *
 * Both halves of a trade share one, as do a funding row and its detail record.
 * This is the join the mapper works from — never a reconstruction from two
 * rows that happen to be adjacent.
 */
export function groupByRefid(rows: readonly LedgerRow[]): Map<string, LedgerRow[]> {
  const groups = new Map<string, LedgerRow[]>();
  for (const row of rows) {
    const group = groups.get(row.refid);
    if (group) group.push(row);
    else groups.set(row.refid, [row]);
  }
  return groups;
}

/**
 * A purchase made through Kraken's Instant Buy, reassembled from its two rows.
 *
 * These do **not** appear in `TradesHistory` and are not `trade` ledger rows.
 * Kraken records them as a `spend` of one asset and a `receive` of another,
 * sharing a `refid` — and an account that only ever used Instant Buy reports
 * zero trades while plainly holding things it bought. Neither `spend` nor
 * `receive` is in Kraken's documented list of ledger types, which is the whole
 * reason the smoke test prints a census rather than assuming the documentation
 * is complete.
 *
 * Nothing is inferred here. Both legs state their own asset, amount and fee;
 * the pairing comes from Kraken's own `refid`, and a group that is not exactly
 * one spend and one receive is returned as unpaired rather than guessed at.
 */
export interface InstantBuy {
  refid: string;
  time: number;
  /** The asset given up, as a positive amount. */
  spent: { asset: string; amount: number; fee: number };
  /** The asset acquired. */
  received: { asset: string; amount: number; fee: number };
}

export function pairInstantBuys(rows: readonly LedgerRow[]): {
  buys: InstantBuy[];
  unpaired: LedgerRow[];
} {
  const relevant = rows.filter((row) => row.type === 'spend' || row.type === 'receive');
  const buys: InstantBuy[] = [];
  const unpaired: LedgerRow[] = [];

  for (const group of groupByRefid(relevant).values()) {
    const spend = group.filter((row) => row.type === 'spend');
    const receive = group.filter((row) => row.type === 'receive');

    // Exactly one of each, or it is not a shape this can speak for.
    if (spend.length !== 1 || receive.length !== 1 || group.length !== 2) {
      unpaired.push(...group);
      continue;
    }

    const [spent] = spend as [LedgerRow];
    const [received] = receive as [LedgerRow];
    buys.push({
      refid: spent.refid,
      time: Math.min(spent.time, received.time),
      spent: {
        asset: spent.asset,
        amount: Math.abs(Number(spent.amount)),
        fee: Number(spent.fee || 0),
      },
      received: {
        asset: received.asset,
        amount: Number(received.amount),
        fee: Number(received.fee || 0),
      },
    });
  }

  return { buys: buys.sort((a, b) => a.time - b.time), unpaired };
}

/**
 * The display symbol for a ledger asset code, as Kraken states it.
 *
 * Suffixed balances resolve to their underlying — `XBT.S` is Bitcoin, not a
 * separate instrument — because Kraken documents the suffix set. An unknown
 * code returns undefined so the caller can surface it, rather than falling
 * back to the raw code and letting a wrong symbol reach the portfolio.
 */
export function displaySymbol(assets: Map<string, AssetInfo>, code: string): string | undefined {
  const exact = assets.get(code);
  if (exact?.display) return exact.display;

  const { base } = splitSuffix(code);
  if (base !== code) {
    const underlying = assets.get(base);
    if (underlying?.display) return underlying.display;
  }
  return undefined;
}

/** Every asset code the account has actually touched, ledger and balances alike. */
export function touchedAssets(dataset: KrakenDataset): Set<string> {
  const codes = new Set<string>();
  for (const row of dataset.ledgers) codes.add(row.asset);
  for (const [code, amount] of Object.entries(dataset.balances)) {
    if (Number(amount) !== 0) codes.add(code);
  }
  return codes;
}

/** Duplicate ledger ids, which would make de-duplication drop real rows. */
export function findDuplicateIds(rows: readonly { id: string }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
  return new Map([...counts].filter(([, count]) => count > 1));
}

/** One place a ledger's own running balance disagrees with its rows. */
export interface ContinuityGap {
  asset: string;
  /** The row whose balance does not follow from the one before it. */
  id: string;
  time: number;
  expected: number;
  actual: number;
  /** What is unaccounted for — a positive figure means rows are missing. */
  missing: number;
}

/**
 * Check the extraction against Kraken's own arithmetic.
 *
 * Every ledger row carries the resulting `balance`, so the ledger states its
 * own continuity: `balance = previous + amount - fee`, per asset, in time
 * order. Anywhere that fails, a row between the two is missing — and a missing
 * row is the one extraction fault that looks like success, because what did
 * arrive is entirely correct.
 *
 * This is not a theoretical guard. It is the only thing that caught a
 * pagination bug which dropped one row in 315: every asset balance reconciled
 * except sterling, and nothing else in the pipeline noticed.
 *
 * Runs on whatever was extracted, so a deliberately truncated walk reports a
 * gap at its own boundary — the caller knows whether it asked for everything.
 */
export function checkLedgerContinuity(rows: readonly LedgerRow[]): ContinuityGap[] {
  const byAsset = new Map<string, LedgerRow[]>();
  for (const row of rows) {
    if (row.balance === undefined) continue;
    const group = byAsset.get(row.asset);
    if (group) group.push(row);
    else byAsset.set(row.asset, [row]);
  }

  const gaps: ContinuityGap[] = [];
  for (const [asset, group] of byAsset) {
    const ordered = [...group].sort((a, b) => a.time - b.time);
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1]!;
      const row = ordered[index]!;
      const expected = Number(previous.balance) + Number(row.amount) - Number(row.fee || 0);
      const actual = Number(row.balance);
      // Kraken quotes to 8–10 decimals; anything under this is representation
      // noise rather than a missing row.
      if (Math.abs(expected - actual) < 1e-8) continue;
      gaps.push({ asset, id: row.id, time: row.time, expected, actual, missing: expected - actual });
    }
  }
  return gaps;
}
