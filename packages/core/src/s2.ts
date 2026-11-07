import {
  Decimal,
  ZERO,
  calculateNetProfitBps,
  calculateSafetyBuffer,
  bps as toBps,
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

export interface TriangularEdge {
  market: MarketMetadata;
  book: OrderBookSnapshot;
}

export interface TriangularPath {
  currencies: string[];
  edges: TriangularEdge[];
}

export interface TriangularFill {
  from: string;
  to: string;
  venueId: string;
  symbol: string;
  inputAmount: Decimal;
  /** Quote currency retained at this venue after rounding a buy order. */
  unspentInputAmount?: Decimal;
  outputAmount: Decimal;
  fee: Decimal;
  feeCurrency: string;
  averagePrice: Decimal;
  worstPrice: Decimal;
  levelsConsumed: number;
  insufficientDepth: boolean;
}

export interface TriangularSimulation {
  /** Terminal proceeds plus retained starting-currency cash; other residual currencies are unvalued. */
  outputAmount: Decimal;
  fills: TriangularFill[];
  reasons: RejectionReason[];
  dataAgeMs: number;
}

const MAX_PATH_HOPS = 5;

function finiteNonNegative(value: Decimal): boolean {
  return value.isFinite() && value.gte(0);
}

function edgeKey(edge: TriangularEdge): string {
  return `${edge.market.venueId}|${edge.market.exchangeSymbol}`;
}

export function estimateTriangularPathReturn(path: TriangularPath): Decimal {
  let rate = new Decimal(1);
  for (let index = 0; index < path.edges.length; index += 1) {
    const edge = path.edges[index]!;
    const from = path.currencies[index]!;
    const to = path.currencies[index + 1]!;
    const feeBps = edge.market.feeTakerBps ?? ZERO;
    const feeFactor = new Decimal(1).minus(feeBps.div(10_000));
    if (feeFactor.lte(0)) return ZERO;
    if (edge.market.base === from && edge.market.quote === to) {
      const bid = edge.book.bids[0]?.price;
      if (!bid || !bid.gt(0)) return ZERO;
      rate = rate.mul(bid).mul(feeFactor);
    } else if (edge.market.quote === from && edge.market.base === to) {
      const ask = edge.book.asks[0]?.price;
      if (!ask || !ask.gt(0)) return ZERO;
      rate = rate.mul(new Decimal(1).div(ask)).mul(feeFactor);
    } else {
      return ZERO;
    }
  }
  return rate.minus(1);
}

function hasValidSettings(settings: CostSettings): boolean {
  return (
    Number.isFinite(settings.maxOrderbookAgeMs) &&
    settings.maxOrderbookAgeMs >= 0 &&
    finiteNonNegative(settings.safetyBufferBps) &&
    finiteNonNegative(settings.minProfitUsd) &&
    settings.minNetProfitBps.isFinite() &&
    settings.minNetProfitBps.gte(0)
  );
}

export function enumerateTriangularPaths(
  edges: readonly TriangularEdge[],
  startCurrency = 'USDT',
  maxTrades = 3,
  maxIntermediateCurrencies = 2,
): TriangularPath[] {
  const paths: TriangularPath[] = [];
  const walk = (
    currency: string,
    visited: Set<string>,
    usedEdges: TriangularEdge[],
    usedEdgeKeys: Set<string>,
    currencies: string[],
  ): void => {
    if (usedEdges.length >= maxTrades) return;
    for (const edge of edges) {
      if (!edge.market.active) continue;
      const key = edgeKey(edge);
      if (usedEdgeKeys.has(key)) continue;
      let next: string | undefined;
      if (edge.market.base === currency) next = edge.market.quote;
      else if (edge.market.quote === currency) next = edge.market.base;
      if (!next) continue;
      if (next === startCurrency) {
        if (usedEdges.length + 1 >= 2) {
          paths.push({
            currencies: [...currencies, startCurrency],
            edges: [...usedEdges, edge],
          });
        }
        continue;
      }
      if (visited.has(next)) continue;
      if (visited.size - 1 >= maxIntermediateCurrencies) continue;
      visited.add(next);
      walk(next, visited, [...usedEdges, edge], new Set([...usedEdgeKeys, key]), [
        ...currencies,
        next,
      ]);
      visited.delete(next);
    }
  };
  walk(startCurrency, new Set([startCurrency]), [], new Set(), [startCurrency]);
  return paths;
}

interface DirectedEdge {
  edge: TriangularEdge;
  next: string;
  rate: Decimal;
}

export interface CyclicPathOptions {
  startCurrency: string;
  maxHops?: number;
  maxLegsPerCurrency?: number;
  maxPaths?: number;
}

function directedEdges(edges: readonly TriangularEdge[]): Map<string, DirectedEdge[]> {
  const adjacency = new Map<string, DirectedEdge[]>();
  for (const edge of edges) {
    if (!edge.market.active) continue;
    const feeBps = edge.market.feeTakerBps ?? ZERO;
    const feeFactor = new Decimal(1).minus(feeBps.div(10_000));
    if (feeFactor.lte(0)) continue;
    const bid = edge.book.bids[0]?.price;
    const ask = edge.book.asks[0]?.price;
    if (bid && bid.gt(0)) {
      const from = edge.market.base;
      const list = adjacency.get(from) ?? [];
      list.push({ edge, next: edge.market.quote, rate: bid.mul(feeFactor) });
      adjacency.set(from, list);
    }
    if (ask && ask.gt(0)) {
      const from = edge.market.quote;
      const list = adjacency.get(from) ?? [];
      list.push({
        edge,
        next: edge.market.base,
        rate: new Decimal(1).div(ask).mul(feeFactor),
      });
      adjacency.set(from, list);
    }
  }
  for (const list of adjacency.values()) {
    list.sort((left, right) => right.rate.comparedTo(left.rate));
  }
  return adjacency;
}

export function enumerateCyclicPaths(
  edges: readonly TriangularEdge[],
  options: CyclicPathOptions,
): TriangularPath[] {
  const start = options.startCurrency.trim().toUpperCase();
  const maxHops = Math.max(2, Math.min(options.maxHops ?? 3, MAX_PATH_HOPS));
  const maxLegs = Math.max(1, options.maxLegsPerCurrency ?? 4);
  const maxPaths = Math.max(0, options.maxPaths ?? 200);
  const adjacency = directedEdges(edges);
  const paths: TriangularPath[] = [];
  const seen = new Set<string>();

  const walk = (
    currency: string,
    visited: Set<string>,
    usedEdges: Set<string>,
    current: TriangularPath,
  ): void => {
    if (paths.length >= maxPaths) return;
    for (const { edge, next } of (adjacency.get(currency) ?? []).slice(0, maxLegs)) {
      if (paths.length >= maxPaths) return;
      const edgeIdentity = edgeKey(edge);
      if (usedEdges.has(edgeIdentity)) continue;
      if (next === start) {
        if (current.edges.length + 1 >= 2) {
          const currencies = [...current.currencies, start];
          const signature = currencies.join('>');
          if (!seen.has(signature)) {
            seen.add(signature);
            paths.push({ currencies, edges: [...current.edges, edge] });
          }
        }
        continue;
      }
      if (visited.has(next)) continue;
      if (current.edges.length + 1 >= maxHops) continue;
      visited.add(next);
      usedEdges.add(edgeIdentity);
      walk(next, visited, usedEdges, {
        currencies: [...current.currencies, next],
        edges: [...current.edges, edge],
      });
      usedEdges.delete(edgeIdentity);
      visited.delete(next);
    }
  };

  walk(start, new Set([start]), new Set(), { currencies: [start], edges: [] });
  return paths;
}

function simulateChain(
  path: TriangularPath,
  startAmount: Decimal,
  settings: CostSettings,
  now: number,
  applyFees: boolean,
): TriangularSimulation {
  const reasons: RejectionReason[] = [];
  const fills: TriangularFill[] = [];
  let amount = startAmount;
  // Only retained starting currency can be added to the terminal cash balance without conversion.
  let unspentStartAmount = ZERO;
  let dataAgeMs = 0;
  if (!startAmount.isFinite() || startAmount.lte(0) || !Number.isFinite(now) || now <= 0) {
    reasons.push('invalid_request');
    return { outputAmount: ZERO, fills, reasons, dataAgeMs };
  }
  if (!hasValidSettings(settings)) {
    reasons.push('invalid_request');
    return { outputAmount: ZERO, fills, reasons, dataAgeMs };
  }
  if (
    path.edges.length < 2 ||
    path.edges.length > MAX_PATH_HOPS ||
    path.currencies.length !== path.edges.length + 1 ||
    path.currencies[0] !== path.currencies.at(-1) ||
    path.currencies.some((currency) => currency.trim() === '')
  ) {
    reasons.push('quote_mismatch');
    return { outputAmount: ZERO, fills, reasons, dataAgeMs };
  }
  const pathVenueId = path.edges[0]?.market.venueId;
  if (!pathVenueId || path.edges.some((edge) => edge.market.venueId !== pathVenueId)) {
    reasons.push('venue_mismatch');
    return { outputAmount: ZERO, fills, reasons, dataAgeMs };
  }
  const usedEdgeKeys = new Set<string>();
  for (let index = 0; index < path.edges.length; index += 1) {
    const edge = path.edges[index]!;
    const from = path.currencies[index]!;
    const to = path.currencies[index + 1]!;
    const key = edgeKey(edge);
    if (usedEdgeKeys.has(key)) {
      reasons.push('quote_mismatch');
      return { outputAmount: ZERO, fills, reasons, dataAgeMs };
    }
    usedEdgeKeys.add(key);
    if (!edge.market.active) {
      reasons.push('market_inactive');
      return { outputAmount: ZERO, fills, reasons, dataAgeMs };
    }
    const forward = edge.market.base === from && edge.market.quote === to;
    const reverse = edge.market.quote === from && edge.market.base === to;
    if (!forward && !reverse) {
      reasons.push('quote_mismatch');
      return { outputAmount: ZERO, fills, reasons, dataAgeMs };
    }
    if (
      edge.market.amountStep &&
      (!edge.market.amountStep.isFinite() || edge.market.amountStep.lte(0))
    ) {
      reasons.push('amount_precision_invalid');
      return { outputAmount: ZERO, fills, reasons, dataAgeMs };
    }
    if (
      (edge.market.minAmount &&
        (!finiteNonNegative(edge.market.minAmount) || edge.market.minAmount.lte(0))) ||
      (edge.market.minNotional &&
        (!finiteNonNegative(edge.market.minNotional) || edge.market.minNotional.lte(0)))
    ) {
      reasons.push('invalid_request');
      return { outputAmount: ZERO, fills, reasons, dataAgeMs };
    }
    const validation = validateOrderBook(edge.book, {
      expectedVenueId: edge.market.venueId,
      expectedSymbol: edge.market.exchangeSymbol,
      maxAgeMs: settings.maxOrderbookAgeMs,
      now,
    });
    dataAgeMs = Math.max(dataAgeMs, Math.max(0, now - edge.book.fetchedAt));
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
    const feeBps = edge.market.feeTakerBps;
    if (feeBps === undefined || !feeBps.isFinite() || feeBps.lt(0)) {
      reasons.push('fee_not_configured');
    }
    const effectiveFeeBps = feeBps ?? ZERO;
    if (edge.market.base === from) {
      const input = edge.market.amountStep
        ? alignAmountDown(amount, edge.market.amountStep)
        : amount;
      if (!input.gt(0)) {
        reasons.push('amount_precision_invalid');
        return { outputAmount: ZERO, fills, reasons, dataAgeMs };
      }
      if (edge.market.minAmount && input.lt(edge.market.minAmount)) {
        reasons.push('below_min_notional');
      }
      const depth = calculateSellDepthByBase(validation.book, input);
      if (depth.insufficientDepth) reasons.push('insufficient_depth');
      const grossOutput = depth.executableQuoteAmount;
      if (edge.market.minNotional && grossOutput.lt(edge.market.minNotional)) {
        reasons.push('below_min_notional');
      }
      const fee = applyFees ? grossOutput.mul(toBps(effectiveFeeBps)) : ZERO;
      amount = grossOutput.minus(fee);
      fills.push({
        from,
        to,
        venueId: edge.market.venueId,
        symbol: edge.market.exchangeSymbol,
        inputAmount: input,
        outputAmount: amount,
        fee,
        feeCurrency: edge.market.quote,
        averagePrice: depth.averagePrice,
        worstPrice: depth.worstPrice,
        levelsConsumed: depth.levelsConsumed,
        insufficientDepth: depth.insufficientDepth,
      });
    } else {
      const budgetDepth = calculateBuyDepthByQuote(validation.book, amount);
      if (budgetDepth.insufficientDepth) reasons.push('insufficient_depth');
      const grossOutput = edge.market.amountStep
        ? alignAmountDown(budgetDepth.executableBaseAmount, edge.market.amountStep)
        : budgetDepth.executableBaseAmount;
      if (!grossOutput.gt(0)) {
        reasons.push('amount_precision_invalid');
        return { outputAmount: ZERO, fills, reasons, dataAgeMs };
      }
      // Preserve the exact quote budget when alignment did not reduce the order.
      const depth = grossOutput.eq(budgetDepth.executableBaseAmount)
        ? budgetDepth
        : calculateBuyDepthByBase(validation.book, grossOutput);
      if (edge.market.minNotional && depth.executableQuoteAmount.lt(edge.market.minNotional)) {
        reasons.push('below_min_notional');
      }
      const unspentInputAmount = amount.minus(depth.executableQuoteAmount);
      if (from === path.currencies[0]) {
        unspentStartAmount = unspentStartAmount.plus(unspentInputAmount);
      }
      if (edge.market.minAmount && grossOutput.lt(edge.market.minAmount)) {
        reasons.push('below_min_notional');
      }
      const fee = applyFees ? grossOutput.mul(toBps(effectiveFeeBps)) : ZERO;
      amount = grossOutput.minus(fee);
      fills.push({
        from,
        to,
        venueId: edge.market.venueId,
        symbol: edge.market.exchangeSymbol,
        inputAmount: depth.executableQuoteAmount,
        unspentInputAmount,
        outputAmount: amount,
        fee,
        feeCurrency: edge.market.base,
        averagePrice: depth.averagePrice,
        worstPrice: depth.worstPrice,
        levelsConsumed: depth.levelsConsumed,
        insufficientDepth: depth.insufficientDepth,
      });
    }
    if (!amount.gt(0) || !amount.isFinite()) {
      reasons.push('insufficient_depth');
      return { outputAmount: ZERO, fills, reasons, dataAgeMs };
    }
  }
  return { outputAmount: amount.plus(unspentStartAmount), fills, reasons, dataAgeMs };
}

export function simulateTriangularPath(
  path: TriangularPath,
  startAmount: Decimal,
  settings: CostSettings,
  now: number,
): TriangularSimulation {
  return simulateChain(path, startAmount, settings, now, true);
}

export function evaluateTriangularPath(
  path: TriangularPath,
  startAmount: Decimal,
  settings: CostSettings,
  now: number,
  venueHealth: HealthState = 'B',
): OpportunityResult {
  const venueId = path.edges[0]?.market.venueId ?? 'unknown';
  const grossSimulation = simulateChain(path, startAmount, settings, now, false);
  const netSimulation = simulateChain(path, startAmount, settings, now, true);
  const rejections: RejectionReason[] = [...grossSimulation.reasons, ...netSimulation.reasons];
  if (venueHealth !== 'A' && venueHealth !== 'B') rejections.push('venue_health_below_threshold');
  const usableInput = startAmount.isFinite() && startAmount.gt(0) && hasValidSettings(settings);
  const grossSpread = usableInput ? grossSimulation.outputAmount.minus(startAmount) : ZERO;
  const depthNet = usableInput ? netSimulation.outputAmount.minus(startAmount) : ZERO;
  const safety = usableInput
    ? calculateSafetyBuffer(startAmount, settings.safetyBufferBps, settings.minProfitUsd)
    : ZERO;
  const conservative = depthNet.minus(safety);
  const netBps = usableInput ? calculateNetProfitBps(conservative, startAmount) : ZERO;
  if (usableInput && conservative.lte(0)) rejections.push('gross_profit_below_threshold');
  else if (usableInput && netBps.lt(settings.minNetProfitBps)) {
    rejections.push('conservative_profit_below_threshold');
  }
  const unique = [...new Set(rejections)];
  const prices = netSimulation.fills.map(
    (fill) => `${fill.from}->${fill.to}:${fill.worstPrice.toFixed()}`,
  );
  return {
    strategy: 'S2',
    opportunityKey: `S2|${venueId}|${path.currencies.join('>')}`,
    instrumentKey: path.currencies.join('>'),
    direction: `${venueId}:${path.currencies.join('>')}`,
    venueBuy: path.edges[0]?.market.venueId ?? '',
    venueSell: path.edges.at(-1)?.market.venueId ?? '',
    instrumentBuy: path.currencies[0] ?? '',
    instrumentSell: path.currencies.at(-1) ?? '',
    requestedNotional: usableInput ? startAmount : ZERO,
    grossSpread,
    totalCost: grossSpread.minus(depthNet).plus(safety),
    depthNetProfit: depthNet,
    conservativeNetProfit: conservative,
    netProfitBps: netBps,
    dataAgeMs: Math.max(grossSimulation.dataAgeMs, netSimulation.dataAgeMs),
    valid: unique.length === 0,
    rejectionReasons: unique,
    sampledAt: now,
    metadata: {
      prices: prices.join('|'),
      path: path.currencies.join('>'),
      fillCount: String(netSimulation.fills.length),
    },
    fillQuality: {
      path: path.currencies.join('>'),
      fills: netSimulation.fills.map((fill) => ({
        from: fill.from,
        to: fill.to,
        venueId: fill.venueId,
        symbol: fill.symbol,
        inputAmount: fill.inputAmount.toFixed(),
        ...(fill.unspentInputAmount !== undefined
          ? { unspentInputAmount: fill.unspentInputAmount.toFixed() }
          : {}),
        outputAmount: fill.outputAmount.toFixed(),
        fee: fill.fee.toFixed(),
        feeCurrency: fill.feeCurrency,
        averagePrice: fill.averagePrice.toFixed(),
        worstPrice: fill.worstPrice.toFixed(),
        levelsConsumed: fill.levelsConsumed,
        insufficientDepth: fill.insufficientDepth,
      })),
    },
  };
}

export interface S2OptimizationOptions {
  minNotional?: Decimal;
  step?: Decimal;
  samples?: number;
  refineLevels?: number;
  refineSamples?: number;
}

export function evaluateTriangularPathOptimal(
  path: TriangularPath,
  maxNotional: Decimal,
  settings: CostSettings,
  now: number,
  venueHealth: HealthState = 'B',
  options: S2OptimizationOptions = {},
): OpportunityResult {
  const search = searchOptimalNotional({
    minNotional: options.minNotional ?? new Decimal(1),
    maxNotional,
    ...(options.step ? { step: options.step } : {}),
    ...(options.samples !== undefined ? { samples: options.samples } : {}),
    ...(options.refineLevels !== undefined ? { refineLevels: options.refineLevels } : {}),
    ...(options.refineSamples !== undefined ? { refineSamples: options.refineSamples } : {}),
    evaluate: (notional) => {
      const result = evaluateTriangularPath(path, notional, settings, now, venueHealth);
      return {
        conservativeNetProfit: result.conservativeNetProfit,
        valid: result.valid,
        rejectionReasons: result.rejectionReasons,
      };
    },
  });
  const final = evaluateTriangularPath(path, search.notional, settings, now, venueHealth);
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
