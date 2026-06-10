import { describe, expect, it } from "vitest";
import {
  hyperliquidCandlePriceRange,
  hyperliquidCumulativeDepth,
  hyperliquidDepthMax,
  nearestHyperliquidCandleIndex,
  type HyperliquidChartCandle,
} from "./hyperliquid-chart-helpers";

const candles: HyperliquidChartCandle[] = [
  { t: 1, T: 2, o: "100", h: "110", l: "95", c: "108", v: "5", n: 10 },
  { t: 3, T: 4, o: "108", h: "120", l: "105", c: "112", v: "8", n: 12 },
  { t: 5, T: 6, o: "112", h: "116", l: "90", c: "91", v: "11", n: 14 },
];

describe("Hyperliquid chart helpers", () => {
  it("calculates a padded candle price range", () => {
    const range = hyperliquidCandlePriceRange(candles);

    expect(range.min).toBeLessThan(90);
    expect(range.max).toBeGreaterThan(120);
    expect(range.range).toBeGreaterThan(30);
  });

  it("builds cumulative depth without losing price order", () => {
    const bids = hyperliquidCumulativeDepth([
      { px: "100", sz: "1", n: 2 },
      { px: "99", sz: "2", n: 1 },
      { px: "98", sz: "3", n: 1 },
    ], "bid");
    const asks = hyperliquidCumulativeDepth([
      { px: "101", sz: "4", n: 2 },
      { px: "102", sz: "5", n: 1 },
    ], "ask");

    expect(bids.map((point) => point.px)).toEqual([98, 99, 100]);
    expect(bids.map((point) => point.cumulative)).toEqual([6, 3, 1]);
    expect(asks.map((point) => point.cumulative)).toEqual([4, 9]);
    expect(hyperliquidDepthMax([...bids, ...asks])).toBe(9);
  });

  it("finds the nearest candle from pointer position", () => {
    expect(nearestHyperliquidCandleIndex(5, 10, 10, 100)).toBe(0);
    expect(nearestHyperliquidCandleIndex(5, 60, 10, 100)).toBe(2);
    expect(nearestHyperliquidCandleIndex(5, 500, 10, 100)).toBe(4);
    expect(nearestHyperliquidCandleIndex(0, 60, 10, 100)).toBeNull();
  });
});
