import type { GholaChartCandle } from "./ghola-market-chart";

export type TerminalPlanPathStudyBlocker =
  | "invalid_plan"
  | "history_invalid"
  | "insufficient_history";

export const TERMINAL_PLAN_PATH_STUDY_HORIZONS = [5, 20, 50] as const;

export interface TerminalPlanPathStudy {
  status: "ready" | "unavailable";
  blocker: TerminalPlanPathStudyBlocker | null;
  sampleSize: number;
  horizonBars: number;
  episodeCount: number;
  resolvedCount: number;
  targetFirstCount: number;
  stopFirstCount: number;
  ambiguousCount: number;
  unresolvedCount: number;
  targetFirstRatePct: number | null;
  expectancyR: number | null;
  rewardRiskRatio: number | null;
  medianBarsToResolution: number | null;
}

type Candle = { t: number; high: number; low: number };

const STUDY_KEYS = [
  "status",
  "blocker",
  "sampleSize",
  "horizonBars",
  "episodeCount",
  "resolvedCount",
  "targetFirstCount",
  "stopFirstCount",
  "ambiguousCount",
  "unresolvedCount",
  "targetFirstRatePct",
  "expectancyR",
  "rewardRiskRatio",
  "medianBarsToResolution",
] as const satisfies readonly (keyof TerminalPlanPathStudy)[];

export function terminalPlanPathStudyEqual(
  left: TerminalPlanPathStudy,
  right: TerminalPlanPathStudy,
) {
  return left === right || STUDY_KEYS.every((key) => Object.is(left[key], right[key]));
}

export function terminalPlanPathStudiesEqual(
  left: readonly TerminalPlanPathStudy[],
  right: readonly TerminalPlanPathStudy[],
) {
  return left === right || (
    left.length === right.length
    && left.every((study, index) => {
      const candidate = right[index];
      return candidate != null && terminalPlanPathStudyEqual(study, candidate);
    })
  );
}

export function studyTerminalPlanPathHorizons(
  input: Omit<Parameters<typeof studyTerminalPlanPaths>[0], "horizonBars">,
): TerminalPlanPathStudy[] {
  return TERMINAL_PLAN_PATH_STUDY_HORIZONS.map((horizonBars) => (
    studyTerminalPlanPaths({ ...input, horizonBars })
  ));
}

/**
 * Replays non-overlapping hypothetical resting-limit episodes over closed bars.
 * The entry bar is never used to resolve an outcome because OHLC cannot prove
 * whether entry preceded the stop or target touch within that bar.
 */
export function studyTerminalPlanPaths(input: {
  candles: GholaChartCandle[];
  side: "buy" | "sell";
  entryPrice: number | null;
  stopPrice: number | null;
  targetPrice: number | null;
  lookback?: number;
  horizonBars?: number;
}): TerminalPlanPathStudy {
  const lookback = boundedInteger(input.lookback, 240, 3, 500);
  const horizonBars = boundedInteger(input.horizonBars, 20, 1, 100);
  const entry = positive(input.entryPrice);
  const stop = positive(input.stopPrice);
  const target = positive(input.targetPrice);
  const stopValid = entry != null && stop != null && (input.side === "buy" ? stop < entry : stop > entry);
  const targetValid = entry != null && target != null && (input.side === "buy" ? target > entry : target < entry);
  if (entry == null || !stopValid || !targetValid) return unavailable("invalid_plan", 0, horizonBars);

  const bounded = input.candles.slice(-Math.min(input.candles.length, lookback + 1));
  const source = bounded.slice(0, -1);
  const candles = normalizeCandles(source);
  if (!candles) return unavailable("history_invalid", source.length, horizonBars);
  if (candles.length < 2) return unavailable("insufficient_history", candles.length, horizonBars);

  let episodeCount = 0;
  let targetFirstCount = 0;
  let stopFirstCount = 0;
  let ambiguousCount = 0;
  let unresolvedCount = 0;
  const resolutionBars: number[] = [];
  let cursor = 0;

  while (cursor < candles.length) {
    const relativeEntryIndex = candles.slice(cursor).findIndex((candle) => entryTouched(candle, input.side, entry));
    if (relativeEntryIndex < 0) break;
    const entryIndex = cursor + relativeEntryIndex;
    episodeCount += 1;
    const entryCandle = candles[entryIndex] as Candle;
    if (
      stopTouched(entryCandle, input.side, stop as number)
      || targetTouched(entryCandle, input.side, target as number)
    ) {
      ambiguousCount += 1;
      cursor = entryIndex + 1;
      continue;
    }
    const finalIndex = Math.min(candles.length - 1, entryIndex + horizonBars);
    let terminalIndex: number | null = null;

    for (let index = entryIndex + 1; index <= finalIndex; index += 1) {
      const candle = candles[index] as Candle;
      const stopHit = stopTouched(candle, input.side, stop as number);
      const targetHit = targetTouched(candle, input.side, target as number);
      if (!stopHit && !targetHit) continue;
      terminalIndex = index;
      if (stopHit && targetHit) ambiguousCount += 1;
      else if (targetHit) targetFirstCount += 1;
      else stopFirstCount += 1;
      if (!(stopHit && targetHit)) resolutionBars.push(index - entryIndex);
      break;
    }

    if (terminalIndex == null) unresolvedCount += 1;
    cursor = (terminalIndex ?? finalIndex) + 1;
  }

  const resolvedCount = targetFirstCount + stopFirstCount;
  const rewardRiskRatio = Math.abs((target as number) - entry) / Math.abs(entry - (stop as number));
  const targetFirstRatePct = resolvedCount > 0 ? targetFirstCount / resolvedCount * 100 : null;
  const expectancyR = resolvedCount > 0
    ? (targetFirstCount * rewardRiskRatio - stopFirstCount) / resolvedCount
    : null;

  return {
    status: "ready",
    blocker: null,
    sampleSize: candles.length,
    horizonBars,
    episodeCount,
    resolvedCount,
    targetFirstCount,
    stopFirstCount,
    ambiguousCount,
    unresolvedCount,
    targetFirstRatePct: finite(targetFirstRatePct),
    expectancyR: finite(expectancyR),
    rewardRiskRatio: finite(rewardRiskRatio),
    medianBarsToResolution: median(resolutionBars),
  };
}

function entryTouched(candle: Candle, side: "buy" | "sell", entry: number) {
  return side === "buy" ? candle.low <= entry : candle.high >= entry;
}

function stopTouched(candle: Candle, side: "buy" | "sell", stop: number) {
  return side === "buy" ? candle.low <= stop : candle.high >= stop;
}

function targetTouched(candle: Candle, side: "buy" | "sell", target: number) {
  return side === "buy" ? candle.high >= target : candle.low <= target;
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
      t == null || t <= previousTime || open == null || high == null || low == null || close == null
      || high < low || high < Math.max(open, close) || low > Math.min(open, close)
    ) return null;
    result.push({ t, high, low });
    previousTime = t;
  }
  return result;
}

function unavailable(
  blocker: TerminalPlanPathStudyBlocker,
  sampleSize = 0,
  horizonBars = 20,
): TerminalPlanPathStudy {
  return {
    status: "unavailable",
    blocker,
    sampleSize,
    horizonBars,
    episodeCount: 0,
    resolvedCount: 0,
    targetFirstCount: 0,
    stopFirstCount: 0,
    ambiguousCount: 0,
    unresolvedCount: 0,
    targetFirstRatePct: null,
    expectancyR: null,
    rewardRiskRatio: null,
    medianBarsToResolution: null,
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle] as number
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

function positive(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function finite(value: number | null): number | null {
  return value != null && Number.isFinite(value) ? value : null;
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number) {
  const candidate = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, Math.floor(candidate)));
}
