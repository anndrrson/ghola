import { floorTerminalNotionalUsd } from "./terminal-position-sizing";
import type { TerminalRouteCostEvidence } from "./terminal-route-cost-policy";

export type TerminalPlanLossEnvelopeStatus =
  | "ready"
  | "cost_policy_unavailable"
  | "cost_assumption_missing"
  | "cost_assumption_expired"
  | "risk_input_invalid";

export interface TerminalPlanLossEnvelope {
  status: TerminalPlanLossEnvelopeStatus;
  ready: boolean;
  stopAndSlippageLossUsd: number | null;
  roundTripCostLossUsd: number | null;
  allInLossUsd: number | null;
  feeBps: number | null;
  bufferBps: number | null;
  roundTripCostBps: number | null;
  safeNotionalUsd: number | null;
  reason: string;
}

/** Conservative round-trip envelope: stop/slippage plus entry and exit fee+buffer. */
export function deriveTerminalPlanLossEnvelope(input: {
  notionalUsd: unknown;
  stopAndSlippageLossUsd: unknown;
  stopAndSlippageRiskBps: unknown;
  riskBudgetUsd: unknown;
  maxNotionalUsd: unknown;
  costEvidence: TerminalRouteCostEvidence;
}): TerminalPlanLossEnvelope {
  if (input.costEvidence.status === "blocked") return unavailable("cost_policy_unavailable", "Local fee and execution-buffer policy is unreadable.");
  if (input.costEvidence.status === "unavailable") return unavailable("cost_policy_unavailable", "Local fee and execution-buffer policy is still loading or unavailable.");
  if (input.costEvidence.status === "invalid") return unavailable("cost_policy_unavailable", "Local fee and execution-buffer evidence has an invalid timestamp.");
  if (input.costEvidence.status === "expired") return unavailable("cost_assumption_expired", "Reconfirm the selected venue's expired fee and execution-buffer assumptions.");
  if (input.costEvidence.status !== "ready" || !input.costEvidence.feeConfigured || !input.costEvidence.bufferConfigured) {
    const missing = [!input.costEvidence.feeConfigured ? "fee" : null, !input.costEvidence.bufferConfigured ? "execution buffer" : null].filter(Boolean).join(" and ");
    return unavailable("cost_assumption_missing", `Set an explicit ${missing} assumption for the selected venue.`);
  }
  const notional = positive(input.notionalUsd);
  const stopLoss = nonNegative(input.stopAndSlippageLossUsd);
  const stopRiskBps = positive(input.stopAndSlippageRiskBps);
  const budget = positive(input.riskBudgetUsd);
  const maxNotional = positive(input.maxNotionalUsd);
  const feeBps = boundedBps(input.costEvidence.feeBps);
  const bufferBps = boundedBps(input.costEvidence.bufferBps);
  if (notional == null || stopLoss == null || stopRiskBps == null || budget == null || maxNotional == null || feeBps == null || bufferBps == null) {
    return unavailable("risk_input_invalid", "All-in plan loss is unavailable until risk and cost inputs are valid.");
  }
  const roundTripCostBps = 2 * (feeBps + bufferBps);
  const roundTripCostLossUsd = notional * roundTripCostBps / 10_000;
  const allInLossUsd = stopLoss + roundTripCostLossUsd;
  const totalRiskBps = stopRiskBps + roundTripCostBps;
  const safeNotionalUsd = floorTerminalNotionalUsd(Math.min(maxNotional, budget / (totalRiskBps / 10_000)));
  if (safeNotionalUsd == null || !Number.isFinite(allInLossUsd)) return unavailable("risk_input_invalid", "All-in plan loss is not finite.");
  return {
    status: "ready",
    ready: true,
    stopAndSlippageLossUsd: stopLoss,
    roundTripCostLossUsd,
    allInLossUsd,
    feeBps,
    bufferBps,
    roundTripCostBps,
    safeNotionalUsd,
    reason: "Includes the selected venue's explicit entry and exit fee and execution-buffer assumptions.",
  };
}

function unavailable(status: Exclude<TerminalPlanLossEnvelopeStatus, "ready">, reason: string): TerminalPlanLossEnvelope {
  return { status, ready: false, stopAndSlippageLossUsd: null, roundTripCostLossUsd: null, allInLossUsd: null, feeBps: null, bufferBps: null, roundTripCostBps: null, safeNotionalUsd: null, reason };
}

function positive(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function nonNegative(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function boundedBps(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 500 ? value : null;
}
