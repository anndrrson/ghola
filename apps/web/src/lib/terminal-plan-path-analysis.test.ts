import { describe, expect, it } from "vitest";
import type { GholaChartCandle } from "./ghola-market-chart";
import { analyzeTerminalPlanPath } from "./terminal-plan-path-analysis";

describe("terminal plan path analysis", () => {
  it("waits for a long entry touch and resolves target before stop", () => {
    const result = analyzeTerminalPlanPath({
      candles: candles([
        [105, 106, 104, 105],
        [102, 103, 99, 100],
        [101, 102, 100, 101],
        [102, 106, 101, 105],
        [999, 999, 1, 999],
      ]),
      side: "buy",
      entryPrice: 100,
      stopPrice: 95,
      targetPrice: 105,
      notionalUsd: 1_000,
    });

    expect(result).toMatchObject({
      outcome: "target_first",
      sampleSize: 4,
      entryBarIndex: 1,
      barsToEntry: 1,
      postEntryBars: 2,
      maxFavorableExcursionBps: 500,
      maxAdverseExcursionBps: 0,
      maxFavorableExcursionUsd: 50,
    });
  });

  it("uses short-side entry and excursion directions", () => {
    const result = analyzeTerminalPlanPath({
      candles: candles([
        [95, 96, 94, 95],
        [99, 101, 98, 100],
        [98, 99, 96, 97],
        [99, 106, 98, 104],
        [100, 100, 100, 100],
      ]),
      side: "sell",
      entryPrice: 100,
      stopPrice: 105,
      targetPrice: 90,
      notionalUsd: 500,
    });

    expect(result).toMatchObject({
      outcome: "stop_first",
      entryBarIndex: 1,
      maxFavorableExcursionBps: 400,
      maxAdverseExcursionBps: 500,
      maxFavorableExcursionUsd: 20,
      maxAdverseExcursionUsd: 25,
    });
  });

  it("reports same-bar stop and target as unknowable without inventing excursions", () => {
    const result = analyzeTerminalPlanPath({
      candles: candles([
        [100, 101, 99, 100],
        [100, 106, 94, 100],
        [100, 100, 100, 100],
      ]),
      side: "buy",
      entryPrice: 100,
      stopPrice: 95,
      targetPrice: 105,
      notionalUsd: 1_000,
    });
    expect(result).toMatchObject({
      outcome: "ambiguous_same_bar",
      postEntryBars: 1,
      maxFavorableExcursionBps: 0,
      maxAdverseExcursionBps: 0,
    });
  });

  it("distinguishes no entry from entry on the latest closed bar", () => {
    const noEntry = analyzeTerminalPlanPath({
      candles: candles([[110, 111, 109, 110], [108, 109, 107, 108], [100, 100, 100, 100]]),
      side: "buy", entryPrice: 100, stopPrice: 95, targetPrice: 105, notionalUsd: 100,
    });
    const latestEntry = analyzeTerminalPlanPath({
      candles: candles([[110, 111, 109, 110], [101, 102, 99, 100], [100, 100, 100, 100]]),
      side: "buy", entryPrice: 100, stopPrice: 95, targetPrice: 105, notionalUsd: 100,
    });
    expect(noEntry).toMatchObject({ outcome: "entry_not_touched", sampleSize: 2 });
    expect(latestEntry).toMatchObject({ outcome: "awaiting_follow_through", entryBarIndex: 1, postEntryBars: 0 });
  });

  it("fails closed for invalid plans, malformed candles, and regressed time", () => {
    const base = { side: "buy" as const, entryPrice: 100, stopPrice: 95, targetPrice: 105, notionalUsd: 100 };
    expect(analyzeTerminalPlanPath({ ...base, stopPrice: 110, candles: candles([[100, 101, 99, 100]]) }).outcome).toBe("unavailable");
    expect(analyzeTerminalPlanPath({ ...base, candles: candles([[100, 99, 101, 100], [100, 101, 99, 100], [100, 101, 99, 100]]) }).outcome).toBe("unavailable");
    const regressed = candles([[100, 101, 99, 100], [100, 101, 99, 100], [100, 101, 99, 100]]);
    regressed[1]!.t = regressed[0]!.t;
    expect(analyzeTerminalPlanPath({ ...base, candles: regressed }).outcome).toBe("unavailable");
  });

  it("never reads the newest possibly-open bar", () => {
    const result = analyzeTerminalPlanPath({
      candles: candles([[110, 111, 109, 110], [108, 109, 107, 108], [100, 200, 1, 100]]),
      side: "buy", entryPrice: 100, stopPrice: 95, targetPrice: 105, notionalUsd: 100,
    });
    expect(result).toMatchObject({ outcome: "entry_not_touched", sampleSize: 2 });
  });
});

function candles(rows: Array<[number, number, number, number]>): GholaChartCandle[] {
  const start = Date.parse("2026-08-12T00:00:00.000Z");
  return rows.map(([o, h, l, c], index) => ({
    t: start + index * 60_000,
    T: start + (index + 1) * 60_000 - 1,
    o: String(o), h: String(h), l: String(l), c: String(c), v: "10", n: 1,
  }));
}
