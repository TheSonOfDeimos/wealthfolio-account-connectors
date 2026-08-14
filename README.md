# Trading 212 → Wealthfolio adapter

A Wealthfolio addon that reads filled orders from Trading 212 and imports them
as BUY/SELL activities.

This is the hello-world slice: it authenticates, pulls one window of order
history, maps it to Wealthfolio's import format, shows a preview, and writes
the rows you approve. It is deliberately small, but every layer it touches is
the real one.

```
Trading 212  ──►  t212-sdk  ──►  mapOrdersToActivities  ──►  checkImport  ──►  import
 /history/orders   (client)      (src/lib/mapper.ts)          (preview)      (write)
                      ▲
                      │ brokered fetch: host-attached auth, allowlisted host
                    Wealthfolio addon sandbox
```

## What it does today

- Stores your Trading 212 API key/secret in the OS keyring via the addon
  secrets API — never in the bundle, never in `localStorage`.
- Calls `GET /equity/account/summary` and `GET /equity/history/orders` through
  Wealthfolio's network broker (the sandbox blocks direct `fetch`).
- Uses [`t212-sdk`](https://github.com/codeledge/t212-sdk) for the API itself —
  cursor pagination, rate-limit pacing, and typed responses generated from
  Trading 212's own schema.
- Maps each `TRADE` fill to a Wealthfolio activity, splitting Trading 212's
  charges into `fee` (commission, FX conversion, FINRA, PTM) and `tax` (stamp
  duty, SDRT, French FTT).
- Skips corporate actions (splits, stock dividends) instead of forcing them
  into a BUY, and reports what it skipped.
- Previews with `checkImport` — read-only — before anything is written.

## Repository layout

| Path | What lives there |
| --- | --- |
| [manifest.json](manifest.json) | Addon identity, sidebar entry, permissions, allowed hosts. |
| [src/addon.tsx](src/addon.tsx) | Entry point: registers the route, captures the host context. |
| [src/config.ts](src/config.ts) | Credentials, environment, page limit. |
| [src/lib/](src/lib/) | `brokered-fetch` (sandbox egress), `credentials` (keyring), `mapper` (translation), `sync` (pipeline). |
| [src/pages/](src/pages/) | The import page. |
| [scripts/smoke-live.ts](scripts/smoke-live.ts) | Read-only check against the real Trading 212 API. |
| [compose.yml](compose.yml) | A local Wealthfolio instance for testing the addon. |
| [.vscode/](.vscode/) | Workspace with tasks and debug configs. |

## Setup

Requires Node 20+ and pnpm.

```bash
pnpm install
pnpm verify      # type-check + production build
```

### Your Trading 212 credentials

Generate a key pair in the Trading 212 mobile app (Settings → API):
<https://helpcentre.trading212.com/hc/en-us/articles/14584770928157-Trading-212-API-key>

`DEV_CREDENTIALS` in [src/config.ts](src/config.ts) is the one place they live
during development. Fill it in and the addon moves the pair into the OS keyring
on first start, while `pnpm smoke:live` reads it directly to call the API from
Node.

Anything you put there is compiled into `dist/addon.js` in plaintext and the
file is tracked by git, so keep local edits out of your diffs with
`git update-index --skip-worktree src/config.ts`, and clear it before sharing a
build. Leave it empty and the addon asks for the pair in its settings form
instead — the right way round for a shared addon, and the only path that keeps
credentials out of the bundle entirely.

## Checking it works

There is no test suite — the addon is exercised against the real Trading 212
API and a real Wealthfolio instance.

### Against the real Trading 212 API

```bash
pnpm smoke:live
```

Performs the same two reads the addon performs, maps them with the same mapper,
and prints what would be imported. Nothing is written; Wealthfolio is not
involved. It also prints a currency check — see the note below.

## A Wealthfolio instance in Docker

Wealthfolio publishes a server build that runs the *same* addon host as the
desktop app — verified: `POST /api/v1/addons/<id>/network/request` is served by
the same handler, so the network broker this addon depends on is present.

```bash
cp .env.docker.example .env.docker
echo "WF_SECRET_KEY=$(openssl rand -base64 32)" >> .env.docker
docker compose --env-file .env.docker up -d
open http://127.0.0.1:8088
```

Then install `trading212-import-0.1.0.zip` through Settings → Addons → **+**.
The file picker reads from your machine, not the container, so nothing needs
mounting.

Two differences from the desktop app:

- Credentials land in an encrypted file inside the container volume (keyed by
  `WF_SECRET_KEY`), not your OS keyring.
- Addon dev mode is compiled out of release builds, so `pnpm dev:server` hot
  reload does **not** reach this instance. Rebuild and reinstall the zip.

The compose file binds to `127.0.0.1` and disables auth, which is safe only
because nothing off this machine can reach it. Don't expose it without setting
up authentication — see [upstream compose.yml](https://github.com/wealthfolio/wealthfolio/blob/main/compose.yml)
for the password-hash and OIDC options.

## Running inside Wealthfolio

```bash
pnpm dev:server    # serves the addon on http://localhost:3001

# in a clone of wealthfolio/wealthfolio:
VITE_ENABLE_ADDON_DEV_MODE=true pnpm tauri dev
```

Wealthfolio auto-discovers the dev server and the addon appears in the sidebar
as **Trading 212**. For a distributable package:

```bash
pnpm bundle        # trading212-import-0.1.0.zip
```

## Safety notes

- The addon talks to **live.trading212.com** — your real account. Every call it
  makes is a `GET`; it never places, amends, or cancels an order. To rehearse
  against paper money, set `T212_ENVIRONMENT` in
  [src/config.ts](src/config.ts) to `'demo'`
  **and** add `demo.trading212.com` to `network.allowedHosts` in
  [manifest.json](manifest.json) — the broker refuses any host
  the manifest does not declare.
- The only write is into Wealthfolio, behind the preview and an explicit click.
- Symbols come from Trading 212's instrument catalogue
  (`GET /equity/metadata/instruments`), not from parsing the ticker — its
  format is undocumented. An instrument missing from the catalogue (a delisted
  name still in your history) keeps its raw Trading 212 ticker, which
  Wealthfolio will reject visibly; fix those with `SYMBOL_OVERRIDES` in
  [src/config.ts](src/config.ts). The ISIN travels in each activity's comment
  so a wrong symbol stays traceable.
- **Open question — trade currency.** The mapper labels each row with the
  wallet currency while taking `unitPrice` from `fill.price`, which may be
  quoted in the instrument's currency. If so, a US stock bought in a GBP
  account would be priced in USD but labelled GBP. `pnpm smoke:live` prints the
  arithmetic that settles it; fix [src/lib/mapper.ts](src/lib/mapper.ts) before
  trusting an import of cross-currency trades.

## Not yet covered

Dividends (`/equity/history/dividends`), cash transactions
(`/equity/history/transactions`), current positions (`/equity/positions`),
corporate actions as SPLIT/DIVIDEND activities, and incremental sync that
remembers the last cursor instead of re-reading the same window.

## References

- [Trading 212 Public API](https://docs.trading212.com/api) (v0, beta)
- [Wealthfolio addon docs](https://github.com/wealthfolio/wealthfolio/blob/main/docs/addons/addon-getting-started.md)
- [`@wealthfolio/addon-sdk`](https://www.npmjs.com/package/@wealthfolio/addon-sdk)

## On the `t212-sdk` dependency

The Trading 212 API layer is [`t212-sdk`](https://github.com/codeledge/t212-sdk)
(MIT), **pinned to an exact version** rather than a caret range, so an upgrade
is always a deliberate act. It was audited before adoption: no install scripts,
unminified shipped code, no `eval`/`child_process`/`fs`/DOM access, and the only
URL literals in the bundle are `live.trading212.com` and `demo.trading212.com`
— its base URL is not user-configurable. The published tarball matches the
public source at that commit. Its two declared dependencies are never imported
by the shipped code.

Its weakness is obscurity, not conduct: ~70 downloads a month, one maintainer,
and a `v2` sitting unreleased on `main`. Two things bound the risk — the SDK is
bundled into `dist/addon.js` and pinned by the lockfile, so a later bad version
cannot reach a built addon; and every request it makes passes through the host's
`allowedHosts` check, which holds whether or not the library behaves.

Treat any version bump as a re-audit. The diff is small enough to read.
