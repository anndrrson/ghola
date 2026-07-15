import { consumerCommitment } from "./consumer-production";

export type CrossVenueId = "hyperliquid" | "phoenix" | "backpack";
export type CrossVenueLegStatus = "pending" | "submitted" | "partially_filled" | "filled" | "cancelled" | "rejected";
export type CrossVenueExecutionStatus =
  | "planned"
  | "submitting"
  | "legs_open"
  | "unhedged"
  | "partially_hedged"
  | "hedging"
  | "unwinding"
  | "both_filled"
  | "hedged"
  | "cancelled"
  | "failed"
  | "manual_intervention_required";

export interface CrossVenueRiskBudget {
  max_unhedged_notional_micro_usdc: number;
  max_hedge_slippage_bps: number;
  max_hedge_duration_ms: number;
  max_unwind_loss_micro_usdc: number;
  max_daily_loss_micro_usdc: number;
}

export interface CrossVenueExecutionLeg {
  leg_id: string;
  venue_id: CrossVenueId;
  side: "buy" | "sell";
  symbol: string;
  limit_price: string;
  order_type: "ioc_limit";
  target_notional_micro_usdc: number;
  filled_notional_micro_usdc: number;
  status: CrossVenueLegStatus;
  venue_order_reference_commitment: string | null;
}

export interface CrossVenueExecutionPlan {
  version: 1;
  execution_id: string;
  owner_commitment: string;
  idempotency_key: string;
  opportunity_commitment: string;
  market: string;
  matched_notional_micro_usdc: number;
  risk_budget: CrossVenueRiskBudget;
  legs: [CrossVenueExecutionLeg, CrossVenueExecutionLeg];
  repair_fills: CrossVenueRepairFill[];
  status: CrossVenueExecutionStatus;
  residual_notional_micro_usdc: number;
  last_report_sequence: number;
  unhedged_since_at: string | null;
  hedge_deadline_at: string | null;
  cancel_requested_at: string | null;
  worker_receipt_commitment: string | null;
  failure_code: string | null;
  created_at: string;
  updated_at: string;
}

export interface CrossVenueRepairFill {
  repair_id: string;
  venue_id: CrossVenueId;
  side: "buy" | "sell";
  filled_notional_micro_usdc: number;
  venue_order_reference_commitment: string | null;
}

export interface CrossVenueWorkerReport {
  sequence: number;
  phase: "accepted" | "legs_open" | "hedging" | "unwinding" | "complete" | "failed";
  legs: Array<{
    leg_id: string;
    status: CrossVenueLegStatus;
    filled_notional_micro_usdc: number;
    venue_order_reference?: string | null;
  }>;
  repair_fills?: Array<{
    repair_id: string;
    venue_id: CrossVenueId;
    side: "buy" | "sell";
    filled_notional_micro_usdc: number;
    venue_order_reference?: string | null;
  }>;
  hedge_slippage_bps?: number;
  unwind_loss_micro_usdc?: number;
  daily_realized_loss_micro_usdc?: number;
  failure_code?: string | null;
  observed_at: string;
}

export function createCrossVenueExecutionPlan(input: {
  owner_commitment: string;
  idempotency_key: string;
  opportunity_commitment: string;
  market: string;
  matched_notional_micro_usdc: number;
  risk_budget: CrossVenueRiskBudget;
  legs: Array<{
    venue_id: CrossVenueId;
    side: "buy" | "sell";
    symbol: string;
    limit_price: string;
  }>;
  now?: Date;
}): CrossVenueExecutionPlan {
  if (!/^[A-Za-z0-9._:-]{8,180}$/.test(input.idempotency_key)) throw new Error("idempotency_key_invalid");
  if (!/^consumer_|^ghola_/.test(input.opportunity_commitment)) throw new Error("opportunity_commitment_invalid");
  const market = normalizeMarket(input.market);
  const notional = positiveSafeInteger(input.matched_notional_micro_usdc, "matched_notional_micro_usdc");
  const budget = validateCrossVenueRiskBudget(input.risk_budget, notional);
  if (input.legs.length !== 2) throw new Error("exactly_two_legs_required");
  const [left, right] = input.legs;
  if (left.venue_id === right.venue_id) throw new Error("distinct_venues_required");
  if (left.side === right.side) throw new Error("opposite_sides_required");
  const now = input.now ?? new Date();
  const executionId = consumerCommitment("cross_venue_execution", {
    owner: input.owner_commitment,
    key: input.idempotency_key,
  });
  const legs = input.legs.map((leg, index): CrossVenueExecutionLeg => ({
    leg_id: consumerCommitment("cross_venue_leg", { execution_id: executionId, index }),
    venue_id: leg.venue_id,
    side: leg.side,
    symbol: normalizeSymbol(leg.symbol),
    limit_price: positiveDecimal(leg.limit_price, "limit_price"),
    order_type: "ioc_limit",
    target_notional_micro_usdc: notional,
    filled_notional_micro_usdc: 0,
    status: "pending",
    venue_order_reference_commitment: null,
  })) as [CrossVenueExecutionLeg, CrossVenueExecutionLeg];
  return {
    version: 1,
    execution_id: executionId,
    owner_commitment: input.owner_commitment,
    idempotency_key: input.idempotency_key,
    opportunity_commitment: input.opportunity_commitment,
    market,
    matched_notional_micro_usdc: notional,
    risk_budget: budget,
    legs,
    repair_fills: [],
    status: "planned",
    residual_notional_micro_usdc: 0,
    last_report_sequence: 0,
    unhedged_since_at: null,
    hedge_deadline_at: null,
    cancel_requested_at: null,
    worker_receipt_commitment: null,
    failure_code: null,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
}

export function applyCrossVenueWorkerReport(
  current: CrossVenueExecutionPlan,
  report: CrossVenueWorkerReport,
): CrossVenueExecutionPlan {
  if (!Number.isSafeInteger(report.sequence) || report.sequence <= current.last_report_sequence) {
    throw new Error("report_sequence_replay");
  }
  const observedAt = new Date(report.observed_at);
  if (!Number.isFinite(observedAt.getTime())) throw new Error("report_observed_at_invalid");
  const updates = new Map(report.legs.map((leg) => [leg.leg_id, leg]));
  for (const update of report.legs) {
    if (!current.legs.some((leg) => leg.leg_id === update.leg_id)) throw new Error("unknown_leg_id");
  }
  const legs = current.legs.map((leg) => {
    const update = updates.get(leg.leg_id);
    if (!update) return leg;
    const filled = nonnegativeSafeInteger(update.filled_notional_micro_usdc, "filled_notional_micro_usdc");
    if (filled < leg.filled_notional_micro_usdc) throw new Error("filled_notional_regression");
    if (filled > leg.target_notional_micro_usdc) throw new Error("filled_notional_exceeds_target");
    return {
      ...leg,
      status: update.status,
      filled_notional_micro_usdc: filled,
      venue_order_reference_commitment: update.venue_order_reference
        ? consumerCommitment("venue_order_reference", update.venue_order_reference)
        : leg.venue_order_reference_commitment,
    };
  }) as [CrossVenueExecutionLeg, CrossVenueExecutionLeg];
  const repairs = mergeRepairFills(current.repair_fills, report.repair_fills ?? [], current.matched_notional_micro_usdc);
  const residual = residualNotional(legs, repairs);
  const unhedgedSince = residual > 0 ? current.unhedged_since_at ?? observedAt.toISOString() : null;
  const hedgeDeadline = unhedgedSince
    ? new Date(Date.parse(unhedgedSince) + current.risk_budget.max_hedge_duration_ms).toISOString()
    : null;
  if ((report.hedge_slippage_bps ?? 0) > current.risk_budget.max_hedge_slippage_bps) {
    return intervention({ ...current, legs, repair_fills: repairs }, report, "hedge_slippage_budget_exceeded", observedAt);
  }
  if ((report.unwind_loss_micro_usdc ?? 0) > current.risk_budget.max_unwind_loss_micro_usdc) {
    return intervention({ ...current, legs, repair_fills: repairs }, report, "unwind_loss_budget_exceeded", observedAt);
  }
  if ((report.daily_realized_loss_micro_usdc ?? 0) > current.risk_budget.max_daily_loss_micro_usdc) {
    return intervention({ ...current, legs, repair_fills: repairs }, report, "daily_loss_budget_exceeded", observedAt);
  }
  if (residual > current.risk_budget.max_unhedged_notional_micro_usdc) {
    return intervention({ ...current, legs, repair_fills: repairs }, report, "unhedged_notional_budget_exceeded", observedAt);
  }
  const bothTerminal = legs.every((leg) => ["filled", "cancelled", "rejected"].includes(leg.status));
  let status: CrossVenueExecutionStatus;
  if (report.phase === "failed") status = residual > 0 ? "manual_intervention_required" : "failed";
  else if (report.phase === "unwinding") status = "unwinding";
  else if (residual > 0 && hedgeDeadline && observedAt.getTime() > Date.parse(hedgeDeadline)) status = "manual_intervention_required";
  else if (report.phase === "hedging") status = "hedging";
  else if (residual > 0) status = legs.some((leg) => leg.filled_notional_micro_usdc === 0) ? "unhedged" : "partially_hedged";
  else if ((report.phase === "complete" || bothTerminal) && repairs.some((repair) => repair.filled_notional_micro_usdc > 0)) status = "hedged";
  else if ((report.phase === "complete" || bothTerminal) && legs.every((leg) => leg.filled_notional_micro_usdc > 0)) status = "both_filled";
  else status = "legs_open";
  return {
    ...current,
    legs,
    repair_fills: repairs,
    status,
    residual_notional_micro_usdc: residual,
    unhedged_since_at: unhedgedSince,
    hedge_deadline_at: hedgeDeadline,
    last_report_sequence: report.sequence,
    failure_code: report.failure_code || (status === "manual_intervention_required" ? "hedge_deadline_exceeded" : null),
    updated_at: observedAt.toISOString(),
  };
}

export function requestCrossVenueCancellation(current: CrossVenueExecutionPlan, now = new Date()): CrossVenueExecutionPlan {
  if (["both_filled", "hedged", "cancelled", "failed", "manual_intervention_required"].includes(current.status)) return current;
  const hasFill = current.legs.some((leg) => leg.filled_notional_micro_usdc > 0) || current.repair_fills.some((fill) => fill.filled_notional_micro_usdc > 0);
  return {
    ...current,
    status: hasFill ? "unwinding" : "cancelled",
    cancel_requested_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
}

export function validateCrossVenueRiskBudget(input: CrossVenueRiskBudget, matchedNotional: number): CrossVenueRiskBudget {
  const maxUnhedged = positiveSafeInteger(input.max_unhedged_notional_micro_usdc, "max_unhedged_notional_micro_usdc");
  if (maxUnhedged > matchedNotional) throw new Error("unhedged_budget_exceeds_matched_notional");
  if (!Number.isInteger(input.max_hedge_slippage_bps) || input.max_hedge_slippage_bps < 1 || input.max_hedge_slippage_bps > 100) {
    throw new Error("max_hedge_slippage_bps_invalid");
  }
  if (!Number.isInteger(input.max_hedge_duration_ms) || input.max_hedge_duration_ms < 500 || input.max_hedge_duration_ms > 30_000) {
    throw new Error("max_hedge_duration_ms_invalid");
  }
  const maxLoss = positiveSafeInteger(input.max_unwind_loss_micro_usdc, "max_unwind_loss_micro_usdc");
  const maxDailyLoss = positiveSafeInteger(input.max_daily_loss_micro_usdc, "max_daily_loss_micro_usdc");
  return { ...input, max_unhedged_notional_micro_usdc: maxUnhedged, max_unwind_loss_micro_usdc: maxLoss, max_daily_loss_micro_usdc: maxDailyLoss };
}

function intervention(
  current: CrossVenueExecutionPlan,
  report: CrossVenueWorkerReport,
  failureCode: string,
  observedAt: Date,
): CrossVenueExecutionPlan {
  return {
    ...current,
    status: "manual_intervention_required",
    last_report_sequence: report.sequence,
    residual_notional_micro_usdc: residualNotional(current.legs, current.repair_fills),
    failure_code: failureCode,
    updated_at: observedAt.toISOString(),
  };
}

function mergeRepairFills(
  current: CrossVenueRepairFill[],
  updates: NonNullable<CrossVenueWorkerReport["repair_fills"]>,
  maximum: number,
): CrossVenueRepairFill[] {
  const merged = new Map(current.map((fill) => [fill.repair_id, fill]));
  for (const update of updates) {
    if (!/^[A-Za-z0-9._:-]{8,180}$/.test(update.repair_id)) throw new Error("repair_id_invalid");
    const filled = nonnegativeSafeInteger(update.filled_notional_micro_usdc, "repair_filled_notional_micro_usdc");
    if (filled > maximum) throw new Error("repair_fill_exceeds_matched_notional");
    const prior = merged.get(update.repair_id);
    if (prior && (prior.venue_id !== update.venue_id || prior.side !== update.side || filled < prior.filled_notional_micro_usdc)) {
      throw new Error("repair_fill_regression");
    }
    merged.set(update.repair_id, {
      repair_id: update.repair_id,
      venue_id: update.venue_id,
      side: update.side,
      filled_notional_micro_usdc: filled,
      venue_order_reference_commitment: update.venue_order_reference
        ? consumerCommitment("venue_order_reference", update.venue_order_reference)
        : prior?.venue_order_reference_commitment ?? null,
    });
  }
  return Array.from(merged.values());
}

function residualNotional(legs: [CrossVenueExecutionLeg, CrossVenueExecutionLeg], repairs: CrossVenueRepairFill[]) {
  const signedLegs = legs.reduce((total, leg) => total + (leg.side === "buy" ? 1 : -1) * leg.filled_notional_micro_usdc, 0);
  const signedRepairs = repairs.reduce((total, fill) => total + (fill.side === "buy" ? 1 : -1) * fill.filled_notional_micro_usdc, 0);
  return Math.abs(signedLegs + signedRepairs);
}

function normalizeMarket(value: string) {
  const normalized = String(value || "").trim().toUpperCase();
  if (!/^[A-Z0-9/_:-]{2,32}$/.test(normalized)) throw new Error("market_invalid");
  return normalized;
}

function normalizeSymbol(value: string) {
  const normalized = String(value || "").trim().toUpperCase();
  if (!/^[A-Z0-9/_:-]{1,32}$/.test(normalized)) throw new Error("symbol_invalid");
  return normalized;
}

function positiveDecimal(value: string, field: string) {
  const normalized = String(value || "").trim();
  const parsed = Number(normalized);
  if (!/^\d+(?:\.\d+)?$/.test(normalized) || !Number.isFinite(parsed) || parsed <= 0) throw new Error(`${field}_invalid`);
  return normalized;
}

function positiveSafeInteger(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${field}_invalid`);
  return value;
}

function nonnegativeSafeInteger(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field}_invalid`);
  return value;
}
