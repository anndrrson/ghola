export type HyperliquidChartMode = "candles" | "line" | "depth";

export interface HyperliquidChartCandle {
  t: number;
  T: number | null;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
  n: number | null;
}

export interface HyperliquidChartBookLevel {
  px: string;
  sz: string;
  n: number | null;
}

export interface HyperliquidDepthPoint {
  px: number;
  sz: number;
  cumulative: number;
}

export function hyperliquidCandlePriceRange(candles: HyperliquidChartCandle[]) {
  const lows = candles.map((candle) => Number(candle.l)).filter((value) => Number.isFinite(value));
  const highs = candles.map((candle) => Number(candle.h)).filter((value) => Number.isFinite(value));
  if (lows.length === 0 || highs.length === 0) {
    return { min: 0, max: 1, range: 1 };
  }
  const rawMin = Math.min(...lows);
  const rawMax = Math.max(...highs);
  const rawRange = Math.max(1, rawMax - rawMin);
  const padding = rawRange * 0.08;
  return {
    min: rawMin - padding,
    max: rawMax + padding,
    range: rawRange + padding * 2,
  };
}

export function hyperliquidCumulativeDepth(
  levels: HyperliquidChartBookLevel[],
  side: "bid" | "ask",
): HyperliquidDepthPoint[] {
  let cumulative = 0;
  const points = levels.map((level) => {
    const px = Number(level.px);
    const sz = Number(level.sz);
    if (!Number.isFinite(px) || !Number.isFinite(sz)) return null;
    cumulative += sz;
    return { px, sz, cumulative };
  }).filter(Boolean) as HyperliquidDepthPoint[];

  return side === "bid"
    ? points.sort((a, b) => a.px - b.px)
    : points.sort((a, b) => a.px - b.px);
}

export function nearestHyperliquidCandleIndex(
  candleCount: number,
  pointerX: number,
  chartLeft: number,
  chartWidth: number,
) {
  if (candleCount <= 0 || chartWidth <= 0) return null;
  const relative = Math.min(Math.max(pointerX - chartLeft, 0), chartWidth);
  return Math.min(candleCount - 1, Math.max(0, Math.round((relative / chartWidth) * (candleCount - 1))));
}

export function hyperliquidDepthMax(points: HyperliquidDepthPoint[]) {
  return Math.max(1, ...points.map((point) => point.cumulative).filter((value) => Number.isFinite(value)));
}
