import { describe, expect, it } from "vitest";
import {
  aggregateGholaCandles,
  buildGholaMultiTimeframeStructure,
  detectGholaMarketStructure,
  gholaVolatilityContext,
} from "./ghola-market-structure";
import type { GholaChartCandle } from "./ghola-market-chart";

describe("ghola market structure", () => {
  it("does not expose a swing until the required right bars exist", () => {
    const series = [
      candle(0, 1, 0, 0.5),
      candle(1, 2, 0.5, 1.5),
      candle(2, 5, 1, 4),
      candle(3, 3, 1, 2),
      candle(4, 2, 0.5, 1),
    ];

    expect(detectGholaMarketStructure(series.slice(0, 4)).markers).toEqual([]);
    const marker = detectGholaMarketStructure(series).markers.find((item) => item.kind === "swing_high");
    expect(marker).toMatchObject({ index: 2, confirmedIndex: 4, price: 5, label: "SH" });
    expect(marker?.confirmedTime).toBe(series[4].t);
  });

  it("labels close-through breaks and only calls an opposite break a shift", () => {
    const result = detectGholaMarketStructure([
      candle(0, 10, 8, 9),
      candle(1, 12, 9, 11),
      candle(2, 11, 7, 8),
      candle(3, 13, 8, 12.5),
      candle(4, 12, 9, 10),
      candle(5, 11, 6, 6.5),
      candle(6, 10, 7, 8),
    ], { leftBars: 1, rightBars: 1 });

    const events = result.markers.filter((item) => item.kind === "high_break" || item.kind === "low_break" || item.kind === "trend_shift");
    expect(events.map((event) => ({ kind: event.kind, label: event.label, index: event.index }))).toEqual([
      { kind: "high_break", label: "High break", index: 3 },
      { kind: "trend_shift", label: "Shift ↓", index: 5 },
    ]);
    expect(result.trend).toBe("down");
    expect(result.lastBreak?.detail).toContain("after an opposite break");
  });

  it("aggregates aligned higher-timeframe OHLCV and omits the forming context bar", () => {
    const source = Array.from({ length: 9 }, (_, index) => candle(index, 102 + index, 98 + index, 100 + index, 10 + index));
    const aggregated = aggregateGholaCandles(source, 4);
    const context = buildGholaMultiTimeframeStructure(source, 4);

    expect(aggregated).toHaveLength(3);
    expect(aggregated[0]).toMatchObject({ o: "100", h: "105", l: "98", c: "103", v: "46", n: 4 });
    expect(aggregated[0].T).toBe(aggregated[0].t + 240_000 - 1);
    expect(context.higherCandles).toHaveLength(2);
    expect(context.baseIntervalMs).toBe(60_000);
    expect(context.higherIntervalMs).toBe(240_000);
  });

  it("classifies volatility against prior ranges with explicit thresholds", () => {
    const quiet = Array.from({ length: 55 }, (_, index) => candle(index, 100.5, 99.5, 100));
    const expanded = quiet.concat(Array.from({ length: 14 }, (_, offset) => candle(55 + offset, 108, 92, 100)));

    const context = gholaVolatilityContext(expanded, 14, 40);
    expect(context.regime).toBe("expanded");
    expect(context.ratio).toBeGreaterThan(1.5);
    expect(context.currentAtrPct).toBeGreaterThan(context.baselineAtrPct ?? 0);
  });

  it("bounds rendered markers after computing the complete structure state", () => {
    const series = Array.from({ length: 80 }, (_, index) => {
      const center = index % 2 === 0 ? 100 : 110;
      return candle(index, center + 2, center - 2, center);
    });
    const result = detectGholaMarketStructure(series, { leftBars: 1, rightBars: 1, maxMarkers: 5 });

    expect(result.markers.length).toBeLessThanOrEqual(5);
    expect(result.lastSwingHigh).not.toBeNull();
    expect(result.lastSwingLow).not.toBeNull();
  });
});

function candle(index: number, high: number, low: number, close: number, volume = 10): GholaChartCandle {
  const t = Date.parse("2026-08-12T00:00:00.000Z") + index * 60_000;
  return {
    t,
    T: t + 59_999,
    o: String(close),
    h: String(high),
    l: String(low),
    c: String(close),
    v: String(volume),
    n: 1,
  };
}
