# Wealthfolio account connectors

**Connect your brokers and banks to [Wealthfolio](https://wealthfolio.app) — and
import your account data in the currency your provider recorded it in.**

[![CI](https://github.com/TheSonOfDeimos/wealthfolio-account-connectors/actions/workflows/ci.yml/badge.svg)](https://github.com/TheSonOfDeimos/wealthfolio-account-connectors/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/TheSonOfDeimos/wealthfolio-account-connectors?sort=semver&label=release&color=6c8f4a)](https://github.com/TheSonOfDeimos/wealthfolio-account-connectors/releases/latest)
[![Licence: AGPL v3](https://img.shields.io/badge/licence-AGPL%20v3-blue.svg)](LICENSE)
[![Wealthfolio](https://img.shields.io/badge/wealthfolio-%E2%89%A5%203.6.2-6c8f4a.svg)](https://wealthfolio.app)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2020-5a5a5a.svg)](https://nodejs.org)

Wealthfolio keeps your portfolio on your own machine. Getting your history *into*
it is the tedious part: exporting CSVs, fixing tickers by hand, and discovering
six months later that a London holding was priced in pence and quietly counted a
hundred times over.

These connectors do that job properly, for one provider each.

## The one rule

**Nothing is invented.**

Every amount stays in the currency the provider recorded it in, with the
provider's own conversion rate attached so Wealthfolio does the arithmetic
itself. Symbols come from fields the provider states outright, never parsed out
of a ticker string. Where a provider does not say something — withholding tax
split out of a dividend, a corporate action's terms — the connector says so and
leaves it for you, rather than filling the gap with a plausible number.

A guess that is right most of the time is worse than no guess, because nothing
prompts you to check the rest.

## Connectors

| Provider | Type | Status | Imports |
| --- | --- | --- | --- |
| [Trading 212](connectors/trading212) | Broker | **Working** | Trades, dividends, deposits, withdrawals, interest, fees and taxes |
| [Kraken](connectors/kraken) | Crypto exchange | **Working** | Purchases, deposits, withdrawals, staking rewards and coin-for-coin exchanges |

Adding one? See [Writing a connector](#writing-a-connector).

## Install a connector

You need Wealthfolio 3.6.2 or newer.

1. Download the connector's `.zip` from the
   [latest release](https://github.com/TheSonOfDeimos/wealthfolio-account-connectors/releases/latest),
   or build it yourself:

   ```bash
   pnpm install
   cd connectors/trading212 && pnpm bundle   # or connectors/kraken
   ```

2. In Wealthfolio: **Settings → Add-ons → Add-on Manager → +** and pick the zip.
3. Open the connector from the sidebar and follow its steps. Trading 212 has
   four — paste your API credentials, name the account, import, then keep it in
   sync. Kraken adds one before the import, to set up a price source for coins
   Yahoo cannot value correctly.

Your credentials go into Wealthfolio's own keyring, and nothing but *Reset
everything* removes them. How they are used differs by broker, which is worth
stating plainly:

- **Trading 212** sends a bearer token, so the host attaches it to each request
  and the connector never reads it back.
- **Kraken** signs every request with an HMAC the network broker cannot compute
  on our behalf, so that connector *does* read the private key back to sign
  with. Give it a read-only key: Funds · Query, Orders · Query closed orders &
  trades, and Data · Query ledger entries, and nothing else.

[ci]: https://github.com/TheSonOfDeimos/wealthfolio-account-connectors/actions/workflows/ci.yml

## Layout

```
connectors/          one directory per provider, each a self-contained addon
  trading212/          manifest, icon, src/, its own tools/ and README
  kraken/              the same shape, plus request signing and a quote provider
packages/
  connector-kit/       what every connector needs, and nothing broker-specific
tools/               dev-deploy and icon embedding, usable from any connector
docker/              a local Wealthfolio to test against
.vscode/             workspace, tasks and debug configs
```

The split between a connector and the kit is decided by one question: **would a
second provider need this?** Sandbox egress, keyring credentials, account
linking and the asset-currency repair would — so they are in the kit. Anything
that knows what a Trading 212 order or a Kraken ledger row looks like stays in
the connector.

## Working on it

Requires Node 20+ and pnpm.

```bash
pnpm install          # links the workspace
pnpm verify           # type-check and build every package
pnpm docker:up        # a Wealthfolio instance on :8088 to test against
```

Then, from a connector:

```bash
cd connectors/trading212
pnpm dev:deploy       # build, zip, install into the running Wealthfolio
```

Reload the Wealthfolio tab to pick up the new build. There is more on the Docker
instance and the inner development loop in
[connectors/trading212/README.md](connectors/trading212/README.md), including how
to attach Wealthfolio's own frontend dev server; what Kraken's API does and does
not state is in [connectors/kraken/README.md](connectors/kraken/README.md).

## Writing a connector

1. Copy `connectors/trading212` as a starting point, or start from an empty
   directory with a `manifest.json`, `package.json` and `src/addon.tsx`.
2. Depend on `@wealthfolio-connectors/connector-kit` and use it for the parts
   that are not about your provider: `createBrokeredFetch` for sandbox egress,
   `saveCredentials`/`hasCredentials` for the keyring, `linkOrCreateAccount` for
   the Wealthfolio account, and `reconcileAssetCurrencies` for the currency
   repair below.
3. Write the provider-specific half: reading its API, and mapping its records to
   Wealthfolio activities.
4. Add your connector to the table above.

Three things that cost the most to learn the first time, and will bite any
connector:

- **A quote currency is not a trade currency.** Wealthfolio derives an asset's
  currency from its exchange, so every London listing becomes pence — correct
  for the pence lines and a 100× error for the ones quoted in pounds or dollars.
  The kit repairs this, but only if you tell it what your provider states.
- **Never infer market data from an identifier.** Trading 212's `ABML_US_EQ` is
  `ABAT`: the company renamed and the code did not follow. A parsing rule that
  looked 88% correct mapped holdings to the wrong companies, silently.
- **Check against the running host, not the types.** Both SDKs involved describe
  their backends inaccurately in places — fields declared and never sent, fields
  sent and never declared. Compiling is not evidence.

## Contributing

Fixes, providers this does not cover yet, and instruments it maps badly — all
welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

[GNU AGPL v3](LICENSE).

Use it for anything, change it however you like. The one obligation: **if you
distribute a modified version, or let other people use one over a network, you
must publish your source under the AGPL too.** Improving a connector privately
for your own portfolio owes nothing to anyone; the moment others use your
version, they get the same rights you did.

That is the point of the choice. Fixes should come back, and a fork should not
quietly get better while everyone else's copy stays as it is.

## Trademarks and warranty

Provider names and logos belong to their owners and are used here to identify
the service each connector talks to. This project is not published by, endorsed
by, or affiliated with any of them.

No warranty. These connectors write to your portfolio — read the code before
pointing one at real money, and keep a backup of your Wealthfolio database.
