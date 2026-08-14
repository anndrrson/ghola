import type { GholaChartCandle } from "./ghola-market-chart";

export type TerminalPlanPathOutcome =
  | "unavailable"
  | "entry_not_touched"
  | "awaiting_follow_through"
  | "stop_first"
  | "target_first"
  | "ambiguous_same_bar"
  | "neither_touched";

export interface TerminalPlanPathAnalysis {
  outcome: TerminalPlanPathOutcome;
  sampleSize: number;
  entryBarIndex: number | null;
  entryTouchedAt: number | null;
  barsToEntry: number | null;
  postEntryBars: number;
  terminalTouchedAt: number | null;
  maxFavorableExcursionBps: number | null;
  maxAdverseExcursionBps: number | null;
  maxFavorableExcursionUsd: number | null;
  maxAdverseExcursionUsd: number | null;
}

type Candle = { t: number; high: number; low: number };

/**
 * Historical resting-limit diagnostic. The newest bar and entry bar are
 * excluded because OHLC cannot prove their intrabar path. Excursions stop at
 * the first terminal touch and never infer movement beyond that boundary.
 */
export function analyzeTerminalPlanPath(input: {
  candles: GholaChartCandle[];
  side: "buy" | "sell";
  entryPrice: number | null;
  stopPrice: number | null;
  targetPrice: number | null;
  notionalUsd: number;
  lookback?: number;
}): TerminalPlanPathAnalysis {
  const entry = positive(input.entryPrice);
  const stop = positive(input.stopPrice);
  const target = positive(input.targetPrice);
  const notional = nonNegative(input.notionalUsd);
  const stopValid = entry != null && stop != null && (input.side === "buy" ? stop < entry : stop > entry);
  const targetValid = entry != null && target != null && (input.side === "buy" ? target > entry : target < entry);
  if (entry == null || !stopValid || !targetValid || notional == null) return empty("unavailable");

  const lookback = clampInteger(input.lookback ?? 120, 3, 500);
  const bounded = input.candles.slice(-Math.min(input.candles.length, lookback + 1));
  const source = bounded.slice(0, -1);
  const candles = normalizeCandles(source);
  if (!candles || candles.length < 2) return empty("unavailable", candles?.length ?? 0);

  const entryBarIndex = candles.findIndex((candle) => input.side === "buy"
    ? candle.low <= entry
    : candle.high >= entry);
  if (entryBarIndex < 0) return empty("entry_not_touched", candles.length);

  const entryCandle = candles[entryBarIndex];
  const afterEntry = candles.slice(entryBarIndex + 1);
  if (afterEntry.length === 0) {
    return {
      ...empty("awaiting_follow_through", candles.length),
      entryBarIndex,
      entryTouchedAt: entryCandle.t,
      barsToEntry: entryBarIndex,
    };
  }

  let favorableBps = 0;
  let adverseBps = 0;
  let outcome: TerminalPlanPathOutcome = "neither_touched";
  let terminalTouchedAt: number | null = null;
  let observedBars = 0;
  for (const candle of afterEntry) {
    const stopTouched = input.side === "buy" ? candle.low <= stop : candle.high >= stop;
    const targetTouched = input.side === "buy" ? candle.high >= target : candle.low <= target;
    observedBars += 1;
    if (stopTouched || targetTouched) {
      terminalTouchedAt = candle.t;
      if (stopTouched && targetTouched) {
        outcome = "ambiguous_same_bar";
      } else if (stopTouched) {
        outcome = "stop_first";
        adverseBps = Math.max(adverseBps, Math.abs(entry - stop) / entry * 10_000);
      } else {
        outcome = "target_first";
        favorableBps = Math.max(favorableBps, Math.abs(target - entry) / entry * 10_000);
      }
      break;
    }
    favorableBps = Math.max(favorableBps, input.side === "buy"
      ? Math.max(0, (candle.high - entry) / entry * 10_000)
      : Math.max(0, (entry - candle.low) / entry * 10_000));
    adverseBps = Math.max(adverseBps, input.side === "buy"
      ? Math.max(0, (entry - candle.low) / entry * 10_000)
      : Math.max(0, (candle.high - entry) / entry * 10_000));
  }

  return {
    outcome,
    sampleSize: candles.length,
    entryBarIndex,
    entryTouchedAt: entryCandle.t,
    barsToEntry: entryBarIndex,
    postEntryBars: observedBars,
    terminalTouchedAt,
    maxFavorableExcursionBps: finite(favorableBps),
    maxAdverseExcursionBps: finite(adverseBps),
    maxFavorableExcursionUsd: finite(notional * favorableBps / 10_000),
    maxAdverseExcursionUsd: finite(notional * adverseBps / 10_000),
  };
}

function normalizeCandles(source: GholaChartCandle[]): Candle[] | null {
  const result: Candle[] = [];
  let previousTime = -1;
  for (const candle of source) {
    const t = finiteNonNegative(candle.t);
    const open = positive(candle.o);
    const high = positive(candle.h);
    const low = positive(candle.l);
    const close = positive(candle.c);
    if (
      t == null || t <= previousTime || open == null || high == null || low == null || close == null ||
      high < low || high < Math.max(open, close) || low > Math.min(open, close)
    ) return null;
    result.push({ t, high, low });
    previousTime = t;
  }
  return result;
}

function empty(outcome: TerminalPlanPathOutcome, sampleSize = 0): TerminalPlanPathAnalysis {
  return {
    outcome,
    sampleSize,
    entryBarIndex: null,
    entryTouchedAt: null,
    barsToEntry: null,
    postEntryBars: 0,
    terminalTouchedAt: null,
    maxFavorableExcursionBps: null,
    maxAdverseExcursionBps: null,
    maxFavorableExcursionUsd: null,
    maxAdverseExcursionUsd: null,
  };
}

function positive(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function nonNegative(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function finite(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

function clampInteger(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.floor(value)));
}
