# Kraken → Wealthfolio

Imports your Kraken history into [Wealthfolio](https://wealthfolio.app) — purchases,
deposits, withdrawals and staking rewards — and keeps it in step afterwards.

Part of [wealthfolio-account-connectors](../../README.md); start there for
installing, the workspace layout and the licence.

**Status: working.** Verified end to end against a live Kraken account and a
real Wealthfolio 3.6.3 — 289 activities imported, 0 rejected, and 19 of 21
asset balances reproduced to the last decimal. The two that differ are
purchases paid for in crypto, which are deliberately left out; see
[The currency ceiling](#the-currency-ceiling).

```
Kraken  ──►  extract  ──►  mapper  ──►  saveMany  ──►  recalculate
 ledgers      (all          (one       (writes        (Wealthfolio
 trades        history       activity   activities     revalues)
 assets        streams)      per event) + assets)
 balances          ▲
 funding           │ signed in-sandbox: API-Key + API-Sign over a brokered fetch
 earn            Wealthfolio addon sandbox
```

## Layout

| Path | What lives there |
| --- | --- |
| [src/config.ts](src/config.ts) | Rate limits, page sizes, importable currencies, storage keys. No secrets. |
| [src/lib/sign.ts](src/lib/sign.ts) | HMAC-SHA512 request signing, on WebCrypto so Node and the sandbox run the same code. |
| [src/lib/client.ts](src/lib/client.ts) | Transport over an injected `fetch`, and Kraken's rate limiter modelled. |
| [src/lib/types.ts](src/lib/types.ts) | What Kraken actually returns, as far as this reads it. |
| [src/lib/extract.ts](src/lib/extract.ts) | Every stream, the pagination, and the joins the mapper needs. |
| [src/lib/mapper.ts](src/lib/mapper.ts) | Kraken records → Wealthfolio activities. |
| [src/lib/pipeline.ts](src/lib/pipeline.ts) | A sync end to end: fetch, map, write, revalue. |
| [src/lib/assets.ts](src/lib/assets.ts) | Correcting the price source and the name Wealthfolio gave each asset. |
| [src/pages/ImportPage.tsx](src/pages/ImportPage.tsx) | The wizard, then the control panel. |
| [tools/smoke-live.ts](tools/smoke-live.ts) | Live smoke test against a real account. |
| [tools/probe-host.ts](tools/probe-host.ts) | What Wealthfolio does with the rows this sends. |
| [tools/reconcile-docker.ts](tools/reconcile-docker.ts) | Replays a ledger into Docker and compares balances. |

## Why there is no SDK

Every Kraken client on npm bundles its own HTTP layer — axios, got, `request`,
`ws` — and that is precisely the layer the addon sandbox forbids. The sandbox is
an opaque-origin iframe with no egress; the only way out is
`ctx.api.network.request`. Trading 212's SDK was usable only because it accepts
an injected `fetch`, and no Kraken wrapper offers the same seam.

`@siebly/kraken-api` came closest and is genuinely well made — published by the
maintainer behind `bybit-api`, `binance` and `okx-api`, browser-targeted, with a
correct WebCrypto signature. But `BaseRestClient` calls `axios(options)`
directly and mutates the global axios interceptors, so using it would mean
reaching through a bundled dependency's globals for 1.45 MB and 204 files to
reach six endpoints.

The transport here is instead a port of
[`kraken-api`](https://github.com/nothingisdead/npm-kraken-api)'s `kraken.js`
(MIT, deprecated, Node-only) — read as the reference implementation, not
depended on. Its 180 lines pin down the signing algorithm and the method list.

## Your Kraken credentials

Kraken Pro → Settings → API → **Add API key**. Tick exactly three boxes:

| Group | Permission | Reaches |
| --- | --- | --- |
| Funds permissions | **Query** | `Balance`, `TradeBalance`, `DepositStatus`, `Earn/Allocations` |
| Orders and trades | **Query closed orders & trades** | `TradesHistory` |
| Data | **Query ledger entries** | `Ledgers`, `WithdrawStatus` |

Everything else is a write path that buys no extra visibility, verified per
endpoint against a live account:

- **Earn** covers `Earn/Allocate` and `Earn/Deallocate` only — moving your funds
  between strategies. Reading allocations runs on *Funds · Query*.
- **Withdraw** gates the actual `Withdraw` call. `WithdrawStatus` accepts
  *Query ledger entries* instead.
- **Deposit** gates `DepositAddresses`, which generates addresses.
  `DepositStatus` needs only *Funds · Query*.

Leave all six toggles off. **Query start date** and **Query end date** matter
most: either one silently caps how far back the key can read, which truncates a
backfill without saying so.

Use the key for nothing else. Kraken requires a strictly increasing nonce per
key, so a second tool sharing it produces `EAPI:Invalid nonce` that looks
exactly like a bug in here.

**For the Node tools**, copy `.env.example` to `.env` and fill in
`KRAKEN_API_KEY` and `KRAKEN_API_SECRET`. `.env` is git-ignored, and a
pre-commit hook refuses both a staged `.env` and a filled-in `.env.example`.

## Checking it works

```bash
pnpm smoke:live                     # 500 rows per history stream
pnpm smoke:live -- --full           # walk the whole history
pnpm smoke:live -- --json=out.json  # dump the raw dataset

pnpm probe:host                     # what the host does with our rows
pnpm reconcile -- --dataset=kraken-dataset.json
```

### Does the ledger reproduce Kraken's balances?

```bash
pnpm smoke:live -- --full --json=kraken-dataset.json
pnpm reconcile -- --dataset=kraken-dataset.json
```

Balances are the sharpest test available, and a better one than the Trading 212
connector gets: Kraken states the closing balance of **every** asset, so each
holding has a stated answer that depends on nothing but the ledger. On a live
account, 19 of 21 reconcile exactly and the remaining two are short by precisely
the crypto-quoted purchases the mapper declines.

### What the host actually does with our rows

```bash
pnpm probe:host
```

Writes a handful of deliberately-varied activities into a throwaway account and
reads them back. Six behaviours decide the mapper's shape, and every one was
settled here rather than guessed:

| Verified | Consequence |
| --- | --- |
| A BUY without `unitPrice` is stored with a **null** price — not derived, not rejected | The price must be computed; a null cost basis is silent and worse than an error |
| `asset.kind` beats the host's own guess; without it `GRT` is stored as an **EQUITY** | Always send `CRYPTO` |
| `sourceSystem`, `sourceRecordId`, `subtype`, `needsReview` and `idempotencyKey` are all forwarded and stored, though the SDK declares none of them | Provenance lives in fields, not stamped into a comment |
| An activity in a crypto currency is accepted **silently** and then never priced | Fiat-quoted rows only |
| A BUY at `unitPrice: 0` creates a real holding | Rewards can be recorded without inventing a value |

Drives [src/lib/extract.ts](src/lib/extract.ts) — the same module, the same
calls, the same order the addon will use — and prints the balances, the ledger
with its own ids, a census of every entry type, the purchases, the funding
detail, the Earn allocations, and which of it can honestly be imported.

Nothing is written. Wealthfolio is not involved.

## What a live account settled

- **Kraken's documented ledger types are incomplete.** A real account returns
  `spend` and `receive`, which appear nowhere in the list. They are the two legs
  of an **Instant Buy**, sharing a `refid` — and they never reach
  `TradesHistory`. An account that only bought that way reports **zero trades**
  while visibly holding what it bought. This is why the smoke test prints a
  census of whatever arrives rather than checking against a fixed list.
- **Staking rewards dominate by row count**, and Kraken takes a cut: each
  `staking` row carries its own `fee`, around 30% of the reward on some assets.
  They are not free money arriving whole.
- **Kraken has no account currency.** Balances are held per asset;
  `TradeBalance` only converts into whichever asset you ask for. The connector
  has to ask which currency the Wealthfolio account should use.
- **The rate limiter sets the pace.** History endpoints cost 4 against a counter
  of 20 decaying at 0.5/s — one 50-row page every eight seconds sustained. A
  316-row ledger takes about 20 seconds; an incremental sync stops on the first
  page and takes a tenth of one.
- **`Ledgers` cannot be paginated by descending `end`.** Kraken's timestamps are
  fractional but `end` behaves as whole seconds, so a page boundary inside a
  cluster of same-second rows skips the rest of that second. It silently lost a
  £49.50 purchase out of 315 rows — every asset reconciled except sterling. The
  walk uses offset paging inside a window fixed at the start instead, and every
  sync now checks the ledger against its own running balance, which is the only
  thing that catches a *missing* row.
- **A crypto asset's quote currency belongs to its price feed, not to what you
  paid.** Yahoo carries GBP pairs only for the majors — `BTC-GBP` resolves,
  `GRT-GBP`, `TAO-GBP`, `ARKM-GBP` and `RENDER-GBP` are all 404 — so setting it
  from the purchase left seven of twenty holdings unpriced. Assets are quoted in
  USD; activities keep the currency Kraken charged.

## The currency ceiling

Wealthfolio resolves an activity's currency as an FX pair in Yahoo's format,
`format!("{}{}=X", from, to)`. So a `BTC` activity becomes a request for
`BTCUSD=X` — which does not exist. Verified: `BTC-USD` and `USDT-USD` both
resolve as *crypto assets*, while `BTCUSD=X` and `USDTUSD=X` are 404. Nothing
rejects the row; it is stored and then silently never priced.

Kraken states no fiat equivalent for a crypto-quoted purchase, and inventing one
is what this project refuses to do. So those rows are **reported by name rather
than written**, and `FIAT_CURRENCIES` in [src/config.ts](src/config.ts) is the
line between the two. On the account this was built against, 22 of 24 purchases
were paid in GBP and importable; two were paid in TRX and USDG and were not.

## Prices come from Kraken, not Yahoo

Wealthfolio prices crypto through Yahoo, whose symbol space is not Kraken's, and
it is wrong in two directions at once. It has no entry at all for `GRT`, `TAO`,
`BABY` or `CC`. For others it resolves a **different instrument** and returns a
confident, wrong number: `USDG-USD` quotes about $5.45 for a dollar stablecoin,
and `CC-USD` is CloudCoin — not the Canton Coin that Kraken's `CC` actually is,
and roughly twice the price.

A wrong price is worse than a missing one, because nothing looks broken.

So the connector offers a **custom Wealthfolio provider** reading Kraken's own
public endpoints — no API key, and the venue the holdings actually sit on:

| Source | Endpoint | Gives |
| --- | --- | --- |
| Latest | `/0/public/Ticker` | the current price |
| Historical | `/0/public/OHLC?interval=1440` | 721 daily candles, about two years |

Both are needed. Without the historical one every chart is empty and every
return figure is computed against a single point.

The addon **cannot create the provider**: the SDK has no custom-provider API,
and the host's own REST API is unreachable from the sandbox. Nor can it ask
whether one exists — `market.getProviders()` returns the built-in provider
*types*, never a configured custom one. So it detects absence by trying, and
then shows every field with a copy button for a one-time setup under
**Settings → Market Data → Custom Providers**. It can assign a provider to an
asset, which it does through `providerConfig`.

Two details that cost time to find:

- **Keep the `*` in every path.** Kraken re-keys some pairs in its response — a
  request for `XBTUSD` comes back under `XXBTZUSD`, `ETHUSD` under `XETHZUSD` —
  so an exact key works for most coins and silently fails on the majors.
- **Pin the pair to `USD`, never `{CURRENCY}`.** That placeholder expands to the
  *asset's* currency, so a GBP-quoted asset asks Kraken for `ARKMGBP`, a pair
  that does not exist. Eight assets failed at once that way.

## Asset names

Kraken's API speaks only in codes. `/0/public/Assets` returns `aclass`,
`altname`, `decimals` and `status`; `AssetPairs` gets as far as
`wsname: "CC/USD"`; the private Earn endpoints report `asset: "ADA"`. Nothing
serves a human-readable name — "Canton Coin" exists on Kraken's website and in
no response this connector can make.

Left alone, Wealthfolio names a new asset from whatever its provider matched,
which is how `CC` became "CloudCoin USD". So the default name is Kraken's own
code, and [`ASSET_NAMES`](src/config.ts) is where a proper one goes — your
knowledge stated in the source, rather than the code guessing. Only names listed
there are corrected on an existing asset: for the majors the provider's name is
right, and overwriting one you set by hand would be worse than the problem.

## Not yet covered

- **The rate you were actually given.** Kraken states no fiat value for a
  staking reward or a coin-for-coin exchange — not in `Ledgers`, not in
  `TradesHistory` (a Convert is not a trade), not in `QueryTrades`. Those rows
  are valued at Kraken's published daily close for the asset instead, which is
  a real number for a known asset and date but not the rate on your ticket. A
  swap is written as a sell and a buy priced from the sell's proceeds, so it is
  cash-neutral; a reward is written as `DIVIDEND`/`DIVIDEND_IN_KIND`, which
  adds the units and a cost basis without spending money you never spent. Where
  Kraken publishes no close, the row falls back to zero cost and is flagged.
  Dropping such rows instead — the first attempt — left TRX 461 units high and
  CC 911 low.
- **Prices that resolve to the wrong instrument.** Quoting assets in USD gets
  them all priced, but not all priced correctly: Yahoo's `USDG-USD` quotes about
  $5.45 for a dollar stablecoin, and its `TAO-USD` is plainly not Bittensor. A
  wrong price is worse than a missing one, so each sync compares the resulting
  portfolio against Kraken's own `TradeBalance` valuation and reports the gap.
  Correct an individual asset with a per-provider symbol override on its Market
  Data tab.
- **Tokenized equities.** Kraken lists 352 `tokenized_asset` pairs — `AAPLx` is
  backed by Apple but is not Apple, and mapping one to the other would be the
  `ABML_US_EQ` mistake in a different costume. The class is stated explicitly by
  Kraken, so they can be flagged rather than guessed at.
- **Margin, futures and the `transfer` subtypes.** No account has exercised them
  here yet; the census will show them the first time one does.

## References

- [Kraken Spot REST API](https://docs.kraken.com/api/docs/rest-api/)
- [Spot REST authentication](https://docs.kraken.com/api/docs/guides/spot-rest-auth/)
- [Rate limits](https://support.kraken.com/articles/206548367-what-are-the-api-rate-limits-)

## Licence

[GNU AGPL v3](../../LICENSE), like the rest of the repository.
