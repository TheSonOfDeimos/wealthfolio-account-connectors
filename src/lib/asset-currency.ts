/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  Making Wealthfolio agree with Trading 212 about what an asset is priced in
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Wealthfolio decides an asset's quote currency from its exchange, not from the
 * `quoteCcy` the import supplies. Every `XLON` asset is stored as `GBp`
 * whatever was sent — right for the pence lines, wrong for the London lines
 * quoted in pounds or dollars. The price is then read in the wrong unit: a
 * £455 holding of VFEG showed as £4.55, and `CORN`, `WEAT` and `URNJ` had a
 * currency applied that was never theirs.
 *
 * The disagreement is detectable without guessing at anything, because both
 * sides state their answer: Trading 212 gives a currency on every fill and
 * every dividend, Wealthfolio gives a `quoteCcy` on every asset. Where they
 * differ the broker wins — it is the system of record for what it sold you.
 *
 * The expected value is Trading 212's `currencyCode`, bundled per listing in
 * `SYMBOL_TABLE`. Two nearer-looking sources are both wrong, and were both
 * tried first:
 *
 *  - **The live catalogue** states it, but is 4.2 MB in one response and fails
 *    the addon network broker's size limit on every run, which is the reason
 *    the table exists at all.
 *  - **The currency on an imported trade** looks authoritative and is not. It
 *    describes the *trade*, and this addon converts a pence fill into pounds
 *    when it writes one, so a London pence holding stores `GBP` at £3.80 while
 *    its price feed still quotes `447.5` in `GBX`. Trusting it set every pence
 *    asset to pounds and made each one read a hundred times too large — a
 *    worse fault than the one being fixed.
 *
 * A quote currency belongs to the price feed, not to the transaction, and only
 * the instrument's own record states it.
 *
 * The repair goes through `assets/profile`, which accepts `quoteCcy` even
 * though the addon SDK's `UpdateAssetProfile` does not declare the field —
 * verified against the running backend, which is the only place worth
 * verifying it. Wealthfolio's own asset editor sends exactly this.
 */

import type { ActivityDetails, AddonContext } from '@wealthfolio/addon-sdk';
import { activityKeyOf } from './mapper';
import { quoteCurrencyFor } from './symbols';
import { hostCurrency } from './mapper';

/** One asset whose stored currency did not match Trading 212's. */
export interface CurrencyFix {
  symbol: string;
  /** What Wealthfolio had. */
  was: string;
  /** What Trading 212 says, and what it now holds. */
  now: string;
  applied: boolean;
  error?: string;
}

/**
 * `UpdateAssetProfile` omits `quoteCcy`; the backend behind it does not.
 *
 * Read-modify-write rather than a bare patch: the handler takes a whole
 * profile, so anything left out risks being cleared.
 */
type ProfileUpdate = Record<string, unknown> & { id: string };

/**
 * Point every imported asset at the currency Trading 212 states for it.
 *
 * Returns what changed, so the caller can log it and the UI can show it.
 */
export async function reconcileAssetCurrencies(
  ctx: AddonContext,
  accountId: string,
  log: (level: 'info' | 'warn' | 'error' | 'success', message: string) => void,
): Promise<CurrencyFix[]> {
  // Everything in the account, not just what this run touched: a position
  // closed years ago still prices the days it was open, and still carries the
  // same currency error into every valuation from back then.
  const activities = await ctx.api.activities.getAll(accountId);
  const ids = assetIds(activities);
  if (ids.size === 0) {
    log('info', 'No imported securities to check a currency against.');
    return [];
  }

  const fixes: CurrencyFix[] = [];
  let compared = 0;
  let unreadable = 0;
  let silent = 0;
  let readError = '';
  let unknown = 0;
  for (const [symbol, id] of ids) {
    let profile;
    try {
      profile = await ctx.api.assets.getProfile(id);
    } catch (error) {
      // Kept apart from the no-currency case below. Collapsing the two hid a
      // missing `assets` permission behind a message saying the assets stated
      // no currency, which is a very different problem with a very different
      // fix, and cost an evening.
      unreadable += 1;
      if (!readError) readError = error instanceof Error ? error.message : String(error);
      continue;
    }
    // An asset that states no currency cannot be said to disagree with one.
    if (!profile.quoteCcy) {
      silent += 1;
      continue;
    }

    // Matched on venue as well as symbol, so a London listing is not answered
    // for by its American one.
    const stated = quoteCurrencyFor(symbol, profile.instrumentExchangeMic ?? undefined);
    const currency = hostCurrency(stated);
    if (!currency) {
      unknown += 1;
      continue;
    }

    compared += 1;
    if (profile.quoteCcy === currency) continue;

    const fix: CurrencyFix = { symbol, was: profile.quoteCcy, now: currency, applied: false };

    try {
      const update: ProfileUpdate = {
        id,
        displayCode: profile.displayCode,
        name: profile.name,
        notes: profile.notes,
        instrumentType: profile.instrumentType,
        quoteMode: profile.quoteMode,
        instrumentExchangeMic: profile.instrumentExchangeMic,
        providerConfig: profile.providerConfig ?? null,
        metadata: profile.metadata,
        quoteCcy: currency,
      };
      await ctx.api.assets.updateProfile(update as never);
      fix.applied = true;
    } catch (error) {
      fix.error = error instanceof Error ? error.message : String(error);
    }

    fixes.push(fix);
  }

  if (unreadable > 0) {
    log('error', `Could not read ${unreadable} asset profile(s): ${readError}`);
  }
  if (silent > 0) {
    log('warn', `${silent} asset(s) state no currency of their own and were left alone.`);
  }
  if (unknown > 0) {
    log(
      'info',
      `${unknown} asset(s) are not in the bundled instrument table, so their ` +
        'currency was left as Wealthfolio has it.',
    );
  }
  if (fixes.length === 0) {
    log('info', `All ${compared} assets are priced in the currency Trading 212 states.`);
  }
  return fixes;
}

/**
 * Every security this addon imported, as symbol → asset id.
 *
 * Read from the activities rather than from holdings: a position closed years
 * ago still prices the days it was open, and still carries the same currency
 * error into every valuation from back then. Only this addon's own rows count,
 * identified by the key it stamps into every comment — a security you added by
 * hand is yours, and nothing here should rewrite it.
 */
function assetIds(activities: ActivityDetails[]): Map<string, string> {
  const ids = new Map<string, string>();
  for (const activity of activities) {
    if (!activityKeyOf(activity.comment)) continue;
    const symbol = activity.assetSymbol;
    if (!symbol || !activity.assetId || symbol.startsWith('$CASH')) continue;
    ids.set(symbol, activity.assetId);
  }
  return ids;
}
