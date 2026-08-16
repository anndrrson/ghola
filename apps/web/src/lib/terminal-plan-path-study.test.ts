import { describe, expect, it } from "vitest";
import type { GholaChartCandle } from "./ghola-market-chart";
import {
  studyTerminalPlanPathHorizons,
  studyTerminalPlanPaths,
  terminalPlanPathStudiesEqual,
  terminalPlanPathStudyEqual,
} from "./terminal-plan-path-study";

describe("terminal plan path study", () => {
  it("measures non-overlapping target-first and stop-first episodes", () => {
    const result = studyTerminalPlanPaths({
      candles: candles([
        [101, 102, 99, 100],
        [101, 106, 99, 105],
        [101, 102, 99, 100],
        [99, 104, 94, 95],
        [100, 999, 1, 100],
      ]),
      side: "buy",
      entryPrice: 100,
      stopPrice: 95,
      targetPrice: 105,
    });

    expect(result).toMatchObject({
      status: "ready",
      sampleSize: 4,
      episodeCount: 2,
      resolvedCount: 2,
      targetFirstCount: 1,
      stopFirstCount: 1,
      targetFirstRatePct: 50,
      expectancyR: 0,
      rewardRiskRatio: 1,
      medianBarsToResolution: 1,
    });
  });

  it("separates ambiguous and horizon-expired episodes from resolved expectancy", () => {
    const result = studyTerminalPlanPaths({
      candles: candles([
        [100, 101, 99, 100],
        [100, 106, 94, 100],
        [100, 101, 99, 100],
        [101, 104, 98, 102],
        [102, 104, 98, 101],
        [100, 999, 1, 100],
      ]),
      side: "buy",
      entryPrice: 100,
      stopPrice: 95,
      targetPrice: 105,
      horizonBars: 2,
    });

    expect(result).toMatchObject({
      episodeCount: 2,
      resolvedCount: 0,
      ambiguousCount: 1,
      unresolvedCount: 1,
      targetFirstRatePct: null,
      expectancyR: null,
    });
  });

  it("does not count repeated entry touches while an episode remains active", () => {
    const result = studyTerminalPlanPaths({
      candles: candles([
        [100, 101, 99, 100],
        [100, 102, 99, 101],
        [100, 103, 99, 102],
        [102, 106, 101, 105],
        [100, 100, 100, 100],
      ]),
      side: "buy",
      entryPrice: 100,
      stopPrice: 95,
      targetPrice: 105,
    });

    expect(result).toMatchObject({ episodeCount: 1, targetFirstCount: 1, medianBarsToResolution: 3 });
  });

  it("classifies terminal touches on the entry bar as ambiguous", () => {
    const result = studyTerminalPlanPaths({
      candles: candles([
        [100, 106, 99, 105],
        [110, 111, 109, 110],
        [100, 100, 100, 100],
      ]),
      side: "buy",
      entryPrice: 100,
      stopPrice: 95,
      targetPrice: 105,
      horizonBars: Number.NaN,
    });

    expect(result).toMatchObject({ episodeCount: 1, ambiguousCount: 1, resolvedCount: 0, horizonBars: 20 });
  });

  it("handles short-side direction and non-unit reward/risk", () => {
    const result = studyTerminalPlanPaths({
      candles: candles([
        [99, 101, 98, 100],
        [95, 99, 89, 90],
        [100, 100, 100, 100],
      ]),
      side: "sell",
      entryPrice: 100,
      stopPrice: 105,
      targetPrice: 90,
    });

    expect(result).toMatchObject({ targetFirstCount: 1, rewardRiskRatio: 2, expectancyR: 2 });
  });

  it("excludes the newest bar and fails closed for invalid inputs", () => {
    const newestOnly = studyTerminalPlanPaths({
      candles: candles([[110, 111, 109, 110], [100, 200, 1, 100]]),
      side: "buy", entryPrice: 100, stopPrice: 95, targetPrice: 105,
    });
    expect(newestOnly).toMatchObject({ status: "unavailable", blocker: "insufficient_history", sampleSize: 1 });

    const malformed = candles([[100, 101, 99, 100], [100, 101, 99, 100], [100, 100, 100, 100]]);
    malformed[1]!.t = malformed[0]!.t;
    expect(studyTerminalPlanPaths({
      candles: malformed, side: "buy", entryPrice: 100, stopPrice: 95, targetPrice: 105,
    }).blocker).toBe("history_invalid");
    expect(studyTerminalPlanPaths({
      candles: candles([[100, 101, 99, 100], [100, 100, 100, 100]]),
      side: "buy", entryPrice: 100, stopPrice: 105, targetPrice: 110,
    }).blocker).toBe("invalid_plan");
  });

  it("compares studies semantically", () => {
    const result = studyTerminalPlanPaths({
      candles: candles([[100, 101, 99, 100], [101, 106, 99, 105], [100, 100, 100, 100]]),
      side: "buy", entryPrice: 100, stopPrice: 95, targetPrice: 105,
    });
    expect(terminalPlanPathStudyEqual(result, { ...result })).toBe(true);
    expect(terminalPlanPathStudyEqual(result, { ...result, episodeCount: 99 })).toBe(false);
  });

  it("builds deterministic fast, base, and extended horizon comparisons", () => {
    const input = {
      candles: candles([
        [100, 101, 99, 100],
        [100, 102, 99, 101],
        [101, 103, 99, 102],
        [102, 104, 99, 103],
        [103, 104, 99, 103],
        [103, 104, 99, 103],
        [103, 106, 99, 105],
        [100, 100, 100, 100],
      ]),
      side: "buy" as const,
      entryPrice: 100,
      stopPrice: 95,
      targetPrice: 105,
    };
    const studies = studyTerminalPlanPathHorizons(input);

    expect(studies.map((study) => study.horizonBars)).toEqual([5, 20, 50]);
    expect(studies[0]).toMatchObject({ unresolvedCount: 1, targetFirstCount: 0 });
    expect(studies[1]).toMatchObject({ unresolvedCount: 0, targetFirstCount: 1 });
    expect(terminalPlanPathStudiesEqual(studies, studies.map((study) => ({ ...study })))).toBe(true);
    expect(terminalPlanPathStudiesEqual(studies, studies.slice(1))).toBe(false);
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
