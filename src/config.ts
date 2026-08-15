/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  YOUR TRADING 212 CREDENTIALS GO HERE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Generate a key pair in the Trading 212 mobile app (Settings → API):
 * https://helpcentre.trading212.com/hc/en-us/articles/14584770928157-Trading-212-API-key
 *
 * This is the single place credentials live for development. Fill it in and:
 *   • the addon moves them into the OS keyring on first start, then uses the
 *     keyring from there on;
 *   • `pnpm smoke:live` reads them directly to call the real API from Node.
 *
 * Leave it empty and the addon asks for the pair in its settings form instead
 * — the right way round for anything you intend to share.
 *
 * Two things to know before pasting real keys:
 *   1. Whatever is here is compiled into `dist/addon.js` in plaintext. Fine on
 *      your own machine, not fine in a bundle you hand out.
 *   2. This file IS tracked by git. Keep local edits out of your diffs with:
 *      git update-index --skip-worktree src/config.ts
 */
export const DEV_CREDENTIALS = {
  apiKey: 'REDACTED-API-KEY',
  apiSecret: 'REDACTED-API-SECRET',
};

/**
 * Which Trading 212 environment to talk to.
 *
 * `live` is your real account. Every call the addon makes is a read (`GET`);
 * it never places, amends or cancels an order. The only thing it writes to is
 * Wealthfolio, and only after you click through the preview.
 *
 * To rehearse against paper money, set this to `'demo'` AND add
 * `demo.trading212.com` to `network.allowedHosts` in manifest.json — the host
 * broker refuses any host the manifest does not declare.
 */
export const T212_ENVIRONMENT: 'live' | 'demo' = 'live';

/**
 * Symbol corrections, keyed by Trading 212 ticker.
 *
 * Symbols normally come from Trading 212's instrument catalogue. Add an entry
 * here when the catalogue's `shortName` is not what Wealthfolio's market-data
 * provider expects — typically to add an exchange suffix — or when an
 * instrument is missing from the catalogue entirely, which the preview will
 * tell you about by name.
 */
export const SYMBOL_OVERRIDES: Record<string, string> = {
  // 'VODl_EQ': 'VOD.L',
  // 'AIRp_EQ': 'AIR.PA',
};

/**
 * Trading 212 exchange names to ISO 10383 market identifier codes.
 *
 * Without a MIC, Wealthfolio guesses the venue from the bare symbol and guesses
 * badly: a live import resolved the London ETF `IBZL` as `IBZL@XETR` on
 * Deutsche Börse and found nothing. The names on the left are Trading 212's
 * own, taken from `/equity/metadata/exchanges`; add to this table when the
 * smoke test reports an exchange that is not here.
 */
export const EXCHANGE_MIC: Record<string, string> = {
  NYSE: 'XNYS',
  NASDAQ: 'XNAS',
  'London Stock Exchange': 'XLON',
  'London Stock Exchange AIM': 'XLON',
  'London Stock Exchange NON-ISA': 'XLON',
  'Toronto Stock Exchange': 'XTSE',
  'Deutsche Börse Xetra': 'XETR',
  'SIX Swiss Exchange': 'XSWX',
  'Wiener Börse': 'XWBO',
  'Bolsa de Madrid': 'XMAD',
  'Borsa Italiana': 'XMIL',
  'Euronext Amsterdam': 'XAMS',
  'Euronext Brussels': 'XBRU',
  'Euronext Lisbon': 'XLIS',
  'Euronext Paris': 'XPAR',
  // Over-the-counter, not an exchange. Left unmapped on purpose: forcing a MIC
  // here would send the lookup somewhere it certainly is not.
  'OTC Markets': '',
  Gettex: 'MUNC',
};

/** Keyring entry holding base64("API_KEY:API_SECRET"). */
export const CREDENTIALS_SECRET_KEY = 'trading212-basic-auth';

/** Wealthfolio account chosen for import; remembered between sessions. */
export const SELECTED_ACCOUNT_STORAGE_KEY = 'selected-account-id';

/**
 * The account this addon created and syncs into. Remembered so a second run
 * adopts it instead of creating a duplicate.
 */
export const LINKED_ACCOUNT_STORAGE_KEY = 'linked-account-id';

/**
 * Stamped on accounts this addon creates, alongside the Trading 212 account id.
 * Together they survive a rename and a cleared addon storage, which is what
 * makes re-finding the account reliable.
 */
export const T212_PROVIDER = 'TRADING212';

/**
 * How far back one extraction walks, per history stream.
 *
 * t212-sdk paces itself against each endpoint's rate-limit headers, so the
 * only cost of a bigger number is wall-clock time. Raise it — or pass
 * `Infinity` — for a full backfill; keep it small while iterating on mapping,
 * where the shape of the data matters more than its volume.
 */
export const MAX_HISTORY_ITEMS = 200;

/**
 * Items per page for the history endpoints that accept a page size. Trading
 * 212 caps this per endpoint and does not document the ceiling; a rejected
 * value is retried once on the endpoint's own default.
 */
export const HISTORY_PAGE_LIMIT = 50;
