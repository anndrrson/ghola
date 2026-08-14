import { describe, expect, it } from "vitest";
import { sizeTerminalPositionForRisk } from "./terminal-position-sizing";
import { deriveTerminalTradeRisk } from "./trading-terminal-metrics";
import { deriveTerminalRiskBudgetInterlock } from "./terminal-risk-budget-interlock";

describe("terminal risk-budget interlock", () => {
  it("passes below budget", () => {
    expect(check(9, 10)).toMatchObject({
      allowed: true,
      status: "pass",
      utilizationPct: 90,
    });
  });

  it("passes exact equality", () => {
    expect(check(10, 10)).toMatchObject({
      allowed: true,
      status: "pass",
      utilizationPct: 100,
    });
  });

  it("passes machine-scale noise but blocks a meaningful overage", () => {
    expect(deriveTerminalRiskBudgetInterlock({ riskBudgetUsd: 0.05, modeledLossUsd: 0.05000000000000004 }).status).toBe("pass");
    expect(deriveTerminalRiskBudgetInterlock({ riskBudgetUsd: 0.05, modeledLossUsd: 0.050001 }).status).toBe("over_budget");
  });

  it("blocks above budget", () => {
    expect(check(10.01, 10)).toMatchObject({
      allowed: false,
      status: "over_budget",
      utilizationPct: 100.1,
    });
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "blocks invalid budget %s",
    (riskBudgetUsd) => {
      expect(check(1, riskBudgetUsd)).toMatchObject({
        allowed: false,
        status: "invalid_budget",
        utilizationPct: null,
      });
    },
  );

  it.each([null, Number.NaN, Number.POSITIVE_INFINITY, -1])(
    "blocks unavailable modeled loss %s",
    (modeledLossUsd) => {
      expect(check(modeledLossUsd, 10)).toMatchObject({
        allowed: false,
        status: "modeled_loss_unavailable",
        utilizationPct: null,
      });
    },
  );

  it("surfaces a bounded authoritative blocker for unavailable all-in loss", () => {
    expect(deriveTerminalRiskBudgetInterlock({
      riskBudgetUsd: 10,
      modeledLossUsd: null,
      modeledLossUnavailableReason: "Set explicit venue costs.",
    }).reason).toBe("Set explicit venue costs.");
  });

  it("offers the existing risk-sized notional and recovers to equality", () => {
    const sizing = sizeTerminalPositionForRisk({
      side: "buy",
      riskBudgetUsd: 1,
      entryPrice: 100,
      stopPrice: 95,
      slippageBps: 0,
      maxNotionalUsd: 100,
    });
    const blocked = deriveTerminalRiskBudgetInterlock({
      riskBudgetUsd: 1,
      modeledLossUsd: modeledLoss(100),
      safeNotionalUsd: sizing.notionalUsd,
      currentNotionalUsd: 100,
      minimumNotionalUsd: 1,
    });

    expect(blocked).toMatchObject({
      allowed: false,
      status: "over_budget",
      safeNotionalUsd: 20,
      canApplySafeSize: true,
    });
    expect(deriveTerminalRiskBudgetInterlock({
      riskBudgetUsd: 1,
      modeledLossUsd: modeledLoss(blocked.safeNotionalUsd ?? 0),
      safeNotionalUsd: sizing.notionalUsd,
      currentNotionalUsd: blocked.safeNotionalUsd,
      minimumNotionalUsd: 1,
    })).toMatchObject({
      allowed: true,
      status: "pass",
      utilizationPct: 100,
      canApplySafeSize: false,
    });
  });
});

function check(modeledLossUsd: unknown, riskBudgetUsd: unknown) {
  return deriveTerminalRiskBudgetInterlock({
    riskBudgetUsd,
    modeledLossUsd,
    safeNotionalUsd: 5,
    currentNotionalUsd: 10,
    minimumNotionalUsd: 1,
  });
}

function modeledLoss(notionalUsd: number) {
  return deriveTerminalTradeRisk({
    side: "buy",
    notionalUsd,
    entryPrice: 100,
    stopPrice: 95,
    slippageBps: 0,
  }).maxLossUsd;
}
