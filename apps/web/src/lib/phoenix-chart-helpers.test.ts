import { describe, expect, it } from "vitest";
import {
  canvasYForPrice,
  formatPhoenixPrice,
  frameAlpha,
  interpolatePrice,
  nearestPhoenixCandleIndex,
  phoenixCandlePriceRange,
  phoenixCumulativeDepth,
  phoenixDepthMax,
  phoenixPriceSeriesRange,
  priceAtCanvasY,
  type PhoenixChartBookLevel,
  type PhoenixChartCandle,
} from "./phoenix-chart-helpers";

const candles: PhoenixChartCandle[] = [
  { t: 1, o: "150", h: "155", l: "148", c: "152", v: "5" },
  { t: 2, o: "152", h: "160", l: "151", c: "158", v: "8" },
  { t: 3, o: "158", h: "159", l: "144", c: "146", v: "11" },
];

const asks: PhoenixChartBookLevel[] = [
  { px: "150.2", sz: "3" },
  { px: "150.3", sz: "2" },
];
const bids: PhoenixChartBookLevel[] = [
  { px: "150.1", sz: "4" },
  { px: "150.0", sz: "1" },
];

describe("Phoenix chart helpers", () => {
  it("pads the candle price range around the high/low", () => {
    const range = phoenixCandlePriceRange(candles);
    expect(range.min).toBeLessThan(144);
    expect(range.max).toBeGreaterThan(160);
    expect(range.range).toBeGreaterThan(16);
  });

  it("returns a safe range for empty candles", () => {
    expect(phoenixCandlePriceRange([])).toEqual({ min: 0, max: 1, range: 1 });
  });

  it("builds a padded series range for the live line", () => {
    const range = phoenixPriceSeriesRange([150, 151, 149]);
    expect(range.min).toBeLessThan(149);
    expect(range.max).toBeGreaterThan(151);
  });

  it("accumulates depth in ascending price order", () => {
    const askDepth = phoenixCumulativeDepth(asks);
    expect(askDepth.map((p) => p.px)).toEqual([150.2, 150.3]);
    expect(askDepth[askDepth.length - 1].cumulative).toBe(5);
    expect(phoenixDepthMax(askDepth)).toBe(5);
    expect(phoenixDepthMax([])).toBeGreaterThan(0);
  });

  it("maps a pointer X to the nearest candle index", () => {
    expect(nearestPhoenixCandleIndex(3, 0, 0, 100)).toBe(0);
    expect(nearestPhoenixCandleIndex(3, 100, 0, 100)).toBe(2);
    expect(nearestPhoenixCandleIndex(3, 50, 0, 100)).toBe(1);
    expect(nearestPhoenixCandleIndex(0, 50, 0, 100)).toBeNull();
  });

  it("interpolates toward the target and clamps alpha", () => {
    expect(interpolatePrice(100, 200, 0.5)).toBe(150);
    expect(interpolatePrice(100, 200, 2)).toBe(200);
    expect(interpolatePrice(Number.NaN, 200, 0.5)).toBe(200);
  });

  it("produces a framerate-independent alpha in [0,1]", () => {
    expect(frameAlpha(0)).toBe(0);
    const a = frameAlpha(16, 90);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(1);
    expect(frameAlpha(1000, 90)).toBeGreaterThan(a);
  });

  it("round-trips price <-> canvas Y", () => {
    const top = 10;
    const height = 200;
    const min = 100;
    const max = 200;
    // Top of the chart is the max price; bottom is the min.
    expect(priceAtCanvasY(top, top, height, min, max)).toBeCloseTo(max);
    expect(priceAtCanvasY(top + height, top, height, min, max)).toBeCloseTo(min);
    const y = canvasYForPrice(150, top, height, min, max);
    expect(priceAtCanvasY(y, top, height, min, max)).toBeCloseTo(150);
  });

  it("formats prices with sensible precision", () => {
    expect(formatPhoenixPrice(152.456)).toBe("152.456");
    expect(formatPhoenixPrice(1500.123)).toBe("1500.12");
    expect(formatPhoenixPrice(0.123456)).toBe("0.12346");
  });
});
