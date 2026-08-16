import { sizeTerminalPositionForRisk } from "./terminal-position-sizing";
import { deriveTerminalTradeRisk } from "./trading-terminal-metrics";

export const TERMINAL_INVALIDATION_ATR_MULTIPLIERS = [1, 1.5, 2] as const;
export type TerminalInvalidationAtrMultiplier = (typeof TERMINAL_INVALIDATION_ATR_MULTIPLIERS)[number];

export type TerminalInvalidationPlannerBlocker =
  | "entry_invalid"
  | "atr_invalid"
  | "notional_invalid"
  | "risk_budget_invalid"
  | "slippage_invalid"
  | "cost_assumption_invalid"
  | "max_notional_invalid";

export interface TerminalInvalidationCandidate {
  multiplier: TerminalInvalidationAtrMultiplier;
  invalidationPrice: number;
  distanceBps: number;
  modeledLossUsd: number;
  budgetUtilizationPct: number;
  safeNotionalUsd: number;
}

export interface TerminalInvalidationPlan {
  status: "ready" | "unavailable";
  blocker: TerminalInvalidationPlannerBlocker | null;
  atr: number | null;
  candidates: TerminalInvalidationCandidate[];
}

export function deriveTerminalInvalidationPlan(input: {
  side: "buy" | "sell";
  entryPrice: number | null;
  atr: number | null;
  notionalUsd: number;
  riskBudgetUsd: number;
  slippageBps: number;
  roundTripCostBps?: number;
  maxNotionalUsd: number;
}): TerminalInvalidationPlan {
  const entryPrice = positive(input.entryPrice);
  if (entryPrice == null) return unavailable("entry_invalid");
  const atr = positive(input.atr);
  if (atr == null || atr >= entryPrice) return unavailable("atr_invalid");
  const notionalUsd = positive(input.notionalUsd);
  if (notionalUsd == null) return unavailable("notional_invalid", atr);
  const riskBudgetUsd = positive(input.riskBudgetUsd);
  if (riskBudgetUsd == null) return unavailable("risk_budget_invalid", atr);
  const slippageBps = nonNegative(input.slippageBps);
  if (slippageBps == null) return unavailable("slippage_invalid", atr);
  const roundTripCostBps = input.roundTripCostBps === undefined ? 0 : nonNegative(input.roundTripCostBps);
  if (roundTripCostBps == null) return unavailable("cost_assumption_invalid", atr);
  const maxNotionalUsd = positive(input.maxNotionalUsd);
  if (maxNotionalUsd == null) return unavailable("max_notional_invalid", atr);

  const candidates = TERMINAL_INVALIDATION_ATR_MULTIPLIERS.flatMap((multiplier) => {
    const distance = atr * multiplier;
    const invalidationPrice = input.side === "buy" ? entryPrice - distance : entryPrice + distance;
    if (!Number.isFinite(invalidationPrice) || invalidationPrice <= 0) return [];
    const risk = deriveTerminalTradeRisk({
      side: input.side,
      notionalUsd,
      entryPrice,
      stopPrice: invalidationPrice,
      slippageBps,
    });
    const sizing = sizeTerminalPositionForRisk({
      side: input.side,
      riskBudgetUsd,
      entryPrice,
      stopPrice: invalidationPrice,
      slippageBps,
      roundTripCostBps,
      maxNotionalUsd,
    });
    if (
      risk.stopValid !== true
      || risk.stopDistanceBps == null
      || risk.maxLossUsd == null
      || sizing.status !== "ready"
      || sizing.notionalUsd == null
    ) return [];
    return [{
      multiplier,
      invalidationPrice,
      distanceBps: risk.stopDistanceBps,
      modeledLossUsd: risk.maxLossUsd + notionalUsd * roundTripCostBps / 10_000,
      budgetUtilizationPct: (risk.maxLossUsd + notionalUsd * roundTripCostBps / 10_000) / riskBudgetUsd * 100,
      safeNotionalUsd: sizing.notionalUsd,
    }];
  });
  return candidates.length === TERMINAL_INVALIDATION_ATR_MULTIPLIERS.length
    ? { status: "ready", blocker: null, atr, candidates }
    : unavailable("atr_invalid", atr);
}

export function terminalInvalidationCandidateMatches(
  candidates: readonly TerminalInvalidationCandidate[],
  multiplier: TerminalInvalidationAtrMultiplier,
  expectedPrice: number,
) {
  const candidate = candidates.find((item) => item.multiplier === multiplier);
  return candidate != null
    && Number.isFinite(expectedPrice)
    && Math.abs(candidate.invalidationPrice - expectedPrice) <= Math.max(1e-9, candidate.invalidationPrice * 1e-10);
}

function unavailable(blocker: TerminalInvalidationPlannerBlocker, atr: number | null = null): TerminalInvalidationPlan {
  return { status: "unavailable", blocker, atr, candidates: [] };
}

function positive(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function nonNegative(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
