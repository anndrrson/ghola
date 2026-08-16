export interface TerminalPositionSizingInput {
  side: "buy" | "sell";
  riskBudgetUsd: number;
  entryPrice: number | null;
  stopPrice: number | null;
  slippageBps: number;
  roundTripCostBps?: number;
  maxNotionalUsd: number;
}

export interface TerminalPositionSizing {
  status: "ready" | "invalid_budget" | "invalid_entry" | "invalid_stop" | "invalid_cost_assumption";
  totalRiskBps: number | null;
  uncappedNotionalUsd: number | null;
  notionalUsd: number | null;
  baseSize: number | null;
  projectedLossUsd: number | null;
  capped: boolean;
}

/** Converts an explicit dollar loss budget into a bounded quote size. */
export function sizeTerminalPositionForRisk(
  input: TerminalPositionSizingInput,
): TerminalPositionSizing {
  const budget = positive(input.riskBudgetUsd);
  if (budget == null) return empty("invalid_budget");
  const entry = positive(input.entryPrice);
  if (entry == null) return empty("invalid_entry");
  const stop = positive(input.stopPrice);
  const stopValid = stop != null && (input.side === "buy" ? stop < entry : stop > entry);
  if (!stopValid) return empty("invalid_stop");

  const stopDistanceBps = (Math.abs(entry - stop) / entry) * 10_000;
  const slippageBps = nonNegative(input.slippageBps) ?? 0;
  const roundTripCostBps = input.roundTripCostBps === undefined ? 0 : nonNegative(input.roundTripCostBps);
  if (roundTripCostBps == null) return empty("invalid_cost_assumption");
  const totalRiskBps = stopDistanceBps + slippageBps + roundTripCostBps;
  const maxNotional = positive(input.maxNotionalUsd);
  if (!(totalRiskBps > 0) || maxNotional == null) return empty("invalid_stop");

  const uncappedNotionalUsd = budget / (totalRiskBps / 10_000);
  const boundedNotional = Math.min(uncappedNotionalUsd, maxNotional);
  const notionalUsd = floorTerminalNotionalUsd(boundedNotional) as number;
  return {
    status: "ready",
    totalRiskBps,
    uncappedNotionalUsd,
    notionalUsd,
    baseSize: notionalUsd / entry,
    projectedLossUsd: notionalUsd * (totalRiskBps / 10_000),
    capped: uncappedNotionalUsd > maxNotional,
  };
}

/** Normalizes an actionable quote notional without ever rounding risk upward. */
export function floorTerminalNotionalUsd(value: number): number | null {
  if (!Number.isFinite(value) || value < 0) return null;
  const scaledCents = value * 100;
  const nearestCent = Math.round(scaledCents);
  const stableCents = Math.abs(scaledCents - nearestCent) <= 1e-9
    ? nearestCent
    : scaledCents;
  return Math.floor(stableCents) / 100;
}

function empty(status: Exclude<TerminalPositionSizing["status"], "ready">): TerminalPositionSizing {
  return {
    status,
    totalRiskBps: null,
    uncappedNotionalUsd: null,
    notionalUsd: null,
    baseSize: null,
    projectedLossUsd: null,
    capped: false,
  };
}

function positive(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function nonNegative(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
