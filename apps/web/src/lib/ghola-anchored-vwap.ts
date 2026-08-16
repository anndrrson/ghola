import type { GholaChartCandle } from "./ghola-market-chart";

export interface GholaAnchoredVwapBand {
  multiplier: number;
  upper: number;
  lower: number;
}

export interface GholaAnchoredVwapPoint {
  candleIndex: number;
  time: number;
  typicalPrice: number;
  volume: number;
  cumulativeVolume: number;
  vwap: number;
  deviation: number;
  bands: GholaAnchoredVwapBand[];
}

export interface GholaAnchoredVwap {
  anchorIndex: number;
  anchorTime: number;
  anchorTypicalPrice: number;
  points: GholaAnchoredVwapPoint[];
  totalVolume: number;
  latest: GholaAnchoredVwapPoint;
  multipliers: number[];
}

export interface GholaAnchoredVwapOptions {
  deviationMultipliers?: number[];
}

export function calculateGholaAnchoredVwap(
  candles: GholaChartCandle[],
  anchorIndex: number,
  options: GholaAnchoredVwapOptions = {},
): GholaAnchoredVwap | null {
  if (!Number.isFinite(anchorIndex) || anchorIndex < 0 || anchorIndex >= candles.length) return null;
  const normalizedAnchor = Math.round(anchorIndex);
  const anchor = candleValues(candles[normalizedAnchor]);
  if (!anchor) return null;
  const multipliers = normalizeMultipliers(options.deviationMultipliers);
  const points: GholaAnchoredVwapPoint[] = [];
  let cumulativeVolume = 0;
  let mean = 0;
  let weightedM2 = 0;
  for (let index = normalizedAnchor; index < candles.length; index += 1) {
    const candle = candleValues(candles[index]);
    if (!candle || candle.volume <= 0) continue;
    const previousMean = mean;
    cumulativeVolume += candle.volume;
    const delta = candle.typicalPrice - previousMean;
    mean = previousMean + (candle.volume / cumulativeVolume) * delta;
    weightedM2 += candle.volume * delta * (candle.typicalPrice - mean);
    const deviation = Math.sqrt(Math.max(0, weightedM2 / cumulativeVolume));
    points.push({
      candleIndex: index,
      time: candles[index].t,
      typicalPrice: candle.typicalPrice,
      volume: candle.volume,
      cumulativeVolume,
      vwap: mean,
      deviation,
      bands: multipliers.map((multiplier) => ({
        multiplier,
        upper: mean + deviation * multiplier,
        lower: mean - deviation * multiplier,
      })),
    });
  }
  const latest = points.at(-1);
  if (!latest) return null;
  return {
    anchorIndex: normalizedAnchor,
    anchorTime: candles[normalizedAnchor].t,
    anchorTypicalPrice: anchor.typicalPrice,
    points,
    totalVolume: cumulativeVolume,
    latest,
    multipliers,
  };
}

function candleValues(candle: GholaChartCandle | undefined) {
  if (!candle) return null;
  const high = finiteNumber(candle.h);
  const low = finiteNumber(candle.l);
  const close = finiteNumber(candle.c);
  const volume = finiteNumber(candle.v);
  if (high == null || low == null || close == null || volume == null || volume < 0) return null;
  return { typicalPrice: (high + low + close) / 3, volume };
}

function normalizeMultipliers(values: number[] | undefined) {
  const source = values ?? [1, 2];
  return [...new Set(source
    .filter((value) => Number.isFinite(value) && value > 0)
    .map((value) => Math.min(4, Math.max(0.25, value))))]
    .sort((a, b) => a - b)
    .slice(0, 3);
}

function finiteNumber(value: unknown) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
