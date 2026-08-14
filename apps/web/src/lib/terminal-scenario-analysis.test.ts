import { describe, expect, it } from "vitest";
import type { GholaChartCandle } from "./ghola-market-chart";
import { analyzeTerminalScenario } from "./terminal-scenario-analysis";

describe("terminal scenario analysis", () => {
  it("models long-side historical stress, payoff, ATR, and stop breach", () => {
    const result = analyzeTerminalScenario({
      candles: candles([100, 102, 98, 105]),
      side: "buy",
      entryPrice: 100,
      stopPrice: 99,
      targetPrice: 102,
      notionalUsd: 1_000,
      slippageBps: 10,
    });

    expect(result.sampleSize).toBe(4);
    expect(result.adverseMoveBps).toBe(300);
    expect(result.favorableMoveBps).toBe(600);
    expect(result.stopDistanceBps).toBe(100);
    expect(result.rewardRiskRatio).toBe(2);
    expect(result.historicalStopBreached).toBe(true);
    expect(result.historicalTargetReached).toBe(true);
    expect(result.stopLossUsd).toBeCloseTo(11);
    expect(result.targetProfitUsd).toBeCloseTo(19);
    expect(result.stressLossUsd).toBeCloseTo(31);
    expect(result.atrBps).toBeGreaterThan(0);
  });

  it("uses the correct adverse direction for a short plan", () => {
    const result = analyzeTerminalScenario({
      candles: candles([100, 104, 101, 96]),
      side: "sell",
      entryPrice: 100,
      stopPrice: 105,
      targetPrice: 90,
      notionalUsd: 500,
      slippageBps: 0,
    });

    expect(result.adverseMoveBps).toBe(500);
    expect(result.favorableMoveBps).toBe(500);
    expect(result.historicalStopBreached).toBe(true);
    expect(result.historicalTargetReached).toBe(false);
    expect(result.rewardRiskRatio).toBe(2);
  });

  it("is bounded to the requested candle prefix and rejects invalid plans", () => {
    const all = candles([100, 100, 100, 100, 80]);
    const bounded = analyzeTerminalScenario({
      candles: all,
      side: "buy",
      entryPrice: 100,
      stopPrice: 90,
      targetPrice: 120,
      notionalUsd: 100,
      slippageBps: 0,
      lookback: 4,
    });
    const invalid = analyzeTerminalScenario({
      candles: [],
      side: "buy",
      entryPrice: 100,
      stopPrice: 110,
      targetPrice: 90,
      notionalUsd: -1,
      slippageBps: 0,
    });

    expect(bounded.sampleSize).toBe(4);
    expect(bounded.adverseMoveBps).toBe(2_100);
    expect(invalid.stopDistanceBps).toBeNull();
    expect(invalid.targetDistanceBps).toBeNull();
    expect(invalid.stressGrade).toBe("unavailable");
  });
});

function candles(closes: number[]): GholaChartCandle[] {
  return closes.map((close, index) => ({
    t: Date.parse("2026-08-12T00:00:00.000Z") + index * 60_000,
    T: null,
    o: String(close),
    h: String(close + 1),
    l: String(close - 1),
    c: String(close),
    v: "10",
    n: 1,
  }));
}
