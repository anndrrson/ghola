import { describe, expect, it } from "vitest";
import { calculateGholaTrendLine } from "./ghola-trend-line";
import type { GholaChartCandle } from "./ghola-market-chart";

describe("ghola trend-line geometry", () => {
  it("calculates a finite segment and its per-bar statistics", () => {
    const candles = series(6);
    const result = calculateGholaTrendLine(
      candles,
      { time: candles[1].t, price: 100 },
      { time: candles[4].t, price: 112 },
      "segment",
    );

    expect(result).toMatchObject({
      kind: "segment",
      bars: 3,
      absoluteChange: 12,
      changePct: 12,
      slopePerBar: 4,
      slopePctPerBar: 4,
      elapsedMs: 180_000,
    });
    expect(result?.projection.map((point) => point.price)).toEqual([100, 104, 108, 112]);
    expect(result?.projection.map((point) => point.candleIndex)).toEqual([1, 2, 3, 4]);
  });

  it("right-extends a ray only through supplied candles", () => {
    const candles = series(6);
    const replay = calculateGholaTrendLine(
      candles.slice(0, 5),
      { time: candles[1].t, price: 100 },
      { time: candles[3].t, price: 104 },
      "ray",
    );
    const full = calculateGholaTrendLine(
      candles,
      { time: candles[1].t, price: 100 },
      { time: candles[3].t, price: 104 },
      "ray",
    );

    expect(replay?.projection.at(-1)).toMatchObject({ candleIndex: 4, price: 106 });
    expect(full?.projection.at(-1)).toMatchObject({ candleIndex: 5, price: 108 });
    expect(full?.projection.slice(0, replay?.projection.length)).toEqual(replay?.projection);
  });

  it("normalizes reverse-selected endpoints into chronological slope", () => {
    const candles = series(5);
    const result = calculateGholaTrendLine(
      candles,
      { time: candles[4].t, price: 90 },
      { time: candles[1].t, price: 105 },
      "segment",
    );

    expect(result?.start).toMatchObject({ candleIndex: 1, price: 105 });
    expect(result?.end).toMatchObject({ candleIndex: 4, price: 90 });
    expect(result?.slopePerBar).toBe(-5);
    expect(result?.changePct).toBeCloseTo(-14.285714);
  });

  it("hides a drawing until both endpoints are revealed", () => {
    const candles = series(6);
    const first = { time: candles[1].t, price: 100 };
    const future = { time: candles[4].t, price: 112 };

    expect(calculateGholaTrendLine(candles.slice(0, 4), first, future, "segment")).toBeNull();
    expect(calculateGholaTrendLine(candles.slice(0, 5), first, future, "segment")?.bars).toBe(3);
  });

  it("rejects invalid prices, duplicate candles, and unknown timestamps", () => {
    const candles = series(3);
    expect(calculateGholaTrendLine(candles, { time: candles[0].t, price: 0 }, { time: candles[1].t, price: 2 }, "ray")).toBeNull();
    expect(calculateGholaTrendLine(candles, { time: candles[0].t, price: 1 }, { time: candles[0].t, price: 2 }, "ray")).toBeNull();
    expect(calculateGholaTrendLine(candles, { time: candles[0].t, price: 1 }, { time: 42, price: 2 }, "segment")).toBeNull();
  });
});

function series(length: number): GholaChartCandle[] {
  return Array.from({ length }, (_, index) => {
    const t = Date.parse("2026-08-12T00:00:00.000Z") + index * 60_000;
    return { t, T: t + 59_999, o: "100", h: "101", l: "99", c: "100", v: "10", n: 1 };
  });
}
