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
  | "closing"
  | "closed"
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
  target_base_size: string | null;
  filled_notional_micro_usdc: number;
  filled_base_size: string;
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
  close_requested_at: string | null;
  closed_at: string | null;
  close_receipt_commitment: string | null;
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
  filled_base_size: string | null;
  venue_order_reference_commitment: string | null;
}

export function isProvenLiveCrossVenuePair(
  legs: ReadonlyArray<{ venue_id: string; symbol: string }> | null | undefined,
): boolean {
  if (!Array.isArray(legs) || legs.length !== 2) return false;
  const normalized = legs
    .map((leg) => `${String(leg.venue_id).toLowerCase()}:${String(leg.symbol).toUpperCase()}`)
    .sort();
  return normalized[0] === "backpack:SOL_USDC_PERP" && normalized[1] === "hyperliquid:SOL";
}

export function provenCrossVenueBaseSize(input: {
  matchedNotionalMicroUsdc: number;
  limitPrices: readonly [string, string];
  maxSlippageBps: number;
}): string {
  const target = positiveSafeInteger(input.matchedNotionalMicroUsdc, "matched_notional_micro_usdc") / 1_000_000;
  const prices = input.limitPrices.map((price) => Number(positiveDecimal(price, "limit_price")));
  const slippage = input.maxSlippageBps / 10_000;
  if (!Number.isInteger(input.maxSlippageBps) || input.maxSlippageBps < 1 || input.maxSlippageBps > 100) {
    throw new Error("max_hedge_slippage_bps_invalid");
  }
  const lots = Math.ceil(10 / Math.min(...prices) / 0.01 - 1e-12);
  const base = lots * 0.01;
  if (prices.some((price) => base * price * (1 + slippage) > Math.min(target, 11) + 1e-9)) {
    throw new Error("cross_venue_no_common_base_size_within_cap");
  }
  return trimDecimal(base);
}

export interface CrossVenueWorkerReport {
  sequence: number;
  phase: "accepted" | "legs_open" | "hedging" | "unwinding" | "complete" | "failed";
  legs: Array<{
    leg_id: string;
    status: CrossVenueLegStatus;
    filled_notional_micro_usdc: number;
    filled_base_size?: string;
    venue_order_reference?: string | null;
  }>;
  repair_fills?: Array<{
    repair_id: string;
    venue_id: CrossVenueId;
    side: "buy" | "sell";
    filled_notional_micro_usdc: number;
    filled_base_size?: string;
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
    target_base_size?: string;
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
    target_base_size: leg.target_base_size ? positiveDecimal(leg.target_base_size, "target_base_size") : null,
    filled_notional_micro_usdc: 0,
    filled_base_size: "0",
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
    close_requested_at: null,
    closed_at: null,
    close_receipt_commitment: null,
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
    const filledBase = update.filled_base_size === undefined
      ? leg.filled_base_size
      : nonnegativeDecimal(update.filled_base_size, "filled_base_size");
    if (leg.target_base_size && Number(filledBase) > Number(leg.target_base_size) + 1e-9) throw new Error("filled_base_exceeds_target");
    if (Number(filledBase) + 1e-9 < Number(leg.filled_base_size)) throw new Error("filled_base_regression");
    return {
      ...leg,
      status: update.status,
      filled_notional_micro_usdc: filled,
      filled_base_size: filledBase,
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

export function requestCrossVenueClose(current: CrossVenueExecutionPlan, now = new Date()): CrossVenueExecutionPlan {
  if (current.status === "closed" || current.status === "closing") return current;
  if (current.status !== "both_filled" || current.residual_notional_micro_usdc !== 0) {
    throw new Error("cross_venue_close_requires_completed_pair");
  }
  return {
    ...current,
    status: "closing",
    close_requested_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
}

export function completeCrossVenueClose(
  current: CrossVenueExecutionPlan,
  workerReceipt: unknown,
  now = new Date(),
): CrossVenueExecutionPlan {
  if (current.status === "closed") return current;
  if (!new Set<CrossVenueExecutionStatus>(["both_filled", "closing"]).has(current.status)) {
    throw new Error("cross_venue_close_requires_completed_pair");
  }
  const envelope = record(workerReceipt);
  const receipt = record(envelope?.receipt);
  if (
    envelope?.accepted !== true ||
    receipt?.execution_id !== current.execution_id ||
    receipt?.status !== "closed" ||
    receipt?.final_flat_proven !== true
  ) {
    throw new Error("cross_venue_close_flat_proof_required");
  }
  const timestamp = now.toISOString();
  return {
    ...current,
    status: "closed",
    close_requested_at: current.close_requested_at ?? timestamp,
    closed_at: timestamp,
    close_receipt_commitment: consumerCommitment("cross_venue_close_receipt", workerReceipt),
    updated_at: timestamp,
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
      filled_base_size: update.filled_base_size === undefined
        ? prior?.filled_base_size ?? null
        : nonnegativeDecimal(update.filled_base_size, "repair_filled_base_size"),
      venue_order_reference_commitment: update.venue_order_reference
        ? consumerCommitment("venue_order_reference", update.venue_order_reference)
        : prior?.venue_order_reference_commitment ?? null,
    });
  }
  return Array.from(merged.values());
}

function residualNotional(legs: [CrossVenueExecutionLeg, CrossVenueExecutionLeg], repairs: CrossVenueRepairFill[]) {
  if (legs.every((leg) => leg.target_base_size !== null)) {
    const signedBase = legs.reduce((total, leg) => total + (leg.side === "buy" ? 1 : -1) * Number(leg.filled_base_size), 0) +
      repairs.reduce((total, fill) => total + (fill.side === "buy" ? 1 : -1) * Number(fill.filled_base_size ?? 0), 0);
    const benchmark = Math.max(...legs.map((leg) => Number(leg.limit_price)));
    return Math.abs(signedBase) <= 1e-9 ? 0 : Math.ceil(Math.abs(signedBase) * benchmark * 1_000_000);
  }
  const signedLegs = legs.reduce((total, leg) => total + (leg.side === "buy" ? 1 : -1) * leg.filled_notional_micro_usdc, 0);
  const signedRepairs = repairs.reduce((total, fill) => total + (fill.side === "buy" ? 1 : -1) * fill.filled_notional_micro_usdc, 0);
  return Math.abs(signedLegs + signedRepairs);
}

function normalizeMarket(value: string) {
  const normalized = String(value || "").trim().toUpperCase();
  if (!/^[A-Z0-9/_:-]{2,32}$/.test(normalized)) throw new Error("market_invalid");
  return normalized;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
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

function nonnegativeDecimal(value: string, field: string) {
  const normalized = String(value || "").trim();
  const parsed = Number(normalized);
  if (!/^\d+(?:\.\d+)?$/.test(normalized) || !Number.isFinite(parsed) || parsed < 0) throw new Error(`${field}_invalid`);
  return normalized;
}

function trimDecimal(value: number) {
  return value.toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
}

function positiveSafeInteger(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${field}_invalid`);
  return value;
}

function nonnegativeSafeInteger(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field}_invalid`);
  return value;
}
