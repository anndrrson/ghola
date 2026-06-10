// Pure chart math for the Phoenix live SOL terminal. No DOM, no React — unit-testable.
// Mirrors `hyperliquid-chart-helpers.ts` and adds interpolation + pixel<->price mapping
// used by the canvas renderer and click-to-trade.

export type PhoenixChartMode = "candles" | "line" | "depth";

export interface PhoenixChartCandle {
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
}

export interface PhoenixChartBookLevel {
  px: string;
  sz: string;
}

export interface PhoenixDepthPoint {
  px: number;
  sz: number;
  cumulative: number;
}

export interface PhoenixPriceRange {
  min: number;
  max: number;
  range: number;
}

export function phoenixCandlePriceRange(candles: PhoenixChartCandle[]): PhoenixPriceRange {
  const lows = candles.map((candle) => Number(candle.l)).filter((value) => Number.isFinite(value));
  const highs = candles.map((candle) => Number(candle.h)).filter((value) => Number.isFinite(value));
  if (lows.length === 0 || highs.length === 0) {
    return { min: 0, max: 1, range: 1 };
  }
  const rawMin = Math.min(...lows);
  const rawMax = Math.max(...highs);
  const rawRange = Math.max(Number.EPSILON, rawMax - rawMin);
  const padding = rawRange * 0.08;
  return { min: rawMin - padding, max: rawMax + padding, range: rawRange + padding * 2 };
}

// Range over an arbitrary list of prices (used for the live line + last-price tag).
export function phoenixPriceSeriesRange(prices: number[]): PhoenixPriceRange {
  const finite = prices.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return { min: 0, max: 1, range: 1 };
  const rawMin = Math.min(...finite);
  const rawMax = Math.max(...finite);
  const rawRange = Math.max(Number.EPSILON, rawMax - rawMin);
  const padding = rawRange * 0.12 || 1;
  return { min: rawMin - padding, max: rawMax + padding, range: rawRange + padding * 2 };
}

export function phoenixCumulativeDepth(levels: PhoenixChartBookLevel[]): PhoenixDepthPoint[] {
  let cumulative = 0;
  const points = levels
    .map((level) => {
      const px = Number(level.px);
      const sz = Number(level.sz);
      if (!Number.isFinite(px) || !Number.isFinite(sz)) return null;
      cumulative += sz;
      return { px, sz, cumulative };
    })
    .filter(Boolean) as PhoenixDepthPoint[];
  return points.sort((a, b) => a.px - b.px);
}

export function phoenixDepthMax(points: PhoenixDepthPoint[]): number {
  return Math.max(Number.EPSILON, ...points.map((point) => point.cumulative).filter((value) => Number.isFinite(value)));
}

export function nearestPhoenixCandleIndex(
  candleCount: number,
  pointerX: number,
  chartLeft: number,
  chartWidth: number,
): number | null {
  if (candleCount <= 0 || chartWidth <= 0) return null;
  const relative = Math.min(Math.max(pointerX - chartLeft, 0), chartWidth);
  return Math.min(candleCount - 1, Math.max(0, Math.round((relative / chartWidth) * (candleCount - 1))));
}

// Eased lerp toward the latest tick. `alpha` is a per-frame factor in [0,1]; the
// renderer derives it from frame dt so the glide is framerate-independent.
export function interpolatePrice(current: number, target: number, alpha: number): number {
  if (!Number.isFinite(current)) return target;
  if (!Number.isFinite(target)) return current;
  const a = Math.min(1, Math.max(0, alpha));
  return current + (target - current) * a;
}

// Per-frame alpha for a time-constant `tau` (ms): higher dt => faster catch-up.
export function frameAlpha(dtMs: number, tauMs = 90): number {
  if (!(dtMs > 0)) return 0;
  if (!(tauMs > 0)) return 1;
  return 1 - Math.exp(-dtMs / tauMs);
}

// Map a canvas Y pixel (top-origin) to a price within [min,max]. Top => max.
export function priceAtCanvasY(y: number, top: number, height: number, min: number, max: number): number {
  if (height <= 0) return min;
  const clamped = Math.min(Math.max(y - top, 0), height);
  const fraction = 1 - clamped / height;
  return min + fraction * (max - min);
}

// Inverse of `priceAtCanvasY` — price to canvas Y pixel.
export function canvasYForPrice(price: number, top: number, height: number, min: number, max: number): number {
  const range = max - min;
  if (range <= 0) return top + height;
  const fraction = (price - min) / range;
  return top + (1 - Math.min(Math.max(fraction, 0), 1)) * height;
}

// Format a price to a sensible number of decimals for SOL (~2 decimals) without
// pinning to a currency. Used for the order ticket prefill string.
export function formatPhoenixPrice(price: number): string {
  if (!Number.isFinite(price)) return "0";
  const decimals = price >= 1000 ? 2 : price >= 1 ? 3 : 5;
  return Number(price.toFixed(decimals)).toString();
}
