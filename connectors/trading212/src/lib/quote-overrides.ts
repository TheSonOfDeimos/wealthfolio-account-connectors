/**
 * Where to price an instrument whose own listing has no price history.
 *
 * Wealthfolio prices a Trading 212 holding through Yahoo, under the symbol and
 * venue Trading 212 states for it. That is right for almost everything, and
 * wrong for a handful of thinly-traded ETPs: Yahoo carries the *ticker* — it
 * returns the correct name and currency — but almost no history behind it.
 * Measured against Yahoo directly, `3LSI.L` has bars only from 2026-07-17 and
 * exactly one of them carries a close, at every range up to `max`.
 *
 * The effect is not a gap in a chart. Wealthfolio carries the last known price
 * forward across the hole and marks the affected days "missing valuation
 * source", so months of daily returns are approximations, and the asset page
 * reports nonsense — one live account showed `3LSI` at +15,905% because a
 * stale price was being compared against a current one.
 *
 * These ETPs list the same security in more than one currency, and the other
 * lines are covered properly. So each entry here points Yahoo at the line it
 * actually has data for, and states the currency that line quotes in.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  Two things this must get right, both of which bit during development
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * **The currency travels with the symbol.** Wealthfolio stores whatever number
 * the provider returns and interprets it as the asset's `quoteCcy`. Point a
 * GBp-denominated asset at a USD line without saying so and every stored price
 * is wrong by the FX rate and a factor of 100 — `3LSI` briefly held 13.09
 * where it should have held 975. So `quoteCcy` is part of the entry, not an
 * afterthought, and it is what the asset is set to.
 *
 * That is not a lie about the holding: `quoteCcy` names the *price feed's*
 * currency, which is a different fact from what the trades were denominated
 * in. The activities keep the currency Trading 212 charged, and Wealthfolio
 * converts.
 *
 * **The lines have to actually agree.** A second listing of the same company is
 * not the same thing as another currency line of the same security. Every
 * entry below was checked by converting the alternate's close into the
 * asset's own quote currency on the same day and comparing:
 *
 *     3LSI  3SIL.L  9.6550 USD → 712.99 GBp  vs  712.25 GBp   0.10%
 *     3LGO  3GOL.L  162.03 USD → 11965 GBp   vs  11950 GBp    0.13%
 *     LCOR  LCOR.MI 0.8988 EUR → 1.0409 USD  vs  1.0415 USD    0.06%
 *     LPLA  LPLA.MI 2.9625 EUR → 3.4308 USD  vs  3.4320 USD    0.03%
 *     3WHL  3WHL.MI 0.1647 EUR → 0.1907 USD  vs  0.1906 USD    0.07%
 *
 * `XUSIO` is deliberately absent. Its Madrid line has no usable history
 * either, but nothing else prices it honestly: the Stuttgart line is 7% away
 * on the same day, and São Paulo converts 13% away. A holding left visibly
 * unpriced is recoverable; one priced from the wrong listing is not.
 *
 * Add an entry only after running that comparison. It is your knowledge stated
 * in the source, which is a different thing from the code guessing.
 */
import type { AddonContext } from '@wealthfolio/addon-sdk';

/** One instrument, and the line Yahoo can actually price. */
export interface QuoteOverride {
  /** The Yahoo ticker to ask for instead. */
  symbol: string;
  /** What that ticker quotes in. The asset is set to this. */
  quoteCcy: string;
  /** Which listing this is, so the choice can be re-checked. */
  note: string;
}

/** Keyed by the symbol Trading 212 states, as `symbol-table.ts` resolves it. */
export const QUOTE_OVERRIDES: Record<string, QuoteOverride> = {
  '3LSI': { symbol: '3SIL.L', quoteCcy: 'USD', note: 'LSE USD line of the same ETP' },
  '3LGO': { symbol: '3GOL.L', quoteCcy: 'USD', note: 'LSE USD line of the same ETP' },
  LCOR: { symbol: 'LCOR.MI', quoteCcy: 'EUR', note: 'Borsa Italiana line of the same ETP' },
  LPLA: { symbol: 'LPLA.MI', quoteCcy: 'EUR', note: 'Borsa Italiana line of the same ETP' },
  '3WHL': { symbol: '3WHL.MI', quoteCcy: 'EUR', note: 'Borsa Italiana line of the same ETP' },
};

/** What Wealthfolio calls the built-in provider these overrides are for. */
const YAHOO = 'YAHOO';

export interface OverrideFix {
  symbol: string;
  applied: boolean;
  detail: string;
  /**
   * Set when the attempt actually failed, as opposed to being unnecessary.
   * Without it both collapse into `applied: false` and get logged the same
   * way — which is how a flat permission denial on `updateQuoteMode` sat in
   * the run log looking like "nothing to do" instead of an error.
   */
  failed?: boolean;
}

/**
 * Point the listed instruments at the line Yahoo can price, and stop the cash
 * placeholder from being priced at all.
 *
 * Both are the same underlying problem — an asset Wealthfolio cannot get a
 * quote for — and both end up on the data-health page as sync failures. The
 * cash one is worth stating plainly: `$CASH` is a placeholder the host creates
 * for cash movements, it has no market price, and leaving it on automatic
 * updates means every enabled provider is asked for a ticker that cannot
 * exist. On an account that also had a custom crypto provider installed, that
 * provider was asked for `$CASHUSD` and failed seventeen times.
 */
export async function applyQuoteOverrides(
  ctx: AddonContext,
  accountId: string,
  isOurs: (comment: string | null | undefined) => boolean,
  log: (level: 'info' | 'warn' | 'error' | 'success', message: string) => void,
): Promise<OverrideFix[]> {
  const activities = (await ctx.api.activities.getAll(accountId)) as unknown as {
    comment?: string | null;
    assetId?: string | null;
    assetSymbol?: string | null;
  }[];

  const wanted = new Map<string, string>();
  let cashAssetId: string | undefined;
  for (const activity of activities) {
    if (!isOurs(activity.comment)) continue;
    const symbol = activity.assetSymbol;
    if (!symbol || !activity.assetId) continue;
    if (symbol.startsWith('$CASH')) {
      cashAssetId = activity.assetId;
      continue;
    }
    if (QUOTE_OVERRIDES[symbol]) wanted.set(symbol, activity.assetId);
  }

  const fixes: OverrideFix[] = [];
  /** Assets whose quote currency changed, so their stored history is now stale. */
  const restated: string[] = [];

  for (const [symbol, assetId] of wanted) {
    const override = QUOTE_OVERRIDES[symbol]!;
    try {
      const profile = (await ctx.api.assets.getProfile(assetId)) as unknown as Record<
        string,
        unknown
      > & { providerConfig?: Record<string, unknown> | null; quoteCcy?: string };

      const already =
        (profile.providerConfig as { overrides?: Record<string, { symbol?: string }> } | null)
          ?.overrides?.[YAHOO]?.symbol === override.symbol && profile.quoteCcy === override.quoteCcy;
      if (already) {
        fixes.push({ symbol, applied: false, detail: `already reading ${override.symbol}` });
        continue;
      }

      await ctx.api.assets.updateProfile({
        ...profile,
        quoteCcy: override.quoteCcy,
        providerConfig: {
          ...(typeof profile.providerConfig === 'object' && profile.providerConfig !== null
            ? profile.providerConfig
            : {}),
          overrides: {
            ...((profile.providerConfig as { overrides?: Record<string, unknown> } | null)
              ?.overrides ?? {}),
            [YAHOO]: { symbol: override.symbol, type: 'equity_symbol' },
          },
        },
      } as never);

      restated.push(assetId);
      fixes.push({
        symbol,
        applied: true,
        detail: `priced from ${override.symbol} in ${override.quoteCcy} — ${override.note}`,
      });
    } catch (error) {
      fixes.push({
        symbol,
        applied: false,
        detail: `could not set a price source: ${describe(error)}`,
        failed: true,
      });
    }
  }

  if (cashAssetId) {
    try {
      const profile = (await ctx.api.assets.getProfile(cashAssetId)) as unknown as Record<
        string,
        unknown
      > & { quoteMode?: string };
      if (profile.quoteMode === 'MANUAL') {
        fixes.push({ symbol: '$CASH', applied: false, detail: 'already off automatic updates' });
      } else {
        // Deliberately not `updateProfile`: `UpdateAssetProfile` lists
        // `quoteMode`, but the handler behind it ignores the field and returns
        // 200, so this silently did nothing for as long as it has existed.
        // `updateQuoteMode` is the host function that writes the column.
        await ctx.api.assets.updateQuoteMode(cashAssetId, 'MANUAL');
        fixes.push({
          symbol: '$CASH',
          applied: true,
          detail: 'taken off automatic updates — a cash line has no market price',
        });
      }
    } catch (error) {
      fixes.push({
        symbol: '$CASH',
        applied: false,
        detail: `could not stop price updates: ${describe(error)}`,
        failed: true,
      });
    }
  }

  for (const fix of fixes) {
    log(fix.failed ? 'error' : fix.applied ? 'success' : 'info', `${fix.symbol}: ${fix.detail}`);
  }

  // Changing where an asset is priced from also changes what currency it is
  // priced in, and Wealthfolio keeps whatever it already stored.
  //
  // ⚠ Verified the hard way: the host **fills gaps but never overwrites an
  // existing quote row**. Refresh History, Update Price, `market.sync` with
  // `refetchAll`, and Rebuild History were each tried against a live account,
  // and every one left the earlier rows untouched — 52 of 122 rows for `3LSI`
  // stayed in pence while the rest arrived in dollars. There is no delete
  // endpoint either, so a row written in the old currency is permanent.
  //
  // So the currency has to be right *before* the first quote is stored, which
  // is why `quoteCurrencyFor` hands the override's currency to the asset at
  // creation time. This refetch only fills the history behind it.
  if (restated.length > 0) {
    try {
      await ctx.api.market.sync(restated, true);
      log('success', `Fetched full price history for ${restated.length} restated asset(s).`);
    } catch (error) {
      log('warn', `Could not fetch the restated history (${describe(error)}).`);
    }
  }

  return fixes;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
