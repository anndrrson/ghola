import { describe, expect, it } from "vitest";
import type { GholaChartCandle } from "./ghola-market-chart";
import type { TerminalEntryOutcomeMatrix } from "./terminal-entry-outcome-matrix";
import {
  deriveTerminalEntryTargetSurface,
  terminalEntryTargetStageSelection,
  terminalEntryTargetSurfaceEqual,
} from "./terminal-entry-target-surface";

describe("terminal entry-target surface", () => {
  it("joins each entry outcome to four independently calibrated targets", () => {
    const surface = deriveTerminalEntryTargetSurface({
      entryMatrix: matrix(),
      candles: history(),
      side: "buy",
      notionalUsd: 1_000,
      slippageBps: 10,
    });

    expect(surface.status).toBe("ready");
    expect(surface.rows).toHaveLength(3);
    expect(surface.rows[0]).toMatchObject({ mode: "join", entryPrice: 99, visibleFillPct: 0, budgetAllowed: true });
    expect(surface.rows[0]?.cells.map((cell) => [cell.rewardMultiple, cell.targetPrice])).toEqual([
      [1, 103],
      [1.5, 105],
      [2, 107],
      [3, 111],
    ]);
    expect(surface.rows[1]?.cells[2]).toMatchObject({ rewardMultiple: 2, targetPrice: 109, evidenceStatus: "ready" });
    expect(surface.rows[0]?.cells.every((cell) => cell.requiredWinRatePct != null)).toBe(true);
  });

  it("keeps exact target prices while degrading unavailable history", () => {
    const surface = deriveTerminalEntryTargetSurface({
      entryMatrix: matrix(),
      candles: [],
      side: "buy",
      notionalUsd: 1_000,
      slippageBps: 10,
    });
    expect(surface.status).toBe("degraded");
    expect(surface.blocker).toBe("historical_evidence_unavailable");
    expect(surface.rows[2]?.cells[3]).toMatchObject({ targetPrice: 113, evidenceStatus: "unavailable" });
  });

  it("mirrors the joint target geometry for short entries", () => {
    const entryMatrix = matrix();
    for (const outcome of entryMatrix.outcomes) outcome.risk.invalidationPrice = outcome.price + 4;
    const surface = deriveTerminalEntryTargetSurface({
      entryMatrix,
      candles: [],
      side: "sell",
      notionalUsd: 1_000,
      slippageBps: 10,
    });
    expect(surface.rows[2]?.cells.map((cell) => cell.targetPrice)).toEqual([97, 95, 93, 89]);
  });

  it("fails closed when entry outcomes are unavailable or invalid", () => {
    expect(deriveTerminalEntryTargetSurface({
      entryMatrix: { status: "unavailable", blocker: "book_unavailable", outcomes: [] },
      candles: history(),
      side: "buy",
      notionalUsd: 1_000,
      slippageBps: 10,
    })).toEqual({ status: "unavailable", blocker: "entry_outcomes_unavailable", horizonBars: 20, rows: [] });

    const invalid = matrix();
    invalid.outcomes[0]!.risk.invalidationPrice = null;
    const surface = deriveTerminalEntryTargetSurface({
      entryMatrix: invalid,
      candles: history(),
      side: "buy",
      notionalUsd: 1_000,
      slippageBps: 10,
    });
    expect(surface.rows[0]?.cells.every((cell) => cell.targetPrice == null)).toBe(true);
  });

  it("compares models semantically for memoized rendering", () => {
    const input = { entryMatrix: matrix(), candles: history(), side: "buy" as const, notionalUsd: 1_000, slippageBps: 10 };
    const left = deriveTerminalEntryTargetSurface(input);
    const right = deriveTerminalEntryTargetSurface(input);
    expect(terminalEntryTargetSurfaceEqual(left, right)).toBe(true);
    right.rows[0]!.cells[0]!.resolvedCount += 1;
    expect(terminalEntryTargetSurfaceEqual(left, right)).toBe(false);
  });

  it("revalidates an exact stage selection and rejects stale prices", () => {
    const surface = deriveTerminalEntryTargetSurface({
      entryMatrix: matrix(),
      candles: [],
      side: "buy",
      notionalUsd: 1_000,
      slippageBps: 10,
    });
    expect(terminalEntryTargetStageSelection({
      surface,
      mode: "cross",
      expectedEntryPrice: 101,
      rewardMultiple: 3,
      expectedTargetPrice: 113,
    })).toEqual({ entryPrice: 101, targetPrice: 113 });
    expect(terminalEntryTargetStageSelection({
      surface,
      mode: "cross",
      expectedEntryPrice: 101,
      rewardMultiple: 3,
      expectedTargetPrice: 113.01,
    })).toBeNull();
  });
});

function matrix(): TerminalEntryOutcomeMatrix {
  return {
    status: "ready",
    blocker: null,
    outcomes: [
      outcome("join", 99, 95, 0, true),
      outcome("current", 101, 97, 50, false),
      outcome("cross", 101, 97, 100, false),
    ],
  };
}

function outcome(
  mode: "join" | "current" | "cross",
  price: number,
  invalidationPrice: number,
  fillPct: number,
  budgetAllowed: boolean,
): TerminalEntryOutcomeMatrix["outcomes"][number] {
  return {
    mode,
    price,
    intent: mode === "cross" ? "marketable" : "resting",
    quality: {
      status: fillPct === 100 ? "full" : fillPct > 0 ? "partial" : "none",
      targetBaseSize: 10,
      filledBaseSize: fillPct / 10,
      filledNotionalUsd: fillPct * 10,
      unfilledNotionalUsd: 1_000 - fillPct * 10,
      fillPct,
      vwap: fillPct > 0 ? price : null,
      worstPrice: fillPct > 0 ? price : null,
      impactBps: fillPct > 0 ? 10 : null,
      feeUsd: 0,
      arrivalCostUsd: 0,
      allInImpactBps: fillPct > 0 ? 10 : null,
      levelsConsumed: fillPct > 0 ? 1 : 0,
    },
    risk: {
      stopValid: true,
      invalidationPrice,
      modeledLossUsd: 40,
      stopDistanceBps: 400,
      budgetUtilizationPct: 80,
      budgetAllowed,
      safeNotionalUsd: 1_000,
      visibleFullFillNotionalUsd: null,
      recommendedNotionalUsd: 1_000,
      recommendationConstraint: "risk_budget",
      canApplyRecommendedNotional: false,
      twoRTargetPrice: price + 8,
    },
  };
}

function history(): GholaChartCandle[] {
  const candles: GholaChartCandle[] = [];
  for (let index = 0; index < 80; index += 1) {
    const phase = index % 4;
    const values: [number, number, number, number] = phase === 0
      ? [101, 101.5, 98.5, 101]
      : phase === 1
        ? [100, 101, 98.5, 99]
        : phase === 2
          ? [100, 114, 98, 110]
          : [110, 111, 109, 110];
    candles.push({
      t: index * 60_000 + 1,
      T: index * 60_000 + 59_999,
      o: String(values[0]),
      h: String(values[1]),
      l: String(values[2]),
      c: String(values[3]),
      v: "1",
      n: 1,
    });
  }
  return candles;
}
