import { describe, expect, it } from "vitest";
import { calculateGholaAnchoredVwap } from "./ghola-anchored-vwap";
import type { GholaChartCandle } from "./ghola-market-chart";

describe("ghola anchored VWAP", () => {
  it("uses actual typical price and volume with weighted deviation", () => {
    const result = calculateGholaAnchoredVwap([
      candle(0, 9, 11, 10, 10, 1),
      candle(1, 19, 21, 20, 20, 3),
    ], 0);

    expect(result?.points).toHaveLength(2);
    expect(result?.latest.vwap).toBeCloseTo(17.5);
    expect(result?.latest.deviation).toBeCloseTo(Math.sqrt(18.75));
    expect(result?.latest.bands[0]).toMatchObject({ multiplier: 1 });
    expect(result?.latest.bands[0].upper).toBeCloseTo(17.5 + Math.sqrt(18.75));
    expect(result?.latest.bands[1].lower).toBeCloseTo(17.5 - Math.sqrt(18.75) * 2);
    expect(result?.totalVolume).toBe(4);
  });

  it("starts exactly at the selected anchor", () => {
    const result = calculateGholaAnchoredVwap([
      candle(0, 90, 110, 100, 100, 1000),
      candle(1, 10, 10, 10, 10, 2),
      candle(2, 20, 20, 20, 20, 2),
    ], 1);

    expect(result?.anchorIndex).toBe(1);
    expect(result?.anchorTime).toBe(candleTime(1));
    expect(result?.points.map((point) => point.candleIndex)).toEqual([1, 2]);
    expect(result?.latest.vwap).toBe(15);
    expect(result?.totalVolume).toBe(4);
  });

  it("never changes earlier values when future candles arrive", () => {
    const candles = [
      candle(0, 10, 12, 11, 11, 5),
      candle(1, 11, 13, 12, 12, 7),
      candle(2, 50, 70, 60, 60, 100),
    ];
    const replay = calculateGholaAnchoredVwap(candles.slice(0, 2), 0);
    const full = calculateGholaAnchoredVwap(candles, 0);

    expect(full?.points.slice(0, 2)).toEqual(replay?.points);
    expect(replay?.latest.time).toBe(candleTime(1));
    expect(full?.latest.time).toBe(candleTime(2));
  });

  it("skips zero-volume candles without inventing weight", () => {
    const result = calculateGholaAnchoredVwap([
      candle(0, 10, 10, 10, 10, 0),
      candle(1, 20, 20, 20, 20, 2),
    ], 0);

    expect(result?.points).toHaveLength(1);
    expect(result?.latest.vwap).toBe(20);
    expect(result?.latest.deviation).toBe(0);
    expect(calculateGholaAnchoredVwap([candle(0, 10, 10, 10, 10, 0)], 0)).toBeNull();
  });

  it("bounds and deduplicates optional band multipliers", () => {
    const result = calculateGholaAnchoredVwap([
      candle(0, 10, 10, 10, 10, 1),
    ], 0, { deviationMultipliers: [2, 1, 2, 99, -1] });

    expect(result?.multipliers).toEqual([1, 2, 4]);
    expect(result?.latest.bands.map((band) => band.multiplier)).toEqual([1, 2, 4]);
  });
});

function candle(index: number, low: number, high: number, open: number, close: number, volume: number): GholaChartCandle {
  const t = candleTime(index);
  return { t, T: t + 59_999, o: String(open), h: String(high), l: String(low), c: String(close), v: String(volume), n: 1 };
}

function candleTime(index: number) {
  return Date.parse("2026-08-12T00:00:00.000Z") + index * 60_000;
}
