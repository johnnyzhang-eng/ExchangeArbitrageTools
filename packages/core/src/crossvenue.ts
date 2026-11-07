import {
  Decimal,
  ZERO,
  calculateNetProfitBps,
  calculateSafetyBuffer,
  minDecimal,
} from './money.js';
import {
  calculateBuyDepthByBase,
  calculateBuyDepthByQuote,
  calculateSellDepthByBase,
} from './depth.js';
import { alignAmountDown } from './precision.js';
import { validateOrderBook } from './orderbook.js';
import { searchOptimalNotional } from './optimal.js';
import type {
  CostSettings,
  HealthState,
  MarketMetadata,
  OpportunityResult,
  OrderBookSnapshot,
  RejectionReason,
} from './types.js';

export interface CrossVenueNode {
  venueId: string;
  currency: string;
}

export interface TradeLeg {
  kind: 'trade';
  from: CrossVenueNode;
  to: CrossVenueNode;
  market: MarketMetadata;
  book: OrderBookSnapshot;
  side: 'buy' | 'sell';
  rate: Decimal;
}

export interface InventoryLeg {
  kind: 'inventory';
  from: CrossVenueNode;
  to: CrossVenueNode;
  available: Decimal;
}

export type CrossVenueLeg = TradeLeg | InventoryLeg;

export interface CrossVenuePath {
  nodes: CrossVenueNode[];
  legs: CrossVenueLeg[];
  estimatedReturn: Decimal;
  venueSwitches: number;
  startAvailable: Decimal;
}

export interface CrossVenueGraphInput {
  markets: ReadonlyArray<{ venueId: string; market: MarketMetadata; book: OrderBookSnapshot }>;
  balances: ReadonlyArray<{ venueId: string; currency: string; free: Decimal }>;
}

export interface CrossVenuePathOptions {
  startCurrency: string;
  startVenues?: readonly string[];
  startAvailableByVenue?: ReadonlyMap<string, Decimal>;
  maxHops?: number;
  maxVenueSwitches?: number;
  maxLegsPerNode?: number;
  maxPaths?: number;
}

export interface CrossVenueFill {
  kind: 'trade' | 'inventory';
  fromVenue: string;
  fromCurrency: string;
  toVenue: string;
  toCurrency: string;
  inputAmount: Decimal;
  /** Quote currency retained at fromVenue after rounding a buy order. */
  unspentInputAmount?: Decimal;
  outputAmount: Decimal;
  fee: Decimal;
  symbol?: string;
  side?: 'buy' | 'sell';
  averagePrice?: Decimal;
  worstPrice?: Decimal;
  levelsConsumed?: number;
  available?: Decimal;
}

export interface CrossVenueSimulation {
  /** Terminal proceeds plus retained starting currency across venues, not terminal-venue availability. */
  outputAmount: Decimal;
  fills: CrossVenueFill[];
  reasons: RejectionReason[];
  dataAgeMs: number;
}

const MAX_HOPS = 5;
const UNBOUNDED = new Decimal(Number.POSITIVE_INFINITY);

function normalizeCurrency(currency: string): string {
  return currency.trim().toUpperCase();
}

function nodeKey(node: CrossVenueNode): string {
  return `${node.venueId}\u0000${normalizeCurrency(node.currency)}`;
}

function parseNodeKey(key: string): CrossVenueNode {
  const [venueId = '', currency = ''] = key.split('\u0000');
  return { venueId, currency };
}

function normalized(node: CrossVenueNode): CrossVenueNode {
  return { venueId: node.venueId, currency: normalizeCurrency(node.currency) };
}

function legSignature(leg: CrossVenueLeg): string {
  if (leg.kind === 'trade') {
    return `T:${leg.market.venueId}|${leg.market.exchangeSymbol}|${normalizeCurrency(leg.from.currency)}>${normalizeCurrency(leg.to.currency)}`;
  }
  return `I:${leg.from.venueId}>${leg.to.venueId}|${normalizeCurrency(leg.from.currency)}`;
}

export function buildCrossVenueGraph(input: CrossVenueGraphInput): Map<string, CrossVenueLeg[]> {
  const adjacency = new Map<string, CrossVenueLeg[]>();
  const add = (leg: CrossVenueLeg): void => {
    const key = nodeKey(leg.from);
    const list = adjacency.get(key) ?? [];
    list.push(leg);
    adjacency.set(key, list);
  };
  const venueIds = new Set<string>();
  const tradeCurrencies = new Set<string>();

  for (const { venueId, market, book } of input.markets) {
    if (!market.active) continue;
    if (market.venueId !== venueId) continue;
    venueIds.add(venueId);
    const feeBps = market.feeTakerBps ?? ZERO;
    const feeFactor = new Decimal(1).minus(feeBps.div(10_000));
    if (feeFactor.lte(0)) continue;
    const base = normalizeCurrency(market.base);
    const quote = normalizeCurrency(market.quote);
    if (!base || !quote || base === quote) continue;
    tradeCurrencies.add(base);
    tradeCurrencies.add(quote);
    const bid = book.bids[0]?.price;
    const ask = book.asks[0]?.price;
    if (bid && bid.gt(0)) {
      add({
        kind: 'trade',
        from: { venueId, currency: base },
        to: { venueId, currency: quote },
        market,
        book,
        side: 'sell',
        rate: bid.mul(feeFactor),
      });
    }
    if (ask && ask.gt(0)) {
      add({
        kind: 'trade',
        from: { venueId, currency: quote },
        to: { venueId, currency: base },
        market,
        book,
        side: 'buy',
        rate: new Decimal(1).div(ask).mul(feeFactor),
      });
    }
  }

  const balancesByCurrency = new Map<string, Map<string, Decimal>>();
  for (const balance of input.balances) {
    if (!balance.free.isFinite() || !balance.free.gt(0)) continue;
    const currency = normalizeCurrency(balance.currency);
    if (!tradeCurrencies.has(currency)) continue;
    if (!venueIds.has(balance.venueId)) continue;
    const byVenue = balancesByCurrency.get(currency) ?? new Map<string, Decimal>();
    byVenue.set(balance.venueId, (byVenue.get(balance.venueId) ?? ZERO).plus(balance.free));
    balancesByCurrency.set(currency, byVenue);
  }
  for (const [currency, byVenue] of balancesByCurrency) {
    for (const [targetVenue, free] of byVenue) {
      for (const sourceVenue of venueIds) {
        if (sourceVenue === targetVenue) continue;
        add({
          kind: 'inventory',
          from: { venueId: sourceVenue, currency },
          to: { venueId: targetVenue, currency },
          available: free,
        });
      }
    }
  }

  for (const list of adjacency.values()) {
    list.sort((left, right) => {
      const leftRate = left.kind === 'trade' ? left.rate : new Decimal(1);
      const rightRate = right.kind === 'trade' ? right.rate : new Decimal(1);
      return rightRate.comparedTo(leftRate);
    });
  }
  return adjacency;
}

export function enumerateCrossVenuePaths(
  adjacency: ReadonlyMap<string, CrossVenueLeg[]>,
  options: CrossVenuePathOptions,
): CrossVenuePath[] {
  const startCurrency = normalizeCurrency(options.startCurrency);
  const maxHops = Math.max(2, Math.min(options.maxHops ?? MAX_HOPS, MAX_HOPS));
  const maxVenueSwitches = Math.max(0, options.maxVenueSwitches ?? 1);
  const maxLegsPerNode = Math.max(1, options.maxLegsPerNode ?? 4);
  const maxPaths = Math.max(0, options.maxPaths ?? 300);
  const startVenues = options.startVenues ? new Set(options.startVenues) : undefined;
  const paths: CrossVenuePath[] = [];
  const seen = new Set<string>();

  const startKeys = [...adjacency.keys()].filter((key) => {
    const node = parseNodeKey(key);
    if (normalizeCurrency(node.currency) !== startCurrency) return false;
    return startVenues ? startVenues.has(node.venueId) : true;
  });

  for (const startKey of startKeys) {
    if (paths.length >= maxPaths) break;
    const startNode = normalized(parseNodeKey(startKey));
    const provided = options.startAvailableByVenue?.get(startNode.venueId);
    if (options.startAvailableByVenue && provided === undefined) continue;
    const startAvailable = provided ?? UNBOUNDED;
    if (startAvailable.isFinite() && startAvailable.lte(0)) continue;

    const walk = (
      node: CrossVenueNode,
      visited: Set<string>,
      usedMarkets: Set<string>,
      tradeVenues: Set<string>,
      legs: CrossVenueLeg[],
      nodes: CrossVenueNode[],
      tradeCount: number,
      venueSwitches: number,
    ): void => {
      if (paths.length >= maxPaths) return;
      const outgoing = adjacency.get(nodeKey(node)) ?? [];
      const trades = outgoing
        .filter((leg): leg is TradeLeg => leg.kind === 'trade')
        .slice(0, maxLegsPerNode);
      const previousIsInventory = legs.at(-1)?.kind === 'inventory';
      const inventories =
        legs.length === 0 || previousIsInventory
          ? []
          : outgoing.filter((leg): leg is InventoryLeg => leg.kind === 'inventory');
      for (const leg of [...trades, ...inventories]) {
        if (paths.length >= maxPaths) return;
        const next = normalized(leg.to);
        const nextKey = nodeKey(next);
        if (visited.has(nextKey)) continue;
        if (legs.length + 1 > maxHops) continue;
        const nextTradeCount = tradeCount + (leg.kind === 'trade' ? 1 : 0);
        const nextVenueSwitches = venueSwitches + (leg.kind === 'inventory' ? 1 : 0);
        if (nextVenueSwitches > maxVenueSwitches) continue;
        let nextUsedMarkets = usedMarkets;
        let nextTradeVenues = tradeVenues;
        if (leg.kind === 'trade') {
          const marketKey = `${leg.market.venueId}|${leg.market.exchangeSymbol}`;
          if (usedMarkets.has(marketKey)) continue;
          nextUsedMarkets = new Set(usedMarkets);
          nextUsedMarkets.add(marketKey);
          nextTradeVenues = new Set(tradeVenues);
          nextTradeVenues.add(leg.market.venueId);
        }
        const nextLegs = [...legs, leg];
        const nextNodes = [...nodes, next];
        if (next.currency === startCurrency) {
          if (
            leg.kind === 'trade' &&
            nextTradeCount >= 2 &&
            nextVenueSwitches >= 1 &&
            nextTradeVenues.size >= 2
          ) {
            const signature =
              nextNodes.map(nodeKey).join('>') + '|' + nextLegs.map(legSignature).join(';');
            if (!seen.has(signature)) {
              seen.add(signature);
              const estimated = nextLegs
                .reduce(
                  (total, current) => (current.kind === 'trade' ? total.mul(current.rate) : total),
                  new Decimal(1),
                )
                .minus(1);
              paths.push({
                nodes: nextNodes,
                legs: nextLegs,
                estimatedReturn: estimated,
                venueSwitches: nextVenueSwitches,
                startAvailable,
              });
            }
          }
          continue;
        }
        const nextVisited = new Set(visited);
        nextVisited.add(nextKey);
        walk(
          next,
          nextVisited,
          nextUsedMarkets,
          nextTradeVenues,
          nextLegs,
          nextNodes,
          nextTradeCount,
          nextVenueSwitches,
        );
      }
    };

    walk(startNode, new Set([startKey]), new Set(), new Set(), [], [startNode], 0, 0);
  }

  return paths
    .sort((left, right) => right.estimatedReturn.comparedTo(left.estimatedReturn))
    .slice(0, maxPaths);
}

function validSettings(settings: CostSettings): boolean {
  return (
    Number.isFinite(settings.maxOrderbookAgeMs) &&
    settings.maxOrderbookAgeMs >= 0 &&
    settings.safetyBufferBps.isFinite() &&
    settings.safetyBufferBps.gte(0) &&
    settings.minProfitUsd.isFinite() &&
    settings.minProfitUsd.gte(0) &&
    settings.minNetProfitBps.isFinite() &&
    settings.minNetProfitBps.gte(0)
  );
}

export function simulateCrossVenuePath(
  path: CrossVenuePath,
  startAmount: Decimal,
  settings: CostSettings,
  now: number,
  applyFees: boolean,
): CrossVenueSimulation {
  const reasons: RejectionReason[] = [];
  const fills: CrossVenueFill[] = [];
  let amount = startAmount;
  // Sum starting currency across venues; residual cash never enters the inventory leg.
  let unspentStartAmount = ZERO;
  let dataAgeMs = 0;
  if (!startAmount.isFinite() || startAmount.lte(0) || !Number.isFinite(now) || now <= 0) {
    reasons.push('invalid_request');
    return { outputAmount: ZERO, fills, reasons, dataAgeMs };
  }
  if (!validSettings(settings)) {
    reasons.push('invalid_request');
    return { outputAmount: ZERO, fills, reasons, dataAgeMs };
  }
  const tradeLegs = path.legs.filter((leg): leg is TradeLeg => leg.kind === 'trade');
  const inventoryLegs = path.legs.filter((leg): leg is InventoryLeg => leg.kind === 'inventory');
  const tradeVenues = new Set(tradeLegs.map((leg) => leg.market.venueId));
  const firstCurrency = path.nodes[0] ? normalizeCurrency(path.nodes[0].currency) : '';
  const lastCurrency = path.nodes.at(-1) ? normalizeCurrency(path.nodes.at(-1)!.currency) : '';
  if (
    path.legs.length < 2 ||
    path.legs.length > MAX_HOPS ||
    path.nodes.length !== path.legs.length + 1 ||
    firstCurrency !== lastCurrency ||
    tradeLegs.length < 2 ||
    inventoryLegs.length < 1 ||
    tradeVenues.size < 2
  ) {
    reasons.push('quote_mismatch');
    return { outputAmount: ZERO, fills, reasons, dataAgeMs };
  }
  const startAvailable = path.startAvailable ?? UNBOUNDED;
  if (startAvailable.isFinite() && startAmount.gt(startAvailable)) {
    reasons.push('insufficient_inventory');
    return { outputAmount: ZERO, fills, reasons, dataAgeMs };
  }

  const usedMarkets = new Set<string>();
  for (let index = 0; index < path.legs.length; index += 1) {
    const leg = path.legs[index]!;
    const from = normalized(path.nodes[index]!);
    const to = normalized(path.nodes[index + 1]!);
    if (leg.kind === 'inventory') {
      if (amount.gt(leg.available)) {
        reasons.push('insufficient_inventory');
        return { outputAmount: ZERO, fills, reasons, dataAgeMs };
      }
      fills.push({
        kind: 'inventory',
        fromVenue: from.venueId,
        fromCurrency: from.currency,
        toVenue: to.venueId,
        toCurrency: to.currency,
        inputAmount: amount,
        outputAmount: amount,
        fee: ZERO,
        available: leg.available,
      });
      continue;
    }

    const marketKey = `${leg.market.venueId}|${leg.market.exchangeSymbol}`;
    if (usedMarkets.has(marketKey)) {
      reasons.push('quote_mismatch');
      return { outputAmount: ZERO, fills, reasons, dataAgeMs };
    }
    usedMarkets.add(marketKey);

    const validation = validateOrderBook(leg.book, {
      expectedVenueId: leg.market.venueId,
      expectedSymbol: leg.market.exchangeSymbol,
      maxAgeMs: settings.maxOrderbookAgeMs,
      now,
    });
    dataAgeMs = Math.max(dataAgeMs, Math.max(0, now - leg.book.fetchedAt));
    if (!validation.valid) {
      reasons.push('invalid_orderbook');
      if (
        validation.reasons.some(
          (reason) => reason === 'stale_orderbook' || reason === 'exchange_timestamp_stale',
        )
      ) {
        reasons.push('stale_orderbook');
      }
      if (validation.reasons.includes('crossed_orderbook')) reasons.push('crossed_orderbook');
      return { outputAmount: ZERO, fills, reasons, dataAgeMs };
    }
    const feeBps = leg.market.feeTakerBps;
    if (feeBps === undefined || !feeBps.isFinite() || feeBps.lt(0)) {
      reasons.push('fee_not_configured');
    }
    const effectiveFeeBps = feeBps ?? ZERO;
    if (leg.side === 'sell') {
      const input = leg.market.amountStep ? alignAmountDown(amount, leg.market.amountStep) : amount;
      if (!input.gt(0)) {
        reasons.push('amount_precision_invalid');
        return { outputAmount: ZERO, fills, reasons, dataAgeMs };
      }
      if (leg.market.minAmount && input.lt(leg.market.minAmount)) {
        reasons.push('below_min_notional');
      }
      const depth = calculateSellDepthByBase(validation.book, input);
      if (depth.insufficientDepth) reasons.push('insufficient_depth');
      const grossOutput = depth.executableQuoteAmount;
      if (leg.market.minNotional && grossOutput.lt(leg.market.minNotional)) {
        reasons.push('below_min_notional');
      }
      const fee = applyFees ? grossOutput.mul(effectiveFeeBps.div(10_000)) : ZERO;
      amount = grossOutput.minus(fee);
      fills.push({
        kind: 'trade',
        fromVenue: from.venueId,
        fromCurrency: from.currency,
        toVenue: to.venueId,
        toCurrency: to.currency,
        inputAmount: input,
        outputAmount: amount,
        fee,
        symbol: leg.market.exchangeSymbol,
        side: 'sell',
        averagePrice: depth.averagePrice,
        worstPrice: depth.worstPrice,
        levelsConsumed: depth.levelsConsumed,
      });
    } else {
      const budgetDepth = calculateBuyDepthByQuote(validation.book, amount);
      if (budgetDepth.insufficientDepth) reasons.push('insufficient_depth');
      const grossOutput = leg.market.amountStep
        ? alignAmountDown(budgetDepth.executableBaseAmount, leg.market.amountStep)
        : budgetDepth.executableBaseAmount;
      if (!grossOutput.gt(0)) {
        reasons.push('amount_precision_invalid');
        return { outputAmount: ZERO, fills, reasons, dataAgeMs };
      }
      // Preserve the exact quote budget when alignment did not reduce the order.
      const depth = grossOutput.eq(budgetDepth.executableBaseAmount)
        ? budgetDepth
        : calculateBuyDepthByBase(validation.book, grossOutput);
      if (leg.market.minNotional && depth.executableQuoteAmount.lt(leg.market.minNotional)) {
        reasons.push('below_min_notional');
      }
      const unspentInputAmount = amount.minus(depth.executableQuoteAmount);
      if (from.currency === firstCurrency) {
        unspentStartAmount = unspentStartAmount.plus(unspentInputAmount);
      }
      if (leg.market.minAmount && grossOutput.lt(leg.market.minAmount)) {
        reasons.push('below_min_notional');
      }
      const fee = applyFees ? grossOutput.mul(effectiveFeeBps.div(10_000)) : ZERO;
      amount = grossOutput.minus(fee);
      fills.push({
        kind: 'trade',
        fromVenue: from.venueId,
        fromCurrency: from.currency,
        toVenue: to.venueId,
        toCurrency: to.currency,
        inputAmount: depth.executableQuoteAmount,
        unspentInputAmount,
        outputAmount: amount,
        fee,
        symbol: leg.market.exchangeSymbol,
        side: 'buy',
        averagePrice: depth.averagePrice,
        worstPrice: depth.worstPrice,
        levelsConsumed: depth.levelsConsumed,
      });
    }
    if (!amount.gt(0) || !amount.isFinite()) {
      reasons.push('insufficient_depth');
      return { outputAmount: ZERO, fills, reasons, dataAgeMs };
    }
  }
  return { outputAmount: amount.plus(unspentStartAmount), fills, reasons, dataAgeMs };
}

export function evaluateCrossVenuePath(
  path: CrossVenuePath,
  startAmount: Decimal,
  settings: CostSettings,
  now: number,
  healthByVenue: Record<string, HealthState> = {},
): OpportunityResult {
  const gross = simulateCrossVenuePath(path, startAmount, settings, now, false);
  const net = simulateCrossVenuePath(path, startAmount, settings, now, true);
  const rejections: RejectionReason[] = [...gross.reasons, ...net.reasons];
  for (const leg of path.legs) {
    if (leg.kind !== 'trade') continue;
    const health = healthByVenue[leg.market.venueId] ?? 'D';
    if (health !== 'A' && health !== 'B') {
      rejections.push('venue_health_below_threshold');
      break;
    }
  }
  const usable = startAmount.isFinite() && startAmount.gt(0) && validSettings(settings);
  const grossSpread = usable ? gross.outputAmount.minus(startAmount) : ZERO;
  const depthNet = usable ? net.outputAmount.minus(startAmount) : ZERO;
  const safety = usable
    ? calculateSafetyBuffer(startAmount, settings.safetyBufferBps, settings.minProfitUsd)
    : ZERO;
  const conservative = depthNet.minus(safety);
  const netBps = usable ? calculateNetProfitBps(conservative, startAmount) : ZERO;
  if (usable && conservative.lte(0)) rejections.push('gross_profit_below_threshold');
  else if (usable && netBps.lt(settings.minNetProfitBps)) {
    rejections.push('conservative_profit_below_threshold');
  }
  const unique = [...new Set(rejections)];
  const tradeLegs = path.legs.filter((leg): leg is TradeLeg => leg.kind === 'trade');
  const firstTrade = tradeLegs[0];
  const lastTrade = tradeLegs.at(-1);
  const venuePath = path.nodes.map((node) => node.venueId).join('>');
  const currencyPath = path.nodes.map((node) => normalizeCurrency(node.currency)).join('>');
  const tradeVenues = [...new Set(tradeLegs.map((leg) => leg.market.venueId))];
  return {
    strategy: 'S2',
    opportunityKey: `S2X|${venuePath}|${currencyPath}`,
    instrumentKey: currencyPath,
    direction: `${venuePath}:${currencyPath}`,
    venueBuy: firstTrade?.market.venueId ?? '',
    venueSell: lastTrade?.market.venueId ?? '',
    instrumentBuy: normalizeCurrency(path.nodes[0]?.currency ?? ''),
    instrumentSell: normalizeCurrency(path.nodes.at(-1)?.currency ?? ''),
    requestedNotional: usable ? startAmount : ZERO,
    grossSpread,
    totalCost: grossSpread.minus(depthNet).plus(safety),
    depthNetProfit: depthNet,
    conservativeNetProfit: conservative,
    netProfitBps: netBps,
    dataAgeMs: Math.max(gross.dataAgeMs, net.dataAgeMs),
    valid: unique.length === 0,
    rejectionReasons: unique,
    sampledAt: now,
    metadata: {
      variant: 'cross_venue_inventory',
      venuePath,
      path: currencyPath,
      hops: String(path.legs.length),
      tradeLegs: String(tradeLegs.length),
      pathClass: tradeLegs.length <= 2 ? 'two_venue_bridge' : 'multi_hop',
      venueSwitches: String(path.venueSwitches),
      tradeVenues: tradeVenues.join('>'),
      rebalanceDeferred: 'true',
    },
    fillQuality: {
      strategy: 'S2',
      variant: 'cross_venue_inventory',
      venuePath,
      path: currencyPath,
      legs: net.fills.map((fill) => ({
        kind: fill.kind,
        fromVenue: fill.fromVenue,
        fromCurrency: fill.fromCurrency,
        toVenue: fill.toVenue,
        toCurrency: fill.toCurrency,
        inputAmount: fill.inputAmount.toFixed(),
        ...(fill.unspentInputAmount !== undefined
          ? { unspentInputAmount: fill.unspentInputAmount.toFixed() }
          : {}),
        outputAmount: fill.outputAmount.toFixed(),
        fee: fill.fee.toFixed(),
        ...(fill.symbol ? { symbol: fill.symbol } : {}),
        ...(fill.side ? { side: fill.side } : {}),
        ...(fill.averagePrice ? { averagePrice: fill.averagePrice.toFixed() } : {}),
        ...(fill.worstPrice ? { worstPrice: fill.worstPrice.toFixed() } : {}),
        ...(fill.available ? { available: fill.available.toFixed() } : {}),
      })),
    },
  };
}

export interface CrossVenueOptimizationOptions {
  minNotional?: Decimal;
  step?: Decimal;
  samples?: number;
  refineLevels?: number;
  refineSamples?: number;
}

export function evaluateCrossVenuePathOptimal(
  path: CrossVenuePath,
  maxNotional: Decimal,
  settings: CostSettings,
  now: number,
  healthByVenue: Record<string, HealthState> = {},
  options: CrossVenueOptimizationOptions = {},
): OpportunityResult {
  const capacityMax = path.startAvailable.isFinite()
    ? minDecimal(maxNotional, path.startAvailable)
    : maxNotional;
  const search = searchOptimalNotional({
    minNotional: options.minNotional ?? new Decimal(1),
    maxNotional: capacityMax,
    ...(options.step ? { step: options.step } : {}),
    ...(options.samples !== undefined ? { samples: options.samples } : {}),
    ...(options.refineLevels !== undefined ? { refineLevels: options.refineLevels } : {}),
    ...(options.refineSamples !== undefined ? { refineSamples: options.refineSamples } : {}),
    evaluate: (notional) => {
      const result = evaluateCrossVenuePath(path, notional, settings, now, healthByVenue);
      return {
        conservativeNetProfit: result.conservativeNetProfit,
        valid: result.valid,
        rejectionReasons: result.rejectionReasons,
      };
    },
  });
  const final = evaluateCrossVenuePath(path, search.notional, settings, now, healthByVenue);
  return {
    ...final,
    metadata: {
      ...(final.metadata ?? {}),
      sizing: 'optimal',
      sizingEvaluated: String(search.evaluated),
      sizingBoundary: search.boundary,
    },
  };
}
