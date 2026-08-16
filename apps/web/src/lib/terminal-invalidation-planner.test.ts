import { describe, expect, it } from "vitest";
import {
  deriveTerminalInvalidationPlan,
  terminalInvalidationCandidateMatches,
} from "./terminal-invalidation-planner";

describe("terminal invalidation planner", () => {
  it("builds long ATR candidates with loss, budget, and safe size", () => {
    const plan = deriveTerminalInvalidationPlan(input());
    expect(plan.status).toBe("ready");
    expect(plan.candidates.map((candidate) => [candidate.multiplier, candidate.invalidationPrice]))
      .toEqual([[1, 98], [1.5, 97], [2, 96]]);
    expect(plan.candidates[0]).toMatchObject({ distanceBps: 200, modeledLossUsd: 2.5, budgetUtilizationPct: 50 });
    expect(plan.candidates[0]?.safeNotionalUsd).toBeCloseTo(100);
  });

  it("mirrors prices for shorts and caps safe size", () => {
    const plan = deriveTerminalInvalidationPlan({ ...input(), side: "sell", maxNotionalUsd: 50 });
    expect(plan.candidates.map((candidate) => candidate.invalidationPrice)).toEqual([102, 103, 104]);
    expect(plan.candidates.every((candidate) => candidate.safeNotionalUsd <= 50)).toBe(true);
  });

  it("includes round-trip costs in candidate loss and sizing", () => {
    const plan = deriveTerminalInvalidationPlan({ ...input(), roundTripCostBps: 50 });
    expect(plan.candidates[0]).toMatchObject({ modeledLossUsd: 3, budgetUtilizationPct: 60, safeNotionalUsd: 100 });
    expect(deriveTerminalInvalidationPlan({ ...input(), roundTripCostBps: Number.NaN })).toMatchObject({ status: "unavailable", blocker: "cost_assumption_invalid" });
  });

  it("fails closed for invalid or uncertified inputs", () => {
    const cases = [
      [{ entryPrice: null }, "entry_invalid"],
      [{ atr: null }, "atr_invalid"],
      [{ atr: 100 }, "atr_invalid"],
      [{ notionalUsd: 0 }, "notional_invalid"],
      [{ riskBudgetUsd: 0 }, "risk_budget_invalid"],
      [{ slippageBps: -1 }, "slippage_invalid"],
      [{ maxNotionalUsd: Number.NaN }, "max_notional_invalid"],
    ] as const;
    for (const [overrides, blocker] of cases) {
      expect(deriveTerminalInvalidationPlan({ ...input(), ...overrides })).toEqual({
        status: "unavailable",
        blocker,
        atr: blocker === "entry_invalid" || blocker === "atr_invalid" ? null : 2,
        candidates: [],
      });
    }
  });

  it("revalidates the exact candidate before staging", () => {
    const candidates = deriveTerminalInvalidationPlan(input()).candidates;
    expect(terminalInvalidationCandidateMatches(candidates, 1.5, 97)).toBe(true);
    expect(terminalInvalidationCandidateMatches(candidates, 1.5, 97.01)).toBe(false);
    expect(terminalInvalidationCandidateMatches(candidates, 2, 97)).toBe(false);
  });
});

function input() {
  return {
    side: "buy" as const,
    entryPrice: 100,
    atr: 2,
    notionalUsd: 100,
    riskBudgetUsd: 5,
    slippageBps: 50,
    maxNotionalUsd: 100,
  };
}
