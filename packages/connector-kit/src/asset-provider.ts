/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  Why an imported asset must name its price source, even the default one
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Wealthfolio assets are global, not per-account, and an asset with no
 * `preferred_provider` is fair game for **every enabled provider** — including
 * the custom ones other connectors installed for their own venue.
 *
 * That is not theoretical. On a live install with all three connectors, the
 * market-data page reported:
 *
 *     6 assets failed to sync
 *     Kraken Ticker: Could not extract price from path '$.result.*[*][4]'
 *                    for symbol '3LGO'
 *     …the same for 3LSI, 3WHL, LCOR, LPLA
 *
 * Every one of those is a London-listed ETP imported by the Trading 212
 * connector. Kraken has never heard of them, and Kraken's provider was never
 * pointed at them by anybody — they simply had no provider of their own, so the
 * host worked down the list and asked a crypto exchange to price a FTSE
 * tracker. The errors are then attributed to *Kraken's* provider, which is the
 * worst part: the connector that looks broken is not the one that imported the
 * asset.
 *
 * An earlier test suggested custom providers were strictly opt-in, and it was
 * too weak: it used `AAPL`, which Yahoo resolves cleanly, so the fallback never
 * ran. A custom provider does not *override* an asset that already prices — it
 * gets consulted when nothing else answers.
 *
 * So every connector states a provider for the assets it creates, including
 * when that provider is just the built-in default. Naming it costs one field
 * and closes the fallback path entirely.
 */
import type { ActivityDetails, AddonContext } from '@wealthfolio/addon-sdk';

/**
 * `UpdateAssetProfile` omits `providerConfig`; the backend behind it does not —
 * the same undeclared-but-accepted route `quoteCcy` takes. Read-modify-write,
 * because the handler takes a whole profile and anything left out risks being
 * cleared.
 */
type ProfileUpdate = Record<string, unknown> & { id: string };

export interface ProviderPin {
  /** The built-in provider type, e.g. `YAHOO`. */
  preferred: string;
  /** Set only for a custom provider, alongside `preferred: 'CUSTOM_SCRAPER'`. */
  customCode?: string;
}

export interface PinResult {
  symbol: string;
  applied: boolean;
  error?: string;
}

/**
 * Name a price source on every asset this connector imported that has none.
 *
 * Deliberately conservative in two directions:
 *
 *  - **An asset that already names a provider is never touched.** It may be
 *    another connector's, or a choice the user made by hand on the Market Data
 *    tab, and silently overwriting either would be the same fallback problem
 *    wearing different clothes.
 *  - **Only this connector's own assets are considered**, identified the way
 *    the caller identifies its rows. A security you added yourself is yours.
 */
export async function pinDefaultProvider(
  ctx: AddonContext,
  accountId: string,
  isOurs: (comment: string | null | undefined) => boolean,
  pin: ProviderPin,
  log: (level: 'info' | 'warn' | 'error' | 'success', message: string) => void,
): Promise<PinResult[]> {
  const activities = await ctx.api.activities.getAll(accountId);

  // Read from the activities rather than from holdings: a position closed years
  // ago still exists as an asset, still gets swept by the host's price sync,
  // and is exactly what produced the errors above — all five were closed.
  const ids = new Map<string, string>();
  for (const activity of activities as ActivityDetails[]) {
    if (!isOurs(activity.comment)) continue;
    const symbol = activity.assetSymbol;
    if (!symbol || !activity.assetId || symbol.startsWith('$CASH')) continue;
    ids.set(symbol, activity.assetId);
  }
  if (ids.size === 0) return [];

  const pinned: PinResult[] = [];
  let alreadySet = 0;

  for (const [symbol, id] of ids) {
    try {
      const profile = (await ctx.api.assets.getProfile(id)) as unknown as {
        providerConfig?: { preferred_provider?: string } | null;
      } & Record<string, unknown>;

      if (profile.providerConfig?.preferred_provider) {
        alreadySet += 1;
        continue;
      }

      const update: ProfileUpdate = {
        ...profile,
        id,
        providerConfig: {
          ...(typeof profile.providerConfig === 'object' && profile.providerConfig
            ? profile.providerConfig
            : {}),
          preferred_provider: pin.preferred,
          ...(pin.customCode ? { custom_provider_code: pin.customCode } : {}),
        },
      };
      await ctx.api.assets.updateProfile(update as never);
      pinned.push({ symbol, applied: true });
    } catch (error) {
      pinned.push({
        symbol,
        applied: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const applied = pinned.filter((entry) => entry.applied).length;
  const failed = pinned.filter((entry) => !entry.applied);

  if (applied > 0) {
    log(
      'info',
      `Named ${pin.preferred} as the price source for ${applied} asset(s) that had none, so no ` +
        "other connector's provider gets asked to price them.",
    );
  }
  if (alreadySet > 0) {
    log('info', `${alreadySet} asset(s) already name a price source and were left alone.`);
  }
  if (failed.length > 0) {
    log('warn', `Could not set a price source for ${failed.length} asset(s): ${failed[0]?.error}`);
  }

  return pinned;
}

/**
 * Stop Wealthfolio trying to buy a market price for cash.
 *
 * `$CASH` is not a ticker. Every row pointing at it is a cash flow, never a
 * trade — on a live install its 527 activities were 351 INTEREST, 162 FEE and
 * 14 DEPOSIT, each with no quantity and no unit price, only an amount. It is
 * the counterparty a cash movement is booked against; there is no instrument
 * behind it to look up.
 *
 * The host still creates it as a real asset, and on that same install it came
 * out `kind: INVESTMENT`, `instrumentType: CRYPTO`, `quoteMode: MARKET` — so
 * the price sweep treated a GBP balance as a tradable crypto instrument and
 * walked the whole provider chain looking for a quote:
 *
 *     YAHOO: ERROR (No data returned for requested range)
 *     CUSTOM_SCRAPER: ERROR ([kraken-ticker] Could not extract price
 *                            from path '$.result.*[*][4]' for symbol '$CASH')
 *
 * It fails every time, because there is no such instrument on any exchange, and
 * the data-health page reports it as an error against whichever custom provider
 * answered last — a connector that had nothing to do with it.
 *
 * `MANUAL` is what cash is: a balance carried at face value, not a price to be
 * fetched. Setting it ends the sweep at the source rather than teaching each
 * provider to decline politely.
 *
 * Only assets whose symbol is `$CASH` or `$CASH-<CCY>` are touched, and only
 * when they are still on `MARKET`.
 */
export async function settleCashQuoteMode(
  ctx: AddonContext,
  accountId: string,
  log: (level: 'info' | 'warn' | 'error' | 'success', message: string) => void,
): Promise<number> {
  const activities = await ctx.api.activities.getAll(accountId);

  const cash = new Map<string, string>();
  for (const activity of activities as ActivityDetails[]) {
    const symbol = activity.assetSymbol;
    if (!symbol || !symbol.startsWith('$CASH') || !activity.assetId) continue;
    cash.set(symbol, activity.assetId);
  }
  if (cash.size === 0) return 0;

  let settled = 0;
  for (const [symbol, id] of cash) {
    try {
      const profile = (await ctx.api.assets.getProfile(id)) as unknown as {
        quoteMode?: string;
      } & Record<string, unknown>;
      if (profile.quoteMode !== 'MARKET') continue;

      // NOT `updateProfile`. `UpdateAssetProfile` declares `quoteMode`, and
      // sending it there returns 200 and changes nothing — the field is read
      // off the payload type but never applied by the handler behind it. The
      // quote mode has its own host function, and it is the only thing that
      // actually writes the column.
      await ctx.api.assets.updateQuoteMode(id, 'MANUAL');
      settled += 1;
      log('info', `${symbol} is cash, so it no longer asks a market-data provider for a price.`);
    } catch (error) {
      log('warn', `Could not settle ${symbol}: ${error instanceof Error ? error.message : error}`);
    }
  }
  return settled;
}
