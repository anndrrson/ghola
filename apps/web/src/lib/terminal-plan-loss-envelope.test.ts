import { describe, expect, it } from "vitest";
import { deriveTerminalPlanLossEnvelope } from "./terminal-plan-loss-envelope";
import type { TerminalRouteCostEvidence } from "./terminal-route-cost-policy";

describe("terminal all-in plan-loss envelope", () => {
  it("adds conservative round-trip costs and derives a non-upward safe size", () => {
    expect(derive({ feeBps: 5, bufferBps: 10 })).toMatchObject({
      status: "ready",
      stopAndSlippageLossUsd: 5,
      roundTripCostBps: 30,
      roundTripCostLossUsd: 0.3,
      allInLossUsd: 5.3,
      safeNotionalUsd: 94.33,
    });
  });

  it("accepts explicitly configured zero but rejects untouched defaults", () => {
    expect(derive({ feeBps: 0, bufferBps: 0 })).toMatchObject({ status: "ready", allInLossUsd: 5 });
    expect(derive({ feeConfigured: false })).toMatchObject({ status: "cost_assumption_missing", ready: false, allInLossUsd: null });
    expect(derive({ bufferConfigured: false })).toMatchObject({ status: "cost_assumption_missing", ready: false });
  });

  it("fails closed for blocked policy and invalid arithmetic", () => {
    expect(derive({ status: "blocked" })).toMatchObject({ status: "cost_policy_unavailable", ready: false });
    expect(derive({ status: "unavailable" })).toMatchObject({ status: "cost_policy_unavailable", ready: false });
    expect(derive({ status: "invalid" })).toMatchObject({ status: "cost_policy_unavailable", ready: false });
    expect(derive({ status: "expired" })).toMatchObject({ status: "cost_assumption_expired", ready: false });
    expect(derive({}, { stopAndSlippageRiskBps: 0 })).toMatchObject({ status: "risk_input_invalid", ready: false });
    expect(derive({}, { stopAndSlippageLossUsd: Number.NaN })).toMatchObject({ status: "risk_input_invalid", ready: false });
  });
});

function derive(
  evidence: Partial<TerminalRouteCostEvidence> = {},
  input: Partial<Parameters<typeof deriveTerminalPlanLossEnvelope>[0]> = {},
) {
  return deriveTerminalPlanLossEnvelope({
    notionalUsd: 100,
    stopAndSlippageLossUsd: 5,
    stopAndSlippageRiskBps: 500,
    riskBudgetUsd: 5,
    maxNotionalUsd: 100,
    costEvidence: {
      status: "ready",
      feeBps: 5,
      bufferBps: 10,
      feeConfigured: true,
      bufferConfigured: true,
      feeCurrent: true,
      bufferCurrent: true,
      feeUpdatedAtMs: 1,
      bufferUpdatedAtMs: 1,
      ageMs: 0,
      expiresAtMs: 1,
      ...evidence,
    },
    ...input,
  });
}
