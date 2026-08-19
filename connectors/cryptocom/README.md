# Crypto.com → Wealthfolio

Imports your [Crypto.com **Exchange**](https://crypto.com/exchange) history into
[Wealthfolio](https://wealthfolio.app) — trades, deposits, withdrawals and
staking rewards — and keeps it in step afterwards.

Part of [wealthfolio-account-connectors](../../README.md); start there for
installing, the workspace layout and the licence.

**Status: working.** Verified end to end against a live Crypto.com Exchange
account: 622 ledger rows and 126 fills extracted across eighteen months, and
**all ten asset balances reproduced exactly** — both from the ledger and from
the activities the mapper writes.

```
Crypto.com  ──►  extract  ──►  mapper  ──►  saveMany  ──►  recalculate
 transactions     (all          (one       (writes        (Wealthfolio
 trades            history       activity   activities     revalues)
 balances          streams)      per event) + assets)
 funding                ▲
 staking                │ signed in-sandbox: HMAC-SHA256 inside the JSON body
 instruments        Wealthfolio addon sandbox
```

## The Exchange, not the app

They are two different products and only one of them has an API.

| | Crypto.com **Exchange** | Crypto.com **App** |
| --- | --- | --- |
| API keys | Manage Account → API Management | **None at all** |
| Getting data out | This connector | CSV export, by hand |

If **API Management** is not in your Manage Account menu, you are on the app and
this connector cannot see your holdings. Every tax and portfolio tool that
advertises a "Crypto.com API import" means the Exchange.

## Layout

| Path | What lives there |
| --- | --- |
| [src/config.ts](src/config.ts) | Window limits, rate limits, currencies, storage keys. No secrets. |
| [src/lib/sign.ts](src/lib/sign.ts) | HMAC-SHA256 and `params_to_str`, on WebCrypto so Node and the sandbox run the same code. |
| [src/lib/client.ts](src/lib/client.ts) | Transport over an injected `fetch`, and the per-method rate limiter. |
| [src/lib/types.ts](src/lib/types.ts) | What Crypto.com actually returns, as far as this reads it. |
| [src/lib/extract.ts](src/lib/extract.ts) | Every stream, the window walk and the page walk. |
| [src/lib/mapper.ts](src/lib/mapper.ts) | Crypto.com records → Wealthfolio activities. |
| [src/lib/prices.ts](src/lib/prices.ts) | Daily closes, paged, for the rows Crypto.com values in nothing. |
| [src/lib/pipeline.ts](src/lib/pipeline.ts) | A sync end to end: fetch, map, write, revalue. |
| [src/lib/assets.ts](src/lib/assets.ts) | Correcting the price source and the name Wealthfolio gave each asset. |
| [src/pages/ImportPage.tsx](src/pages/ImportPage.tsx) | The wizard, then the control panel. |
| [tools/smoke-live.ts](tools/smoke-live.ts) | Live smoke test — is the extraction complete? |
| [tools/reconcile.ts](tools/reconcile.ts) | Offline replay — is the mapping faithful? |

## Why there is no SDK

[ccxt](https://github.com/ccxt/ccxt) covers this exchange properly and was read
as the reference implementation — its `sign()` pins down the signature payload
and its endpoint table pins down the per-method costs. Depending on it would
mean shipping megabytes and a bundled HTTP layer to reach eight endpoints, and
that layer is exactly what the addon sandbox forbids: an opaque-origin iframe
whose only egress is `ctx.api.network.request`.

`node-crypto-com` is four years stale. `@crypto.com/developer-platform-client`
is for the Cronos chain, not the exchange.

## Your Crypto.com credentials

crypto.com/exchange → **Manage Account → API Management → Create a new API key**.

| Permission | Set it to |
| --- | --- |
| **Can Read** | on — the default, and all this connector uses |
| Enable Trading | **off** |
| Enable Withdrawal | **off** |

Leaving both toggles off matters twice over. The obvious reason, and a second
one that is easy to miss: Crypto.com **requires an IP whitelist** as soon as
either is enabled, and a whitelist pinned to one address breaks the addon the
moment you move networks. A read-only key needs none.

The secret is shown once, at creation, and cannot be retrieved afterwards.

Unlike Kraken's, neither half is base64 — both are plain strings used exactly as
displayed. The secret is the UTF-8 HMAC key and must not be decoded, which is
the first thing to check if every call comes back `UNAUTHORIZED`.

**For the Node tools**, copy `.env.example` to `.env` and fill in
`CRYPTOCOM_API_KEY` and `CRYPTOCOM_API_SECRET`. `.env` is git-ignored, and a
pre-commit hook refuses both a staged `.env` and a filled-in `.env.example`.

## Checking it works

```bash
pnpm smoke:live                          # walk back until the history runs out
pnpm smoke:live -- --days=30             # a shorter walk, for iterating
pnpm smoke:live -- --json=out.json       # dump the raw dataset

pnpm reconcile                           # fetch live, then check the mapping
pnpm reconcile -- --dataset=out.json     # replay a saved dump instead
```

The two answer different questions, and both matter:

- **`smoke:live`** — is the *extraction* complete? It rebuilds every balance
  from the ledger and compares against the balance Crypto.com states.
- **`reconcile`** — is the *translation* faithful? It runs the real mapper over
  the real dataset and adds up the quantities the activities would create. This
  is where a fee counted twice or a staked balance split in two would show, and
  it needs neither Wealthfolio nor Docker.

`reconcile` earned its place immediately: it caught three coin-for-coin trades
being dropped, which left CRO 173.13 low, SOL 0.749235 low and USDT 185.69854
high while every other holding matched exactly.

## What a live account settled

- **The documented 6-month limit is not what the ledger does.** Crypto.com
  states "History will be stored for recent 6 months record only", and rows from
  fifteen months back come out without complaint. This connector believed the
  documentation first and shipped a walk that stopped at 180 days, reporting the
  gap as Crypto.com's refusal. It was our own default.

- **The real limit is a silent 7-day clamp.** `get-transactions` and
  `get-trades` answer for the most recent seven days before `end_time`, whatever
  range you ask for. Measured with `end_time` fixed and only the span varied:

  | requested span | rows | oldest row |
  | --- | --- | --- |
  | 3 days | 24 | 2.0 days before end |
  | 7 days | 26 | 6.0 days before end |
  | 30 days | 26 | 6.0 days before end |
  | 90 days | 26 | 6.0 days before end |

  A 90-day request returns the same rows as a 7-day one, with no error and no
  truncation flag. A wider window does not fetch more — it *skips* what it
  claims to cover. `MAX_HISTORY_WINDOW_DAYS` is a ceiling, not a knob.

- **The funding endpoints are the opposite shape.** They take `page`/`page_size`
  and no useful range, and they return the whole history at once. Walking them
  by time window found 2 of 6 withdrawals. `page` is *mandatory* on the fiat
  pair — omitting it returns `BAD_REQUEST (10004)`, which reads like a malformed
  request rather than a missing default.

- **`transaction_cost` is `transaction_qty` again.** 0 of 622 rows differed. The
  name promises a cost in money and delivers the quantity, in the row's own
  asset — so nothing in the ledger states a valuation, and everything needing
  one comes from `prices.ts`.

- **A trade is three ledger rows sharing one `trade_id`**, and 126 of 126 groups
  had exactly that shape: a `TRADING` leg for the money, a `TRADING` leg for the
  coin, and a `TRADE_FEE`. No pairing by proximity, no reconstruction.

- **The fee is charged in the asset bought**, 126 times out of 126. So a
  purchase of 2657 CRO with a 6.6425 CRO fee credits 2650.3575, and the quantity
  written is net of it. Recording the gross and putting the fee in Wealthfolio's
  `fee` field would be wrong twice: the holding too high, and a fee reported as
  money when no money was charged.

- **Crypto.com's documented journal types are incomplete**, exactly as Kraken's
  were. A real account returns `STAKING_REWARDS`, `STABLECOIN_CONVERSION`,
  `FIAT_DEPOSIT`, `ONCHAIN_DEPOSIT`, `ONCHAIN_WITHDRAWAL`, `CRYPTO_DUSTING` and
  `STAKING` — none of which appear in the documented list. That is 244 of 622
  rows. The smoke test prints a census of whatever arrives rather than checking
  against a fixed set.

- **Crypto.com has an account currency**, which Kraken does not:
  `user-balance.instrument_name` is USD. So the wizard defaults to it rather
  than asking a question with no good answer — but it stays a choice, because
  what an account *reports* in is your preference while only what it *records*
  in is Crypto.com's to state. Pick GBP if your other accounts are in GBP; the
  deposits stay GBP, the conversions keep Crypto.com's own rate, and only the
  account's reporting denomination changes.

  `user-balance` also gives a `market_value` per position — a sharper
  reconciliation target than Kraken's single combined balance. Compare against
  it with `marketValue.local`, never `.base`: `.base` is your base currency, and
  comparing GBP against Crypto.com's USD reported a 26% gap on a flawless
  import.

## What is stated, and what is not

| Crypto.com states | So the connector |
| --- | --- |
| `base_ccy` and `quote_ccy` per instrument | Never splits `BTC_USD` on the underscore |
| `inst_type` (`CCY_PAIR` vs `PERPETUAL_SWAP`) | Excludes derivatives on a stated field |
| `underlying_inst_name` for a staked balance | Folds `CRO.staked` into `CRO` as a stated fact |
| `trade_id` on all three legs of a fill | Joins them explicitly |
| Both legs of a currency conversion, under one `order_id` | Reports its rate as Crypto.com's own |
| **No fiat value for a staking reward** | Values it at the published daily close, and says so |
| **No link between a dust sweep's legs** | Records each leg's quantity, withholds the value |

## Prices come from Crypto.com, not Yahoo

Wealthfolio prices crypto through Yahoo, whose symbol space is not this
exchange's — it has no entry for some listings and resolves a *different
instrument* for others, returning a confident wrong number. A wrong price is
worse than a missing one, because nothing looks broken.

So the connector offers a **custom Wealthfolio provider** reading Crypto.com's
own public endpoints — no API key, and the venue the holdings actually sit on:

| Source | Endpoint | Gives |
| --- | --- | --- |
| Latest | `public/get-tickers` | the current price (`a`, the last trade) |
| Historical | `public/get-candlestick?timeframe=1D` | 300 daily candles, about ten months |

The addon **cannot create the provider**: the SDK has no custom-provider API and
the host's REST API is unreachable from the sandbox. Nor can it ask whether one
exists — `market.getProviders()` returns built-in provider *types*, never a
configured custom one. So it detects absence by trying, and shows every field
with a copy button for a one-time setup under **Settings → Market Data → Custom
Providers**.

Two details worth stating:

- **300 candles per request, whatever `count` says.** The provider form takes a
  single URL with no paging, so a configured provider carries about ten months
  of daily history. The *import* is not limited this way — `prices.ts` pages
  backwards with `start_ts`/`end_ts` to price every row it writes.
- **Pin the pair to `USD`, never `{CURRENCY}`.** That placeholder expands to the
  *asset's* currency, so a GBP-quoted asset would ask for a `CRO_GBP` pair that
  does not exist here.

## Not yet covered

- **The rate you were actually given.** Crypto.com states no fiat value for a
  staking reward or a coin-for-coin trade. Those rows are valued at its own
  published daily close — a real number for a known asset and date, and not the
  rate on your ticket. A swap is written as a sell and a buy priced from the
  sell's proceeds, so it stays cash-neutral; a reward is written as
  `DIVIDEND`/`DIVIDEND_IN_KIND`, which adds units and a basis without spending
  money you never spent.
- **Dust sweeps, beyond their quantities.** `CRYPTO_DUSTING` rows land on one
  timestamp with `order_id` and `trade_id` both zero, so which coin became which
  CRO is not stated. Each leg is recorded at its exact quantity and zero cost,
  and flagged, rather than paired by guesswork.
- **Derivatives.** Crypto.com lists 343 perpetual swaps and 10 futures.
  `BTCUSD-PERP` is a contract on Bitcoin and is not Bitcoin; the class is stated
  explicitly, so such a position is reported rather than mapped.
- **Sub-accounts.** `get-accounts` is read and the master account is used. No
  account here has exercised a sub-account yet.

## References

- [Crypto.com Exchange API v1](https://exchange-developer.crypto.com/)
- [ccxt's `cryptocom`](https://github.com/ccxt/ccxt/blob/master/ts/src/cryptocom.ts) — the reference implementation, read rather than depended on
- [API key permissions](https://help.crypto.com/en/articles/3511424-api)

## Licence

[GNU AGPL v3](../../LICENSE), like the rest of the repository.
