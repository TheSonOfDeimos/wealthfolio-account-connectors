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
 * | A BUY at `unitPrice: 0` creates a real holding.  | Rewards can be recorded     |
 * |                                                  | without inventing a value.  |
 *
 * The one place this computes rather than copies is a purchase's unit price,
 * `amount / quantity`. Both operands are stated by Kraken on their own ledger
 * rows, and the comment carries them so the arithmetic stays auditable.
 */
import type { AssetInfo, InstantBuy, KrakenDataset } from './extract';
import { displaySymbol, groupByRefid, ledgerKind, pairInstantBuys } from './extract';
import { CRYPTO_QUOTE_CURRENCY, FIAT_CURRENCIES, KRAKEN_PROVIDER } from '../config';

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
 */
export function idempotencyKeyFor(sourceId: string): string {
  return `kraken:${sourceId}`;
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

export function mapDataset(
  dataset: KrakenDataset,
  accountId: string,
  options: MapOptions,
): MapResult {
  const activities: MappedActivity[] = [];
  const issues: MappingIssue[] = [];
  const assets = dataset.assets;

  const symbolOf = (code: string): string | undefined => displaySymbol(assets, code);
  const isFiat = (code: string): boolean => {
    const symbol = symbolOf(code);
    return symbol !== undefined && FIAT_CURRENCIES.has(symbol);
  };

  const base = (row: { time: number }, sourceId: string) => ({
    accountId,
    activityDate: new Date(row.time * 1000).toISOString(),
    sourceSystem: KRAKEN_PROVIDER,
    sourceRecordId: sourceId,
    idempotencyKey: idempotencyKeyFor(sourceId),
  });

  // The quote currency names the *price feed*, never the trade. Passing the
  // purchase currency through here left seven of twenty holdings unpriced,
  // because Yahoo carries GBP pairs only for the majors.
  const assetFor = (code: string) => {
    const symbol = symbolOf(code);
    if (!symbol) return undefined;
    // `kind` is not advisory: without it the host classifies an unrecognised
    // coin as an equity. Verified — GRT was stored as EQUITY.
    return { symbol, kind: 'CRYPTO' as const, quoteCcy: CRYPTO_QUOTE_CURRENCY };
  };

  // ── Purchases ────────────────────────────────────────────────────────────
  //
  // Kraken records an Instant Buy as a `spend` and a `receive` sharing a
  // refid, and never reports it through TradesHistory. Both legs state their
  // own asset, amount and fee.
  const { buys, unpaired } = pairInstantBuys(dataset.ledgers);
  for (const buy of buys) {
    const result = mapPurchase(buy, { accountId, options, assets, symbolOf, isFiat, assetFor, base });
    if (result.activity) activities.push(result.activity);
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
        activities.push({
          ...base(row, row.id),
          activityType: 'BUY',
          subtype: 'STAKING_REWARD',
          asset: assetFor(row.asset)!,
          quantity: decimal(net),
          // Zero, because Kraken states no value for a reward and any other
          // number would be one this connector made up. A verified host
          // behaviour makes this viable: a BUY at zero still creates a holding.
          unitPrice: '0',
          amount: '0',
          currency: options.accountCurrency,
          comment:
            `Kraken staking ${row.refid} · gross ${decimal(amount)} ${symbol}, ` +
            `fee ${decimal(fee)}, net ${decimal(net)} · no fiat value stated`,
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
): { activity?: MappedActivity; issue?: MappingIssue } {
  const { symbolOf, isFiat, assetFor, base } = context;

  const spentSymbol = symbolOf(buy.spent.asset) ?? buy.spent.asset;
  const receivedSymbol = symbolOf(buy.received.asset);

  if (!receivedSymbol) {
    return {
      issue: {
        kind: 'skipped',
        sourceId: buy.refid,
        message: `Bought ${buy.received.asset}, which is not in Kraken's asset catalogue. Left out.`,
      },
    };
  }

  // Paying in crypto or a stablecoin is the case Wealthfolio cannot represent:
  // it would resolve the currency as an FX pair — `BTCUSD=X` — that does not
  // exist, store the row, and never price it.
  if (!isFiat(buy.spent.asset)) {
    return {
      issue: {
        kind: 'skipped',
        sourceId: buy.refid,
        message:
          `Bought ${receivedSymbol} with ${spentSymbol}, which Wealthfolio cannot price as a ` +
          'currency, and Kraken states no fiat equivalent. Left out rather than valued at a made-up rate.',
      },
    };
  }

  // The receive leg can carry its own fee, deducted in the asset received.
  const quantity = buy.received.amount - buy.received.fee;
  if (quantity <= 0) {
    return {
      issue: {
        kind: 'skipped',
        sourceId: buy.refid,
        message: `Purchase ${buy.refid} nets no quantity after fees. Left out.`,
      },
    };
  }

  return {
    activity: {
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
