# Trading 212 → Wealthfolio adapter

A Wealthfolio addon that reads filled orders from Trading 212 and imports them
as BUY/SELL activities.

This is the hello-world slice: it authenticates, pulls one window of order
history, maps it to Wealthfolio's import format, shows a preview, and writes
the rows you approve. It is deliberately small, but every layer it touches is
the real one.

```
Trading 212  ──►  Trading212Client  ──►  mapOrdersToActivities  ──►  checkImport  ──►  import
 /history/orders    (packages/core)        (packages/core)          (preview)      (write)
                          ▲
                          │ host-brokered HTTPS + OS keyring credentials
                    Wealthfolio addon sandbox (packages/addon)
```

## What it does today

- Stores your Trading 212 API key/secret in the OS keyring via the addon
  secrets API — never in the bundle, never in `localStorage`.
- Calls `GET /equity/account/summary` and `GET /equity/history/orders` through
  Wealthfolio's network broker (the sandbox blocks direct `fetch`).
- Follows the API's cursor pagination and paces requests inside the documented
  6-requests-per-minute budget.
- Maps each `TRADE` fill to a Wealthfolio activity, splitting Trading 212's
  charges into `fee` (commission, FX conversion, FINRA, PTM) and `tax` (stamp
  duty, SDRT, French FTT).
- Skips corporate actions (splits, stock dividends) instead of forcing them
  into a BUY, and reports what it skipped.
- Previews with `checkImport` — read-only — before anything is written.

## Repository layout

| Path | What lives there |
| --- | --- |
| [packages/core/](packages/core/) | Trading 212 client + activity mapper. No React, no Wealthfolio runtime — pure and testable. |
| [packages/addon/](packages/addon/) | The Wealthfolio addon: manifest, sandbox glue, React page. |
| [packages/addon/test/mocks/](packages/addon/test/mocks/) | Mock Wealthfolio host (see below). |
| [packages/core/test/](packages/core/test/) | Stub Trading 212 API and fixtures. |
| [scripts/smoke-live.ts](scripts/smoke-live.ts) | Read-only smoke test against the real API. |

## Setup

Requires Node 20+ and pnpm.

```bash
pnpm install
pnpm verify      # type-check + tests + production build
```

### Your Trading 212 credentials

Generate a key pair in the Trading 212 mobile app (Settings → API):
<https://helpcentre.trading212.com/hc/en-us/articles/14584770928157-Trading-212-API-key>

There are two places to put them, for two different purposes:

1. **In the addon UI** — the normal path. Paste the key and secret into the
   addon's settings form and they go straight into the OS keyring. Wealthfolio
   attaches them to each request host-side; the addon code never sees them
   again.

2. **`DEV_CREDENTIALS` in [packages/addon/src/config.ts](packages/addon/src/config.ts)** —
   the free variable for local development. Fill it in and the addon moves the
   values into the keyring on first start. Anything you put there is compiled
   into `dist/addon.js` in plaintext, so clear it before sharing a build.

For the out-of-app smoke test, copy `.env.example` to `.env` and fill in
`T212_API_KEY` / `T212_API_SECRET` instead — `.env` is gitignored.

## Verifying without a running Wealthfolio

Wealthfolio ships no mock host. `wealthfolio-addon test` only checks dev-server
connectivity, and the official addons unit-test pure helpers against CSV
fixtures. So this repo brings its own test environment:

- **[Mock Wealthfolio host](packages/addon/test/mocks/mock-host.ts)** — enough
  of `AddonContext` to run the addon's real code path. It enforces
  `network.allowedHosts`, resolves `auth.secretKey` from a fake keyring and
  builds the `Authorization` header itself (exactly as the broker does),
  validates rows in `checkImport`, and detects duplicates. Any host API the
  addon touches that the mock does not implement throws by name, mirroring the
  sandbox's "unknown API" error.
- **[Stub Trading 212 API](packages/core/test/t212-stub.ts)** — in-memory
  implementation of Basic auth, cursor pagination, `x-ratelimit-*` headers, and
  the 401/429 responses.

```bash
pnpm test          # 40 tests: client, mapper, and the full addon pipeline
pnpm test:watch
```

What this proves: credentials land in the keyring in the exact form the broker
needs, the plaintext secret never enters a request object, blocked hosts are
refused, pagination terminates, charges land in the right column, corporate
actions are skipped, invalid rows never reach `import()`, and a re-import is
detected as duplicates rather than doubling your positions.

What it cannot prove: that the real Wealthfolio host behaves like the mock, and
that Wealthfolio resolves the symbols this mapper produces. Both need a real
instance — see below.

### Smoke test against the real Trading 212 API

```bash
cp .env.example .env    # then fill it in
pnpm smoke:live
```

Performs the same two reads the addon performs and prints what would be
imported. Nothing is written; Wealthfolio is not involved.

## Running inside Wealthfolio

```bash
pnpm dev:server    # serves the addon on http://localhost:3001

# in a clone of wealthfolio/wealthfolio:
VITE_ENABLE_ADDON_DEV_MODE=true pnpm tauri dev
```

Wealthfolio auto-discovers the dev server and the addon appears in the sidebar
as **Trading 212**. For a distributable package:

```bash
pnpm bundle        # packages/addon/dist/trading212-import-0.1.0.zip
```

## Safety notes

- The addon talks to **live.trading212.com** — your real account. Every call it
  makes is a `GET`; it never places, amends, or cancels an order. To rehearse
  against paper money, point `T212_BASE_URL` in
  [packages/addon/src/config.ts](packages/addon/src/config.ts) at
  `T212_DEMO_BASE_URL` **and** add `demo.trading212.com` to
  `network.allowedHosts` in [manifest.json](packages/addon/manifest.json) — the
  broker refuses any host the manifest does not declare.
- The only write is into Wealthfolio, behind the preview and an explicit click.
- Symbol mapping is a heuristic. Trading 212 tickers like `VODl_EQ` carry a
  venue letter with no published rule, so guesses are flagged in the preview
  and correctable via `SYMBOL_OVERRIDES` in
  [packages/core/src/symbols.ts](packages/core/src/symbols.ts). The ISIN travels
  in each activity's comment so a wrong guess stays traceable.

## Not yet covered

Dividends (`/equity/history/dividends`), cash transactions
(`/equity/history/transactions`), current positions (`/equity/positions`),
corporate actions as SPLIT/DIVIDEND activities, and incremental sync that
remembers the last cursor instead of re-reading the same window.

## References

- [Trading 212 Public API](https://docs.trading212.com/api) (v0, beta)
- [Wealthfolio addon docs](https://github.com/wealthfolio/wealthfolio/blob/main/docs/addons/addon-getting-started.md)
- [`@wealthfolio/addon-sdk`](https://www.npmjs.com/package/@wealthfolio/addon-sdk)
