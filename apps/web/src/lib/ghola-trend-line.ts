import type { GholaChartCandle } from "./ghola-market-chart";

export type GholaTrendLineKind = "segment" | "ray";

export interface GholaTrendLineAnchor {
  time: number;
  price: number;
}

export interface GholaTrendLinePoint extends GholaTrendLineAnchor {
  candleIndex: number;
}

export interface GholaTrendLineGeometry {
  kind: GholaTrendLineKind;
  start: GholaTrendLinePoint;
  end: GholaTrendLinePoint;
  bars: number;
  elapsedMs: number;
  absoluteChange: number;
  changePct: number;
  slopePerBar: number;
  slopePctPerBar: number;
  projection: GholaTrendLinePoint[];
}

/**
 * Resolves a two-point drawing against only the supplied candle prefix. A line
 * with an unrevealed endpoint returns null; a ray projects only to the final
 * supplied candle, which keeps replay calculations free of future data.
 */
export function calculateGholaTrendLine(
  candles: GholaChartCandle[],
  first: GholaTrendLineAnchor,
  second: GholaTrendLineAnchor,
  kind: GholaTrendLineKind,
): GholaTrendLineGeometry | null {
  const firstPrice = finitePositive(first.price);
  const secondPrice = finitePositive(second.price);
  if (firstPrice == null || secondPrice == null || candles.length < 2) return null;
  const firstIndex = candleIndexAtTime(candles, first.time);
  const secondIndex = candleIndexAtTime(candles, second.time);
  if (firstIndex < 0 || secondIndex < 0 || firstIndex === secondIndex) return null;

  const firstPoint = { candleIndex: firstIndex, time: candles[firstIndex].t, price: firstPrice };
  const secondPoint = { candleIndex: secondIndex, time: candles[secondIndex].t, price: secondPrice };
  const start = firstIndex < secondIndex ? firstPoint : secondPoint;
  const end = firstIndex < secondIndex ? secondPoint : firstPoint;
  const bars = end.candleIndex - start.candleIndex;
  const absoluteChange = end.price - start.price;
  const slopePerBar = absoluteChange / bars;
  const projectionEnd = kind === "ray" ? candles.length - 1 : end.candleIndex;
  const projection: GholaTrendLinePoint[] = [];
  for (let candleIndex = start.candleIndex; candleIndex <= projectionEnd; candleIndex += 1) {
    projection.push({
      candleIndex,
      time: candles[candleIndex].t,
      price: start.price + slopePerBar * (candleIndex - start.candleIndex),
    });
  }

  return {
    kind,
    start,
    end,
    bars,
    elapsedMs: Math.abs(timestampMs(end.time) - timestampMs(start.time)),
    absoluteChange,
    changePct: (absoluteChange / start.price) * 100,
    slopePerBar,
    slopePctPerBar: (slopePerBar / start.price) * 100,
    projection,
  };
}

function candleIndexAtTime(candles: GholaChartCandle[], time: number) {
  const target = timestampMs(time);
  if (!Number.isFinite(target)) return -1;
  return candles.findIndex((candle) => timestampMs(candle.t) === target);
}

function finitePositive(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function timestampMs(value: number) {
  if (!Number.isFinite(value)) return Number.NaN;
  if (Math.abs(value) < 100_000_000_000) return value * 1_000;
  if (Math.abs(value) > 100_000_000_000_000) return value / 1_000;
  return value;
}
