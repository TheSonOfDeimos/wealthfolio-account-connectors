# Trading 212 Import

Wealthfolio addon that imports filled Trading 212 orders as BUY/SELL activities.

## Install

Install the packaged `.zip` through Wealthfolio's addon settings, or run the
development server and let Wealthfolio discover it:

```bash
pnpm dev:server
```

## First run

1. Open **Trading 212** in the sidebar.
2. Paste the API key and secret from the Trading 212 mobile app
   (Settings → API). They are stored in your OS keyring, not in the addon.
3. Press **Test connection** to confirm the credentials work.
4. Choose the Wealthfolio account the trades belong to.
5. Press **Fetch and preview**, check the table, then import.

## Permissions and why

| Permission | Why |
| --- | --- |
| `network` | Read order history from `live.trading212.com`. GET only — no orders are placed or cancelled. |
| `secrets` | Keep the API key pair in the OS keyring instead of the bundle. |
| `accounts` | Let you pick the destination account. |
| `activities` | Validate the mapped trades (`checkImport`), then write them (`import`). |

## Notes

- Nothing is written to Wealthfolio until you confirm the preview.
- One sync reads up to 4 pages × 50 fills, paced for the API's 6 requests per
  minute limit on `/history/orders`.
- Corporate actions (splits, stock dividends) are reported as skipped rather
  than imported as trades.
- Each activity's comment carries `t212:order=… fill=… ticker=… isin=…` so rows
  trace back to Trading 212 and re-imports are detected as duplicates.
