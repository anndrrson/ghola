import type { GholaChartCandle } from "./ghola-market-chart";
import { inferGholaCandleIntervalMs } from "./ghola-market-structure";

export type GholaTimeframeTrend = "up" | "down" | "flat" | "insufficient";
export type GholaTimeframeVolatility = "expanded" | "normal" | "compressed" | "insufficient";
export type GholaTimeframeConfluence = "bullish" | "bearish" | "mixed" | "neutral" | "insufficient";

export interface GholaTimeframeContext {
  factor: number;
  intervalMs: number;
  completedBars: number;
  lastClose: number | null;
  lastTime: number | null;
  trend: GholaTimeframeTrend;
  momentumPct: number | null;
  momentumBars: number;
  volatilityPct: number | null;
  volatilityRegime: GholaTimeframeVolatility;
  volatilityRatio: number | null;
  sparkline: number[];
}

export interface GholaMultiTimeframeConfluence {
  baseIntervalMs: number;
  sourceBars: number;
  completedSourceBars: number;
  timeframes: GholaTimeframeContext[];
  confluence: GholaTimeframeConfluence;
  upCount: number;
  downCount: number;
  flatCount: number;
}

const DEFAULT_FACTORS = [1, 4, 12] as const;

export function buildGholaMultiTimeframeConfluence(
  candles: GholaChartCandle[],
  factors: readonly number[] = DEFAULT_FACTORS,
): GholaMultiTimeframeConfluence {
  const ordered = normalizedCandles(candles);
  const baseIntervalMs = inferGholaCandleIntervalMs(ordered);
  // At any replay cursor the newest revealed bar may still be forming. Excluding
  // it makes every derived view use only information available at that cursor.
  const closedSource = ordered.length > 1 ? ordered.slice(0, -1) : [];
  const normalizedFactors = uniqueFactors(factors);
  const timeframes = normalizedFactors.map((factor) =>
    timeframeContext(completeAggregates(closedSource, baseIntervalMs, factor), baseIntervalMs, factor)
  );
  const upCount = timeframes.filter((timeframe) => timeframe.trend === "up").length;
  const downCount = timeframes.filter((timeframe) => timeframe.trend === "down").length;
  const flatCount = timeframes.filter((timeframe) => timeframe.trend === "flat").length;
  return {
    baseIntervalMs,
    sourceBars: ordered.length,
    completedSourceBars: closedSource.length,
    timeframes,
    confluence: confluenceFor(timeframes, upCount, downCount, flatCount),
    upCount,
    downCount,
    flatCount,
  };
}

export function gholaMultiTimeframeAccessibleSummary(
  context: GholaMultiTimeframeConfluence,
): string {
  const agreement = context.confluence === "bullish"
    ? `Bullish agreement across ${context.upCount} timeframes.`
    : context.confluence === "bearish"
      ? `Bearish agreement across ${context.downCount} timeframes.`
      : context.confluence === "mixed"
        ? `Mixed directional context with ${context.upCount} rising and ${context.downCount} falling timeframes.`
        : context.confluence === "neutral"
          ? "No directional agreement across the completed timeframes."
          : "Insufficient completed bars for multi-timeframe agreement.";
  const details = context.timeframes.map((timeframe) => {
    const close = timeframe.lastClose == null ? "unavailable" : formatSummaryNumber(timeframe.lastClose);
    const momentum = timeframe.momentumPct == null
      ? "unavailable"
      : `${signed(timeframe.momentumPct)} percent over ${timeframe.momentumBars} bars`;
    const volatility = timeframe.volatilityPct == null
      ? "unavailable"
      : `${timeframe.volatilityPct.toFixed(2)} percent ${timeframe.volatilityRegime}`;
    return `${formatGholaTimeframe(timeframe.intervalMs)}: ${timeframe.trend} trend, last close ${close}, momentum ${momentum}, volatility ${volatility}`;
  });
  return `Multi-timeframe context from ${context.completedSourceBars} completed of ${context.sourceBars} received candles. ${agreement} ${details.join(". ")}.`;
}

export function formatGholaTimeframe(intervalMs: number): string {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return "—";
  if (intervalMs % 86_400_000 === 0) return `${intervalMs / 86_400_000}d`;
  if (intervalMs % 3_600_000 === 0) return `${intervalMs / 3_600_000}h`;
  if (intervalMs % 60_000 === 0) return `${intervalMs / 60_000}m`;
  if (intervalMs % 1_000 === 0) return `${intervalMs / 1_000}s`;
  return `${Math.round(intervalMs)}ms`;
}

function timeframeContext(
  candles: AggregatedCandle[],
  baseIntervalMs: number,
  factor: number,
): GholaTimeframeContext {
  const closes = candles.map((candle) => candle.close);
  const trend = trendFor(closes);
  const momentumBars = Math.min(5, Math.max(0, closes.length - 1));
  const momentumStart = closes[closes.length - 1 - momentumBars];
  const momentumPct = momentumBars > 0 && momentumStart !== 0
    ? ((closes.at(-1)! - momentumStart) / Math.abs(momentumStart)) * 100
    : null;
  const volatility = volatilityFor(candles);
  const latest = candles.at(-1);
  return {
    factor,
    intervalMs: baseIntervalMs * factor,
    completedBars: candles.length,
    lastClose: latest?.close ?? null,
    lastTime: latest?.time ?? null,
    trend,
    momentumPct: finiteOrNull(momentumPct),
    momentumBars,
    volatilityPct: volatility.atrPct,
    volatilityRegime: volatility.regime,
    volatilityRatio: volatility.ratio,
    sparkline: closes.slice(-24),
  };
}

function trendFor(closes: number[]): GholaTimeframeTrend {
  if (closes.length < 6) return "insufficient";
  const fastPeriod = Math.min(5, Math.max(2, Math.floor(closes.length / 2)));
  const slowPeriod = Math.min(10, closes.length);
  const fast = ema(closes, fastPeriod);
  const slow = ema(closes, slowPeriod);
  const latestFast = fast.at(-1)!;
  const latestSlow = slow.at(-1)!;
  const priorSlow = slow[Math.max(0, slow.length - 3)];
  if (latestFast > latestSlow && latestSlow > priorSlow) return "up";
  if (latestFast < latestSlow && latestSlow < priorSlow) return "down";
  return "flat";
}

function volatilityFor(candles: AggregatedCandle[]): {
  atrPct: number | null;
  regime: GholaTimeframeVolatility;
  ratio: number | null;
} {
  const ranges: number[] = [];
  for (let index = 1; index < candles.length; index += 1) {
    const candle = candles[index];
    const previousClose = candles[index - 1].close;
    if (previousClose === 0) continue;
    const trueRange = Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    );
    ranges.push((trueRange / Math.abs(previousClose)) * 100);
  }
  if (ranges.length === 0) return { atrPct: null, regime: "insufficient", ratio: null };
  const atrPct = average(ranges.slice(-Math.min(14, ranges.length)));
  const recentLength = Math.min(5, ranges.length);
  const baseline = ranges.slice(0, -recentLength).slice(-20);
  if (baseline.length < 5) return { atrPct, regime: "insufficient", ratio: null };
  const recent = average(ranges.slice(-recentLength));
  const baselineMedian = median(baseline);
  const ratio = baselineMedian > 0 ? recent / baselineMedian : null;
  const regime = ratio == null
    ? "insufficient"
    : ratio >= 1.5
      ? "expanded"
      : ratio <= 0.7
        ? "compressed"
        : "normal";
  return { atrPct, regime, ratio };
}

type AggregatedCandle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

function completeAggregates(
  candles: GholaChartCandle[],
  intervalMs: number,
  factor: number,
): AggregatedCandle[] {
  if (candles.length === 0) return [];
  if (factor === 1) return candles.map(toAggregatedCandle);
  const bucketMs = intervalMs * factor;
  const buckets = new Map<number, GholaChartCandle[]>();
  for (const candle of candles) {
    const time = timestampMs(candle.t);
    const bucket = Math.floor(time / bucketMs) * bucketMs;
    const values = buckets.get(bucket) ?? [];
    values.push(candle);
    buckets.set(bucket, values);
  }
  return [...buckets.entries()].sort(([a], [b]) => a - b).flatMap(([time, values]) => {
    if (!completeBucket(values, intervalMs, factor)) return [];
    const normalized = values.map(toAggregatedCandle);
    return [{
      time,
      open: normalized[0].open,
      high: Math.max(...normalized.map((candle) => candle.high)),
      low: Math.min(...normalized.map((candle) => candle.low)),
      close: normalized.at(-1)!.close,
      volume: normalized.reduce((total, candle) => total + candle.volume, 0),
    }];
  });
}

function completeBucket(candles: GholaChartCandle[], intervalMs: number, factor: number) {
  if (candles.length !== factor) return false;
  for (let index = 1; index < candles.length; index += 1) {
    const difference = timestampMs(candles[index].t) - timestampMs(candles[index - 1].t);
    if (Math.abs(difference - intervalMs) > Math.max(1, intervalMs * 0.01)) return false;
  }
  return true;
}

function normalizedCandles(candles: GholaChartCandle[]) {
  const byTime = new Map<number, GholaChartCandle>();
  for (const candle of candles) {
    const time = timestampMs(candle.t);
    if (time <= 0 || !validCandle(candle)) continue;
    byTime.set(time, candle);
  }
  return [...byTime.entries()].sort(([a], [b]) => a - b).map(([, candle]) => candle);
}

function uniqueFactors(factors: readonly number[]) {
  const normalized = factors
    .map((factor) => Math.min(48, Math.max(1, Math.round(factor))))
    .filter(Number.isFinite);
  return Array.from(new Set(normalized.length > 0 ? normalized : DEFAULT_FACTORS)).slice(0, 4);
}

function confluenceFor(
  timeframes: GholaTimeframeContext[],
  upCount: number,
  downCount: number,
  flatCount: number,
): GholaTimeframeConfluence {
  const available = timeframes.length - timeframes.filter((timeframe) => timeframe.trend === "insufficient").length;
  if (available < 2) return "insufficient";
  if (upCount >= 2 && downCount === 0) return "bullish";
  if (downCount >= 2 && upCount === 0) return "bearish";
  if (upCount > 0 && downCount > 0) return "mixed";
  if (flatCount >= 2 || upCount + downCount === 0) return "neutral";
  return "mixed";
}

function toAggregatedCandle(candle: GholaChartCandle): AggregatedCandle {
  return {
    time: timestampMs(candle.t),
    open: Number(candle.o),
    high: Number(candle.h),
    low: Number(candle.l),
    close: Number(candle.c),
    volume: Math.max(0, Number(candle.v)),
  };
}

function validCandle(candle: GholaChartCandle) {
  return [candle.o, candle.h, candle.l, candle.c, candle.v].every((value) => Number.isFinite(Number(value)));
}

function ema(values: number[], period: number) {
  const alpha = 2 / (period + 1);
  let previous = values[0];
  return values.map((value, index) => {
    previous = index === 0 ? value : value * alpha + previous * (1 - alpha);
    return previous;
  });
}

function timestampMs(value: number) {
  if (!Number.isFinite(value)) return 0;
  if (Math.abs(value) < 100_000_000_000) return value * 1_000;
  if (Math.abs(value) > 100_000_000_000_000) return value / 1_000;
  return value;
}

function average(values: number[]) {
  return values.reduce((total, value) => total + value, 0) / Math.max(1, values.length);
}

function median(values: number[]) {
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function finiteOrNull(value: number | null) {
  return value != null && Number.isFinite(value) ? value : null;
}

function signed(value: number) {
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}`;
}

function formatSummaryNumber(value: number) {
  const digits = Math.abs(value) >= 1_000 ? 2 : Math.abs(value) >= 1 ? 4 : 6;
  return value.toLocaleString("en-US", { maximumFractionDigits: digits });
}
