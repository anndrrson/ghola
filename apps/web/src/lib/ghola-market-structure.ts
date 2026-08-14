import type { GholaChartCandle } from "./ghola-market-chart";

export type GholaStructureTrend = "up" | "down" | "neutral";
export type GholaVolatilityRegime = "compressed" | "normal" | "expanded" | "unknown";

export interface GholaStructureMarker {
  id: string;
  kind: "swing_high" | "swing_low" | "high_break" | "low_break" | "trend_shift";
  index: number;
  time: number;
  price: number;
  confirmedIndex: number;
  confirmedTime: number;
  direction: "up" | "down";
  label: string;
  detail: string;
}

export interface GholaMarketStructure {
  markers: GholaStructureMarker[];
  trend: GholaStructureTrend;
  lastSwingHigh: GholaStructureMarker | null;
  lastSwingLow: GholaStructureMarker | null;
  lastBreak: GholaStructureMarker | null;
}

export interface GholaVolatilityContext {
  regime: GholaVolatilityRegime;
  currentAtrPct: number | null;
  baselineAtrPct: number | null;
  ratio: number | null;
}

export interface GholaMultiTimeframeStructure {
  base: GholaMarketStructure;
  higher: GholaMarketStructure;
  higherCandles: GholaChartCandle[];
  higherFactor: number;
  baseIntervalMs: number;
  higherIntervalMs: number;
  volatility: GholaVolatilityContext;
}

export interface GholaStructureOptions {
  leftBars?: number;
  rightBars?: number;
  maxMarkers?: number;
}

export function detectGholaMarketStructure(
  candles: GholaChartCandle[],
  options: GholaStructureOptions = {},
): GholaMarketStructure {
  const leftBars = boundedInteger(options.leftBars, 2, 1, 8);
  const rightBars = boundedInteger(options.rightBars, 2, 1, 8);
  const maxMarkers = boundedInteger(options.maxMarkers, 48, 1, 96);
  const swings: GholaStructureMarker[] = [];
  let previousHigh: GholaStructureMarker | null = null;
  let previousLow: GholaStructureMarker | null = null;
  for (let index = leftBars; index < candles.length - rightBars; index += 1) {
    const high = candleNumber(candles[index], "h");
    const low = candleNumber(candles[index], "l");
    if (high != null && isStrictPivot(candles, index, leftBars, rightBars, "h", high, "high")) {
      const label = previousHigh == null ? "SH" : high > previousHigh.price ? "HH" : high < previousHigh.price ? "LH" : "EQH";
      const marker = swingMarker(candles, index, index + rightBars, high, "swing_high", label, swingDetail(label));
      swings.push(marker);
      previousHigh = marker;
    }
    if (low != null && isStrictPivot(candles, index, leftBars, rightBars, "l", low, "low")) {
      const label = previousLow == null ? "SL" : low > previousLow.price ? "HL" : low < previousLow.price ? "LL" : "EQL";
      const marker = swingMarker(candles, index, index + rightBars, low, "swing_low", label, swingDetail(label));
      swings.push(marker);
      previousLow = marker;
    }
  }

  const confirmations = new Map<number, GholaStructureMarker[]>();
  for (const swing of swings) {
    const bucket = confirmations.get(swing.confirmedIndex) ?? [];
    bucket.push(swing);
    confirmations.set(swing.confirmedIndex, bucket);
  }
  const breaks: GholaStructureMarker[] = [];
  let activeHigh: GholaStructureMarker | null = null;
  let activeLow: GholaStructureMarker | null = null;
  let brokenHighId: string | null = null;
  let brokenLowId: string | null = null;
  let lastBreakDirection: "up" | "down" | null = null;
  for (let index = 1; index < candles.length; index += 1) {
    for (const swing of confirmations.get(index) ?? []) {
      if (swing.kind === "swing_high") {
        activeHigh = swing;
        brokenHighId = null;
      } else {
        activeLow = swing;
        brokenLowId = null;
      }
    }
    const close = candleNumber(candles[index], "c");
    const previousClose = candleNumber(candles[index - 1], "c");
    if (close == null || previousClose == null) continue;
    if (activeHigh && brokenHighId !== activeHigh.id && previousClose <= activeHigh.price && close > activeHigh.price) {
      const shifted = lastBreakDirection === "down";
      const marker = breakMarker(candles, index, activeHigh, "up", shifted);
      breaks.push(marker);
      brokenHighId = activeHigh.id;
      lastBreakDirection = "up";
    }
    if (activeLow && brokenLowId !== activeLow.id && previousClose >= activeLow.price && close < activeLow.price) {
      const shifted = lastBreakDirection === "up";
      const marker = breakMarker(candles, index, activeLow, "down", shifted);
      breaks.push(marker);
      brokenLowId = activeLow.id;
      lastBreakDirection = "down";
    }
  }
  const markers = swings.concat(breaks)
    .sort((a, b) => a.confirmedIndex - b.confirmedIndex || a.index - b.index || a.id.localeCompare(b.id))
    .slice(-maxMarkers);
  return {
    markers,
    trend: lastBreakDirection ?? "neutral",
    lastSwingHigh: previousHigh,
    lastSwingLow: previousLow,
    lastBreak: breaks.at(-1) ?? null,
  };
}

export function aggregateGholaCandles(candles: GholaChartCandle[], factor = 4): GholaChartCandle[] {
  if (candles.length === 0) return [];
  const interval = inferGholaCandleIntervalMs(candles);
  const normalizedFactor = boundedInteger(factor, 4, 2, 24);
  const bucketMs = Math.max(1, interval * normalizedFactor);
  const buckets = new Map<number, GholaChartCandle[]>();
  for (const candle of candles) {
    const time = timestampMs(candle.t);
    if (time <= 0) continue;
    const bucket = Math.floor(time / bucketMs) * bucketMs;
    const values = buckets.get(bucket) ?? [];
    values.push(candle);
    buckets.set(bucket, values);
  }
  return [...buckets.entries()].sort(([a], [b]) => a - b).flatMap(([time, values]) => {
    const valid = values.filter(validOhlcv);
    if (valid.length === 0) return [];
    const volume = valid.reduce((total, candle) => total + Math.max(0, Number(candle.v)), 0);
    const tradeCount = valid.reduce((total, candle) => total + Math.max(0, Number(candle.n) || 0), 0);
    return [{
      t: time,
      T: time + bucketMs - 1,
      o: valid[0].o,
      h: String(Math.max(...valid.map((candle) => Number(candle.h)))),
      l: String(Math.min(...valid.map((candle) => Number(candle.l)))),
      c: valid.at(-1)?.c ?? valid[0].c,
      v: String(volume),
      n: tradeCount > 0 ? tradeCount : null,
    }];
  });
}

export function inferGholaCandleIntervalMs(candles: GholaChartCandle[]) {
  const differences: number[] = [];
  for (let index = 1; index < candles.length; index += 1) {
    const difference = timestampMs(candles[index].t) - timestampMs(candles[index - 1].t);
    if (difference > 0) differences.push(difference);
  }
  if (differences.length === 0) {
    const first = candles[0];
    const duration = first?.T == null ? 0 : timestampMs(first.T) - timestampMs(first.t) + 1;
    return duration > 0 ? duration : 60_000;
  }
  differences.sort((a, b) => a - b);
  return differences[Math.floor(differences.length / 2)];
}

export function gholaVolatilityContext(candles: GholaChartCandle[], period = 14, baselineLength = 50): GholaVolatilityContext {
  const ranges: number[] = [];
  for (let index = 1; index < candles.length; index += 1) {
    const high = candleNumber(candles[index], "h");
    const low = candleNumber(candles[index], "l");
    const previousClose = candleNumber(candles[index - 1], "c");
    if (high == null || low == null || previousClose == null || previousClose === 0) continue;
    const trueRange = Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose));
    ranges.push((trueRange / Math.abs(previousClose)) * 100);
  }
  const normalizedPeriod = boundedInteger(period, 14, 2, 100);
  if (ranges.length < normalizedPeriod) return { regime: "unknown", currentAtrPct: null, baselineAtrPct: null, ratio: null };
  const currentAtrPct = average(ranges.slice(-normalizedPeriod));
  const baselineEnd = Math.max(0, ranges.length - normalizedPeriod);
  const baselineStart = Math.max(0, baselineEnd - boundedInteger(baselineLength, 50, normalizedPeriod, 500));
  const baselineValues = ranges.slice(baselineStart, baselineEnd);
  const baselineAtrPct = baselineValues.length > 0 ? median(baselineValues) : average(ranges);
  const ratio = baselineAtrPct > 0 ? currentAtrPct / baselineAtrPct : null;
  const regime = ratio == null ? "unknown" : ratio >= 1.5 ? "expanded" : ratio <= 0.7 ? "compressed" : "normal";
  return { regime, currentAtrPct, baselineAtrPct, ratio };
}

export function buildGholaMultiTimeframeStructure(candles: GholaChartCandle[], higherFactor = 4): GholaMultiTimeframeStructure {
  const factor = boundedInteger(higherFactor, 4, 2, 24);
  const baseIntervalMs = inferGholaCandleIntervalMs(candles);
  // The newest source and aggregate bars may still be forming. Omitting both is conservative and replay-safe.
  const closedBase = candles.length > 1 ? candles.slice(0, -1) : [];
  const aggregated = aggregateGholaCandles(candles, factor);
  const higherCandles = aggregated.length > 1 ? aggregated.slice(0, -1) : [];
  return {
    base: detectGholaMarketStructure(closedBase),
    higher: detectGholaMarketStructure(higherCandles, { leftBars: 2, rightBars: 2, maxMarkers: 32 }),
    higherCandles,
    higherFactor: factor,
    baseIntervalMs,
    higherIntervalMs: baseIntervalMs * factor,
    volatility: gholaVolatilityContext(closedBase),
  };
}

function isStrictPivot(
  candles: GholaChartCandle[],
  index: number,
  left: number,
  right: number,
  field: "h" | "l",
  value: number,
  side: "high" | "low",
) {
  for (let cursor = index - left; cursor <= index + right; cursor += 1) {
    if (cursor === index) continue;
    const neighbor = candleNumber(candles[cursor], field);
    if (neighbor == null || (side === "high" ? value <= neighbor : value >= neighbor)) return false;
  }
  return true;
}

function swingMarker(
  candles: GholaChartCandle[],
  index: number,
  confirmedIndex: number,
  price: number,
  kind: "swing_high" | "swing_low",
  label: string,
  detail: string,
): GholaStructureMarker {
  return {
    id: `${kind}:${candles[index].t}:${price}`,
    kind,
    index,
    time: candles[index].t,
    price,
    confirmedIndex,
    confirmedTime: candles[confirmedIndex].t,
    direction: kind === "swing_high" ? "down" : "up",
    label,
    detail,
  };
}

function breakMarker(
  candles: GholaChartCandle[],
  index: number,
  swing: GholaStructureMarker,
  direction: "up" | "down",
  shifted: boolean,
): GholaStructureMarker {
  const kind = shifted ? "trend_shift" : direction === "up" ? "high_break" : "low_break";
  const label = shifted ? `Shift ${direction === "up" ? "↑" : "↓"}` : direction === "up" ? "High break" : "Low break";
  return {
    id: `${kind}:${candles[index].t}:${swing.id}`,
    kind,
    index,
    time: candles[index].t,
    price: swing.price,
    confirmedIndex: index,
    confirmedTime: candles[index].t,
    direction,
    label,
    detail: shifted
      ? `Confirmed close through ${direction === "up" ? "swing high" : "swing low"} after an opposite break`
      : `Confirmed close through prior swing ${direction === "up" ? "high" : "low"}`,
  };
}

function swingDetail(label: string) {
  if (label === "HH") return "Higher high";
  if (label === "LH") return "Lower high";
  if (label === "HL") return "Higher low";
  if (label === "LL") return "Lower low";
  if (label === "EQH") return "Equal high";
  if (label === "EQL") return "Equal low";
  return label === "SH" ? "Confirmed swing high" : "Confirmed swing low";
}

function validOhlcv(candle: GholaChartCandle) {
  return [candle.o, candle.h, candle.l, candle.c, candle.v].every((value) => Number.isFinite(Number(value)));
}

function candleNumber(candle: GholaChartCandle | undefined, field: "h" | "l" | "c") {
  if (!candle) return null;
  const value = Number(candle[field]);
  return Number.isFinite(value) ? value : null;
}

function timestampMs(value: number) {
  if (!Number.isFinite(value)) return 0;
  if (Math.abs(value) < 100_000_000_000) return value * 1_000;
  if (Math.abs(value) > 100_000_000_000_000) return value / 1_000;
  return value;
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number) {
  const normalized = value != null && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, normalized));
}

function average(values: number[]) {
  return values.reduce((total, value) => total + value, 0) / Math.max(1, values.length);
}

function median(values: number[]) {
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}
