import type { GholaChartCandle } from "./ghola-market-chart";

export type TerminalScenarioSide = "buy" | "sell";

export interface TerminalScenarioAnalysisInput {
  candles: GholaChartCandle[];
  side: TerminalScenarioSide;
  entryPrice: number | null;
  stopPrice: number | null;
  targetPrice: number | null;
  notionalUsd: number;
  slippageBps: number;
  lookback?: number;
}

export interface TerminalScenarioAnalysis {
  sampleSize: number;
  atrBps: number | null;
  realizedVolatilityBps: number | null;
  adverseMoveBps: number | null;
  favorableMoveBps: number | null;
  stopDistanceBps: number | null;
  targetDistanceBps: number | null;
  stopAtrMultiple: number | null;
  rewardRiskRatio: number | null;
  historicalStopBreached: boolean | null;
  historicalTargetReached: boolean | null;
  stopLossUsd: number | null;
  targetProfitUsd: number | null;
  stressLossUsd: number | null;
  stressGrade: "contained" | "tight" | "exposed" | "unavailable";
}

type Candle = { high: number; low: number; close: number };

/** Historical, candle-prefix-only stress model for an unfilled trade plan. */
export function analyzeTerminalScenario(input: TerminalScenarioAnalysisInput): TerminalScenarioAnalysis {
  const lookback = clampInteger(input.lookback ?? 60, 2, 500);
  const candles = input.candles.flatMap(normalizeCandle).slice(-lookback);
  const entry = positive(input.entryPrice);
  const stop = positive(input.stopPrice);
  const target = positive(input.targetPrice);
  const notional = nonNegative(input.notionalUsd);
  const slippageBps = nonNegative(input.slippageBps) ?? 0;
  const stopValid = entry != null && stop != null && (input.side === "buy" ? stop < entry : stop > entry);
  const targetValid = entry != null && target != null && (input.side === "buy" ? target > entry : target < entry);
  const stopDistanceBps = stopValid ? Math.abs(entry - stop) / entry * 10_000 : null;
  const targetDistanceBps = targetValid ? Math.abs(target - entry) / entry * 10_000 : null;
  const atr = averageTrueRange(candles, 14);
  const lastClose = candles.at(-1)?.close ?? null;
  const atrBps = atr != null && lastClose != null ? atr / lastClose * 10_000 : null;
  const realizedVolatilityBps = realizedVolatility(candles);
  const low = candles.length ? Math.min(...candles.map((candle) => candle.low)) : null;
  const high = candles.length ? Math.max(...candles.map((candle) => candle.high)) : null;
  const adverseMoveBps = entry == null || low == null || high == null
    ? null
    : input.side === "buy"
      ? Math.max(0, (entry - low) / entry * 10_000)
      : Math.max(0, (high - entry) / entry * 10_000);
  const favorableMoveBps = entry == null || low == null || high == null
    ? null
    : input.side === "buy"
      ? Math.max(0, (high - entry) / entry * 10_000)
      : Math.max(0, (entry - low) / entry * 10_000);
  const stopAtrMultiple = stopDistanceBps != null && atrBps != null && atrBps > 0
    ? stopDistanceBps / atrBps
    : null;
  const rewardRiskRatio = stopDistanceBps != null && stopDistanceBps > 0 && targetDistanceBps != null
    ? targetDistanceBps / stopDistanceBps
    : null;
  const historicalStopBreached = stopValid && adverseMoveBps != null
    ? adverseMoveBps >= (stopDistanceBps as number)
    : null;
  const historicalTargetReached = targetValid && favorableMoveBps != null
    ? favorableMoveBps >= (targetDistanceBps as number)
    : null;
  const stopLossUsd = notional != null && stopDistanceBps != null
    ? notional * ((stopDistanceBps + slippageBps) / 10_000)
    : null;
  const targetProfitUsd = notional != null && targetDistanceBps != null
    ? notional * Math.max(0, targetDistanceBps - slippageBps) / 10_000
    : null;
  const stressLossUsd = notional != null && adverseMoveBps != null
    ? notional * ((adverseMoveBps + slippageBps) / 10_000)
    : null;
  const stressGrade = stopAtrMultiple == null
    ? "unavailable"
    : stopAtrMultiple >= 1.5 && historicalStopBreached === false
      ? "contained"
      : stopAtrMultiple >= 0.75
        ? "tight"
        : "exposed";

  return {
    sampleSize: candles.length,
    atrBps: finite(atrBps),
    realizedVolatilityBps: finite(realizedVolatilityBps),
    adverseMoveBps: finite(adverseMoveBps),
    favorableMoveBps: finite(favorableMoveBps),
    stopDistanceBps: finite(stopDistanceBps),
    targetDistanceBps: finite(targetDistanceBps),
    stopAtrMultiple: finite(stopAtrMultiple),
    rewardRiskRatio: finite(rewardRiskRatio),
    historicalStopBreached,
    historicalTargetReached,
    stopLossUsd: finite(stopLossUsd),
    targetProfitUsd: finite(targetProfitUsd),
    stressLossUsd: finite(stressLossUsd),
    stressGrade,
  };
}

function normalizeCandle(candle: GholaChartCandle): Candle[] {
  const high = positive(candle.h);
  const low = positive(candle.l);
  const close = positive(candle.c);
  return high != null && low != null && close != null && high >= low
    ? [{ high, low, close }]
    : [];
}

function averageTrueRange(candles: Candle[], period: number): number | null {
  if (candles.length < 2) return null;
  const ranges: number[] = [];
  for (let index = 1; index < candles.length; index += 1) {
    const candle = candles[index];
    const previous = candles[index - 1];
    ranges.push(Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previous.close),
      Math.abs(candle.low - previous.close),
    ));
  }
  const sample = ranges.slice(-period);
  return sample.length ? sample.reduce((sum, value) => sum + value, 0) / sample.length : null;
}

function realizedVolatility(candles: Candle[]): number | null {
  if (candles.length < 3) return null;
  const returns: number[] = [];
  for (let index = 1; index < candles.length; index += 1) {
    returns.push(Math.log(candles[index].close / candles[index - 1].close));
  }
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, returns.length - 1);
  return Math.sqrt(variance) * 10_000;
}

function positive(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function nonNegative(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function finite(value: number | null): number | null {
  return value != null && Number.isFinite(value) ? value : null;
}

function clampInteger(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.floor(value)));
}
