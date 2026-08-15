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
| [src/config.ts](src/config.ts) | Credentials, environment, history limits. |
| [src/lib/](src/lib/) | `extract` (everything read from Trading 212), `mapper` (translation), `account` (create/re-find the Wealthfolio account), `brokered-fetch` (sandbox egress), `credentials` (keyring), `sync` (pipeline). |
| [src/pages/](src/pages/) | The import page. |
| [scripts/smoke-live.ts](scripts/smoke-live.ts) | Read-only extraction report against the real Trading 212 API. |
| [scripts/reconcile-docker.ts](scripts/reconcile-docker.ts) | Replays a ledger into the Docker instance and checks the cash balance against Trading 212. |
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
pnpm smoke:live                     # 200 items per history stream
pnpm smoke:live -- --full           # walk the whole history
pnpm smoke:live -- --streams=summary,positions
pnpm smoke:live -- --json=out.json  # dump the raw dataset
```

Drives [src/lib/extract.ts](src/lib/extract.ts) — the same module, the same
calls, the same order the addon uses inside Wealthfolio — and prints what came
back: per-stream timings, the ledger with its Trading 212 source ids, a census
of every event type seen, one dossier per instrument the account has touched,
current prices, and the reconciliation checks. Nothing is written; Wealthfolio
is not involved.

It exits non-zero if a stream fails or if two events share a source id, so it
doubles as a regression check on the extraction layer.

Three things it settled on a real account:

- **Interest is reachable over REST.** `/equity/history/transactions` returns
  `INTEREST_ON_FREE_CASH` rows, despite `t212-sdk` typing `TransactionType`
  without them. No CSV export is needed.
- **`t212-sdk` cannot paginate `/history/transactions`.** That endpoint's
  `nextPagePath` carries `cursor` *and* `time`; the SDK extracts only `cursor`
  and the API replies "Both or none of cursorId and time must be provided".
  Every history stream therefore paginates through our own transport, which
  replays `nextPagePath` verbatim.
- **London listings are quoted in pence.** `currencyCode` is `GBX` and
  `currentPrice x quantity` is exactly 100x the value Trading 212 reports for
  the position. `toMajorUnits` does the scaling; the price check proves it,
  landing all twelve GBX positions on a ratio of 1.0000.

### Does the ledger reproduce Trading 212's cash?

```bash
pnpm smoke:live -- --full --json=full.json
pnpm reconcile -- --dataset=full.json
```

Maps the ledger with the same `mapDataset` the addon uses, replays it into the
Docker instance, and compares the resulting cash balance with the one Trading
212 reports. Cash is the sharp test: it depends on nothing but the ledger —
every deposit, trade, charge, dividend and interest payment in its own currency
— so a match means the mapping is arithmetically sound. Exits non-zero on a
drift over 2p.

It writes over the container's REST API rather than through the addon host, so
it proves the numbers, not the addon's plumbing. It deletes its probe account
afterwards unless you pass `--keep`. A truncated ledger can never reconcile;
`--full` is not optional here.

## A Wealthfolio instance in Docker

Wealthfolio publishes a server build that runs the *same* addon host as the
desktop app — verified: `POST /api/v1/addons/<id>/network/request` is served by
the same handler, so the network broker this addon depends on is present.

```bash
cp .env.docker.example .env.docker
echo "WF_SECRET_KEY=$(openssl rand -base64 32)" >> .env.docker
docker compose --env-file .env.docker up -d
```

Then open <http://127.0.0.1:8088> — the `Wealthfolio: open in editor` task
does it in VS Code's Simple Browser.

> **Not Safari.** Safari cannot host Wealthfolio's addon sandbox: the host
> renders addons in an `<iframe sandbox="allow-scripts" srcdoc=…>` and then
> dynamically imports `blob:` URLs from it, which WebKit blocks from an opaque
> origin. The addon times out with *"Failed to start add-on"* before any of its
> code runs. Chromium browsers — including VS Code's Simple Browser — are fine.

Then install `trading212-import-0.1.0.zip` through Settings → Addons → **+**.
The file picker reads from your machine, not the container, so nothing needs
mounting.

Two differences from the desktop app:

- Credentials land in an encrypted file inside the container volume (keyed by
  `WF_SECRET_KEY`), not your OS keyring.
- Addon dev mode is compiled out of release builds, so there is no hot reload
  against this instance. Rebuild and reinstall the zip.

The compose file binds to `127.0.0.1` and disables auth, which is safe only
because nothing off this machine can reach it. Don't expose it without setting
up authentication — see [upstream compose.yml](https://github.com/wealthfolio/wealthfolio/blob/main/compose.yml)
for the password-hash and OIDC options.

## The development loop

Three options, cheapest first.

**1. Mapper changes — `pnpm smoke:live`.** Same mapping code, real Trading 212
data, no install step, ~2s. Debuggable with F5 in VS Code. Wealthfolio only
becomes necessary once you are testing `checkImport` / `import` behaviour.

**2. Against the container — the `Addon: deploy to Wealthfolio` task.** Runs
the full bundle (clean → type-check → build → zip) and pushes the zip to the
container's `POST /addons/install-zip` — the same call the "Install from file"
button makes. About 2.5s. Deliberately explicit rather than save-triggered.
Reinstalling preserves stored secrets, so credentials survive each round. The
browser tab needs a manual reload: the frontend loads addons at startup and
nothing external can re-trigger that.

```bash
pnpm dev:deploy              # WF_URL=… to point elsewhere
```

**3. True hot reload — the paved path.** Wealthfolio's addon dev server works
against its frontend running in Vite dev mode, which can talk to the
containerised backend. No Rust toolchain and no Tauri build required; the
container stays as the backend.

```bash
# once, in a clone of wealthfolio/wealthfolio
pnpm install

# terminal 1 — frontend in addon-dev mode, proxying to our container
VITE_API_TARGET=http://127.0.0.1:8088 pnpm dev:addons     # serves :1420

# terminal 2 — in this repo (needs @wealthfolio/addon-dev-tools back)
pnpm add -D @wealthfolio/addon-dev-tools@^3.6.2
npx wealthfolio-addon dev                                  # serves :3001
```

Open <http://localhost:1420>. The frontend runs with `import.meta.env.DEV`
true, which is the flag that enables addon dev mode, so it discovers
`localhost:3001`, polls `/status`, and re-mounts the addon on every rebuild —
no reinstall, no tab reload. `compose.yml` already allows CORS from `:1420`.

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
- **Settled — currencies and rates.** `fill.price` is quoted in the
  *instrument's* currency, and `fill.walletImpact.fxRate` **divides**:
  `|price x quantity| / fxRate` reproduces the wallet impact, the remainder
  being the fill's own charges. Verified across every `TRADE` fill in a live
  account — 76 exact, 119 explained by charges, 0 unexplained; `pnpm
  smoke:live` prints the arithmetic under "Fill pricing".

## The mapping contract

One rule: **record what Trading 212 recorded, and convert nothing.** Prices keep
the currency they were quoted in, charges keep the currency they were charged
in, and no exchange rate is derived or applied to an amount. Where Trading 212
does not report a figure, none is invented.

Three host behaviours shape the output. All three were verified against a real
Wealthfolio 3.6.3 instance, not assumed:

| Verified | Consequence |
| --- | --- |
| `fxRate` **multiplies** (`base = local x fxRate`) | Trading 212's rate divides, so the mapper sends `1 / fxRate`. Sending 1.3469 unchanged produced £1346.90 where £742.45 was correct — wrong by its own square. |
| `GBX` and `GBp` are **normalised natively** | 2922 GBX x 8 stored as £233.76, matching Trading 212's `netValue` exactly. The mapper sends the raw pence price and `fxRate: 1`; scaling here would divide twice. |
| `fee` is read **in the row's currency** | A GBP charge on a USD row is silently counted as USD, so charges leave as their own `FEE`/`TAX` activities in the currency they were charged. |

On a live account this maps 505 events to 613 activities with zero warnings —
`BUY` rows in USD, GBX, CAD, EUR and GBP, each keeping its own currency.

## Not yet covered

- **Corporate actions.** `STOCK_SPLIT` and friends are extracted and reported,
  never guessed at. Splits need the running quantity from a chronological
  replay, since Trading 212 reports a share delta where Wealthfolio wants a
  ratio — and it models one split as a paired sell and buy.
- **Dividend withholding tax.** Not recoverable: `amount` is net of both
  withholding *and* a currency conversion, `tickerCurrency` is absent from the
  response despite being typed as required, and no per-dividend rate is given.
  The gross per share is preserved in the comment instead.
- **Prices and incremental sync.** No `quotes.update`, so market values come
  from Wealthfolio's own provider, and no persisted high-water mark — each run
  re-reads the same window rather than resuming.

The addon can now create its own account ([src/lib/account.ts](src/lib/account.ts)),
named by you and denominated in Trading 212's currency so cash needs no
conversion. It is stamped with `provider: TRADING212` and the Trading 212
account id, and re-found on later runs by stored id, then provider, then name —
so a second run adopts the account instead of duplicating it. This needs the
`accounts.create` permission, which is a re-consent prompt on upgrade.

Two things the API cannot give at all: price history (there is no candles
endpoint, only a live `currentPrice` per poll) and pie attribution (order
history carries no pie id).

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
