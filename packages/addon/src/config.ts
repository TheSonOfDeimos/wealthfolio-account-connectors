/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  YOUR TRADING 212 CREDENTIALS GO HERE (development convenience only)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Generate a key pair in the Trading 212 mobile app:
 * https://helpcentre.trading212.com/hc/en-us/articles/14584770928157-Trading-212-API-key
 *
 * Fill these in and the addon will move them into the OS keyring the first
 * time it starts, then use the keyring from there on. Leave them empty and the
 * addon asks for them in its settings form instead — which is the right way
 * round for anything you intend to share.
 *
 * Two things to know before you paste anything here:
 *   1. Whatever you put in this file is compiled into `dist/addon.js` in
 *      plaintext. Fine on your own machine, not fine in a bundle you hand out.
 *   2. This file IS tracked by git. Do not commit real keys. `git update-index
 *      --skip-worktree packages/addon/src/config.ts` keeps local edits out of
 *      your diffs.
 *
 * For the out-of-app smoke test (`pnpm smoke:live`), put the same values in a
 * `.env` at the repo root instead — that path is gitignored.
 */
export const DEV_CREDENTIALS = {
  apiKey: '',
  apiSecret: '',
};

/**
 * Which Trading 212 environment to talk to.
 *
 * This is the LIVE endpoint — your real account and real positions. Every call
 * the addon makes is a read (`GET`); it never places, amends or cancels an
 * order. The only thing it writes to is Wealthfolio, and only after you click
 * through the preview.
 *
 * To rehearse against paper money instead, set this to `'demo'` AND add
 * `demo.trading212.com` to `network.allowedHosts` in manifest.json — the host
 * broker refuses any host the manifest does not declare.
 */
export const T212_ENVIRONMENT: 'live' | 'demo' = 'live';

/** Keyring entry holding base64("API_KEY:API_SECRET"). */
export const CREDENTIALS_SECRET_KEY = 'trading212-basic-auth';

/** Wealthfolio account chosen for import; remembered between sessions. */
export const SELECTED_ACCOUNT_STORAGE_KEY = 'selected-account-id';

/**
 * How far back one sync walks.
 *
 * t212-sdk pages with the API's default size (20 entries) and paces itself
 * against `/history/orders`' 6-requests-per-minute budget, so 5 pages is one
 * minute of budget and roughly 100 entries. Raise it to reach further back, at
 * the cost of a slower sync.
 */
export const SYNC_DEFAULTS = {
  maxPages: 5,
};
