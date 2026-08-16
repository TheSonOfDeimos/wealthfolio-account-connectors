# Contributing

Fixes, instruments this addon maps badly, and brokers' quirks it has not met
yet — all welcome.

## The licence, in short

This project is under the **GNU AGPL v3**. What that means for you:

- Use it for anything, including at work and for money.
- Change it however you like.
- **If you distribute your changed version, or let other people use it over a
  network, you must publish your source under the AGPL too.** A private fork
  that quietly improves the addon and never shares the improvements is exactly
  what this licence exists to prevent.

Using it privately, for your own portfolio, with your own patches, obliges you
nothing. The moment other people use your version, they get the same rights you
got.

## Before you open a pull request

By contributing you agree your work is licensed under the AGPL v3, the same as
everything else here.

A few practical things:

- **Never commit credentials.** Every provider's keys go in `.env`, which git
  ignores. `.env.example` is the tracked template listing what each connector
  needs — copy it, do not fill it in. This project leaked a live key pair into
  its own history once; the fix was rewriting history and revoking the key.

  A `pre-commit` hook in `.githooks/` now refuses both mistakes: staging `.env`
  itself, and committing a `.env.example` with values typed into it. `pnpm
  install` points git at it for you (`core.hooksPath`); if you skipped that,
  run `git config core.hooksPath .githooks`. Bypass with `--no-verify` only
  when you have checked what you are bypassing.
- **Do not infer market data from a ticker string.** `ABML_US_EQ` does not mean
  the symbol is ABML, the market is US, or the type is equity — Trading 212's
  catalogue says that instrument is `ABAT`, because the company renamed and the
  code did not follow. Take the explicit field, or surface a warning. A guess
  that is right 90% of the time is worse than no guess, because nothing prompts
  a check on the other 10%.
- **A quote currency is not a trade currency.** The addon converts a pence fill
  to pounds when it writes an activity, so a London holding stores GBP while its
  price feed still quotes GBX. Deriving one from the other made every pence
  holding read a hundred times too large.
- **Check against the running backend, not the types.** Both SDKs this depends
  on describe their backends inaccurately in places — fields that are declared
  and never sent, fields that are sent and never declared. A call that satisfies
  the type checker is not evidence it works.

## Running it

```sh
pnpm install                      # links the workspace
cp .env.example .env              # only for the Node tools below
pnpm verify                       # type-check and build every package
pnpm docker:up                    # a Wealthfolio on :8088 to test against

cd connectors/trading212
pnpm dev:deploy                   # build, zip, install into it
```

The addon itself never reads `.env` — it asks for your Trading 212 key pair in
its own form and keeps it in Wealthfolio's keyring. `.env` is only for
`pnpm smoke:live` and `pnpm symbols:generate` inside a connector, which run
under Node where there is no keyring.

## Where things live

A connector lives in `connectors/<provider>/`. Anything a *second* provider
would also need belongs in `packages/connector-kit/` instead — sandbox egress,
keyring credentials, account linking, the asset-currency repair. If it knows
what one broker's order looks like, it stays in the connector.

## Trademarks

Provider names and logos belong to their owners, and appear here to identify the
service each connector talks to. This project is not published by, endorsed by,
or affiliated with any of them.
