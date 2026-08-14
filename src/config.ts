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

/** Keyring entry holding base64("API_KEY:API_SECRET"). */
export const CREDENTIALS_SECRET_KEY = 'trading212-basic-auth';

/** Wealthfolio account chosen for import; remembered between sessions. */
export const SELECTED_ACCOUNT_STORAGE_KEY = 'selected-account-id';

/**
 * How far back one sync walks. t212-sdk pages at the API's default size (20
 * entries) and paces itself against `/history/orders`' 6-requests-per-minute
 * budget, so 5 pages is one minute of budget and roughly 100 entries.
 */
export const MAX_HISTORY_PAGES = 5;
