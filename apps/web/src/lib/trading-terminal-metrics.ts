import type { GholaChartCandle, GholaMarketFrame } from "./ghola-market-chart";

export interface TerminalMarketMetrics {
  sessionChangePct: number | null;
  sessionHigh: number | null;
  sessionLow: number | null;
  atr: number | null;
  atrBps: number | null;
  realizedVolatilityBps: number | null;
  bidDepthUsd: number;
  askDepthUsd: number;
  bookImbalancePct: number | null;
  microprice: number | null;
  micropriceEdgeBps: number | null;
  tradeVwap: number | null;
  buyFlowPct: number | null;
  marketAgeMs: number | null;
}

export interface TerminalTradeRiskInput {
  side: "buy" | "sell";
  notionalUsd: number;
  entryPrice: number | null;
  stopPrice: number | null;
  slippageBps: number;
  spreadBps?: number | null;
}

export interface TerminalTradeRisk {
  baseSize: number | null;
  stopDistanceBps: number | null;
  maxLossUsd: number | null;
  crossingCostUsd: number | null;
  worstFillPrice: number | null;
  twoRTargetPrice: number | null;
  stopValid: boolean | null;
}

export function deriveTerminalMarketMetrics(
  frame: GholaMarketFrame | null,
  options: { depthLevels?: number; nowMs?: number } = {},
): TerminalMarketMetrics {
  const candles = validCandles(frame?.candles ?? []);
  const firstOpen = candles.at(0)?.open ?? null;
  const lastClose = candles.at(-1)?.close ?? finitePositive(frame?.mid);
  const sessionChangePct = firstOpen != null && lastClose != null
    ? ((lastClose - firstOpen) / firstOpen) * 100
    : null;
  const sessionHigh = candles.length ? Math.max(...candles.map((candle) => candle.high)) : null;
  const sessionLow = candles.length ? Math.min(...candles.map((candle) => candle.low)) : null;
  const atr = averageTrueRange(candles, 14);
  const atrBps = atr != null && lastClose != null ? (atr / lastClose) * 10_000 : null;
  const realizedVolatilityBps = realizedVolatility(candles);

  const depthLevels = clampInteger(options.depthLevels ?? 10, 1, 100);
  const bids = (frame?.bids ?? []).slice(0, depthLevels);
  const asks = (frame?.asks ?? []).slice(0, depthLevels);
  const bidSize = sum(bids.map((level) => finiteNonNegative(level.sz) ?? 0));
  const askSize = sum(asks.map((level) => finiteNonNegative(level.sz) ?? 0));
  const bidDepthUsd = sum(bids.map((level) => levelNotional(level.px, level.sz)));
  const askDepthUsd = sum(asks.map((level) => levelNotional(level.px, level.sz)));
  const totalSize = bidSize + askSize;
  const bookImbalancePct = totalSize > 0 ? ((bidSize - askSize) / totalSize) * 100 : null;
  const bestBid = finitePositive(frame?.bestBid) ?? finitePositive(bids.at(0)?.px);
  const bestAsk = finitePositive(frame?.bestAsk) ?? finitePositive(asks.at(0)?.px);
  const microprice = bestBid != null && bestAsk != null && totalSize > 0
    ? ((bestAsk * bidSize) + (bestBid * askSize)) / totalSize
    : null;
  const mid = finitePositive(frame?.mid)
    ?? (bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null);
  const micropriceEdgeBps = microprice != null && mid != null ? ((microprice - mid) / mid) * 10_000 : null;

  const trades = (frame?.trades ?? [])
    .map((trade) => ({
      side: trade.side,
      price: finitePositive(trade.px),
      size: finiteNonNegative(trade.sz),
    }))
    .filter((trade): trade is { side: "buy" | "sell"; price: number; size: number } => trade.price != null && trade.size != null);
  const totalTradeSize = sum(trades.map((trade) => trade.size));
  const tradeVwap = totalTradeSize > 0
    ? sum(trades.map((trade) => trade.price * trade.size)) / totalTradeSize
    : null;
  const totalTradeNotional = sum(trades.map((trade) => trade.price * trade.size));
  const buyNotional = sum(trades.filter((trade) => trade.side === "buy").map((trade) => trade.price * trade.size));
  const buyFlowPct = totalTradeNotional > 0 ? (buyNotional / totalTradeNotional) * 100 : null;

  const fetchedAtMs = frame?.fetchedAt ? Date.parse(frame.fetchedAt) : Number.NaN;
  const nowMs = options.nowMs ?? Date.now();
  const marketAgeMs = Number.isFinite(fetchedAtMs) && Number.isFinite(nowMs)
    ? Math.max(0, nowMs - fetchedAtMs)
    : null;

  return {
    sessionChangePct: finiteOrNull(sessionChangePct),
    sessionHigh: finiteOrNull(sessionHigh),
    sessionLow: finiteOrNull(sessionLow),
    atr: finiteOrNull(atr),
    atrBps: finiteOrNull(atrBps),
    realizedVolatilityBps: finiteOrNull(realizedVolatilityBps),
    bidDepthUsd,
    askDepthUsd,
    bookImbalancePct: finiteOrNull(bookImbalancePct),
    microprice: finiteOrNull(microprice),
    micropriceEdgeBps: finiteOrNull(micropriceEdgeBps),
    tradeVwap: finiteOrNull(tradeVwap),
    buyFlowPct: finiteOrNull(buyFlowPct),
    marketAgeMs,
  };
}

export function deriveTerminalTradeRisk(input: TerminalTradeRiskInput): TerminalTradeRisk {
  const entryPrice = finitePositive(input.entryPrice);
  const stopPrice = finitePositive(input.stopPrice);
  const notionalUsd = finiteNonNegative(input.notionalUsd);
  const slippageBps = finiteNonNegative(input.slippageBps) ?? 0;
  const spreadBps = finiteNonNegative(input.spreadBps) ?? 0;
  const baseSize = entryPrice != null && notionalUsd != null ? notionalUsd / entryPrice : null;
  const stopDistanceBps = entryPrice != null && stopPrice != null
    ? (Math.abs(entryPrice - stopPrice) / entryPrice) * 10_000
    : null;
  const maxLossUsd = notionalUsd != null && stopDistanceBps != null
    ? notionalUsd * ((stopDistanceBps + slippageBps) / 10_000)
    : null;
  const crossingCostUsd = notionalUsd != null ? notionalUsd * (spreadBps / 10_000) : null;
  const worstFillPrice = entryPrice == null
    ? null
    : input.side === "buy"
      ? entryPrice * (1 + slippageBps / 10_000)
      : entryPrice * (1 - slippageBps / 10_000);
  const riskDistance = entryPrice != null && stopPrice != null ? Math.abs(entryPrice - stopPrice) : null;
  const twoRTargetPrice = entryPrice != null && riskDistance != null
    ? input.side === "buy"
      ? entryPrice + riskDistance * 2
      : entryPrice - riskDistance * 2
    : null;
  const stopValid = entryPrice == null || stopPrice == null
    ? null
    : input.side === "buy"
      ? stopPrice < entryPrice
      : stopPrice > entryPrice;

  return {
    baseSize: finiteOrNull(baseSize),
    stopDistanceBps: finiteOrNull(stopDistanceBps),
    maxLossUsd: finiteOrNull(maxLossUsd),
    crossingCostUsd: finiteOrNull(crossingCostUsd),
    worstFillPrice: finiteOrNull(worstFillPrice),
    twoRTargetPrice: finitePositive(twoRTargetPrice),
    stopValid,
  };
}

type NumericCandle = { open: number; high: number; low: number; close: number };

function validCandles(candles: GholaChartCandle[]): NumericCandle[] {
  return candles.flatMap((candle) => {
    const open = finitePositive(candle.o);
    const high = finitePositive(candle.h);
    const low = finitePositive(candle.l);
    const close = finitePositive(candle.c);
    return open != null && high != null && low != null && close != null
      ? [{ open, high, low, close }]
      : [];
  });
}

function averageTrueRange(candles: NumericCandle[], period: number): number | null {
  if (candles.length === 0) return null;
  const ranges = candles.map((candle, index) => {
    const previousClose = candles[index - 1]?.close;
    if (previousClose == null) return candle.high - candle.low;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    );
  });
  const sample = ranges.slice(-Math.max(1, period));
  return sample.length ? sum(sample) / sample.length : null;
}

function realizedVolatility(candles: NumericCandle[]): number | null {
  if (candles.length < 3) return null;
  const returns = candles.slice(1).map((candle, index) => Math.log(candle.close / candles[index].close));
  const mean = sum(returns) / returns.length;
  const variance = sum(returns.map((value) => (value - mean) ** 2)) / Math.max(1, returns.length - 1);
  return Math.sqrt(variance) * 10_000;
}

function levelNotional(price: string, size: string) {
  return (finitePositive(price) ?? 0) * (finiteNonNegative(size) ?? 0);
}

function finitePositive(value: string | number | null | undefined): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function finiteNonNegative(value: string | number | null | undefined): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function finiteOrNull(value: number | null | undefined) {
  return value != null && Number.isFinite(value) ? value : null;
}

function clampInteger(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}
