/**
 * Kraken ledger entries → Wealthfolio activities.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  The rule
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Record what Kraken recorded, and convert nothing. Where Kraken does not state
 * a figure, none is invented — the row is reported instead of written. Kraken
 * states less than a stockbroker does, so this mapper declines more often than
 * the Trading 212 one, and says so each time.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  Five host behaviours, each verified against a running 3.6.3 by `pnpm probe:host`
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * | Verified                                        | Consequence here            |
 * | ----------------------------------------------- | --------------------------- |
 * | A BUY without `unitPrice` is accepted and stored | The price must be computed. |
 * | with a null price — not derived, not rejected.   | A null cost basis is silent |
 * |                                                  | and worse than an error.    |
 * | `asset.kind` beats the host's own guess.         | Always send `CRYPTO`.       |
 * | Without it, `GRT` is stored as an EQUITY.        |                             |
 * | `sourceSystem`, `sourceRecordId`, `subtype` and  | Provenance goes in fields,  |
 * | `idempotencyKey` are all forwarded and stored,   | not stamped into a comment. |
 * | though the SDK type declares none of them.       |                             |
 * | An activity in a crypto currency is accepted     | Fiat-quoted rows only; the  |
 * | silently and then never priced.                  | rest are reported.          |
 * | A BUY at `unitPrice: 0` creates a real holding,   | Only as a fallback: it is   |
 * | but leaves its cost basis `unknown`.             | a position with no basis.   |
 * | `DIVIDEND`/`DIVIDEND_IN_KIND` adds quantity and  | Staking rewards go here.    |
 * | a cost basis without touching cash; a priced BUY | A priced BUY spends money   |
 * | deducts cash the user never spent.               | the user never spent.       |
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  Where a number comes from when Kraken states none
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Two row shapes carry quantities and no money: a staking reward, and a
 * coin-for-coin exchange. Kraken states no fiat value for either, anywhere —
 * and Wealthfolio will not give a position a cost basis without one, which is
 * what left 263 transactions flagged and Unrealized P&L at N/A.
 *
 * So those rows are valued at Kraken's published daily close for the asset,
 * supplied by the caller as `priceOn` (see `prices.ts`). That is a stated
 * figure for a known asset on a known date — the same series the connector's
 * own quote provider reads — rather than a guess about what the row was worth.
 * It is still not the rate Kraken gave you, so every row priced this way says
 * so in its comment, and when no close exists the row falls back to zero cost
 * and is flagged. A missing price is recoverable; an invented one is not.
 *
 * The one other place this computes rather than copies is a purchase's unit
 * price, `amount / quantity`. Both operands are stated by Kraken on their own
 * ledger rows, and the comment carries them so the arithmetic stays auditable.
 */
import type { AssetInfo, InstantBuy, KrakenDataset } from './extract';
import { dayOf } from './prices';
import type { PriceLookup } from './prices';
import { displaySymbol, groupByRefid, ledgerKind, pairInstantBuys } from './extract';
import {
  ASSET_NAMES,
  CRYPTO_QUOTE_CURRENCY,
  FIAT_CURRENCIES,
  KRAKEN_PROVIDER,
  SYMBOL_OVERRIDES,
} from '../config';

/** An activity as `saveMany` accepts it, including the fields the SDK omits. */
export interface MappedActivity {
  accountId: string;
  activityType: string;
  activityDate: string;
  subtype?: string;
  asset?: { symbol: string; kind: 'CRYPTO'; quoteCcy: string; name?: string };
  quantity?: string;
  unitPrice?: string;
  amount?: string;
  currency: string;
  fee?: string;
  comment: string;
  /** Undeclared by the SDK, accepted by the backend. Verified. */
  sourceSystem: string;
  sourceRecordId: string;
  idempotencyKey: string;
  needsReview?: boolean;
}

export interface MappingIssue {
  kind: 'skipped' | 'warning';
  /** The Kraken row this is about, for the UI to point at. */
  sourceId: string;
  message: string;
}

export interface MapResult {
  activities: MappedActivity[];
  issues: MappingIssue[];
}

export interface MapOptions {
  /**
   * Kraken's published daily close for an asset, when there is one.
   *
   * Supplied rather than fetched here so the mapper stays a pure function of
   * the dataset it is handed, which is what lets the reconciliation tool run
   * it offline. Absent, or returning `undefined`, every row that needs a price
   * falls back to being recorded at zero and flagged.
   */
  priceOn?: PriceLookup;
  /**
   * The currency the Wealthfolio account is denominated in.
   *
   * Kraken has no account currency — balances are held per asset — so this is
   * the user's choice, and it is what a row with no money in it (a staking
   * reward, an airdrop) is denominated in. Using it rather than the asset's
   * own code is what stops those rows creating an FX pair nobody can price.
   */
  accountCurrency: string;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Identity
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How this connector recognises its own rows.
 *
 * Kraken's ids are stable and unique, so they are the key — no hashing, and no
 * stamping into a comment the way the Trading 212 connector had to before the
 * backend was found to accept `sourceRecordId`.
 *
 * Scoped to the Wealthfolio account, because the host treats an idempotency key
 * as globally unique rather than unique per account. Without the account in the
 * key, importing the same Kraken history into a second account is refused
 * outright — "Duplicate activity detected" — which is exactly what happened the
 * first time the reconciliation tool ran against a host that already held a
 * real import.
 */
export function idempotencyKeyFor(accountId: string, sourceId: string): string {
  return `kraken:${accountId}:${sourceId}`;
}

/** The prefix every key for one account shares, for stripping it back off. */
export function keyPrefixFor(accountId: string): string {
  return `kraken:${accountId}:`;
}

/** True when an activity came from this connector. */
export function isOurs(activity: { sourceSystem?: string; idempotencyKey?: string }): boolean {
  return (
    activity.sourceSystem === KRAKEN_PROVIDER ||
    Boolean(activity.idempotencyKey?.startsWith('kraken:'))
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Numbers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A number as a string the backend will accept, without float noise.
 *
 * Kraken quotes everything as a decimal string precisely to avoid binary
 * float error, so the arithmetic here is kept to the minimum and trimmed back
 * to something exact enough to survive a round trip.
 */
function decimal(value: number, places = 12): string {
  if (!Number.isFinite(value)) return '0';
  return String(Number(value.toFixed(places)));
}

// ─────────────────────────────────────────────────────────────────────────────
//  Mapping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The assets whose daily close the mapper will need.
 *
 * Only two row shapes need one — a staking reward, and the coin given up in a
 * coin-for-coin exchange — so only those assets are looked up rather than the
 * whole catalogue. One public call each, and none at all for an account that
 * neither stakes nor swaps.
 */
export function symbolsNeedingPrices(dataset: KrakenDataset): string[] {
  const assets = dataset.assets;
  const symbolOf = (code: string): string | undefined =>
    SYMBOL_OVERRIDES[code] ?? displaySymbol(assets, code);
  const isFiat = (code: string): boolean => {
    const symbol = symbolOf(code);
    return symbol !== undefined && FIAT_CURRENCIES.has(symbol);
  };

  const wanted = new Set<string>();
  for (const row of dataset.ledgers) {
    const kind = ledgerKind(row).split('/')[0];
    if (kind !== 'staking' && kind !== 'earn') continue;
    const symbol = symbolOf(row.asset);
    if (symbol && !FIAT_CURRENCIES.has(symbol)) wanted.add(symbol);
  }
  for (const buy of pairInstantBuys(dataset.ledgers).buys) {
    if (isFiat(buy.spent.asset)) continue;
    const symbol = symbolOf(buy.spent.asset);
    if (symbol) wanted.add(symbol);
  }
  return [...wanted].sort();
}

export function mapDataset(
  dataset: KrakenDataset,
  accountId: string,
  options: MapOptions,
): MapResult {
  const activities: MappedActivity[] = [];
  const issues: MappingIssue[] = [];
  const assets = dataset.assets;

  // Your correction first, then the display name Kraken states. The smoke test
  // points at `SYMBOL_OVERRIDES` when an asset will not resolve, so it has to
  // be a table something actually reads.
  const symbolOf = (code: string): string | undefined =>
    SYMBOL_OVERRIDES[code] ?? displaySymbol(assets, code);
  const isFiat = (code: string): boolean => {
    const symbol = symbolOf(code);
    return symbol !== undefined && FIAT_CURRENCIES.has(symbol);
  };

  const base = (row: { time: number }, sourceId: string) => ({
    accountId,
    activityDate: new Date(row.time * 1000).toISOString(),
    sourceSystem: KRAKEN_PROVIDER,
    sourceRecordId: sourceId,
    idempotencyKey: idempotencyKeyFor(accountId, sourceId),
  });

  // The quote currency names the *price feed*, never the trade. Passing the
  // purchase currency through here left seven of twenty holdings unpriced,
  // because Yahoo carries GBP pairs only for the majors.
  const assetFor = (code: string) => {
    const symbol = symbolOf(code);
    if (!symbol) return undefined;
    // `kind` is not advisory: without it the host classifies an unrecognised
    // coin as an equity. Verified — GRT was stored as EQUITY.
    //
    // `name` is supplied for the same reason: left unset, the host names the
    // asset from whatever its market-data provider matched, and Yahoo called
    // Kraken's `CC` "CloudCoin USD" — a different coin. Kraken's code is the
    // only name this connector can state, so it is the default.
    return {
      symbol,
      kind: 'CRYPTO' as const,
      quoteCcy: CRYPTO_QUOTE_CURRENCY,
      name: ASSET_NAMES[symbol] ?? symbol,
    };
  };

  // ── Purchases ────────────────────────────────────────────────────────────
  //
  // Kraken records an Instant Buy as a `spend` and a `receive` sharing a
  // refid, and never reports it through TradesHistory. Both legs state their
  // own asset, amount and fee.
  const { buys, unpaired } = pairInstantBuys(dataset.ledgers);
  for (const buy of buys) {
    const result = mapPurchase(buy, { accountId, options, assets, symbolOf, isFiat, assetFor, base });
    activities.push(...result.activities);
    if (result.issue) issues.push(result.issue);
  }
  for (const row of unpaired) {
    issues.push({
      kind: 'skipped',
      sourceId: row.id,
      message:
        `${ledgerKind(row)} ${row.asset} ${row.amount} has no matching counterpart under refid ` +
        `${row.refid}, so what it was exchanged for is not stated. Left out.`,
    });
  }

  // ── Trades proper ────────────────────────────────────────────────────────
  //
  // Nothing on the account this was built against used them, but a limit order
  // placed on Kraken Pro lands here rather than in the spend/receive pair.
  const tradeLedger = groupByRefid(dataset.ledgers.filter((row) => row.type === 'trade'));
  for (const trade of dataset.trades) {
    const pair = dataset.pairs.get(trade.pair);
    if (!pair) {
      issues.push({
        kind: 'skipped',
        sourceId: trade.id,
        message: `Trade ${trade.id} is on pair ${trade.pair}, which is not in the fetched pair list, so its base and quote are unknown. Left out.`,
      });
      continue;
    }
    if (!isFiat(pair.quote)) {
      issues.push({
        kind: 'skipped',
        sourceId: trade.id,
        message:
          `Trade ${trade.id} is quoted in ${symbolOf(pair.quote) ?? pair.quote}, which Wealthfolio ` +
          'cannot price as a currency. Left out rather than valued at a made-up rate.',
      });
      continue;
    }
    const asset = assetFor(pair.base);
    if (!asset) {
      issues.push({
        kind: 'skipped',
        sourceId: trade.id,
        message: `Trade ${trade.id} is on ${pair.base}, which is not in Kraken's asset catalogue. Left out.`,
      });
      continue;
    }
    activities.push({
      ...base(trade, trade.id),
      activityType: trade.type === 'buy' ? 'BUY' : 'SELL',
      asset,
      quantity: trade.vol,
      // Stated outright here, unlike an Instant Buy — no division needed.
      unitPrice: trade.price,
      amount: trade.cost,
      currency: symbolOf(pair.quote)!,
      fee: trade.fee,
      comment: `Kraken trade ${trade.id} · ${trade.pair} ${trade.type} · ledger ${
        tradeLedger.get(trade.id)?.map((row) => row.id).join(',') ?? 'unmatched'
      }`,
    });
  }

  // ── Everything else in the ledger ────────────────────────────────────────
  const spentOrReceived = new Set(
    dataset.ledgers.filter((row) => row.type === 'spend' || row.type === 'receive').map((row) => row.id),
  );

  for (const row of dataset.ledgers) {
    // Already accounted for by a purchase or a trade above.
    if (spentOrReceived.has(row.id) || row.type === 'trade') continue;

    const symbol = symbolOf(row.asset);
    if (!symbol) {
      issues.push({
        kind: 'skipped',
        sourceId: row.id,
        message: `${ledgerKind(row)} in ${row.asset}, which is not in Kraken's asset catalogue, so it has no symbol. Left out.`,
      });
      continue;
    }

    const amount = Number(row.amount);
    const fee = Number(row.fee || 0);
    const fiat = isFiat(row.asset);

    switch (row.type) {
      case 'deposit': {
        if (fiat) {
          activities.push({
            ...base(row, row.id),
            activityType: 'DEPOSIT',
            amount: decimal(amount),
            currency: symbol,
            ...(fee ? { fee: decimal(fee) } : {}),
            comment: `Kraken deposit ${row.refid}`,
          });
        } else {
          // Coins arriving from outside Kraken. Kraken knows the quantity and
          // nothing about what they cost, because they were not bought here.
          activities.push({
            ...base(row, row.id),
            activityType: 'TRANSFER_IN',
            asset: assetFor(row.asset)!,
            quantity: decimal(amount - fee),
            unitPrice: '0',
            amount: '0',
            currency: options.accountCurrency,
            comment: `Kraken deposit ${row.refid} · ${decimal(amount)} ${symbol} received, cost basis not stated by Kraken`,
            needsReview: true,
          });
          issues.push({
            kind: 'warning',
            sourceId: row.id,
            message:
              `${decimal(amount)} ${symbol} was deposited from outside Kraken, which does not state ` +
              'what it cost. Recorded at zero and flagged for review.',
          });
        }
        break;
      }

      case 'withdrawal': {
        activities.push(
          fiat
            ? {
                ...base(row, row.id),
                activityType: 'WITHDRAWAL',
                amount: decimal(Math.abs(amount)),
                currency: symbol,
                ...(fee ? { fee: decimal(fee) } : {}),
                comment: `Kraken withdrawal ${row.refid}`,
              }
            : {
                ...base(row, row.id),
                activityType: 'TRANSFER_OUT',
                asset: assetFor(row.asset)!,
                quantity: decimal(Math.abs(amount) + fee),
                unitPrice: '0',
                amount: '0',
                currency: options.accountCurrency,
                comment: `Kraken withdrawal ${row.refid} · ${decimal(Math.abs(amount))} ${symbol} sent`,
              },
        );
        break;
      }

      case 'staking':
      case 'earn': {
        // Verified against the ledger's own running balance on every asset:
        // `balance = previous + amount - fee`. Kraken's `amount` is gross, so
        // using it credits roughly a third more than actually arrived.
        const net = amount - fee;
        if (net <= 0) {
          issues.push({
            kind: 'skipped',
            sourceId: row.id,
            message: `Staking row ${row.id} nets ${decimal(net)} ${symbol} after its fee. Left out.`,
          });
          break;
        }
        const stakingBase =
          `Kraken staking ${row.refid} · gross ${decimal(amount)} ${symbol}, ` +
          `fee ${decimal(fee)}, net ${decimal(net)}`;
        const close = options.priceOn?.(symbol, dayOf(row.time));

        if (close === undefined) {
          // No published close for this asset on this day, so the reward is
          // recorded at zero rather than at a number this connector made up.
          // Wealthfolio will leave the position's cost basis unknown and say
          // so on its data-health page, which is the honest outcome.
          activities.push({
            ...base(row, row.id),
            activityType: 'BUY',
            subtype: 'STAKING_REWARD',
            asset: assetFor(row.asset)!,
            quantity: decimal(net),
            unitPrice: '0',
            amount: '0',
            currency: options.accountCurrency,
            comment: `${stakingBase} · Kraken publishes no close for ${symbol} that day, so this is recorded at zero cost`,
          });
          issues.push({
            kind: 'warning',
            sourceId: row.id,
            message:
              `No Kraken close for ${symbol} on ${dayOf(row.time)}, so the reward carries no cost ` +
              'basis. Wealthfolio will report the position as missing its purchase price.',
          });
          break;
        }

        // Income received as units, not a purchase. Verified against the host:
        // `DIVIDEND` + `DIVIDEND_IN_KIND` adds the quantity, sets a cost basis
        // and leaves cash alone, whereas a priced `BUY` also deducts cash the
        // user never spent — 1,000 became 900 on a reward of 100.
        activities.push({
          ...base(row, row.id),
          activityType: 'DIVIDEND',
          subtype: 'DIVIDEND_IN_KIND',
          asset: assetFor(row.asset)!,
          quantity: decimal(net),
          unitPrice: decimal(close),
          amount: decimal(net * close),
          currency: CRYPTO_QUOTE_CURRENCY,
          comment:
            `${stakingBase} · valued at Kraken's ${dayOf(row.time)} close of ` +
            `${decimal(close)} ${CRYPTO_QUOTE_CURRENCY}, which Kraken states for the asset but ` +
            'not for this row',
        });
        break;
      }

      case 'transfer': {
        const subtype = row.subtype ?? '';
        // Moves between your own Kraken wallets. Counting one as a deposit
        // would add an asset you already held — the portfolio doubles.
        if (/spot|futures|staking/i.test(subtype)) {
          issues.push({
            kind: 'skipped',
            sourceId: row.id,
            message: `Internal move between Kraken wallets (${subtype}); not a change in what you own.`,
          });
          break;
        }
        activities.push({
          ...base(row, row.id),
          activityType: amount >= 0 ? 'TRANSFER_IN' : 'TRANSFER_OUT',
          asset: assetFor(row.asset)!,
          quantity: decimal(Math.abs(amount) - fee),
          unitPrice: '0',
          amount: '0',
          currency: options.accountCurrency,
          comment: `Kraken transfer ${row.refid}${subtype ? ` (${subtype})` : ''} · ${decimal(amount)} ${symbol}`,
          needsReview: true,
        });
        issues.push({
          kind: 'warning',
          sourceId: row.id,
          message:
            `Transfer of ${decimal(amount)} ${symbol}${subtype ? ` (${subtype})` : ''} — an airdrop, fork or ` +
            'OTC settlement. Recorded at zero cost and flagged for review.',
        });
        break;
      }

      default: {
        issues.push({
          kind: 'skipped',
          sourceId: row.id,
          message:
            `Ledger type "${ledgerKind(row)}" is not mapped (${decimal(amount)} ${symbol}). ` +
            'Left out rather than guessed at — report it so it can be handled.',
        });
      }
    }
  }

  activities.sort((a, b) => a.activityDate.localeCompare(b.activityDate));
  return { activities, issues };
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * One Instant Buy, as a single BUY activity.
 *
 * The unit price is `spent / received`, the only computation in this mapper.
 * Kraken states the two legs and not the rate, and Wealthfolio stores a null
 * price rather than deriving one — verified — so the choice is between doing
 * this arithmetic and shipping a position with no cost basis at all.
 *
 * The fee is not folded into the price. Kraken charges it *on top* of the
 * spend, so `amount / quantity` is the price actually paid per unit, and the
 * fee travels in its own field where Wealthfolio can account for it.
 */
function mapPurchase(
  buy: InstantBuy,
  context: {
    accountId: string;
    options: MapOptions;
    assets: Map<string, AssetInfo>;
    symbolOf: (code: string) => string | undefined;
    isFiat: (code: string) => boolean;
    assetFor: (code: string) => MappedActivity['asset'];
    base: (row: { time: number }, sourceId: string) => Omit<MappedActivity, 'activityType' | 'currency' | 'comment'>;
  },
): { activities: MappedActivity[]; issue?: MappingIssue } {
  const { options, symbolOf, isFiat, assetFor, base } = context;

  const spentSymbol = symbolOf(buy.spent.asset) ?? buy.spent.asset;
  const receivedSymbol = symbolOf(buy.received.asset);

  if (!receivedSymbol) {
    return {
      activities: [],
      issue: {
        kind: 'skipped',
        sourceId: buy.refid,
        message: `Bought ${buy.received.asset}, which is not in Kraken's asset catalogue. Left out.`,
      },
    };
  }

  // The receive leg can carry its own fee, deducted in the asset received.
  const quantity = buy.received.amount - buy.received.fee;
  if (quantity <= 0) {
    return {
      activities: [],
      issue: {
        kind: 'skipped',
        sourceId: buy.refid,
        message: `Purchase ${buy.refid} nets no quantity after fees. Left out.`,
      },
    };
  }

  // ── Paid for in crypto ───────────────────────────────────────────────────
  //
  // Wealthfolio cannot hold an activity denominated in `TRX` or `USDG`: it
  // resolves the currency as an FX pair — `TRXUSD=X` — that does not exist, so
  // the row is stored and then never priced. Kraken states no fiat equivalent
  // for the exchange, and inventing one is out of the question.
  //
  // Dropping the pair entirely was the first answer, and it was the wrong one.
  // It traded a cost this connector does not know for a *quantity* it does:
  // both legs state their amounts outright, so skipping them left the spent
  // coin still in the portfolio and the bought one missing. On a live account
  // that put TRX 461.03 too high and CC 911.31 too low — every other asset
  // matched Kraken to eight decimals.
  //
  // So the movement is recorded and only the cost is withheld: the spent coin
  // leaves, the bought coin arrives, both at zero, both flagged. Quantities
  // then match Kraken exactly, and what is unknown is marked unknown rather
  // than being allowed to corrupt what is known.
  if (!isFiat(buy.spent.asset)) {
    const spentAsset = assetFor(buy.spent.asset);
    if (!spentAsset) {
      return {
        activities: [],
        issue: {
          kind: 'skipped',
          sourceId: buy.refid,
          message:
            `Paid with ${buy.spent.asset}, which is not in Kraken's asset catalogue, so what ` +
            'left the account cannot be identified. Left out.',
        },
      };
    }

    const exchanged =
      `Kraken ${buy.refid} · exchanged ${decimal(buy.spent.amount)} ${spentSymbol}` +
      `${buy.spent.fee ? ` + ${decimal(buy.spent.fee)} fee` : ''}` +
      ` for ${decimal(buy.received.amount)} ${receivedSymbol}` +
      `${buy.received.fee ? ` - ${decimal(buy.received.fee)} fee` : ''}`;

    // Two rows, so two keys. An idempotency key has to be unique per activity,
    // and both legs share one Kraken refid.
    const out = base(buy, buy.refid);
    const into = base(buy, buy.refid);
    out.idempotencyKey = idempotencyKeyFor(context.accountId, `${buy.refid}:out`);
    into.idempotencyKey = idempotencyKeyFor(context.accountId, `${buy.refid}:in`);

    const disposed = buy.spent.amount + buy.spent.fee;
    const close = options.priceOn?.(spentSymbol, dayOf(buy.time));

    if (close === undefined || quantity <= 0 || disposed <= 0) {
      // Unpriceable, so the quantities are recorded and the value is not.
      // `TRANSFER_OUT`/`TRANSFER_IN` is the wrong shape for this — Wealthfolio
      // reads a transfer as a move between *accounts* and asks for the other
      // side ("4 transfers need matching or confirmation") — but a swap that
      // cannot be valued has no honest cash leg either, so the pair stays,
      // flagged, until Kraken publishes a close that covers it.
      const note = `${exchanged} · Kraken states no fiat value for this exchange and publishes no close for ${spentSymbol} that day, so it is recorded at zero cost`;
      return {
        activities: [
          {
            ...out,
            activityType: 'TRANSFER_OUT',
            asset: spentAsset,
            quantity: decimal(disposed),
            unitPrice: '0',
            amount: '0',
            currency: options.accountCurrency,
            comment: note,
            needsReview: true,
          },
          {
            ...into,
            activityType: 'TRANSFER_IN',
            asset: assetFor(buy.received.asset),
            quantity: decimal(quantity),
            unitPrice: '0',
            amount: '0',
            currency: options.accountCurrency,
            comment: note,
            needsReview: true,
          },
        ],
        issue: {
          kind: 'warning',
          sourceId: buy.refid,
          message:
            `${decimal(buy.received.amount)} ${receivedSymbol} was bought with ${spentSymbol}, not ` +
            'with money, and Kraken publishes no close for it that day. The quantities are exact; ' +
            'both sides carry a zero cost and are flagged for review.',
        },
      };
    }

    // A swap is a disposal that funds an acquisition, so it is modelled as
    // one: sell the coin that left at Kraken's close for that day, and buy the
    // coin that arrived for exactly those proceeds. Pricing the buy from the
    // proceeds rather than from its own close is what keeps the pair
    // cash-neutral — two independent closes would leave a cash residue the
    // account never had. Verified against the host: cash is unchanged, both
    // positions come out with a cost basis, and the valuation reports
    // `basisStatus: complete` and `externalFlowSource: NO_FLOW`.
    const proceeds = disposed * close;
    const note =
      `${exchanged} · Kraken states no fiat value for the exchange, so the coin that left is ` +
      `valued at its ${dayOf(buy.time)} close of ${decimal(close)} ${CRYPTO_QUOTE_CURRENCY} and ` +
      'the coin that arrived is priced from those proceeds';

    return {
      activities: [
        {
          ...out,
          activityType: 'SELL',
          asset: spentAsset,
          quantity: decimal(disposed),
          unitPrice: decimal(close),
          amount: decimal(proceeds),
          currency: CRYPTO_QUOTE_CURRENCY,
          comment: note,
        },
        {
          ...into,
          activityType: 'BUY',
          asset: assetFor(buy.received.asset),
          quantity: decimal(quantity),
          unitPrice: decimal(proceeds / quantity),
          amount: decimal(proceeds),
          currency: CRYPTO_QUOTE_CURRENCY,
          comment: note,
        },
      ],
      issue: {
        kind: 'warning',
        sourceId: buy.refid,
        message:
          `${decimal(buy.received.amount)} ${receivedSymbol} was bought with ${spentSymbol}, not ` +
          `with money. Kraken states no value for the exchange, so it is valued at the ` +
          `${dayOf(buy.time)} close of ${spentSymbol} — the quantities are exact, the value is ` +
          "Kraken's published close rather than the rate you were given.",
      },
    };
  }

  // ── Paid for in fiat ─────────────────────────────────────────────────────
  return {
    activities: [
      {
        ...base(buy, buy.refid),
        activityType: 'BUY',
        asset: assetFor(buy.received.asset),
        quantity: decimal(quantity),
        unitPrice: decimal(buy.spent.amount / quantity),
        amount: decimal(buy.spent.amount),
        currency: spentSymbol,
        ...(buy.spent.fee ? { fee: decimal(buy.spent.fee) } : {}),
        comment:
          `Kraken ${buy.refid} · spent ${decimal(buy.spent.amount)} ${spentSymbol}` +
          `${buy.spent.fee ? ` + ${decimal(buy.spent.fee)} fee` : ''}` +
          `, received ${decimal(buy.received.amount)} ${receivedSymbol}` +
          `${buy.received.fee ? ` - ${decimal(buy.received.fee)} fee` : ''}` +
          ' · unit price derived from those two figures',
      },
    ],
  };
}

/** A census of what a mapping produced, for the smoke test and the UI. */
export function summarise(result: MapResult): Map<string, number> {
  const counts = new Map<string, number>();
  for (const activity of result.activities) {
    const key = activity.subtype
      ? `${activity.activityType}/${activity.subtype}`
      : activity.activityType;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
