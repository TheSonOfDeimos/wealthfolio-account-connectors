/**
 * Correcting what Wealthfolio recorded about each Kraken asset.
 *
 * Two things it gets wrong on its own, both for the same reason — it resolves a
 * bare crypto ticker through a market-data provider whose symbol space is not
 * Kraken's. The price comes from the wrong instrument, and so does the name.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  What the addon can and cannot do here
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * It **can** assign a provider to an asset: `assets.updateProfile` forwards
 * `providerId` and `providerSymbol` to the backend, which stores them — the
 * same undeclared-but-accepted route `quoteCcy` takes.
 *
 * It **cannot** create the provider. There is no custom-provider API in the
 * addon SDK, and the host's own REST API is not reachable from the sandbox,
 * whose only egress is `network.request` to declared external hosts. Nor can it
 * ask whether one exists: `market.getProviders()` returns the built-in provider
 * *types* — `YAHOO`, `CUSTOM_SCRAPER` and so on — not the custom providers a
 * user has configured, so `kraken-ticker` never appears there whether or not it
 * is set up.
 *
 * So absence is detected the only way left: assign the provider, ask for a
 * sync, and see whether prices arrive. That is slower than a lookup and it is
 * honest, which a lookup against the wrong list would not be.
 */
import type { AddonContext, Holding } from '@wealthfolio/addon-sdk';
import { ASSET_NAMES, CRYPTO_QUOTE_CURRENCY, QUOTE_PROVIDER } from '../config';

/** An asset this connector imported, and where its price comes from. */
export interface PricedAsset {
  assetId: string;
  symbol: string;
  price: number;
  /** Already reading from the Kraken provider. */
  onKraken: boolean;
}

export interface PricingState {
  assets: PricedAsset[];
  /** No price at all — Yahoo has no entry for this coin. */
  unpriced: PricedAsset[];
  /**
   * Priced by something other than Kraken.
   *
   * Worth offering to change even when a price exists, because the dangerous
   * case is not a missing price but a confident wrong one: Yahoo's tickers
   * collide with other instruments and it will happily quote $5.45 for a dollar
   * stablecoin. Nothing about that looks broken from the outside.
   */
  offKraken: PricedAsset[];
}

/**
 * What Wealthfolio currently makes of the account's holdings.
 *
 * Cash lines are ignored: they are not priced by a market-data provider and
 * would report as unpriced forever.
 */
export async function readPricing(ctx: AddonContext, accountId: string): Promise<PricingState> {
  const holdings = await ctx.api.portfolio.getHoldings(accountId);
  const assets: PricedAsset[] = [];

  for (const holding of holdings as (Holding & { holdingType?: string })[]) {
    if (holding.holdingType === 'cash') continue;
    const symbol = holding.instrument?.symbol;
    const assetId = holding.instrument?.id ?? holding.id;
    if (!symbol || !assetId) continue;
    // Kraken prices coins, not cash balances and not currency pairs. Pointing
    // `$CASH` or `BTCGBP` at it asks for a pair that cannot exist and fills the
    // host's data-health page with failures that look like a broken provider.
    if (symbol.startsWith('$CASH') || symbol.includes('=')) continue;

    // The holding does not carry its data source, so the profile is read for
    // it. Only for securities, and only once per sync, so the cost is small.
    let onKraken = false;
    try {
      const profile = (await ctx.api.assets.getProfile(assetId)) as {
        providerConfig?: { preferred_provider?: string; custom_provider_code?: string } | null;
        instrumentType?: string;
      };
      // Only crypto. An equity, a cash line or an FX pair that happens to sit
      // in this account is not something Kraken's Ticker can answer for —
      // pointing one at it asks for `$CASHUSD` or `BTCGBPUSD`, pairs that
      // cannot exist, and the failures read like a broken provider.
      if (profile.instrumentType !== 'CRYPTO') continue;
      onKraken = isKrakenSource(profile.providerConfig);
    } catch {
      // An unreadable profile is reported as not-on-Kraken, which at worst
      // offers a change that turns out to be a no-op.
    }

    assets.push({ assetId, symbol, price: Number(holding.price ?? 0), onKraken });
  }

  return {
    assets,
    unpriced: assets.filter((asset) => !(asset.price > 0)),
    offKraken: assets.filter((asset) => !asset.onKraken),
  };
}

export interface ApplyResult {
  /** Assets successfully pointed at the Kraken provider. */
  assigned: number;
  /** Assets still without a price after the sync. */
  stillUnpriced: string[];
  /**
   * True when the provider is missing. Inferred, not looked up: if every asset
   * that previously had no price still has none, the provider that was supposed
   * to answer for them does not exist.
   *
   * Only meaningful when `verified` is true. A refresh that never ran proves
   * nothing either way.
   */
  providerMissing: boolean;
  /**
   * Whether a price refresh actually completed.
   *
   * This exists because the first version of this function reported "all
   * holdings now price from Kraken" after the refresh had been refused for a
   * missing permission. Every holding did still have a price — the stale one it
   * already had — so the check passed while nothing had happened. A cached
   * price makes success and failure look identical, which is precisely the
   * confident-wrong-answer this connector exists to avoid.
   */
  verified: boolean;
  /** How many holdings now carry a quote Kraken actually supplied. */
  sourced?: number;
  error?: string;
}

/**
 * Make Kraken the price source for every security in the account.
 *
 * `providerSymbol` is the asset's own display symbol, which is what the
 * provider's `{SYMBOL}` placeholder expands to — Kraken prices `TAOUSD`,
 * `GRTUSD` and so on, and re-keys a few of them in the response, which is why
 * the provider's JSONPath uses a wildcard rather than an exact key.
 */
export async function applyKrakenPricing(
  ctx: AddonContext,
  accountId: string,
  log: (level: 'info' | 'success' | 'warn' | 'error', message: string) => void,
): Promise<ApplyResult> {
  const before = await readPricing(ctx, accountId);
  if (before.assets.length === 0) {
    return { assigned: 0, stillUnpriced: [], providerMissing: false, verified: false };
  }

  let assigned = 0;
  for (const asset of before.assets) {
    try {
      const profile = await ctx.api.assets.getProfile(asset.assetId);
      // Read-modify-write: the handler takes a whole profile, so anything left
      // out risks being cleared.
      //
      // `providerConfig` is the field that does this. `dataSource`,
      // `providerId` and `providerSymbol` are what the SDK's shape suggests,
      // and `UpdateAssetProfile` accepts none of them — sending those returned
      // 200 and changed nothing at all, which is why the panel kept offering a
      // change it had already "made". A custom provider is named in two parts:
      // the built-in type it runs under, then its own code.
      const update = {
        ...profile,
        quoteCcy: CRYPTO_QUOTE_CURRENCY,
        providerConfig: {
          ...(typeof profile.providerConfig === 'object' ? profile.providerConfig : {}),
          preferred_provider: 'CUSTOM_SCRAPER',
          custom_provider_code: QUOTE_PROVIDER.id,
        },
      };
      await ctx.api.assets.updateProfile(update as never);
      assigned += 1;
    } catch (error) {
      log('warn', `Could not set a price source for ${asset.symbol}: ${describe(error)}`);
    }
  }
  log('info', `Pointed ${assigned} asset(s) at ${QUOTE_PROVIDER.name}.`);

  try {
    await ctx.api.market.sync(before.assets.map((asset) => asset.assetId), true);
  } catch (error) {
    // The assignment stands, but nothing has been proven about it.
    return {
      assigned,
      stillUnpriced: before.unpriced.map((asset) => asset.symbol),
      providerMissing: false,
      verified: false,
      error: describe(error),
    };
  }

  await ctx.api.portfolio.recalculate();

  // Whether the provider answered is decided by asking the quotes where they
  // came from, not by whether a price exists.
  //
  // The absence of a price is not evidence: a holding Yahoo already priced
  // keeps that cached quote whether or not the new provider exists, so
  // "everything has a price" is true either way. `Quote.dataSource` is the only
  // positive signal available, and it is what this waits for.
  const sourced = await settle(3000, 12, () => countKrakenQuotes(ctx, before.assets));
  const after = await readPricing(ctx, accountId);

  return {
    assigned,
    stillUnpriced: after.unpriced.map((asset) => asset.symbol),
    // Nothing carries a Kraken quote after a completed refresh: the provider
    // that was supposed to supply them is not configured.
    providerMissing: assigned > 0 && sourced === 0,
    verified: sourced > 0,
    sourced,
  };
}

/** How many of these assets have a latest quote that came from Kraken. */
async function countKrakenQuotes(
  ctx: AddonContext,
  assets: readonly PricedAsset[],
): Promise<number> {
  let sourced = 0;
  for (const asset of assets) {
    try {
      const history = await ctx.api.quotes.getHistory(asset.assetId);
      // Chosen by timestamp rather than by position. The host returns quote
      // history newest-first (`timestamp.desc()`), so taking the last element
      // reads the *oldest* quote — which is always the pre-existing Yahoo one,
      // and made this report "provider missing" while it was working perfectly.
      let latest: (typeof history)[number] | undefined;
      for (const quote of history) {
        if (!latest || quote.timestamp > latest.timestamp) latest = quote;
      }
      if (isKrakenQuote(latest?.dataSource)) sourced += 1;
    } catch {
      // A quote history we cannot read counts as no evidence, not as failure.
    }
  }
  return sourced;
}

/** Poll until the count stops being zero, or give up. Returns the last count. */
async function settle(
  intervalMs: number,
  attempts: number,
  count: () => Promise<number>,
): Promise<number> {
  let last = 0;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    last = await count();
    if (last > 0) return last;
  }
  return last;
}

/**
 * Correct the names of assets Wealthfolio got from the wrong instrument.
 *
 * `asset.name` is honoured when an asset is created and ignored afterwards, so
 * anything imported before a name was known keeps whatever the market-data
 * provider matched. Yahoo called Kraken's `CC` "CloudCoin USD" — a different
 * coin, at roughly twice the price.
 *
 * Only names listed in `ASSET_NAMES` are touched. A stored name is never
 * replaced with the bare symbol: for the majors the provider's name is right
 * and better than `BTC`, and overwriting one a user set by hand would be worse
 * than the problem being fixed.
 */
export async function reconcileAssetNames(
  ctx: AddonContext,
  accountId: string,
  log: (level: 'info' | 'success' | 'warn' | 'error', message: string) => void,
): Promise<number> {
  const { assets } = await readPricing(ctx, accountId);
  let renamed = 0;

  for (const asset of assets) {
    const wanted = ASSET_NAMES[asset.symbol];
    if (!wanted) continue;
    try {
      const profile = (await ctx.api.assets.getProfile(asset.assetId)) as { name?: string };
      if (profile.name === wanted) continue;
      await ctx.api.assets.updateProfile({ ...profile, name: wanted } as never);
      log('success', `${asset.symbol}: renamed from "${profile.name}" to "${wanted}".`);
      renamed += 1;
    } catch (error) {
      log('warn', `Could not rename ${asset.symbol}: ${describe(error)}`);
    }
  }
  return renamed;
}

/** Whether an asset's stored provider config names this connector's provider. */
function isKrakenSource(
  config: { preferred_provider?: string; custom_provider_code?: string } | null | undefined,
): boolean {
  return config?.custom_provider_code === QUOTE_PROVIDER.id;
}

/**
 * Whether a stored quote came from this connector's provider.
 *
 * A custom provider's quotes are namespaced by the provider *type* that ran
 * them: the source recorded against a Kraken quote is
 * `CUSTOM_SCRAPER:kraken-ticker`, not `kraken-ticker`. Comparing for equality
 * matched nothing, so a provider that was working perfectly was reported as
 * missing — and the panel told the user to create one that already existed.
 */
function isKrakenQuote(dataSource: string | undefined): boolean {
  if (!dataSource) return false;
  return dataSource === QUOTE_PROVIDER.id || dataSource.endsWith(`:${QUOTE_PROVIDER.id}`);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
