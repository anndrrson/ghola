import { describe, expect, it } from "vitest";
import {
  buildGholaMultiTimeframeConfluence,
  formatGholaTimeframe,
  gholaMultiTimeframeAccessibleSummary,
} from "./ghola-multi-timeframe-confluence";
import type { GholaChartCandle } from "./ghola-market-chart";

describe("multi-timeframe confluence", () => {
  it("uses only closed source bars and complete aligned higher-timeframe buckets", () => {
    const context = buildGholaMultiTimeframeConfluence(series(25), [1, 4, 12]);

    expect(context).toMatchObject({ sourceBars: 25, completedSourceBars: 24 });
    expect(context.timeframes.map((timeframe) => ({ factor: timeframe.factor, bars: timeframe.completedBars }))).toEqual([
      { factor: 1, bars: 24 },
      { factor: 4, bars: 6 },
      { factor: 12, bars: 2 },
    ]);
    expect(context.timeframes.map((timeframe) => timeframe.lastClose)).toEqual([123, 123, 123]);
  });

  it("is replay-safe because a revealed prefix does not depend on later candles", () => {
    const candles = series(80);
    const prefix = candles.slice(0, 41);

    const beforeFuture = buildGholaMultiTimeframeConfluence(prefix);
    candles.splice(41, 0, ...series(10, 5_000));
    const afterFuture = buildGholaMultiTimeframeConfluence(prefix);

    expect(afterFuture).toEqual(beforeFuture);
    expect(beforeFuture.completedSourceBars).toBe(40);
    expect(beforeFuture.timeframes[0].lastClose).toBe(139);
  });

  it("reports aligned upward trend, momentum, volatility, and bounded sparklines", () => {
    const context = buildGholaMultiTimeframeConfluence(series(145));

    expect(context.confluence).toBe("bullish");
    expect(context.upCount).toBe(3);
    for (const timeframe of context.timeframes) {
      expect(timeframe.trend).toBe("up");
      expect(timeframe.momentumPct).toBeGreaterThan(0);
      expect(timeframe.volatilityPct).toBeGreaterThan(0);
      expect(timeframe.sparkline.length).toBeLessThanOrEqual(24);
    }
  });

  it("fails closed on sparse context instead of inventing a trend", () => {
    const context = buildGholaMultiTimeframeConfluence(series(5));

    expect(context.confluence).toBe("insufficient");
    expect(context.timeframes.every((timeframe) => timeframe.trend === "insufficient")).toBe(true);
    expect(context.timeframes[2]).toMatchObject({ completedBars: 0, lastClose: null });
  });

  it("produces a complete accessible summary without fake sub-tick precision", () => {
    const context = buildGholaMultiTimeframeConfluence(series(145));
    const summary = gholaMultiTimeframeAccessibleSummary(context);

    expect(summary).toContain("144 completed of 145 received candles");
    expect(summary).toContain("Bullish agreement across 3 timeframes");
    expect(summary).toContain("1m: up trend");
    expect(summary).toContain("4m: up trend");
    expect(summary).toContain("12m: up trend");
    expect(formatGholaTimeframe(3_600_000)).toBe("1h");
  });
});

function series(length: number, futureOffset = 0): GholaChartCandle[] {
  const start = Date.parse("2026-08-12T00:00:00.000Z") + futureOffset * 60_000;
  return Array.from({ length }, (_, index) => {
    const close = 100 + futureOffset + index;
    const time = start + index * 60_000;
    return {
      t: time,
      T: time + 59_999,
      o: String(close - 0.4),
      h: String(close + 0.8),
      l: String(close - 0.9),
      c: String(close),
      v: String(100 + index),
      n: 10 + index,
    };
  });
}
