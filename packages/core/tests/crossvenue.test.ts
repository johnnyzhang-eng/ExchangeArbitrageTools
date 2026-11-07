import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import {
  buildCrossVenueGraph,
  enumerateCrossVenuePaths,
  evaluateCrossVenuePath,
  simulateCrossVenuePath,
  type CostSettings,
  type CrossVenuePath,
  type MarketMetadata,
  type OrderBookSnapshot,
} from '../src/index.js';

const now = 1_700_000_000_000;
const settings: CostSettings = {
  minProfitUsd: new Decimal('0.25'),
  safetyBufferBps: new Decimal(15),
  minNetProfitBps: new Decimal(20),
  maxOrderbookAgeMs: 3000,
  maxSlippageBps: new Decimal(50),
  maxGasCostUsd: new Decimal('0.50'),
  maxTransferTaxBps: new Decimal(0),
};
const health = { gateio: 'A', mecx: 'A', weex: 'A' } as const;

function market(venueId: string, base: string, quote: string, fee = '10'): MarketMetadata {
  return {
    venueId,
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

function book(
  venueId: string,
  base: string,
  quote: string,
  ask: string,
  bid: string,
): OrderBookSnapshot {
  return {
    venueId,
    exchangeSymbol: `${base}/${quote}`,
    fetchedAt: now,
    asks: [{ price: new Decimal(ask), amount: new Decimal('100000') }],
    bids: [{ price: new Decimal(bid), amount: new Decimal('100000') }],
    source: 'replay',
  };
}

function twoVenueGraph(withDestinationInventory: boolean) {
  const gateioMarket = market('gateio', 'CAKE', 'USDT');
  const mecxMarket = market('mecx', 'CAKE', 'USDT');
  return buildCrossVenueGraph({
    markets: [
      {
        venueId: 'gateio',
        market: gateioMarket,
        book: book('gateio', 'CAKE', 'USDT', '2.500', '2.490'),
      },
      { venueId: 'mecx', market: mecxMarket, book: book('mecx', 'CAKE', 'USDT', '2.560', '2.550') },
    ],
    balances: [
      { venueId: 'gateio', currency: 'USDT', free: new Decimal('1000') },
      ...(withDestinationInventory
        ? [{ venueId: 'mecx', currency: 'CAKE', free: new Decimal('100') }]
        : []),
    ],
  });
}

const startAvailability = new Map([['gateio', new Decimal('1000')]]);

function roundedCrossVenuePath(minimum = '1') {
  const graph = buildCrossVenueGraph({
    markets: [
      {
        venueId: 'gateio',
        market: {
          ...market('gateio', 'AAA', 'USDT', '0'),
          amountStep: new Decimal(1),
          minNotional: new Decimal(minimum),
        },
        book: book('gateio', 'AAA', 'USDT', '6', '5.9'),
      },
      {
        venueId: 'mecx',
        market: market('mecx', 'AAA', 'USDT', '0'),
        book: book('mecx', 'AAA', 'USDT', '13.1', '13'),
      },
    ],
    balances: [
      { venueId: 'gateio', currency: 'USDT', free: new Decimal(10) },
      { venueId: 'mecx', currency: 'AAA', free: new Decimal(100) },
    ],
  });
  return enumerateCrossVenuePaths(graph, { startCurrency: 'USDT' }).find(
    (candidate) =>
      candidate.nodes.map((node) => node.venueId).join('>') === 'gateio>gateio>mecx>mecx',
  )!;
}

describe('cross-venue inventory discovery', () => {
  it.each([
    ['3', false],
    ['5', true],
  ])('preserves exact-minimum budget fills at ask=%s without amount reduction', (ask, hasStep) => {
    const path = roundedCrossVenuePath('10');
    const firstLeg = path.legs[0]!;
    if (firstLeg.kind !== 'trade') throw new Error('expected buy leg');
    if (!hasStep) delete firstLeg.market.amountStep;
    firstLeg.book.asks[0]!.price = new Decimal(ask);
    firstLeg.book.bids[0]!.price = new Decimal(ask).minus('0.1');
    const result = evaluateCrossVenuePath(path, new Decimal(10), settings, now, health);
    expect(result.valid).toBe(true);
    expect((result.fillQuality!.legs as unknown[])[0]).toMatchObject({
      inputAmount: '10',
      unspentInputAmount: '0',
    });
  });

  it('retains intermediate quote dust without adding it to starting cash or the next trade', () => {
    const path = roundedCrossVenuePath();
    const from = path.nodes[2]!;
    const intermediate = { venueId: 'mecx', currency: 'BBB' };
    const to = path.nodes[3]!;
    path.nodes.splice(3, 0, intermediate);
    path.legs.splice(
      2,
      1,
      {
        kind: 'trade',
        from,
        to: intermediate,
        side: 'buy',
        rate: new Decimal(4),
        market: {
          ...market('mecx', 'BBB', 'AAA', '0'),
          amountStep: new Decimal(3),
          minNotional: new Decimal('0.1'),
        },
        book: book('mecx', 'BBB', 'AAA', '0.25', '0.24'),
      },
      {
        kind: 'trade',
        from: intermediate,
        to,
        side: 'sell',
        rate: new Decimal('6.5'),
        market: market('mecx', 'BBB', 'USDT', '0'),
        book: book('mecx', 'BBB', 'USDT', '6.6', '6.5'),
      },
    );
    const simulation = simulateCrossVenuePath(path, new Decimal(10), settings, now, true);
    expect(simulation.reasons).toEqual([]);
    expect(simulation.fills[2]!.inputAmount.toFixed()).toBe('0.75');
    expect(simulation.fills[2]!.unspentInputAmount!.toFixed()).toBe('0.25');
    expect(simulation.fills[3]!.inputAmount.toFixed()).toBe('3');
    expect(simulation.outputAmount.toFixed()).toBe('23.5');
  });

  it.each([
    ['100', '100000', 'amount_precision_invalid', 0],
    ['1', '1', 'insufficient_depth', 3],
  ] as const)('handles step=%s and available base=%s', (step, available, reason, fillCount) => {
    const path = roundedCrossVenuePath();
    const firstLeg = path.legs[0]!;
    if (firstLeg.kind !== 'trade') throw new Error('expected buy leg');
    firstLeg.market.amountStep = new Decimal(step);
    firstLeg.book.asks[0]!.amount = new Decimal(available);
    const simulation = simulateCrossVenuePath(path, new Decimal(10), settings, now, true);
    expect(simulation.reasons).toContain(reason);
    expect(simulation.fills).toHaveLength(fillCount);
  });

  it.each([
    ['10', false],
    ['6', true],
    ['5', true],
  ])('checks the rounded buy against minNotional=%s', (minimum, valid) => {
    const path = roundedCrossVenuePath(minimum);
    const result = evaluateCrossVenuePath(path, new Decimal(10), settings, now, health);
    expect(result.valid).toBe(valid);
    expect(result.rejectionReasons.includes('below_min_notional')).toBe(!valid);
    expect((result.fillQuality!.legs as unknown[])[0]).toMatchObject({
      inputAmount: '6',
      outputAmount: '1',
      unspentInputAmount: '4',
    });
    const simulation = simulateCrossVenuePath(path, new Decimal(10), settings, now, true);
    expect(simulation.outputAmount.toFixed()).toBe('17');
    expect(result.depthNetProfit.toFixed()).toBe('7');
  });

  it.each([
    ['1', '4', '4', 1, '6'],
    ['0.5', '6', '8', 2, '4'],
  ])(
    'reprices rounded multi-level buys with first-level amount=%s',
    (firstLevelAmount, cost, worstPrice, levelsConsumed, remainder) => {
      const graph = twoVenueGraph(true);
      const path = enumerateCrossVenuePaths(graph, { startCurrency: 'USDT' }).find(
        (candidate) =>
          candidate.nodes.map((node) => node.venueId).join('>') === 'gateio>gateio>mecx>mecx',
      )!;
      const firstLeg = path.legs[0]!;
      if (firstLeg.kind !== 'trade') throw new Error('expected buy leg');
      firstLeg.market.amountStep = new Decimal(1);
      firstLeg.market.feeTakerBps = new Decimal(100);
      firstLeg.book.bids[0]!.price = new Decimal('3.9');
      firstLeg.book.asks = [
        { price: new Decimal(4), amount: new Decimal(firstLevelAmount) },
        { price: new Decimal(8), amount: new Decimal(10) },
      ];
      const inventoryLeg = path.legs[1]!;
      if (inventoryLeg.kind !== 'inventory') throw new Error('expected inventory leg');
      inventoryLeg.available = new Decimal('0.99');
      const simulation = simulateCrossVenuePath(path, new Decimal(10), settings, now, true);
      const first = simulation.fills[0]!;
      expect(first.inputAmount.toFixed()).toBe(cost);
      expect(first.averagePrice!.toFixed()).toBe(cost);
      expect(first.worstPrice!.toFixed()).toBe(worstPrice);
      expect(first.levelsConsumed).toBe(levelsConsumed);
      expect(first.fee.toFixed()).toBe('0.01');
      expect(first.outputAmount.toFixed()).toBe('0.99');
      expect(simulation.reasons).not.toContain('insufficient_inventory');
      expect(simulation.fills[1]!.inputAmount.toFixed()).toBe('0.99');
      expect(simulation.outputAmount.minus(simulation.fills.at(-1)!.outputAmount).toFixed()).toBe(
        remainder,
      );
      expect(first.inputAmount.plus(remainder).toFixed()).toBe('10');
    },
  );

  it('finds and validates a two-venue inventory path', () => {
    const graph = twoVenueGraph(true);
    const paths = enumerateCrossVenuePaths(graph, {
      startCurrency: 'USDT',
      startVenues: ['gateio'],
      startAvailableByVenue: startAvailability,
      maxHops: 5,
      maxVenueSwitches: 1,
      maxLegsPerNode: 4,
      maxPaths: 50,
    });
    expect(paths.length).toBeGreaterThan(0);
    const target = paths.find(
      (path) =>
        path.nodes.map((node) => node.venueId).join('>') === 'gateio>gateio>mecx>mecx' &&
        path.nodes.map((node) => node.currency).join('>') === 'USDT>CAKE>CAKE>USDT',
    );
    expect(target).toBeDefined();
    const result = evaluateCrossVenuePath(target!, new Decimal(30), settings, now, health);
    expect({ valid: result.valid, reasons: result.rejectionReasons }).toEqual({
      valid: true,
      reasons: [],
    });
    expect(result.conservativeNetProfit.gt(0)).toBe(true);
    expect(result.metadata?.variant).toBe('cross_venue_inventory');
    expect(result.metadata?.venueSwitches).toBe('1');
    expect(result.metadata?.pathClass).toBe('two_venue_bridge');
    for (const path of paths) {
      const marketKeys = path.legs
        .filter((leg) => leg.kind === 'trade')
        .map((leg) => `${leg.market.venueId}|${leg.market.exchangeSymbol}`);
      expect(new Set(marketKeys).size).toBe(marketKeys.length);
      expect(path.legs.some((leg) => leg.kind === 'inventory')).toBe(true);
    }
  });

  it('does not invent a path without destination inventory', () => {
    const graph = twoVenueGraph(false);
    const paths = enumerateCrossVenuePaths(graph, {
      startCurrency: 'USDT',
      startVenues: ['gateio'],
      startAvailableByVenue: startAvailability,
      maxHops: 5,
      maxVenueSwitches: 1,
      maxPaths: 50,
    });
    expect(paths).toEqual([]);
  });

  it('rejects a path whose destination inventory is too small', () => {
    const gateioMarket = market('gateio', 'CAKE', 'USDT');
    const mecxMarket = market('mecx', 'CAKE', 'USDT');
    const path: CrossVenuePath = {
      nodes: [
        { venueId: 'gateio', currency: 'USDT' },
        { venueId: 'gateio', currency: 'CAKE' },
        { venueId: 'mecx', currency: 'CAKE' },
        { venueId: 'mecx', currency: 'USDT' },
      ],
      legs: [
        {
          kind: 'trade',
          from: { venueId: 'gateio', currency: 'USDT' },
          to: { venueId: 'gateio', currency: 'CAKE' },
          market: gateioMarket,
          book: book('gateio', 'CAKE', 'USDT', '2.500', '2.490'),
          side: 'buy',
          rate: new Decimal('0.4'),
        },
        {
          kind: 'inventory',
          from: { venueId: 'gateio', currency: 'CAKE' },
          to: { venueId: 'mecx', currency: 'CAKE' },
          available: new Decimal('1'),
        },
        {
          kind: 'trade',
          from: { venueId: 'mecx', currency: 'CAKE' },
          to: { venueId: 'mecx', currency: 'USDT' },
          market: mecxMarket,
          book: book('mecx', 'CAKE', 'USDT', '2.560', '2.550'),
          side: 'sell',
          rate: new Decimal('2.55'),
        },
      ],
      estimatedReturn: new Decimal('0.01'),
      venueSwitches: 1,
      startAvailable: new Decimal('1000'),
    };
    const result = evaluateCrossVenuePath(path, new Decimal(30), settings, now, health);
    expect(result.valid).toBe(false);
    expect(result.rejectionReasons).toContain('insufficient_inventory');
  });

  it('honours the venue-switch limit and requires a funded start venue', () => {
    const graph = twoVenueGraph(true);
    const noSwitch = enumerateCrossVenuePaths(graph, {
      startCurrency: 'USDT',
      startVenues: ['gateio'],
      startAvailableByVenue: startAvailability,
      maxHops: 5,
      maxVenueSwitches: 0,
      maxPaths: 50,
    });
    expect(noSwitch).toEqual([]);

    const unfunded = enumerateCrossVenuePaths(graph, {
      startCurrency: 'USDT',
      startVenues: ['mecx'],
      startAvailableByVenue: new Map([['mecx', new Decimal('0')]]),
      maxHops: 5,
      maxVenueSwitches: 1,
      maxPaths: 50,
    });
    expect(unfunded).toEqual([]);
  });

  it('does not emit single-venue triangular loops as cross-venue paths', () => {
    const cakeUsdt = market('gateio', 'CAKE', 'USDT');
    const bnbUsdt = market('gateio', 'BNB', 'USDT');
    const cakeBnb = market('gateio', 'CAKE', 'BNB');
    const graph = buildCrossVenueGraph({
      markets: [
        {
          venueId: 'gateio',
          market: cakeUsdt,
          book: book('gateio', 'CAKE', 'USDT', '3001', '3000'),
        },
        { venueId: 'gateio', market: bnbUsdt, book: book('gateio', 'BNB', 'USDT', '500', '499') },
        { venueId: 'gateio', market: cakeBnb, book: book('gateio', 'CAKE', 'BNB', '5', '4.9') },
      ],
      balances: [{ venueId: 'gateio', currency: 'USDT', free: new Decimal('1000') }],
    });
    const paths = enumerateCrossVenuePaths(graph, {
      startCurrency: 'USDT',
      startVenues: ['gateio'],
      startAvailableByVenue: startAvailability,
      maxHops: 5,
      maxVenueSwitches: 2,
      maxPaths: 50,
    });
    expect(paths).toEqual([]);
  });

  it('enumerates a three-venue, two-switch inventory chain', () => {
    const graph = buildCrossVenueGraph({
      markets: [
        {
          venueId: 'gateio',
          market: market('gateio', 'CAKE', 'USDT'),
          book: book('gateio', 'CAKE', 'USDT', '2.500', '2.490'),
        },
        {
          venueId: 'mecx',
          market: market('mecx', 'CAKE', 'BNB'),
          book: book('mecx', 'CAKE', 'BNB', '0.100', '0.099'),
        },
        {
          venueId: 'weex',
          market: market('weex', 'BNB', 'USDT'),
          book: book('weex', 'BNB', 'USDT', '500', '499'),
        },
      ],
      balances: [
        { venueId: 'gateio', currency: 'USDT', free: new Decimal('1000') },
        { venueId: 'mecx', currency: 'CAKE', free: new Decimal('100') },
        { venueId: 'weex', currency: 'BNB', free: new Decimal('100') },
      ],
    });
    const paths = enumerateCrossVenuePaths(graph, {
      startCurrency: 'USDT',
      startVenues: ['gateio'],
      startAvailableByVenue: startAvailability,
      maxHops: 5,
      maxVenueSwitches: 2,
      maxLegsPerNode: 4,
      maxPaths: 50,
    });
    const chain = paths.find(
      (path) =>
        path.venueSwitches === 2 &&
        path.nodes.map((node) => node.currency).join('>') === 'USDT>CAKE>CAKE>BNB>BNB>USDT',
    );
    expect(chain).toBeDefined();
    const result = evaluateCrossVenuePath(chain!, new Decimal(30), settings, now, health);
    expect(result.valid).toBe(true);
    expect(result.conservativeNetProfit.gt(0)).toBe(true);
    expect(result.metadata?.tradeVenues).toBe('gateio>mecx>weex');
    expect(result.metadata?.pathClass).toBe('multi_hop');
  });

  it('rejects malformed paths that reuse a market or lack a venue switch', () => {
    const gateioMarket = market('gateio', 'CAKE', 'USDT');
    const trade = {
      kind: 'trade' as const,
      from: { venueId: 'gateio', currency: 'USDT' },
      to: { venueId: 'gateio', currency: 'CAKE' },
      market: gateioMarket,
      book: book('gateio', 'CAKE', 'USDT', '2.500', '2.490'),
      side: 'buy' as const,
      rate: new Decimal('0.4'),
    };
    const path: CrossVenuePath = {
      nodes: [
        { venueId: 'gateio', currency: 'USDT' },
        { venueId: 'gateio', currency: 'CAKE' },
        { venueId: 'gateio', currency: 'USDT' },
      ],
      legs: [trade, { ...trade, side: 'sell', from: trade.to, to: trade.from }],
      estimatedReturn: new Decimal('0.01'),
      venueSwitches: 0,
      startAvailable: new Decimal('1000'),
    };
    const simulation = simulateCrossVenuePath(path, new Decimal(30), settings, now, true);
    expect(simulation.reasons).toContain('quote_mismatch');
  });
});
