import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import {
  enumerateTriangularPaths,
  enumerateCyclicPaths,
  estimateTriangularPathReturn,
  evaluateS3,
  evaluateS4,
  evaluateTriangularPath,
  simulateTriangularPath,
  type CostSettings,
  type DexQuote,
  type MarketMetadata,
  type OrderBookSnapshot,
  type TokenEligibility,
  type TriangularEdge,
} from '../src/index.js';

const now = 1_700_000_000_000;
const CAKE_TOKEN = '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82';
const USDT_TOKEN = '0x55d398326f99059fF775485246999027B3197955';
const settings: CostSettings = {
  minProfitUsd: new Decimal('0.25'),
  safetyBufferBps: new Decimal(15),
  minNetProfitBps: new Decimal(20),
  maxOrderbookAgeMs: 3000,
  maxSlippageBps: new Decimal(50),
  maxGasCostUsd: new Decimal('0.50'),
  maxTransferTaxBps: new Decimal(200),
};

const eligibleToken = {
  mappingStatus: 'active' as const,
  riskLevel: 'low' as const,
  verifiedContract: true,
  contractAddress: CAKE_TOKEN,
  transferTaxBps: new Decimal(0),
  transferRequired: false,
  withdrawEnabled: true,
  depositEnabled: true,
  liquidityUsd: new Decimal('500000'),
  volume24hUsd: new Decimal('500000'),
};

function market(base: string, quote: string, fee = '10'): MarketMetadata {
  return {
    venueId: 'gateio',
    exchangeSymbol: `${base}/${quote}`,
    unifiedSymbol: `${base}/${quote}`,
    base,
    quote,
    active: true,
    pricePrecision: 6,
    amountPrecision: 6,
    amountStep: new Decimal('0.000001'),
    priceStep: new Decimal('0.000001'),
    minAmount: new Decimal('0.000001'),
    minNotional: new Decimal('1'),
    feeTakerBps: new Decimal(fee),
    supportsIoc: true,
  };
}

function book(venue: string, symbol: string, ask: string, bid: string): OrderBookSnapshot {
  return {
    venueId: venue,
    exchangeSymbol: symbol,
    fetchedAt: now,
    asks: [{ price: new Decimal(ask), amount: new Decimal('100000') }],
    bids: [{ price: new Decimal(bid), amount: new Decimal('100000') }],
    source: 'replay',
  };
}

function quote(overrides: Partial<DexQuote> = {}): DexQuote {
  return {
    providerId: '0x',
    chain: 'BSC',
    sellToken: CAKE_TOKEN,
    buyToken: USDT_TOKEN,
    sellAmount: new Decimal('12'),
    buyAmount: new Decimal('31.2'),
    expectedSlippageBps: new Decimal('10'),
    priceImpactBps: new Decimal('10'),
    feeBps: new Decimal('25'),
    gasEstimate: new Decimal('200000'),
    gasPrice: new Decimal('1'),
    gasCostUsd: new Decimal('0.10'),
    quotedAt: now,
    ...overrides,
  };
}

function roundedTriangularPath(minimum = '1') {
  return {
    currencies: ['USDT', 'AAA', 'BBB', 'USDT'],
    edges: [
      {
        market: {
          ...market('AAA', 'USDT', '0'),
          amountStep: new Decimal(1),
          minNotional: new Decimal(minimum),
        },
        book: book('gateio', 'AAA/USDT', '6', '5.9'),
      },
      { market: market('BBB', 'AAA', '0'), book: book('gateio', 'BBB/AAA', '0.5', '0.49') },
      { market: market('BBB', 'USDT', '0'), book: book('gateio', 'BBB/USDT', '6.6', '6.5') },
    ],
  };
}

describe('S2 triangular paths', () => {
  it.each([
    ['3', false],
    ['5', true],
  ])('preserves exact-minimum budget fills at ask=%s without amount reduction', (ask, hasStep) => {
    const path = roundedTriangularPath('10');
    const firstMarket: MarketMetadata = path.edges[0]!.market;
    if (!hasStep) delete firstMarket.amountStep;
    path.edges[0]!.book.asks[0]!.price = new Decimal(ask);
    path.edges[0]!.book.bids[0]!.price = new Decimal(ask).minus('0.1');
    const result = evaluateTriangularPath(path, new Decimal(10), settings, now);
    expect(result.valid).toBe(true);
    expect((result.fillQuality!.fills as unknown[])[0]).toMatchObject({
      inputAmount: '10',
      unspentInputAmount: '0',
    });
  });

  it('retains intermediate quote dust without treating it as starting currency or next-leg input', () => {
    const path = roundedTriangularPath();
    path.edges[1]!.market.amountStep = new Decimal(3);
    path.edges[1]!.market.minNotional = new Decimal('0.1');
    path.edges[1]!.book.asks[0]!.price = new Decimal('0.25');
    path.edges[1]!.book.bids[0]!.price = new Decimal('0.24');
    const simulation = simulateTriangularPath(path, new Decimal(10), settings, now);
    expect(simulation.reasons).toEqual([]);
    expect(simulation.fills[1]!.inputAmount.toFixed()).toBe('0.75');
    expect(simulation.fills[1]!.unspentInputAmount!.toFixed()).toBe('0.25');
    expect(simulation.fills[2]!.inputAmount.toFixed()).toBe('3');
    expect(simulation.outputAmount.toFixed()).toBe('23.5');
  });

  it.each([
    ['100', '100000', 'amount_precision_invalid', 0],
    ['1', '1', 'insufficient_depth', 3],
  ] as const)('handles step=%s and available base=%s', (step, available, reason, fillCount) => {
    const path = roundedTriangularPath();
    path.edges[0]!.market.amountStep = new Decimal(step);
    path.edges[0]!.book.asks[0]!.amount = new Decimal(available);
    const simulation = simulateTriangularPath(path, new Decimal(10), settings, now);
    expect(simulation.reasons).toContain(reason);
    expect(simulation.fills).toHaveLength(fillCount);
  });

  it.each([
    ['10', false],
    ['6', true],
    ['5', true],
  ])('checks the rounded order against minNotional=%s', (minimum, valid) => {
    const path = roundedTriangularPath(minimum);
    const result = evaluateTriangularPath(path, new Decimal(10), settings, now);
    expect(result.valid).toBe(valid);
    expect(result.rejectionReasons.includes('below_min_notional')).toBe(!valid);
    expect((result.fillQuality!.fills as unknown[])[0]).toMatchObject({
      inputAmount: '6',
      outputAmount: '1',
      unspentInputAmount: '4',
    });
    expect(
      simulateTriangularPath(path, new Decimal(10), settings, now).outputAmount.toFixed(),
    ).toBe('17');
    expect(result.depthNetProfit.toFixed()).toBe('7');
  });

  it.each([
    ['1', '4', '4', 1, '6'],
    ['0.5', '6', '8', 2, '4'],
  ])(
    'reprices rounded multi-level buys with first-level amount=%s',
    (firstLevelAmount, cost, worstPrice, levelsConsumed, remainder) => {
      const firstBook = book('gateio', 'AAA/USDT', '4', '3.9');
      firstBook.asks = [
        { price: new Decimal(4), amount: new Decimal(firstLevelAmount) },
        { price: new Decimal(8), amount: new Decimal(10) },
      ];
      const path = {
        currencies: ['USDT', 'AAA', 'BBB', 'USDT'],
        edges: [
          {
            market: { ...market('AAA', 'USDT', '100'), amountStep: new Decimal(1) },
            book: firstBook,
          },
          { market: market('BBB', 'AAA', '0'), book: book('gateio', 'BBB/AAA', '0.5', '0.49') },
          { market: market('BBB', 'USDT', '0'), book: book('gateio', 'BBB/USDT', '6.6', '6.5') },
        ],
      };
      const simulation = simulateTriangularPath(path, new Decimal(10), settings, now);
      const first = simulation.fills[0]!;
      expect(first.inputAmount.toFixed()).toBe(cost);
      expect(first.averagePrice.toFixed()).toBe(cost);
      expect(first.worstPrice.toFixed()).toBe(worstPrice);
      expect(first.levelsConsumed).toBe(levelsConsumed);
      expect(first.fee.toFixed()).toBe('0.01');
      expect(first.outputAmount.toFixed()).toBe('0.99');
      expect(simulation.outputAmount.minus(simulation.fills.at(-1)!.outputAmount).toFixed()).toBe(
        remainder,
      );
      expect(first.inputAmount.plus(remainder).toFixed()).toBe('10');
    },
  );

  it('evaluates sequential depth and rejects stale path data', () => {
    const edges: TriangularEdge[] = [
      { market: market('BNB', 'USDT'), book: book('gateio', 'BNB/USDT', '500', '499') },
      { market: market('CAKE', 'BNB'), book: book('gateio', 'CAKE/BNB', '5', '4.9') },
      { market: market('CAKE', 'USDT'), book: book('gateio', 'CAKE/USDT', '3001', '3000') },
    ];
    const paths = enumerateTriangularPaths(edges, 'USDT', 3, 2);
    expect(paths.length).toBeGreaterThan(0);
    const intendedPath = paths.find((path) => path.currencies.join('>') === 'USDT>BNB>CAKE>USDT');
    expect(intendedPath).toBeDefined();
    expect(estimateTriangularPathReturn(intendedPath!).gt(0)).toBe(true);
    const result = evaluateTriangularPath(intendedPath!, new Decimal(1000), settings, now);
    expect({ valid: result.valid, reasons: result.rejectionReasons }).toEqual({
      valid: true,
      reasons: [],
    });
    expect(result.conservativeNetProfit.gt(0)).toBe(true);

    const staleEdges = edges.map((edge) => ({
      ...edge,
      book: { ...edge.book, fetchedAt: now - 10_000 },
    }));
    const stale = evaluateTriangularPath(
      { currencies: intendedPath!.currencies, edges: staleEdges },
      new Decimal(100),
      settings,
      now,
    );
    expect(stale.valid).toBe(false);
    expect(stale.rejectionReasons).toContain('stale_orderbook');
  });

  it('keeps gross spread, fee-adjusted depth profit and total cost distinct', () => {
    const edges: TriangularEdge[] = [
      { market: market('BNB', 'USDT', '10'), book: book('gateio', 'BNB/USDT', '500', '499') },
      { market: market('CAKE', 'BNB', '10'), book: book('gateio', 'CAKE/BNB', '5', '4.9') },
      { market: market('CAKE', 'USDT', '10'), book: book('gateio', 'CAKE/USDT', '3001', '3000') },
    ];
    const path = enumerateTriangularPaths(edges, 'USDT', 3, 2).find(
      (candidate) => candidate.currencies.join('>') === 'USDT>BNB>CAKE>USDT',
    )!;
    const result = evaluateTriangularPath(path, new Decimal(1000), settings, now);
    expect(result.valid).toBe(true);
    expect(result.grossSpread.gt(result.depthNetProfit)).toBe(true);
    expect(result.totalCost.toFixed()).toBe(
      result.grossSpread.minus(result.depthNetProfit).plus(new Decimal('1.5')).toFixed(),
    );
    expect(result.fillQuality).toBeDefined();
    expect((result.fillQuality!.fills as unknown[]).length).toBe(3);
  });

  it('accepts explicitly configured zero taker fees', () => {
    const edges: TriangularEdge[] = [
      { market: market('BNB', 'USDT', '0'), book: book('gateio', 'BNB/USDT', '500', '499') },
      { market: market('CAKE', 'BNB', '0'), book: book('gateio', 'CAKE/BNB', '5', '4.9') },
      { market: market('CAKE', 'USDT', '0'), book: book('gateio', 'CAKE/USDT', '3001', '3000') },
    ];
    const path = enumerateTriangularPaths(edges, 'USDT', 3, 2).find(
      (candidate) => candidate.currencies.join('>') === 'USDT>BNB>CAKE>USDT',
    )!;
    const result = evaluateTriangularPath(path, new Decimal(1000), settings, now);
    expect({ valid: result.valid, reasons: result.rejectionReasons }).toEqual({
      valid: true,
      reasons: [],
    });
  });

  it('rejects a triangular edge below its minimum order rules', () => {
    const constrained = market('BNB', 'USDT', '10');
    constrained.minAmount = new Decimal('100');
    const edges: TriangularEdge[] = [
      { market: constrained, book: book('gateio', 'BNB/USDT', '500', '499') },
      { market: market('CAKE', 'BNB', '10'), book: book('gateio', 'CAKE/BNB', '5', '4.9') },
      { market: market('CAKE', 'USDT', '10'), book: book('gateio', 'CAKE/USDT', '3001', '3000') },
    ];
    const path = enumerateTriangularPaths(edges, 'USDT', 3, 2).find(
      (candidate) => candidate.currencies.join('>') === 'USDT>BNB>CAKE>USDT',
    )!;
    const result = evaluateTriangularPath(path, new Decimal(1000), settings, now);
    expect(result.valid).toBe(false);
    expect(result.rejectionReasons).toContain('below_min_notional');
  });

  it('does not create a fake path by reusing the same market', () => {
    const edge: TriangularEdge = {
      market: market('BNB', 'USDT'),
      book: book('gateio', 'BNB/USDT', '500', '499'),
    };
    expect(enumerateTriangularPaths([edge], 'USDT', 3, 2)).toEqual([]);
    expect(enumerateTriangularPaths([edge, { ...edge }], 'USDT', 3, 2)).toEqual([]);

    const reused = evaluateTriangularPath(
      { currencies: ['USDT', 'BNB', 'USDT'], edges: [edge, edge] },
      new Decimal(100),
      settings,
      now,
    );
    expect(reused.valid).toBe(false);
    expect(reused.rejectionReasons).toContain('quote_mismatch');
  });

  it('rejects cross-venue paths and invalid profit thresholds', () => {
    const edges: TriangularEdge[] = [
      { market: market('BNB', 'USDT'), book: book('gateio', 'BNB/USDT', '500', '499') },
      { market: market('CAKE', 'BNB'), book: book('gateio', 'CAKE/BNB', '5', '4.9') },
      { market: market('CAKE', 'USDT'), book: book('gateio', 'CAKE/USDT', '3001', '3000') },
    ];
    const path = enumerateTriangularPaths(edges, 'USDT', 3, 2).find(
      (candidate) => candidate.currencies.join('>') === 'USDT>BNB>CAKE>USDT',
    )!;
    const mixedPath = {
      currencies: path.currencies,
      edges: path.edges.map((edge, index) =>
        index === 1
          ? {
              ...edge,
              market: { ...edge.market, venueId: 'mexc' },
              book: { ...edge.book, venueId: 'mexc' },
            }
          : edge,
      ),
    };
    const crossVenue = evaluateTriangularPath(mixedPath, new Decimal(1000), settings, now);
    expect(crossVenue.valid).toBe(false);
    expect(crossVenue.rejectionReasons).toContain('venue_mismatch');

    const invalidSettings = { ...settings, minNetProfitBps: new Decimal(-1) };
    const invalidThreshold = evaluateTriangularPath(path, new Decimal(1000), invalidSettings, now);
    expect(invalidThreshold.valid).toBe(false);
    expect(invalidThreshold.rejectionReasons).toContain('invalid_request');
  });

  it('enumerates and evaluates a four-leg intra-venue cycle', () => {
    const edges: TriangularEdge[] = [
      { market: market('AAA', 'USDT'), book: book('gateio', 'AAA/USDT', '1.00', '0.99') },
      { market: market('BBB', 'AAA'), book: book('gateio', 'BBB/AAA', '1.00', '0.99') },
      { market: market('CCC', 'BBB'), book: book('gateio', 'CCC/BBB', '1.00', '0.99') },
      { market: market('CCC', 'USDT'), book: book('gateio', 'CCC/USDT', '1.60', '1.55') },
    ];
    const paths = enumerateCyclicPaths(edges, {
      startCurrency: 'USDT',
      maxHops: 5,
      maxLegsPerCurrency: 4,
      maxPaths: 20,
    });
    const target = paths.find((path) => path.currencies.join('>') === 'USDT>AAA>BBB>CCC>USDT');
    expect(target).toBeDefined();
    const result = evaluateTriangularPath(target!, new Decimal(100), settings, now);
    expect({ valid: result.valid, reasons: result.rejectionReasons }).toEqual({
      valid: true,
      reasons: [],
    });

    const tooLong = {
      currencies: ['USDT', 'A', 'B', 'C', 'D', 'E', 'USDT'],
      edges: Array.from({ length: 6 }, () => edges[0]!),
    };
    const rejected = evaluateTriangularPath(tooLong, new Decimal(100), settings, now);
    expect(rejected.valid).toBe(false);
    expect(rejected.rejectionReasons).toContain('quote_mismatch');
  });
});

describe('S3 CEX-DEX cost model', () => {
  it('applies transfer tax to the full quoted direction and reports a profitable trade', () => {
    const result = evaluateS3({
      direction: 'cex-buy-dex-sell',
      base: 'CAKE',
      quote: 'USDT',
      cexMarket: market('CAKE', 'USDT'),
      cexBook: book('gateio', 'CAKE/USDT', '2.5', '2.49'),
      dexQuote: quote(),
      quoteTokenContractAddress: USDT_TOKEN,
      requestedNotional: new Decimal('30'),
      token: {
        ...eligibleToken,
        transferTaxBps: new Decimal('100'),
      },
      settings,
      now,
      inventoryMode: true,
    });
    expect({ valid: result.valid, reasons: result.rejectionReasons }).toEqual({
      valid: true,
      reasons: [],
    });
    expect(result.metadata?.gasCostUsd).toBe('0.125');
    expect(result.conservativeNetProfit.gt(0)).toBe(true);
    expect(result.fillQuality).toMatchObject({
      strategy: 'S3',
      cex: { venueId: 'gateio', side: 'buy' },
      dex: { providerId: '0x', sellToken: CAKE_TOKEN, buyToken: USDT_TOKEN },
    });
  });

  it('enforces transfer direction, withdrawal fee and deposit availability', () => {
    const transferToken = {
      ...eligibleToken,
      transferRequired: true,
      withdrawFee: new Decimal('0.1'),
      minWithdrawAmount: new Decimal('1'),
      minDepositAmount: new Decimal('1'),
      canArriveQuickly: true,
      estimatedArrivalMs: 60_000,
    };
    const base = {
      direction: 'cex-buy-dex-sell' as const,
      base: 'CAKE',
      quote: 'USDT',
      cexMarket: market('CAKE', 'USDT'),
      cexBook: book('gateio', 'CAKE/USDT', '2.5', '2.49'),
      quoteTokenContractAddress: USDT_TOKEN,
      requestedNotional: new Decimal('30'),
      settings,
      now,
      inventoryMode: false,
      maxTransferArrivalMs: 60_000,
    };
    const valid = evaluateS3({ ...base, dexQuote: quote(), token: transferToken });
    expect(valid.valid).toBe(true);

    const tokenWithoutWithdrawFee: TokenEligibility = { ...transferToken };
    delete tokenWithoutWithdrawFee.withdrawFee;
    const missingFee = evaluateS3({
      ...base,
      dexQuote: quote(),
      token: tokenWithoutWithdrawFee,
    });
    expect(missingFee.rejectionReasons).toContain('withdrawal_fee_unavailable');

    const withdrawDisabled = evaluateS3({
      ...base,
      dexQuote: quote(),
      token: { ...transferToken, withdrawEnabled: false },
    });
    expect(withdrawDisabled.rejectionReasons).toContain('transfer_disabled');

    const depositDisabled = evaluateS3({
      ...base,
      direction: 'dex-buy-cex-sell',
      cexBook: book('gateio', 'CAKE/USDT', '3.02', '3'),
      dexQuote: quote({
        sellToken: USDT_TOKEN,
        buyToken: CAKE_TOKEN,
        sellAmount: new Decimal('30'),
        buyAmount: new Decimal('12'),
      }),
      token: { ...transferToken, depositEnabled: false },
    });
    expect(depositDisabled.rejectionReasons).toContain('transfer_disabled');

    const wrongDirection = evaluateS3({
      ...base,
      dexQuote: quote({ sellToken: USDT_TOKEN, buyToken: CAKE_TOKEN }),
      token: transferToken,
    });
    expect(wrongDirection.rejectionReasons).toContain('quote_mismatch');

    const belowWithdrawMinimum = evaluateS3({
      ...base,
      dexQuote: quote(),
      token: { ...transferToken, minWithdrawAmount: new Decimal('20') },
    });
    expect(belowWithdrawMinimum.rejectionReasons).toContain('below_min_notional');
  });

  it('fails closed when transfer arrival exceeds the opportunity window', () => {
    const transferToken = {
      ...eligibleToken,
      transferRequired: true,
      withdrawFee: new Decimal('0.1'),
      minWithdrawAmount: new Decimal('1'),
      minDepositAmount: new Decimal('1'),
      canArriveQuickly: true,
      estimatedArrivalMs: 60_001,
    };
    const base = {
      direction: 'cex-buy-dex-sell' as const,
      base: 'CAKE',
      quote: 'USDT',
      cexMarket: market('CAKE', 'USDT'),
      cexBook: book('gateio', 'CAKE/USDT', '2.5', '2.49'),
      dexQuote: quote(),
      quoteTokenContractAddress: USDT_TOKEN,
      requestedNotional: new Decimal('30'),
      token: transferToken,
      settings,
      now,
      inventoryMode: false,
      maxTransferArrivalMs: 60_000,
    };

    const slow = evaluateS3(base);
    expect(slow.valid).toBe(false);
    expect(slow.rejectionReasons).toContain('opportunity_expired');

    const notQuick = evaluateS3({
      ...base,
      token: { ...transferToken, canArriveQuickly: false, estimatedArrivalMs: 1 },
    });
    expect(notQuick.valid).toBe(false);
    expect(notQuick.rejectionReasons).toContain('transfer_disabled');
  });

  it('enforces the minimum deposit on DEX-buy inventory and CEX tick precision', () => {
    const dexBuy = evaluateS3({
      direction: 'dex-buy-cex-sell',
      base: 'CAKE',
      quote: 'USDT',
      cexMarket: market('CAKE', 'USDT'),
      cexBook: book('gateio', 'CAKE/USDT', '3.02', '3'),
      dexQuote: quote({
        sellToken: USDT_TOKEN,
        buyToken: CAKE_TOKEN,
        sellAmount: new Decimal('30'),
        buyAmount: new Decimal('12'),
      }),
      quoteTokenContractAddress: USDT_TOKEN,
      requestedNotional: new Decimal('30'),
      token: {
        ...eligibleToken,
        transferRequired: true,
        depositEnabled: true,
        minDepositAmount: new Decimal('20'),
        canArriveQuickly: true,
        estimatedArrivalMs: 1_000,
      },
      settings,
      now,
      inventoryMode: false,
      maxTransferArrivalMs: 60_000,
    });
    expect(dexBuy.valid).toBe(false);
    expect(dexBuy.rejectionReasons).toContain('below_min_notional');

    const noPriceStepMarket = market('CAKE', 'USDT');
    delete noPriceStepMarket.priceStep;
    const noPriceStep = evaluateS3({
      direction: 'cex-buy-dex-sell',
      base: 'CAKE',
      quote: 'USDT',
      cexMarket: noPriceStepMarket,
      cexBook: book('gateio', 'CAKE/USDT', '2.5', '2.49'),
      dexQuote: quote(),
      quoteTokenContractAddress: USDT_TOKEN,
      requestedNotional: new Decimal('30'),
      token: eligibleToken,
      settings,
      now,
      inventoryMode: true,
    });
    expect(noPriceStep.valid).toBe(false);
    expect(noPriceStep.rejectionReasons).toContain('price_precision_invalid');

    const offGrid = evaluateS3({
      direction: 'cex-buy-dex-sell',
      base: 'CAKE',
      quote: 'USDT',
      cexMarket: market('CAKE', 'USDT'),
      cexBook: book('gateio', 'CAKE/USDT', '2.5000005', '2.49'),
      dexQuote: quote(),
      quoteTokenContractAddress: USDT_TOKEN,
      requestedNotional: new Decimal('30'),
      token: eligibleToken,
      settings,
      now,
      inventoryMode: true,
    });
    expect(offGrid.valid).toBe(false);
    expect(offGrid.rejectionReasons).toContain('price_precision_invalid');
  });

  it('rejects a high gas estimate before producing a trade', () => {
    const result = evaluateS3({
      direction: 'cex-buy-dex-sell',
      base: 'CAKE',
      quote: 'USDT',
      cexMarket: market('CAKE', 'USDT'),
      cexBook: book('gateio', 'CAKE/USDT', '2.5', '2.49'),
      dexQuote: quote({ gasCostUsd: new Decimal('0.75') }),
      quoteTokenContractAddress: USDT_TOKEN,
      requestedNotional: new Decimal('30'),
      token: eligibleToken,
      settings,
      now,
      inventoryMode: true,
    });
    expect(result.valid).toBe(false);
    expect(result.rejectionReasons).toContain('gas_too_high');
  });

  it('fails closed when price impact or liquidity metrics are unavailable', () => {
    const base = {
      direction: 'cex-buy-dex-sell' as const,
      base: 'CAKE',
      quote: 'USDT',
      cexMarket: market('CAKE', 'USDT'),
      cexBook: book('gateio', 'CAKE/USDT', '2.5', '2.49'),
      quoteTokenContractAddress: USDT_TOKEN,
      requestedNotional: new Decimal('30'),
      token: eligibleToken,
      settings,
      now,
      inventoryMode: true,
    };
    const unknownImpact = evaluateS3({
      ...base,
      dexQuote: quote({ priceImpactBps: new Decimal(Number.NaN) }),
    });
    expect(unknownImpact.valid).toBe(false);
    expect(unknownImpact.rejectionReasons).toContain('price_impact_unavailable');

    const missingLiquidity = evaluateS3({
      ...base,
      dexQuote: quote(),
      token: {
        mappingStatus: eligibleToken.mappingStatus,
        riskLevel: eligibleToken.riskLevel,
        verifiedContract: eligibleToken.verifiedContract,
        contractAddress: eligibleToken.contractAddress,
        transferTaxBps: eligibleToken.transferTaxBps,
        transferRequired: eligibleToken.transferRequired,
        withdrawEnabled: eligibleToken.withdrawEnabled,
        depositEnabled: eligibleToken.depositEnabled,
      },
    });
    expect(missingLiquidity.valid).toBe(false);
    expect(missingLiquidity.rejectionReasons).toEqual(
      expect.arrayContaining(['liquidity_data_unavailable', 'volume_data_unavailable']),
    );
  });

  it('deducts DEX price impact from the DEX-buy output', () => {
    const input = {
      direction: 'dex-buy-cex-sell' as const,
      base: 'CAKE',
      quote: 'USDT',
      cexMarket: market('CAKE', 'USDT'),
      cexBook: book('gateio', 'CAKE/USDT', '3.02', '3'),
      quoteTokenContractAddress: USDT_TOKEN,
      requestedNotional: new Decimal('30'),
      token: eligibleToken,
      settings: { ...settings, maxSlippageBps: new Decimal(200) },
      now,
      inventoryMode: true,
    };
    const noImpact = evaluateS3({
      ...input,
      dexQuote: quote({
        sellToken: USDT_TOKEN,
        buyToken: CAKE_TOKEN,
        sellAmount: new Decimal('30'),
        buyAmount: new Decimal('12'),
        feeBps: new Decimal(0),
        priceImpactBps: new Decimal(0),
      }),
    });
    const withImpact = evaluateS3({
      ...input,
      dexQuote: quote({
        sellToken: USDT_TOKEN,
        buyToken: CAKE_TOKEN,
        sellAmount: new Decimal('30'),
        buyAmount: new Decimal('12'),
        feeBps: new Decimal(0),
        priceImpactBps: new Decimal(100),
      }),
    });
    expect(noImpact.valid).toBe(true);
    expect(withImpact.valid).toBe(true);
    expect(noImpact.conservativeNetProfit.gt(withImpact.conservativeNetProfit)).toBe(true);
    expect(noImpact.conservativeNetProfit.minus(withImpact.conservativeNetProfit).gt('0.3')).toBe(
      true,
    );
  });

  it('fails closed on non-finite risk inputs and inactive markets', () => {
    const base = {
      direction: 'cex-buy-dex-sell' as const,
      base: 'CAKE',
      quote: 'USDT',
      cexMarket: market('CAKE', 'USDT'),
      cexBook: book('gateio', 'CAKE/USDT', '2.5', '2.49'),
      quoteTokenContractAddress: USDT_TOKEN,
      requestedNotional: new Decimal('30'),
      token: eligibleToken,
      settings,
      now,
      inventoryMode: true,
    };
    const badLiquidity = evaluateS3({
      ...base,
      dexQuote: quote(),
      token: { ...eligibleToken, liquidityUsd: new Decimal(Number.NaN) },
    });
    expect(badLiquidity.rejectionReasons).toContain('liquidity_data_unavailable');

    const badVolume = evaluateS3({
      ...base,
      dexQuote: quote(),
      token: { ...eligibleToken, volume24hUsd: new Decimal(Number.POSITIVE_INFINITY) },
    });
    expect(badVolume.rejectionReasons).toContain('volume_data_unavailable');

    const badTax = evaluateS3({
      ...base,
      dexQuote: quote(),
      token: { ...eligibleToken, transferTaxBps: new Decimal(Number.NaN) },
    });
    expect(badTax.rejectionReasons).toContain('transfer_tax_too_high');

    const badGas = evaluateS3({
      ...base,
      dexQuote: quote({ gasCostUsd: new Decimal(Number.NaN) }),
    });
    expect(badGas.rejectionReasons).toContain('gas_estimate_missing');

    const staleTimestamp = evaluateS3({
      ...base,
      dexQuote: quote({ quotedAt: Number.NaN }),
    });
    expect(staleTimestamp.rejectionReasons).toContain('quote_not_fresh');

    const inactive = evaluateS3({
      ...base,
      cexMarket: { ...market('CAKE', 'USDT'), active: false },
      dexQuote: quote(),
    });
    expect(inactive.rejectionReasons).toContain('market_inactive');

    const invalidThreshold = evaluateS3({
      ...base,
      dexQuote: quote(),
      settings: { ...settings, minNetProfitBps: new Decimal(-1) },
    });
    expect(invalidThreshold.rejectionReasons).toContain('invalid_request');
  });
});

describe('S4 DEX-DEX cost model', () => {
  it('requires two independent quote directions and deducts both gas legs', () => {
    const result = evaluateS4({
      base: 'CAKE',
      quote: 'USDT',
      baseTokenContractAddress: CAKE_TOKEN,
      quoteTokenContractAddress: USDT_TOKEN,
      buyQuote: quote({
        providerId: '0x',
        sellToken: USDT_TOKEN,
        buyToken: CAKE_TOKEN,
        sellAmount: new Decimal('30'),
        buyAmount: new Decimal('12'),
        gasCostUsd: new Decimal('0.05'),
        feeBps: new Decimal(0),
      }),
      sellQuote: quote({
        providerId: '1inch',
        sellToken: CAKE_TOKEN,
        buyToken: USDT_TOKEN,
        sellAmount: new Decimal('12'),
        buyAmount: new Decimal('31'),
        gasCostUsd: new Decimal('0.05'),
        feeBps: new Decimal(0),
      }),
      tokenRisk: 'low',
      verifiedContract: true,
      transferTaxBps: new Decimal(0),
      requestedNotional: new Decimal('30'),
      settings,
      now,
    });
    expect({ valid: result.valid, reasons: result.rejectionReasons }).toEqual({
      valid: true,
      reasons: [],
    });
    expect(result.metadata?.gasCostUsd).toBe('0.125');
    expect(result.fillQuality).toMatchObject({
      strategy: 'S4',
      buyLeg: { providerId: '0x', sellToken: USDT_TOKEN, buyToken: CAKE_TOKEN },
      sellLeg: { providerId: '1inch', sellToken: CAKE_TOKEN, buyToken: USDT_TOKEN },
    });
  });

  it('rejects the same provider and unknown price impact', () => {
    const input = {
      base: 'CAKE',
      quote: 'USDT',
      baseTokenContractAddress: CAKE_TOKEN,
      quoteTokenContractAddress: USDT_TOKEN,
      buyQuote: quote({
        providerId: '0x',
        sellToken: USDT_TOKEN,
        buyToken: CAKE_TOKEN,
        sellAmount: new Decimal('30'),
        buyAmount: new Decimal('12'),
        feeBps: new Decimal(0),
      }),
      sellQuote: quote({
        providerId: '0x',
        sellToken: CAKE_TOKEN,
        buyToken: USDT_TOKEN,
        sellAmount: new Decimal('12'),
        buyAmount: new Decimal('31'),
        feeBps: new Decimal(0),
      }),
      tokenRisk: 'low' as const,
      verifiedContract: true,
      transferTaxBps: new Decimal(0),
      requestedNotional: new Decimal('30'),
      settings,
      now,
    };
    const sameProvider = evaluateS4(input);
    expect(sameProvider.valid).toBe(false);
    expect(sameProvider.rejectionReasons).toContain('provider_not_independent');

    const unknownImpact = evaluateS4({
      ...input,
      buyQuote: { ...input.buyQuote, providerId: '1inch', priceImpactBps: new Decimal(Number.NaN) },
      sellQuote: { ...input.sellQuote, providerId: '0x' },
    });
    expect(unknownImpact.valid).toBe(false);
    expect(unknownImpact.rejectionReasons).toContain('price_impact_unavailable');

    const wrongContract = evaluateS4({
      ...input,
      sellQuote: { ...input.sellQuote, buyToken: CAKE_TOKEN },
    });
    expect(wrongContract.valid).toBe(false);
    expect(wrongContract.rejectionReasons).toContain('quote_mismatch');

    const wrongBuyAmount = evaluateS4({
      ...input,
      buyQuote: { ...input.buyQuote, sellAmount: new Decimal('29') },
    });
    expect(wrongBuyAmount.valid).toBe(false);
    expect(wrongBuyAmount.rejectionReasons).toContain('quote_mismatch');
  });

  it('fails closed when gas or transfer-tax inputs are non-finite', () => {
    const base = {
      base: 'CAKE',
      quote: 'USDT',
      baseTokenContractAddress: CAKE_TOKEN,
      quoteTokenContractAddress: USDT_TOKEN,
      buyQuote: quote({
        providerId: '0x',
        sellToken: USDT_TOKEN,
        buyToken: CAKE_TOKEN,
        sellAmount: new Decimal('30'),
        buyAmount: new Decimal('12'),
        gasCostUsd: new Decimal('0.05'),
        feeBps: new Decimal(0),
      }),
      sellQuote: quote({
        providerId: '1inch',
        sellToken: CAKE_TOKEN,
        buyToken: USDT_TOKEN,
        sellAmount: new Decimal('12'),
        buyAmount: new Decimal('31'),
        gasCostUsd: new Decimal('0.05'),
        feeBps: new Decimal(0),
      }),
      tokenRisk: 'low' as const,
      verifiedContract: true,
      transferTaxBps: new Decimal(0),
      requestedNotional: new Decimal('30'),
      settings,
      now,
    };

    for (const gasCostUsd of [
      new Decimal(Number.NaN),
      new Decimal(Number.POSITIVE_INFINITY),
      new Decimal('-0.1'),
    ]) {
      const result = evaluateS4({
        ...base,
        buyQuote: { ...base.buyQuote, gasCostUsd },
      });
      expect(result.valid).toBe(false);
      expect(result.rejectionReasons).toContain('gas_estimate_missing');
    }

    const badTax = evaluateS4({ ...base, transferTaxBps: new Decimal(Number.NaN) });
    expect(badTax.valid).toBe(false);
    expect(badTax.rejectionReasons).toContain('transfer_tax_too_high');

    const badNotional = evaluateS4({
      ...base,
      requestedNotional: new Decimal(Number.NaN),
    });
    expect(badNotional.valid).toBe(false);
    expect(badNotional.rejectionReasons).toContain('invalid_request');

    const invalidThreshold = evaluateS4({
      ...base,
      settings: { ...settings, minNetProfitBps: new Decimal(-1) },
    });
    expect(invalidThreshold.valid).toBe(false);
    expect(invalidThreshold.rejectionReasons).toContain('invalid_request');
  });
});
