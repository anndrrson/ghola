import { describe, expect, it } from "vitest";
import { analyzeGholaOrderFlow } from "./ghola-order-flow";
import type { GholaChartCandle, GholaChartTrade } from "./ghola-market-chart";

describe("ghola order flow", () => {
  it("assigns only reported trades to candle intervals and computes delta/CVD", () => {
    const candles = candleSeries(3);
    const analysis = analyzeGholaOrderFlow(candles, [
      trade(candles[0].t + 10_000, "buy", 3),
      trade(candles[0].t + 20_000, "sell", 1),
      trade(candles[1].t + 10_000, "sell", 4),
      trade(candles[2].t + 10_000, "buy", 2),
      trade(candles[2].t + 90_000, "buy", 100),
    ]);

    expect(analysis.buckets.map((bucket) => bucket.delta)).toEqual([2, -4, 2]);
    expect(analysis.buckets.map((bucket) => bucket.cumulativeDelta)).toEqual([2, -2, 0]);
    expect(analysis.buyVolume).toBe(5);
    expect(analysis.sellVolume).toBe(5);
    expect(analysis.reportedTrades).toBe(4);
    expect(analysis.ignoredTrades).toBe(1);
  });

  it("uses event timestamps for replay-safe tape speed", () => {
    const candles = candleSeries(10);
    const end = candles.at(-1)?.T ?? 0;
    const trades = [
      trade(end - 250_000, "buy", 1),
      trade(end - 200_000, "buy", 1),
      trade(end - 150_000, "sell", 1),
      trade(end - 50_000, "buy", 1),
      trade(end - 40_000, "buy", 1),
      trade(end - 30_000, "sell", 1),
      trade(end - 20_000, "buy", 1),
    ];
    const analysis = analyzeGholaOrderFlow(candles, trades, { speedWindowMs: 60_000, baselineWindowMs: 300_000 });

    expect(analysis.tradesPerMinute).toBe(4);
    expect(analysis.speedRatio).toBeCloseTo(5.3333, 3);
    expect(analysis.coverageEnd).toBe(end - 20_000);
  });

  it("labels absorption as an objective candidate, not confirmed intent", () => {
    const candles = [
      candle(0, 100, 100),
      candle(1, 100, 100),
      candle(2, 100, 100.05),
    ];
    const trades = [
      trade(candles[0].t + 10_000, "buy", 5),
      trade(candles[0].t + 20_000, "sell", 5),
      trade(candles[1].t + 10_000, "buy", 5),
      trade(candles[1].t + 20_000, "sell", 5),
      trade(candles[2].t + 10_000, "buy", 25),
      trade(candles[2].t + 20_000, "buy", 25),
      trade(candles[2].t + 30_000, "sell", 2),
    ];
    const analysis = analyzeGholaOrderFlow(candles, trades);

    expect(analysis.candidates).toHaveLength(1);
    expect(analysis.candidates[0]).toMatchObject({ side: "buy", label: "Buy absorption?", candleIndex: 2 });
    expect(analysis.candidates[0].detail).toContain("candidate, not confirmed intent");
    expect(analysis.candidates[0].imbalancePct).toBeGreaterThan(65);
  });

  it("does not infer flow or signals when reported trades are absent", () => {
    const analysis = analyzeGholaOrderFlow(candleSeries(3), []);

    expect(analysis.delta).toBe(0);
    expect(analysis.cumulativeDelta).toBe(0);
    expect(analysis.tradesPerMinute).toBeNull();
    expect(analysis.speedRatio).toBeNull();
    expect(analysis.candidates).toEqual([]);
    expect(analysis.reportedTrades).toBe(0);
  });

  it("bounds candidate markers", () => {
    const candles = Array.from({ length: 20 }, (_, index) => candle(index, 100, 100.01));
    const trades = candles.flatMap((item) => [
      trade(item.t + 10_000, "buy", 20),
      trade(item.t + 20_000, "buy", 20),
      trade(item.t + 30_000, "sell", 1),
    ]);
    const analysis = analyzeGholaOrderFlow(candles, trades, { maxCandidates: 4, absorptionMinVolumeRatio: 1 });

    expect(analysis.candidates).toHaveLength(4);
    expect(analysis.candidates[0].candleIndex).toBe(16);
  });
});

function candleSeries(count: number) {
  return Array.from({ length: count }, (_, index) => candle(index, 100 + index, 100.5 + index));
}

function candle(index: number, open: number, close: number): GholaChartCandle {
  const t = Date.parse("2026-08-12T00:00:00.000Z") + index * 60_000;
  return { t, T: t + 59_999, o: String(open), h: String(Math.max(open, close) + 1), l: String(Math.min(open, close) - 1), c: String(close), v: "100", n: 1 };
}

function trade(time: number, side: "buy" | "sell", size: number): GholaChartTrade {
  return { time, side, sz: String(size), px: "100" };
}
