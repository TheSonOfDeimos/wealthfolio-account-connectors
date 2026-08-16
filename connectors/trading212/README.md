# Trading 212 → Wealthfolio

Imports your whole Trading 212 history into [Wealthfolio](https://wealthfolio.app)
— trades, dividends, deposits, withdrawals, interest and charges — and keeps it
in step afterwards.

Part of [wealthfolio-account-connectors](../../README.md); start there for
installing, the workspace layout and the licence.

```
Trading 212  ──►  extract  ──►  mapper  ──►  saveMany  ──►  reconcile  ──►  recalculate
 orders            (all           (one       (writes       (asset          (Wealthfolio
 dividends          history        activity    activities    currencies      revalues)
 transactions       streams)       per event)  + assets)     vs T212)
 positions              ▲
 instruments            │ brokered fetch: host-attached auth, allowlisted host
 exchanges            Wealthfolio addon sandbox
```

## Layout

| Path | What lives there |
| --- | --- |
| [manifest.json](manifest.json) | Addon identity, sidebar entry, permissions, allowed hosts. |
| [src/addon.tsx](src/addon.tsx) | Entry point: registers the route, captures the host context. |
| [src/config.ts](src/config.ts) | Environment, storage keys, history limits. No secrets. |
| [src/lib/extract.ts](src/lib/extract.ts) | Everything read from Trading 212, and the pagination its SDK cannot do. |
| [src/lib/mapper.ts](src/lib/mapper.ts) | Trading 212 records → Wealthfolio activities. |
| [src/lib/symbols.ts](src/lib/symbols.ts) | Symbol resolution, your corrections, and the price sanity check. |
| [src/lib/symbol-table.ts](src/lib/symbol-table.ts) | Generated: 17,400 instruments as `SYMBOL\|MIC\|CURRENCY`. |
| [src/lib/pipeline.ts](src/lib/pipeline.ts) | A sync end to end: fetch, map, write, reconcile, revalue. |
| [src/pages/ImportPage.tsx](src/pages/ImportPage.tsx) | The wizard, then the control panel. |
| [tools/](tools/) | Live smoke test, ledger reconciliation, symbol-table generation. |

## What it does

- **Imports the full history.** Filled orders, dividends, deposits and
  withdrawals, interest on free cash, and every charge — each as its own
  activity, keyed by Trading 212's own record id so a re-run never doubles up.
- **Keeps every currency as the broker recorded it.** A US trade stays in
  dollars, a London one in pence. Trading 212's conversion rate rides along on
  the activity; no conversion happens behind your back.
- **Resolves symbols from what Trading 212 states**, never from the ticker
  string. `ABML_US_EQ` is `ABAT`, because the company renamed and the code did
  not follow — a parsing rule that looked 88% right mapped holdings to the
  wrong companies, silently.
- **Corrects the currency Wealthfolio assigns to each asset.** Wealthfolio
  derives it from the exchange, so every London listing becomes pence — right
  for the pence lines, and a 100× error for the ones quoted in pounds or
  dollars. Each sync checks and repairs this.
- **Flags what it cannot settle.** A holding priced far from Trading 212's
  quote is reported as a probable wrong security, with a box to correct the
  symbol; the correction is saved and applied on the next sync.
- **Reconciles.** Cash lands within pennies of Trading 212's own figure, and
  the totals are checked against the broker's.

Corporate actions beyond share splits, and withholding tax on foreign
dividends, are deliberately **not** mapped — Trading 212 does not report them
separately, and a number there would be a guess. See *Not yet covered*.

### Your Trading 212 credentials

Generate a key pair in the Trading 212 mobile app (Settings → API):
<https://helpcentre.trading212.com/hc/en-us/articles/14584770928157-Trading-212-API-key>

Read access is all this needs. Every call it makes is a `GET`; it never places,
amends or cancels an order.

**In the addon**, you paste the pair into its first setup step. It goes
straight into Wealthfolio's keyring, survives restarts and reinstalls, and the
addon never reads it back — the host attaches it to each request itself. The
only thing that clears it is *Reset everything*.

**For the Node scripts** — `pnpm smoke:live` and `pnpm symbols:generate`, which
run outside the sandbox and have no keyring — copy `.env.example` to `.env` and
fill it in:

```bash
cp .env.example .env
```

`.env` is git-ignored. Nothing in the tracked source holds a secret, and
nothing secret is compiled into `dist/addon.js`. An earlier version kept the
pair in `src/config.ts`, which put a live key into the git history and every
built bundle; that history has been rewritten and the key revoked.

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

The addon can now create its own account ([the connector kit](../../packages/connector-kit/src/account.ts)),
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


## A Wealthfolio instance in Docker

Wealthfolio publishes a server build that runs the *same* addon host as the
desktop app — verified: `POST /api/v1/addons/<id>/network/request` is served by
the same handler, so the network broker this addon depends on is present.

```bash
cp docker/.env.docker.example docker/.env.docker
echo "WF_SECRET_KEY=$(openssl rand -base64 32)" >> docker/.env.docker
docker compose -f docker/compose.yml --env-file docker/.env.docker up -d
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
no reinstall, no tab reload. `docker/compose.yml` already allows CORS from `:1420`.

## Licence

[GNU AGPL v3](../../LICENSE), like the rest of the repository.
