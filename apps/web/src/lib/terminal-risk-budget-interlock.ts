export type TerminalRiskBudgetStatus =
  | "pass"
  | "invalid_budget"
  | "modeled_loss_unavailable"
  | "over_budget";

export interface TerminalRiskBudgetInput {
  riskBudgetUsd: unknown;
  modeledLossUsd: unknown;
  safeNotionalUsd?: unknown;
  currentNotionalUsd?: unknown;
  minimumNotionalUsd?: unknown;
  modeledLossUnavailableReason?: unknown;
}

export interface TerminalRiskBudgetDecision {
  allowed: boolean;
  status: TerminalRiskBudgetStatus;
  riskBudgetUsd: number | null;
  modeledLossUsd: number | null;
  utilizationPct: number | null;
  safeNotionalUsd: number | null;
  canApplySafeSize: boolean;
  reason: string;
}

/** Fail-closed local check for a plan's modeled dollar loss. */
export function deriveTerminalRiskBudgetInterlock(
  input: TerminalRiskBudgetInput,
): TerminalRiskBudgetDecision {
  const riskBudgetUsd = finitePositive(input.riskBudgetUsd);
  const modeledLossUsd = finiteNonNegative(input.modeledLossUsd);
  const minimumNotionalUsd = finiteNonNegative(input.minimumNotionalUsd) ?? 0;
  const safeCandidate = finitePositive(input.safeNotionalUsd);
  const safeNotionalUsd = safeCandidate != null && safeCandidate >= minimumNotionalUsd
    ? safeCandidate
    : null;
  const currentNotionalUsd = finitePositive(input.currentNotionalUsd);
  const safeSizeDiffers = safeNotionalUsd != null && (
    currentNotionalUsd == null || Math.abs(safeNotionalUsd - currentNotionalUsd) > 0.000_001
  );

  if (riskBudgetUsd == null) {
    return decision({
      status: "invalid_budget",
      riskBudgetUsd: null,
      modeledLossUsd,
      safeNotionalUsd,
      canApplySafeSize: false,
      reason: "Set a positive finite modeled-loss budget.",
    });
  }
  if (modeledLossUsd == null) {
    return decision({
      status: "modeled_loss_unavailable",
      riskBudgetUsd,
      modeledLossUsd: null,
      safeNotionalUsd,
      canApplySafeSize: false,
      reason: typeof input.modeledLossUnavailableReason === "string" && input.modeledLossUnavailableReason.trim()
        ? input.modeledLossUnavailableReason.trim().slice(0, 240)
        : "Modeled plan loss is unavailable; set a valid entry, invalidation, and slippage.",
    });
  }

  const rawUtilization = (modeledLossUsd / riskBudgetUsd) * 100;
  const utilizationPct = Number.isFinite(rawUtilization) ? rawUtilization : null;
  const canApplySafeSize = safeNotionalUsd != null && safeSizeDiffers && (
    modeledLossUsd <= riskBudgetUsd || (currentNotionalUsd != null && safeNotionalUsd < currentNotionalUsd)
  );
  if (!terminalRiskBudgetAllows(modeledLossUsd, riskBudgetUsd)) {
    return {
      allowed: false,
      status: "over_budget",
      riskBudgetUsd,
      modeledLossUsd,
      utilizationPct,
      safeNotionalUsd,
      canApplySafeSize,
      reason: `Modeled plan loss ${formatUsd(modeledLossUsd)} exceeds the ${formatUsd(riskBudgetUsd)} budget.`,
    };
  }

  return {
    allowed: true,
    status: "pass",
    riskBudgetUsd,
    modeledLossUsd,
    utilizationPct,
    safeNotionalUsd,
    canApplySafeSize,
    reason: "Modeled plan loss is within the local budget.",
  };
}

/** Ignores only machine-scale arithmetic noise; any meaningful overage blocks. */
export function terminalRiskBudgetAllows(modeledLossUsd: unknown, riskBudgetUsd: unknown) {
  const modeled = finiteNonNegative(modeledLossUsd);
  const budget = finitePositive(riskBudgetUsd);
  if (modeled == null || budget == null) return false;
  const tolerance = Math.max(1e-9, Math.abs(budget) * 1e-9);
  return modeled <= budget + tolerance;
}

function decision(input: {
  status: Exclude<TerminalRiskBudgetStatus, "pass" | "over_budget">;
  riskBudgetUsd: number | null;
  modeledLossUsd: number | null;
  safeNotionalUsd: number | null;
  canApplySafeSize: boolean;
  reason: string;
}): TerminalRiskBudgetDecision {
  return {
    allowed: false,
    utilizationPct: null,
    ...input,
  };
}

function finitePositive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function formatUsd(value: number) {
  return `$${value.toFixed(2)}`;
}
