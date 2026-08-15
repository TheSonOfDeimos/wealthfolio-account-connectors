import type {
  AccountSummary,
  Exchange,
  HistoricalOrder,
  HistoryDividendItem,
  HistoryTransactionItem,
  InstrumentType,
  PaginatedResponse,
  Position,
  T212,
  T212Environment,
  TradableInstrument,
} from 't212-sdk';

/**
 * Everything the addon reads out of Trading 212, in one place.
 *
 * This module is the only thing that talks to Trading 212. It knows nothing
 * about Wealthfolio — no imports from the addon SDK, no React — so the exact
 * same code runs in the sandboxed addon (over the brokered fetch) and in
 * `scripts/smoke-live.ts` under Node. What the smoke test proves is therefore
 * what the addon does.
 *
 * Nothing here writes: every call is a `GET`.
 */

// ─────────────────────────────────────────────────────────────────────────────
//  What can be extracted
// ─────────────────────────────────────────────────────────────────────────────

/** Streams that page through history and are therefore capped and resumable. */
export const HISTORY_STREAMS = ['orders', 'dividends', 'transactions'] as const;
export type HistoryStream = (typeof HISTORY_STREAMS)[number];

/** Streams that return current state in a single request. */
export const STATE_STREAMS = ['summary', 'positions', 'instruments', 'exchanges'] as const;
export type StateStream = (typeof STATE_STREAMS)[number];

export const ALL_STREAMS = [...STATE_STREAMS, ...HISTORY_STREAMS] as const;
export type Stream = (typeof ALL_STREAMS)[number];

// ─────────────────────────────────────────────────────────────────────────────
//  Transport
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where the data comes from.
 *
 * Two transports, for one reason. `t212-sdk` handles the single-shot endpoints
 * well — it knows each one's minimum spacing and backs off on 429 — so
 * `client` is used for those. Its *pagination* is broken for
 * `/history/transactions`: the API returns `nextPagePath` carrying both
 * `cursor` and `time`, the SDK's `fetchPage` extracts only `cursor`, and the
 * API then rejects the request with "Both or none of cursorId and time must be
 * provided". Every history stream therefore paginates through `rawGet`, which
 * replays `nextPagePath` exactly as it was handed to us.
 */
export interface T212Source {
  client: T212;
  rawGet: T212RawGet;
}

export interface RawResponse {
  status: number;
  headers: Headers;
  body: string;
}

/** A GET against the API, given a path below `/api/v0`. */
export type T212RawGet = (path: string) => Promise<RawResponse>;

const BASE_URLS: Record<T212Environment, string> = {
  live: 'https://live.trading212.com',
  demo: 'https://demo.trading212.com',
};

const BASE_PATH = '/api/v0';

/**
 * Build a raw transport.
 *
 * Under Node, pass real `Authorization` headers. Inside the addon, pass the
 * brokered fetch and no headers at all — the host refuses an addon-supplied
 * `Authorization` and attaches its own from the keyring.
 */
export function createRawGet(options: {
  environment: T212Environment;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
}): T212RawGet {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const base = BASE_URLS[options.environment];

  return async (path) => {
    const response = await fetchImpl(`${base}${BASE_PATH}${path}`, {
      method: 'GET',
      headers: { Accept: 'application/json', ...options.headers },
    });
    return { status: response.status, headers: response.headers, body: await response.text() };
  };
}

export interface ExtractOptions {
  /** Which streams to fetch. Defaults to all of them. */
  streams?: readonly Stream[];
  /**
   * Ceiling on items per history stream, so a first run against a decade-old
   * account does not sit on a rate limiter for twenty minutes. `Infinity`
   * walks the whole history.
   *
   * Pages are taken whole, so the count overshoots to the end of the page that
   * crosses the ceiling — ask for 60 with a page size of 50 and you get 100.
   */
  maxItemsPerStream?: number;
  /**
   * Items per page for the streams that accept it. Trading 212 caps this and
   * the cap is undocumented per endpoint, so a rejected `limit` is retried once
   * without it rather than failing the stream.
   */
  pageLimit?: number;
  /**
   * Source ids already held elsewhere. A history stream stops as soon as a page
   * contains one of them.
   *
   * Trading 212 returns history newest-first, so the first already-known row
   * marks the boundary of what is new — everything past it has been seen. This
   * is what makes a routine sync cost one or two pages instead of the whole
   * account.
   */
  knownSourceIds?: ReadonlySet<string>;
  onProgress?: (event: ProgressEvent) => void;
}

export interface ProgressEvent {
  stream: Stream;
  message: string;
  /** Items collected for this stream so far. */
  items: number;
}

export interface StreamStat {
  stream: Stream;
  items: number;
  /** Only meaningful for `orders`, the one stream exposing page boundaries. */
  pages: number;
  /** True when `maxItemsPerStream` stopped the walk before history ran out. */
  truncated: boolean;
  elapsedMs: number;
  /** Set when the stream failed. The rest of the dataset is still usable. */
  error?: string;
  /** True when the caller did not ask for this stream. */
  skipped: boolean;
}

/**
 * A transaction as the API really returns it.
 *
 * `t212-sdk` narrows `type` to `WITHDRAW | DEPOSIT | FEE | TRANSFER`, which is
 * wrong — see `KNOWN_TRANSACTION_TYPES`. Widening it back to `string` at the
 * boundary keeps that error from propagating into the mapper, where a type the
 * compiler insists cannot exist would be quietly unhandled.
 */
export type T212Transaction = Omit<HistoryTransactionItem, 'type'> & { type: string };

/** One extraction run. Raw Trading 212 records, unmapped and unmodified. */
export interface T212Dataset {
  fetchedAt: string;
  summary?: AccountSummary;
  positions: Position[];
  instruments: TradableInstrument[];
  exchanges: Exchange[];
  orders: HistoricalOrder[];
  dividends: HistoryDividendItem[];
  transactions: T212Transaction[];
  stats: StreamStat[];
}

// ─────────────────────────────────────────────────────────────────────────────
//  Extraction
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_MAX_ITEMS = 200;
const DEFAULT_PAGE_LIMIT = 50;

export async function extractAll(
  source: T212Source,
  options: ExtractOptions = {},
): Promise<T212Dataset> {
  const { client: t212, rawGet } = source;
  const wanted = new Set<Stream>(options.streams ?? ALL_STREAMS);
  const maxItems = options.maxItemsPerStream ?? DEFAULT_MAX_ITEMS;
  const pageLimit = options.pageLimit ?? DEFAULT_PAGE_LIMIT;
  const report = options.onProgress ?? (() => {});

  const dataset: T212Dataset = {
    fetchedAt: new Date().toISOString(),
    positions: [],
    instruments: [],
    exchanges: [],
    orders: [],
    dividends: [],
    transactions: [],
    stats: [],
  };

  /**
   * Run one stream in isolation. A stream that fails is recorded and the rest
   * of the run continues — a 403 on `/history/dividends` should not cost you
   * the order history you already paid rate-limit budget for.
   */
  const run = async (
    stream: Stream,
    collect: () => Promise<{ items: number; pages?: number; truncated?: boolean }>,
  ): Promise<void> => {
    if (!wanted.has(stream)) {
      dataset.stats.push({
        stream,
        items: 0,
        pages: 0,
        truncated: false,
        elapsedMs: 0,
        skipped: true,
      });
      return;
    }

    const startedAt = Date.now();
    try {
      const { items, pages = 0, truncated = false } = await collect();
      dataset.stats.push({
        stream,
        items,
        pages,
        truncated,
        elapsedMs: Date.now() - startedAt,
        skipped: false,
      });
    } catch (error) {
      dataset.stats.push({
        stream,
        items: 0,
        pages: 0,
        truncated: false,
        elapsedMs: Date.now() - startedAt,
        error: describe(error),
        skipped: false,
      });
      report({ stream, message: `failed: ${describe(error)}`, items: 0 });
    }
  };

  // State first: it is cheap, and a failure here (bad credentials, wrong
  // environment) is worth surfacing before spending minutes on history.
  await run('summary', async () => {
    report({ stream: 'summary', message: 'Reading account summary…', items: 0 });
    dataset.summary = await t212.account.getSummary();
    return { items: 1 };
  });

  await run('instruments', async () => {
    report({ stream: 'instruments', message: 'Loading instrument catalogue…', items: 0 });
    dataset.instruments = await t212.instruments.list();
    return { items: dataset.instruments.length };
  });

  await run('exchanges', async () => {
    report({ stream: 'exchanges', message: 'Loading exchanges…', items: 0 });
    dataset.exchanges = await t212.instruments.exchanges();
    return { items: dataset.exchanges.length };
  });

  await run('positions', async () => {
    report({ stream: 'positions', message: 'Reading open positions…', items: 0 });
    dataset.positions = await t212.positions.list();
    return { items: dataset.positions.length };
  });

  const history = async <T>(
    stream: HistoryStream,
    path: string,
    sink: T[],
    sourceIdOf: (item: T) => string | undefined,
  ) =>
    run(stream, async () => {
      const result = await paginate<T>(rawGet, path, {
        maxItems,
        pageLimit,
        knownSourceIds: options.knownSourceIds,
        sourceIdOf,
        onPage: (pages, items) =>
          report({ stream, message: `page ${pages} (${items} items)`, items }),
      });
      sink.push(...result.items);
      if (result.reachedKnown) {
        report({ stream, message: 'reached already-imported history', items: result.items.length });
      }
      return {
        items: result.items.length,
        pages: result.pages,
        truncated: result.truncated,
        reachedKnown: result.reachedKnown,
      };
    });

  await history<HistoricalOrder>(
    'orders',
    '/equity/history/orders',
    dataset.orders,
    orderSourceId,
  );
  await history<HistoryDividendItem>(
    'dividends',
    '/equity/history/dividends',
    dataset.dividends,
    dividendSourceId,
  );
  await history<T212Transaction>(
    'transactions',
    '/equity/history/transactions',
    dataset.transactions,
    transactionSourceId,
  );

  return dataset;
}

/**
 * Walk a paginated history endpoint, following `nextPagePath` verbatim.
 *
 * Trading 212 returns that field in three shapes across the three endpoints —
 * an absolute path with the API prefix, a rooted path, and a bare query
 * fragment — and the transactions variant carries a `time` parameter that is
 * only valid alongside its `cursor`. Replaying the string exactly as given is
 * the only form that works for all three, which is precisely what `t212-sdk`
 * does not do.
 *
 * Pacing follows the same policy as the SDK's rate limiter, since bypassing
 * its transport also bypasses its throttling: spend the documented budget
 * evenly, and stand down until `x-ratelimit-reset` when it runs out.
 */
async function paginate<T>(
  rawGet: T212RawGet,
  initialPath: string,
  options: {
    maxItems: number;
    pageLimit: number;
    knownSourceIds?: ReadonlySet<string>;
    sourceIdOf?: (item: T) => string | undefined;
    onPage: (pages: number, items: number) => void;
  },
): Promise<{ items: T[]; pages: number; truncated: boolean; reachedKnown: boolean }> {
  const walk = async (pageLimit: number | undefined) => {
    const items: T[] = [];
    let path: string | null = pageLimit ? `${initialPath}?limit=${pageLimit}` : initialPath;
    let pages = 0;
    let truncated = false;
    let reachedKnown = false;

    while (path) {
      const page: PaginatedResponse<T> = await getJson<PaginatedResponse<T>>(rawGet, path);
      items.push(...page.items);
      pages += 1;
      options.onPage(pages, items.length);

      // History comes back newest-first, so the first row we already hold marks
      // the boundary of what is new. The whole page is kept — the caller
      // filters — because a page can straddle that boundary.
      if (options.knownSourceIds?.size && options.sourceIdOf) {
        const seen = page.items.some((item) => {
          const sourceId = options.sourceIdOf?.(item);
          return sourceId !== undefined && options.knownSourceIds!.has(sourceId);
        });
        if (seen) {
          reachedKnown = true;
          break;
        }
      }

      if (items.length >= options.maxItems) {
        truncated = page.nextPagePath !== null;
        break;
      }
      path = page.nextPagePath === null ? null : resolveNextPage(initialPath, page.nextPagePath);
    }

    return { items, pages, truncated, reachedKnown };
  };

  try {
    return await walk(options.pageLimit);
  } catch (error) {
    // A rejected page size is a request-shape problem, not an outage. Reads are
    // idempotent, so restarting the walk on the endpoint's own default is safe.
    if (!isBadRequest(error)) throw error;
    return walk(undefined);
  }
}

/** Turn any of the three `nextPagePath` shapes into a path below `/api/v0`. */
function resolveNextPage(initialPath: string, nextPagePath: string): string {
  if (nextPagePath.startsWith(BASE_PATH)) return nextPagePath.slice(BASE_PATH.length);
  if (nextPagePath.startsWith('/')) return nextPagePath;
  // `/history/transactions` returns a bare query fragment, `cursor` and `time`
  // together. Both must survive or the next request is rejected.
  return `${initialPath}?${nextPagePath}`;
}

/** Rate-limit state, shared across every paginated request in a run. */
let nextRequestAllowedAt = 0;

async function getJson<T>(rawGet: T212RawGet, path: string, retries = 3): Promise<T> {
  const delay = nextRequestAllowedAt - Date.now();
  if (delay > 0) await sleep(delay);

  const response = await rawGet(path);
  noteRateLimit(response.headers);

  if (response.status === 429 && retries > 0) {
    deferUntilReset(response.headers);
    return getJson<T>(rawGet, path, retries - 1);
  }
  if (response.status < 200 || response.status >= 300) {
    throw new HttpError(response.status, response.body);
  }

  return JSON.parse(response.body) as T;
}

function noteRateLimit(headers: Headers): void {
  if (headers.get('x-ratelimit-remaining') === '0') {
    deferUntilReset(headers);
    return;
  }
  const limit = Number(headers.get('x-ratelimit-limit'));
  const period = Number(headers.get('x-ratelimit-period'));
  if (limit > 0 && period > 0) {
    nextRequestAllowedAt = Math.max(nextRequestAllowedAt, Date.now() + (period * 1000) / limit);
  }
}

function deferUntilReset(headers: Headers): void {
  const reset = Number(headers.get('x-ratelimit-reset'));
  const period = Number(headers.get('x-ratelimit-period') ?? 5);
  nextRequestAllowedAt = Math.max(
    nextRequestAllowedAt,
    reset > 0 ? reset * 1000 : Date.now() + (period || 5) * 1000,
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * An API failure, carrying Trading 212's own explanation.
 *
 * The `detail` field is what identified the transactions pagination bug —
 * "Both or none of cursorId and time must be provided" — so it is worth
 * surfacing rather than reducing to a status code.
 */
class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`${status} ${explain(body)}`);
    this.name = 'HttpError';
  }
}

function explain(body: string): string {
  try {
    const parsed = JSON.parse(body) as { detail?: string; title?: string };
    return parsed.detail ?? parsed.title ?? body.slice(0, 120);
  } catch {
    return body.slice(0, 120).replace(/\s+/g, ' ');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Events — the ledger, with Trading 212's identity preserved
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Transaction types this account actually returns.
 *
 * `t212-sdk` types `TransactionType` as `WITHDRAW | DEPOSIT | FEE | TRANSFER`,
 * and that union is wrong: `/history/transactions` also returns
 * `INTEREST_ON_FREE_CASH`, which is where interest on uninvested cash lives —
 * 192 daily accruals in the account this was verified against. Nothing here
 * narrows a transaction to this list; it exists so an unrecognised type can be
 * reported rather than silently mapped to the wrong activity.
 */
export const KNOWN_TRANSACTION_TYPES = [
  'DEPOSIT',
  'WITHDRAW',
  'FEE',
  'TRANSFER',
  'INTEREST_ON_FREE_CASH',
] as const;

export type T212TransactionType = (typeof KNOWN_TRANSACTION_TYPES)[number];

export function isKnownTransactionType(type: string): type is T212TransactionType {
  return (KNOWN_TRANSACTION_TYPES as readonly string[]).includes(type);
}

export type T212EventKind = 'order' | 'dividend' | 'transaction';

interface EventBase {
  /**
   * Trading 212's identity for this row, stable across re-fetches.
   *
   * Everything downstream keys off this: duplicate detection on re-import, the
   * high-water mark for incremental syncs, and tracing a Wealthfolio activity
   * back to the exact broker record it came from.
   */
  sourceId: string;
  /** ISO 8601. The ledger is replayed in this order. */
  occurredAt: string;
  ticker?: string;
}

export type T212Event =
  | (EventBase & { kind: 'order'; record: HistoricalOrder })
  | (EventBase & { kind: 'dividend'; record: HistoryDividendItem })
  | (EventBase & { kind: 'transaction'; record: T212Transaction });

/*
 * Source ids, derived straight from a raw record.
 *
 * Kept as standalone functions because pagination needs them mid-walk, before
 * there is a dataset to build events from — and if the two disagreed, an
 * incremental sync would stop at the wrong place or never stop at all.
 */

export function orderSourceId(record: HistoricalOrder): string | undefined {
  const { order, fill } = record;
  if (!order) return undefined;
  return fill ? `t212:order:${order.id}:fill:${fill.id}` : `t212:order:${order.id}`;
}

export function dividendSourceId(record: HistoryDividendItem): string {
  return `t212:dividend:${record.reference}`;
}

export function transactionSourceId(record: T212Transaction): string {
  return `t212:transaction:${record.reference}`;
}

/**
 * Flatten a dataset into one chronological ledger.
 *
 * Order matters beyond tidiness: split ratios can only be recovered by
 * replaying fills in sequence and watching the running quantity, because
 * Trading 212 reports a share delta where Wealthfolio wants a ratio.
 *
 * Rows with no usable timestamp are dropped into `undated` rather than being
 * given a fabricated date that would put them in the wrong place in the replay.
 */
export function toEvents(dataset: T212Dataset): {
  events: T212Event[];
  undated: T212Event[];
} {
  const all: T212Event[] = [];

  for (const record of dataset.orders) {
    const { order, fill } = record;
    const sourceId = orderSourceId(record);
    if (!order || !sourceId) continue;
    all.push({
      kind: 'order',
      sourceId,
      occurredAt:
        fill?.filledAt ?? order.dateExecuted ?? order.createdAt ?? order.creationTime ?? '',
      ticker: order.instrument?.ticker ?? order.ticker,
      record,
    });
  }

  for (const record of dataset.dividends) {
    all.push({
      kind: 'dividend',
      sourceId: dividendSourceId(record),
      occurredAt: record.paidOn ?? '',
      ticker: record.instrument?.ticker ?? record.ticker,
      record,
    });
  }

  for (const record of dataset.transactions) {
    all.push({
      kind: 'transaction',
      sourceId: transactionSourceId(record),
      occurredAt: record.dateTime ?? '',
      record,
    });
  }

  const events = all.filter((event) => event.occurredAt !== '');
  events.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));

  return { events, undated: all.filter((event) => event.occurredAt === '') };
}

/**
 * Source ids that appear more than once.
 *
 * Should always be empty. If it is not, the identity scheme above is unsound
 * for this account and duplicate detection would silently drop real rows, so
 * callers are expected to treat a non-empty result as a failure.
 */
export function findDuplicateSourceIds(events: T212Event[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const event of events) {
    counts.set(event.sourceId, (counts.get(event.sourceId) ?? 0) + 1);
  }
  return new Map([...counts].filter(([, count]) => count > 1));
}

// ─────────────────────────────────────────────────────────────────────────────
//  Assets — everything Trading 212 knows about one instrument
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Currencies Trading 212 quotes in minor units, and what they are worth.
 *
 * `GBX` is pence. A London listing quoted at 447.5 GBX is £4.475, and the
 * account settles in GBP — so a price copied across unscaled overstates every
 * UK holding by 100x. Confirmed against this account: each `*l_EQ` position's
 * `currentPrice x quantity` is exactly 100x the value Trading 212 reports.
 */
const MINOR_UNIT_CURRENCIES: Record<string, { major: string; per: number }> = {
  GBX: { major: 'GBP', per: 100 },
  GBp: { major: 'GBP', per: 100 },
  ZAc: { major: 'ZAR', per: 100 },
  ILA: { major: 'ILS', per: 100 },
};

export interface T212Price {
  /** Exactly as Trading 212 quotes it, in `currency`. */
  value: number;
  /** The instrument's quote currency, not the account's. May be minor units. */
  currency: string;
  /** `value / per` — the same price in major units. Use this downstream. */
  majorValue: number;
  /** The major-unit currency `majorValue` is denominated in. */
  majorCurrency: string;
  /** 1 when the quote is already in major units, 100 for pence. */
  per: number;
  asOf: string;
}

/** Resolve a quote currency to its major-unit equivalent. */
export function toMajorUnits(value: number, currency: string): {
  majorValue: number;
  majorCurrency: string;
  per: number;
} {
  const minor = MINOR_UNIT_CURRENCIES[currency];
  return minor
    ? { majorValue: value / minor.per, majorCurrency: minor.major, per: minor.per }
    : { majorValue: value, majorCurrency: currency, per: 1 };
}

export interface T212Asset {
  ticker: string;
  /** Catalogue `shortName` — the closest thing to a real market symbol. */
  shortName?: string;
  name?: string;
  isin?: string;
  currency?: string;
  type?: InstrumentType;
  /** The full catalogue row, absent when the instrument is delisted or foreign. */
  instrument?: TradableInstrument;
  /** Resolved through the instrument's working schedule. */
  exchange?: Exchange;
  /** Current holding, absent for instruments only present in history. */
  position?: Position;
  price?: T212Price;
  counts: { orders: number; dividends: number };
  firstSeen?: string;
  lastSeen?: string;
  inCatalogue: boolean;
}

/**
 * Assemble one record per instrument the account has ever touched, merging the
 * catalogue, the exchange list, the open position and the history.
 *
 * The union of "held now" and "seen in history" is deliberate: a position sold
 * to zero still needs its metadata to map the trades that closed it.
 */
export function buildAssetIndex(dataset: T212Dataset): Map<string, T212Asset> {
  const catalogue = new Map(dataset.instruments.map((item) => [item.ticker, item]));

  // `TradableInstrument.workingScheduleId` points into `Exchange.workingSchedules`,
  // which is the only link the API gives between an instrument and its venue.
  const exchangeBySchedule = new Map<number, Exchange>();
  for (const exchange of dataset.exchanges) {
    for (const schedule of exchange.workingSchedules ?? []) {
      exchangeBySchedule.set(schedule.id, exchange);
    }
  }

  const assets = new Map<string, T212Asset>();
  const touch = (ticker: string): T212Asset => {
    let asset = assets.get(ticker);
    if (asset) return asset;

    const instrument = catalogue.get(ticker);
    asset = {
      ticker,
      shortName: instrument?.shortName,
      name: instrument?.name,
      isin: instrument?.isin,
      currency: instrument?.currencyCode,
      type: instrument?.type,
      instrument,
      exchange:
        instrument === undefined ? undefined : exchangeBySchedule.get(instrument.workingScheduleId),
      counts: { orders: 0, dividends: 0 },
      inCatalogue: instrument !== undefined,
    };
    assets.set(ticker, asset);
    return asset;
  };

  for (const position of dataset.positions) {
    const asset = touch(position.instrument.ticker);
    asset.position = position;
    asset.name ??= position.instrument.name;
    asset.isin ??= position.instrument.isin;
    // The catalogue is authoritative on quote currency; the position's
    // instrument currency is the fallback when the catalogue has no entry.
    asset.currency ??= position.instrument.currency;
    if (asset.currency) {
      asset.price = {
        value: position.currentPrice,
        currency: asset.currency,
        ...toMajorUnits(position.currentPrice, asset.currency),
        asOf: dataset.fetchedAt,
      };
    }
  }

  const { events } = toEvents(dataset);
  for (const event of events) {
    if (!event.ticker) continue;
    const asset = touch(event.ticker);
    if (event.kind === 'order') asset.counts.orders += 1;
    if (event.kind === 'dividend') asset.counts.dividends += 1;
    asset.firstSeen ??= event.occurredAt;
    asset.lastSeen = event.occurredAt;
  }

  return assets;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Reconciliation
// ─────────────────────────────────────────────────────────────────────────────

export type PricingVerdict =
  /** Quote and reported value agree in the account's own currency. */
  | 'ok'
  /** Quote is in minor units; `per` says by how much. */
  | 'minor-units'
  /** Quote is in another currency; `ratio` is the implied FX rate. */
  | 'cross-currency'
  /** Neither explanation fits. The price cannot be trusted downstream. */
  | 'mismatch';

export interface PositionCheck {
  ticker: string;
  quantity: number;
  /** `currentPrice` x quantity, exactly as quoted. */
  quoted: number;
  quoteCurrency: string;
  /** The same, converted to major units. */
  quotedMajor: number;
  majorCurrency: string;
  per: number;
  /** What Trading 212 says the position is worth, in account currency. */
  reported: number;
  accountCurrency: string;
  /** `quotedMajor / reported`. 1 in the account's currency, else the FX rate. */
  ratio: number;
  verdict: PricingVerdict;
}

/**
 * Check each position's quoted price against the value Trading 212 reports.
 *
 * This is the guard against the pence/pounds trap, and the evidence that
 * `MINOR_UNIT_CURRENCIES` is right: scale the quote to major units first, and
 * a London listing that looked 100x too big should land exactly on the
 * reported value. Anything left over in the account's own currency is a real
 * mismatch and must not reach Wealthfolio unexamined.
 */
export function checkPositionPricing(
  dataset: T212Dataset,
  assets: Map<string, T212Asset>,
): PositionCheck[] {
  return dataset.positions.map((position) => {
    const ticker = position.instrument.ticker;
    const quoteCurrency = assets.get(ticker)?.currency ?? position.instrument.currency ?? '?';
    const accountCurrency = position.walletImpact.currency;
    const quoted = position.currentPrice * position.quantity;
    const { majorValue: quotedMajor, majorCurrency, per } = toMajorUnits(quoted, quoteCurrency);
    const reported = position.walletImpact.currentValue;
    const ratio = reported === 0 ? Number.NaN : quotedMajor / reported;

    // Within a percent of the reported value is agreement; the residue is the
    // delay between the position snapshot and the quote behind it.
    const agrees = Math.abs(ratio - 1) < 0.01;

    return {
      ticker,
      quantity: position.quantity,
      quoted,
      quoteCurrency,
      quotedMajor,
      majorCurrency,
      per,
      reported,
      accountCurrency,
      ratio,
      verdict:
        majorCurrency === accountCurrency
          ? agrees
            ? per === 1
              ? 'ok'
              : 'minor-units'
            : 'mismatch'
          : // A different currency explains any ratio, so nothing is provable
            // here without an FX rate we do not have. Report, do not judge.
            'cross-currency',
    };
  });
}

export type FillPricingVerdict =
  /** `gross / fxRate` lands exactly on the wallet impact. */
  | 'exact'
  /** It lands there once the fill's own charges are added or subtracted. */
  | 'charges-explain'
  /** Neither. The row's cost basis cannot be trusted. */
  | 'unexplained';

export interface FillPricingCheck {
  sourceId: string;
  ticker: string;
  /** The currency `fill.price` is quoted in. */
  quoteCurrency: string;
  /** The currency the account actually settled in. */
  walletCurrency: string;
  price: number;
  quantity: number;
  /** `|price x quantity|`, in the quote currency. */
  gross: number;
  fxRate: number;
  /** `gross / fxRate`, in the wallet currency, before charges. */
  converted: number;
  netValue: number;
  charges: number;
  /** `netValue - converted` — what the charges have to account for. */
  residual: number;
  verdict: FillPricingVerdict;
}

/**
 * Establish what `fill.price` is denominated in, and how `fxRate` applies.
 *
 * Both were open questions, and both matter more than they look: the mapper
 * currently labels every row with the wallet currency while taking `unitPrice`
 * from `fill.price`, which is only correct when the two coincide.
 *
 * Verified against a live account: `fill.price` is in the *instrument's*
 * currency, and `fxRate` divides rather than multiplies — `gross / fxRate`
 * reproduces the wallet impact, with the remainder equal to the fill's own
 * charges. Pence listings fall out of the same rule, Trading 212 reporting
 * `fxRate: 100` for a GBX instrument in a GBP account, so one formula covers
 * both minor units and real currency conversion.
 */
export function checkFillPricing(
  dataset: T212Dataset,
  assets: Map<string, T212Asset>,
): FillPricingCheck[] {
  const checks: FillPricingCheck[] = [];

  for (const { order, fill } of dataset.orders) {
    if (!order || !fill || fill.type !== 'TRADE') continue;

    const ticker = order.instrument?.ticker ?? order.ticker;
    const wallet = fill.walletImpact;
    const quoteCurrency =
      assets.get(ticker)?.currency ?? order.instrument?.currency ?? order.currency ?? '?';
    const gross = Math.abs(fill.price * fill.quantity);
    const fxRate = wallet?.fxRate || 1;
    const converted = gross / fxRate;
    const netValue = Math.abs(wallet?.netValue ?? 0);
    const charges = (wallet?.taxes ?? []).reduce(
      (total, charge) => total + Math.abs(charge.quantity ?? 0),
      0,
    );
    const residual = netValue - converted;

    // A hundredth of a unit is the reporting precision; anything inside that
    // is rounding, not a modelling error.
    const tolerance = 0.011;

    checks.push({
      sourceId: `t212:order:${order.id}:fill:${fill.id}`,
      ticker,
      quoteCurrency,
      walletCurrency: wallet?.currency ?? '?',
      price: fill.price,
      quantity: fill.quantity,
      gross,
      fxRate,
      converted,
      netValue,
      charges,
      residual,
      verdict:
        Math.abs(residual) < tolerance
          ? 'exact'
          : Math.abs(Math.abs(residual) - charges) < tolerance
            ? 'charges-explain'
            : 'unexplained',
    });
  }

  return checks;
}

export interface ValueCheck {
  /** Summed from positions, in account currency. */
  positionsValue: number;
  /** What `/account/summary` reports for investments. */
  reportedInvestments: number;
  cash: number;
  reportedTotal: number;
  /** `positionsValue + cash - reportedTotal`. */
  residual: number;
  currency: string;
}

/**
 * Does positions + cash add up to the total Trading 212 shows?
 *
 * This is the number goal 2 has to reproduce in Wealthfolio, so it is worth
 * knowing whether it even reconciles on Trading 212's own figures first.
 */
export function checkAccountValue(dataset: T212Dataset): ValueCheck | undefined {
  const { summary } = dataset;
  if (!summary) return undefined;

  const positionsValue = dataset.positions.reduce(
    (total, position) => total + position.walletImpact.currentValue,
    0,
  );
  const cash = summary.cash.availableToTrade + summary.cash.reservedForOrders + summary.cash.inPies;

  return {
    positionsValue,
    reportedInvestments: summary.investments.currentValue,
    cash,
    reportedTotal: summary.totalValue,
    residual: positionsValue + cash - summary.totalValue,
    currency: summary.currency,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A rejected request shape, as opposed to an outage or a rate limit. */
function isBadRequest(error: unknown): boolean {
  return error instanceof HttpError && error.status >= 400 && error.status < 500 && error.status !== 429;
}
