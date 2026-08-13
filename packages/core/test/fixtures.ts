import type { T212HistoricalOrder } from '../src/index';

/**
 * Sample `/equity/history/orders` entries, shaped exactly as the API documents
 * them. Realistic enough to cover the cases the mapper has to get right: a US
 * buy with an FX conversion fee, a UK buy carrying stamp duty, a sell, and a
 * corporate action that must not become a trade.
 */

export function buyApple(overrides: Partial<T212HistoricalOrder['fill']> = {}): T212HistoricalOrder {
  return {
    order: {
      id: 900001,
      ticker: 'AAPL_US_EQ',
      instrument: {
        ticker: 'AAPL_US_EQ',
        name: 'Apple Inc.',
        isin: 'US0378331005',
        currency: 'USD',
      },
      side: 'BUY',
      status: 'FILLED',
      type: 'MARKET',
      strategy: 'QUANTITY',
      currency: 'USD',
      createdAt: '2025-03-04T14:29:58.000Z',
      quantity: 10,
      filledQuantity: 10,
    },
    fill: {
      id: 700001,
      type: 'TRADE',
      filledAt: '2025-03-04T14:30:02.000Z',
      price: 187.2,
      quantity: 10,
      tradingMethod: 'TOTV',
      walletImpact: {
        currency: 'GBP',
        fxRate: 0.7821,
        netValue: -1464.24,
        realisedProfitLoss: 0,
        taxes: [
          {
            name: 'CURRENCY_CONVERSION_FEE',
            quantity: 2.2,
            currency: 'GBP',
            chargedAt: '2025-03-04T14:30:02.000Z',
          },
        ],
      },
      ...overrides,
    },
  };
}

export function buyVodafoneWithStampDuty(): T212HistoricalOrder {
  return {
    order: {
      id: 900002,
      ticker: 'VODl_EQ',
      instrument: {
        ticker: 'VODl_EQ',
        name: 'Vodafone Group plc',
        isin: 'GB00BH4HKS39',
        currency: 'GBP',
      },
      side: 'BUY',
      status: 'FILLED',
      type: 'LIMIT',
      strategy: 'QUANTITY',
      currency: 'GBP',
      createdAt: '2025-04-10T08:01:00.000Z',
      quantity: 500,
      filledQuantity: 500,
      limitPrice: 0.68,
    },
    fill: {
      id: 700002,
      type: 'TRADE',
      filledAt: '2025-04-10T08:02:11.000Z',
      price: 0.675,
      quantity: 500,
      tradingMethod: 'TOTV',
      walletImpact: {
        currency: 'GBP',
        fxRate: 1,
        netValue: -339.19,
        realisedProfitLoss: 0,
        taxes: [
          {
            name: 'STAMP_DUTY',
            quantity: 1.69,
            currency: 'GBP',
            chargedAt: '2025-04-10T08:02:11.000Z',
          },
          {
            name: 'PTM_LEVY',
            quantity: 0.0,
            currency: 'GBP',
            chargedAt: '2025-04-10T08:02:11.000Z',
          },
        ],
      },
    },
  };
}

export function sellMicrosoft(): T212HistoricalOrder {
  return {
    order: {
      id: 900003,
      ticker: 'MSFT_US_EQ',
      instrument: {
        ticker: 'MSFT_US_EQ',
        name: 'Microsoft Corporation',
        isin: 'US5949181045',
        currency: 'USD',
      },
      side: 'SELL',
      status: 'FILLED',
      type: 'MARKET',
      strategy: 'QUANTITY',
      currency: 'USD',
      createdAt: '2025-05-20T15:44:00.000Z',
      quantity: -4,
      filledQuantity: -4,
    },
    fill: {
      id: 700003,
      type: 'TRADE',
      filledAt: '2025-05-20T15:44:07.000Z',
      price: 410.05,
      // Sells come back negative — the mapper takes the side from
      // `order.side` and the magnitude from here.
      quantity: -4,
      tradingMethod: 'TOTV',
      walletImpact: {
        currency: 'GBP',
        fxRate: 0.7903,
        netValue: 1294.62,
        realisedProfitLoss: 210.33,
        taxes: [
          {
            name: 'FINRA_FEE',
            quantity: 0.03,
            currency: 'GBP',
            chargedAt: '2025-05-20T15:44:07.000Z',
          },
          {
            name: 'CURRENCY_CONVERSION_FEE',
            quantity: 1.94,
            currency: 'GBP',
            chargedAt: '2025-05-20T15:44:07.000Z',
          },
        ],
      },
    },
  };
}

/** A share split arrives on the same endpoint but is not a trade. */
export function nvidiaStockSplit(): T212HistoricalOrder {
  return {
    order: {
      id: 900004,
      ticker: 'NVDA_US_EQ',
      instrument: {
        ticker: 'NVDA_US_EQ',
        name: 'NVIDIA Corporation',
        isin: 'US67066G1040',
        currency: 'USD',
      },
      side: 'BUY',
      status: 'FILLED',
      type: 'MARKET',
      strategy: 'QUANTITY',
      currency: 'USD',
      createdAt: '2024-06-10T00:00:00.000Z',
      quantity: 90,
    },
    fill: {
      id: 700004,
      type: 'STOCK_SPLIT',
      filledAt: '2024-06-10T00:00:00.000Z',
      price: 0,
      quantity: 90,
      walletImpact: {
        currency: 'GBP',
        fxRate: 1,
        netValue: 0,
        realisedProfitLoss: 0,
        taxes: [],
      },
    },
  };
}

export function sampleHistory(): T212HistoricalOrder[] {
  return [buyApple(), buyVodafoneWithStampDuty(), sellMicrosoft(), nvidiaStockSplit()];
}
