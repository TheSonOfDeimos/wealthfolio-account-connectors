import { describe, expect, it } from 'vitest';
import { mapOrdersToActivities, mapTicker } from '../src/index';
import {
  buyApple,
  buyVodafoneWithStampDuty,
  nvidiaStockSplit,
  sampleHistory,
  sellMicrosoft,
} from './fixtures';

const options = { accountId: 'acct-1' };

describe('mapTicker', () => {
  it('maps a US listing to the bare symbol', () => {
    expect(mapTicker('AAPL_US_EQ')).toEqual({
      symbol: 'AAPL',
      source: 'us-listing',
      needsReview: false,
    });
  });

  it('strips the venue letter and flags the guess for review', () => {
    const mapped = mapTicker('VODl_EQ');
    expect(mapped.symbol).toBe('VOD');
    expect(mapped.source).toBe('venue-suffix');
    expect(mapped.needsReview).toBe(true);
  });

  it('passes an unadorned ticker straight through', () => {
    expect(mapTicker('TSLA')).toEqual({
      symbol: 'TSLA',
      source: 'passthrough',
      needsReview: false,
    });
  });
});

describe('mapOrdersToActivities', () => {
  it('maps a US buy, converting the FX fee into a fee', () => {
    const { activities } = mapOrdersToActivities([buyApple()], options);

    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      accountId: 'acct-1',
      activityType: 'BUY',
      symbol: 'AAPL',
      symbolName: 'Apple Inc.',
      quantity: 10,
      unitPrice: 187.2,
      // The wallet currency is what moved through the account, not USD.
      currency: 'GBP',
      fee: 2.2,
      tax: 0,
      fxRate: 0.7821,
      date: '2025-03-04T14:30:02.000Z',
    });
  });

  it('separates stamp duty from broker fees', () => {
    const { activities } = mapOrdersToActivities([buyVodafoneWithStampDuty()], options);

    expect(activities[0]?.tax).toBe(1.69);
    expect(activities[0]?.fee).toBe(0);
  });

  it('takes the side from the order and the magnitude from the fill', () => {
    const { activities } = mapOrdersToActivities([sellMicrosoft()], options);

    expect(activities[0]?.activityType).toBe('SELL');
    // The fill reports -4; Wealthfolio wants a positive quantity.
    expect(activities[0]?.quantity).toBe(4);
    expect(activities[0]?.fee).toBe(1.97);
  });

  it('skips corporate actions rather than inventing a trade', () => {
    const { activities, skipped } = mapOrdersToActivities([nvidiaStockSplit()], options);

    expect(activities).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ orderId: 900004, ticker: 'NVDA_US_EQ' });
    expect(skipped[0]?.reason).toContain('STOCK_SPLIT');
  });

  it('writes a traceable Trading 212 identity into the comment', () => {
    const { activities } = mapOrdersToActivities([buyApple()], options);

    expect(activities[0]?.comment).toBe(
      't212:order=900001 fill=700001 ticker=AAPL_US_EQ isin=US0378331005',
    );
  });

  it('warns instead of summing charges billed in another currency', () => {
    const order = buyApple();
    order.fill.walletImpact.taxes = [
      { name: 'FINRA_FEE', quantity: 0.05, currency: 'USD', chargedAt: '2025-03-04T14:30:02.000Z' },
    ];

    const { activities, warnings } = mapOrdersToActivities([order], options);

    expect(activities[0]?.fee).toBe(0);
    expect(warnings.some((warning) => warning.includes('FINRA_FEE 0.05 USD'))).toBe(true);
  });

  it('counts an unrecognised charge as a fee and says so', () => {
    const order = buyApple();
    order.fill.walletImpact.taxes = [
      {
        name: 'SOME_NEW_LEVY' as never,
        quantity: 0.4,
        currency: 'GBP',
        chargedAt: '2025-03-04T14:30:02.000Z',
      },
    ];

    const { activities, warnings } = mapOrdersToActivities([order], options);

    expect(activities[0]?.fee).toBe(0.4);
    expect(warnings.some((warning) => warning.includes('SOME_NEW_LEVY'))).toBe(true);
  });

  it('skips a zero-quantity fill', () => {
    const order = buyApple({ quantity: 0 } as never);
    const { activities, skipped } = mapOrdersToActivities([order], options);

    expect(activities).toHaveLength(0);
    expect(skipped[0]?.reason).toContain('quantity is 0');
  });

  it('maps a mixed history in one pass', () => {
    const { activities, skipped, warnings } = mapOrdersToActivities(sampleHistory(), options);

    expect(activities.map((row) => row.activityType)).toEqual(['BUY', 'BUY', 'SELL']);
    expect(activities.map((row) => row.symbol)).toEqual(['AAPL', 'VOD', 'MSFT']);
    expect(skipped).toHaveLength(1);
    // Only the Vodafone venue-letter guess is worth a second look.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('VOD');
  });
});
