import { describe, expect, it } from "vitest";
import {
  deriveTerminalPlanPayoffCalibration,
  terminalPlanPayoffCalibrationEqual,
} from "./terminal-plan-payoff-calibration";
import type { TerminalPlanPathStudy } from "./terminal-plan-path-study";

describe("terminal plan payoff calibration", () => {
  it("compares resolved hit rate with the slippage-adjusted break-even rate", () => {
    const result = deriveTerminalPlanPayoffCalibration({
      studies: [study({ episodeCount: 20, resolvedCount: 16, targetFirstCount: 10, stopFirstCount: 6, ambiguousCount: 2, unresolvedCount: 2, targetFirstRatePct: 62.5 })],
      stopLossUsd: 10,
      targetProfitUsd: 20,
    });

    expect(result).toMatchObject({ status: "ready", resolvedCount: 16, resolutionCoveragePct: 80 });
    expect(result.requiredWinRatePct).toBeCloseTo(33.3333);
    expect(result.edgeMarginPct).toBeCloseTo(29.1667);
    expect(result.modeledExpectancyUsd).toBeCloseTo(8.75);
    expect(result.hitRateLowerPct).toBeCloseTo(38.64, 1);
    expect(result.hitRateUpperPct).toBeCloseTo(81.52, 1);
    expect(result.assessment).toBe("above_break_even");
  });

  it("keeps adverse calibration negative and labels a small resolved sample", () => {
    const result = deriveTerminalPlanPayoffCalibration({
      studies: [study({ episodeCount: 8, resolvedCount: 5, targetFirstCount: 1, stopFirstCount: 4, ambiguousCount: 1, unresolvedCount: 2, targetFirstRatePct: 20 })],
      stopLossUsd: 10,
      targetProfitUsd: 10,
    });

    expect(result.status).toBe("thin_sample");
    expect(result.edgeMarginPct).toBe(-30);
    expect(result.modeledExpectancyUsd).toBe(-6);
    expect(result.assessment).toBe("inconclusive");
  });

  it("calls evidence below break-even only when the full interval is below it", () => {
    const result = deriveTerminalPlanPayoffCalibration({
      studies: [study({ episodeCount: 40, resolvedCount: 40, targetFirstCount: 4, stopFirstCount: 36, ambiguousCount: 0, unresolvedCount: 0, targetFirstRatePct: 10 })],
      stopLossUsd: 20,
      targetProfitUsd: 10,
    });
    expect(result.requiredWinRatePct).toBeCloseTo(66.6667);
    expect(result.hitRateUpperPct).toBeLessThan(result.requiredWinRatePct as number);
    expect(result.assessment).toBe("below_break_even");
  });

  it("fails closed for invalid payoff, unavailable studies, and no resolved outcomes", () => {
    expect(deriveTerminalPlanPayoffCalibration({ studies: [study()], stopLossUsd: 0, targetProfitUsd: 20 }).blocker)
      .toBe("payoff_invalid");
    expect(deriveTerminalPlanPayoffCalibration({ studies: [study({ status: "unavailable" })], stopLossUsd: 10, targetProfitUsd: 20 }).blocker)
      .toBe("study_unavailable");
    expect(deriveTerminalPlanPayoffCalibration({ studies: [study({ episodeCount: 2, resolvedCount: 0, targetFirstCount: 0, stopFirstCount: 0, targetFirstRatePct: null })], stopLossUsd: 10, targetProfitUsd: 20 }).blocker)
      .toBe("resolved_sample_empty");
  });

  it("rejects inconsistent study counters and rates", () => {
    const inconsistentCount = study({ resolvedCount: 10, targetFirstCount: 9, stopFirstCount: 2, targetFirstRatePct: 90 });
    const inconsistentRate = study({ targetFirstRatePct: 70 });
    for (const candidate of [inconsistentCount, inconsistentRate]) {
      expect(deriveTerminalPlanPayoffCalibration({ studies: [candidate], stopLossUsd: 10, targetProfitUsd: 20 }).blocker)
        .toBe("study_unavailable");
    }
  });

  it("selects the requested horizon and compares outputs semantically", () => {
    const result = deriveTerminalPlanPayoffCalibration({
      studies: [study({ horizonBars: 5 }), study({ horizonBars: 50, episodeCount: 14, resolvedCount: 12, targetFirstCount: 8, stopFirstCount: 4, targetFirstRatePct: 66.66666666666667 })],
      stopLossUsd: 10,
      targetProfitUsd: 20,
      horizonBars: 50,
    });
    expect(result.horizonBars).toBe(50);
    expect(terminalPlanPayoffCalibrationEqual(result, { ...result })).toBe(true);
    expect(terminalPlanPayoffCalibrationEqual(result, { ...result, resolvedCount: 13 })).toBe(false);
  });
});

function study(overrides: Partial<TerminalPlanPathStudy> = {}): TerminalPlanPathStudy {
  return {
    status: "ready",
    blocker: null,
    sampleSize: 200,
    horizonBars: 20,
    episodeCount: 12,
    resolvedCount: 10,
    targetFirstCount: 6,
    stopFirstCount: 4,
    ambiguousCount: 1,
    unresolvedCount: 1,
    targetFirstRatePct: 60,
    expectancyR: 0.8,
    rewardRiskRatio: 2,
    medianBarsToResolution: 4,
    ...overrides,
  };
}
