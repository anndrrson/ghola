import { createHash } from "node:crypto";

const ACTIVE = new Set();
const VENUES = new Set(["hyperliquid", "phoenix", "backpack"]);

export function validateCrossVenueExecutionRequest(body) {
  const errors = [];
  if (!body || typeof body !== "object" || Array.isArray(body)) return ["request body must be an object"];
  if (body.version !== 1) errors.push("version must be 1");
  if (!/^consumer_cross_venue_execution_[a-f0-9]{48}$/.test(String(body.execution_id || ""))) errors.push("execution_id is invalid");
  if (!isCommitment(body.owner_commitment)) errors.push("owner_commitment is required");
  if (!isCommitment(body.opportunity_commitment)) errors.push("opportunity_commitment is required");
  if (!/^[A-Z0-9/_:-]{2,32}$/.test(String(body.market || ""))) errors.push("market is invalid");
  if (!safePositive(body.matched_notional_micro_usdc)) errors.push("matched_notional_micro_usdc is invalid");
  if (!Array.isArray(body.legs) || body.legs.length !== 2) errors.push("exactly two legs are required");
  const legs = Array.isArray(body.legs) ? body.legs : [];
  for (const leg of legs) errors.push(...validateLeg(leg));
  if (legs.length === 2 && legs[0]?.venue_id === legs[1]?.venue_id) errors.push("leg venues must be distinct");
  if (legs.length === 2 && legs[0]?.side === legs[1]?.side) errors.push("leg sides must be opposite");
  if (legs.some((leg) => leg?.target_notional_micro_usdc !== body.matched_notional_micro_usdc)) errors.push("leg notional must match the plan");
  errors.push(...validateBudget(body.risk_budget, body.matched_notional_micro_usdc));
  return [...new Set(errors)];
}

export function createCrossVenueCoordinator({ state, adapter, callback = defaultCallback, schedule = queueMicrotask }) {
  return {
    ready() {
      return Boolean(adapter && typeof adapter.preflight === "function" && typeof adapter.submit === "function" &&
        typeof adapter.hedge === "function" && typeof adapter.unwind === "function" && typeof adapter.cancel === "function");
    },

    async submit(plan) {
      const errors = validateCrossVenueExecutionRequest(plan);
      if (errors.length) return { ok: false, status: 400, error: "invalid_cross_venue_execution", details: errors };
      if (!this.ready()) return { ok: false, status: 503, error: "cross_venue_byo_adapter_unavailable" };
      const existing = await state.getExecutionAttempt(plan.execution_id);
      if (existing) return { ok: true, status: 202, replayed: true, receipt: publicReceipt(existing) };
      const attempt = {
        version: 1,
        execution_id: plan.execution_id,
        owner_commitment: plan.owner_commitment,
        status: "accepted",
        sequence: 1,
        cancel_requested: false,
        plan: publicPlan(plan),
        legs: plan.legs.map((leg) => publicLeg(leg)),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await state.putExecutionAttempt(plan.execution_id, attempt);
      if (!ACTIVE.has(plan.execution_id)) {
        ACTIVE.add(plan.execution_id);
        schedule(() => run({ plan, state, adapter, callback })
          .catch((error) => console.error("cross-venue execution failed", safeError(error)))
          .finally(() => ACTIVE.delete(plan.execution_id)));
      }
      return { ok: true, status: 202, replayed: false, receipt: publicReceipt(attempt) };
    },

    async cancel(plan) {
      const errors = validateCrossVenueExecutionRequest(plan);
      if (errors.length) return { ok: false, status: 400, error: "invalid_cross_venue_execution", details: errors };
      if (!this.ready()) return { ok: false, status: 503, error: "cross_venue_byo_adapter_unavailable" };
      const current = await state.getExecutionAttempt(plan.execution_id);
      if (!current) return { ok: false, status: 404, error: "cross_venue_execution_not_found" };
      const next = { ...current, cancel_requested: true, status: "cancel_requested", updated_at: new Date().toISOString() };
      await state.putExecutionAttempt(plan.execution_id, next);
      await adapter.cancel({ plan: publicPlan(plan), attempt: next });
      return { ok: true, status: 202, replayed: false, receipt: publicReceipt(next) };
    },
  };
}

async function run({ plan, state, adapter, callback }) {
  let sequence = 1;
  try {
    await withTimeout(Promise.all(plan.legs.map((leg) => adapter.preflight({ plan: publicPlan(plan), leg: publicLeg(leg) }))), 2_000, "cross_venue_preflight_timeout");
    sequence += 1;
    await persistAndReport({
      state, callback, plan, sequence, phase: "legs_open",
      legs: plan.legs.map((leg) => ({ leg_id: leg.leg_id, status: "submitted", filled_notional_micro_usdc: 0 })),
    });
    const submitted = await withTimeout(Promise.allSettled(plan.legs.map((leg) => adapter.submit({ plan: publicPlan(plan), leg: publicLeg(leg) }))), 2_000, "cross_venue_submit_timeout");
    const fills = submitted.map((result, index) => normalizeResult(result, plan.legs[index]));
    const residual = Math.abs(fills[0].filled_notional_micro_usdc - fills[1].filled_notional_micro_usdc);
    if (residual === 0 && fills.every((fill) => fill.filled_notional_micro_usdc > 0)) {
      sequence += 1;
      return persistAndReport({ state, callback, plan, sequence, phase: "complete", legs: fills });
    }
    if (residual === 0) {
      sequence += 1;
      return persistAndReport({ state, callback, plan, sequence, phase: "failed", legs: fills, failure_code: "both_legs_unfilled" });
    }
    sequence += 1;
    await persistAndReport({ state, callback, plan, sequence, phase: "hedging", legs: fills });
    const dominant = fills[0].filled_notional_micro_usdc > fills[1].filled_notional_micro_usdc ? 0 : 1;
    const hedgeSide = plan.legs[dominant].side === "buy" ? "sell" : "buy";
    let repair;
    try {
      repair = await withTimeout(adapter.hedge({
        plan: publicPlan(plan),
        side: hedgeSide,
        notional_micro_usdc: residual,
        preferred_venue_id: preferredHedgeVenue(plan),
        max_slippage_bps: plan.risk_budget.max_hedge_slippage_bps,
      }), plan.risk_budget.max_hedge_duration_ms, "cross_venue_hedge_timeout");
    } catch {
      repair = await withTimeout(adapter.unwind({
        plan: publicPlan(plan),
        side: hedgeSide,
        notional_micro_usdc: residual,
        venue_id: plan.legs[dominant].venue_id,
        max_loss_micro_usdc: plan.risk_budget.max_unwind_loss_micro_usdc,
      }), plan.risk_budget.max_hedge_duration_ms, "cross_venue_unwind_timeout");
    }
    const repaired = normalizeRepair(repair, residual);
    const repairFill = {
      repair_id: `cross_repair_${digest({ execution_id: plan.execution_id, sequence, side: hedgeSide })}`,
      venue_id: repaired.venue_id || preferredHedgeVenue(plan),
      side: hedgeSide,
      filled_notional_micro_usdc: repaired.filled_notional_micro_usdc,
      venue_order_reference: repaired.venue_order_reference,
    };
    const signedOriginal = plan.legs.reduce((total, leg, index) => total + (leg.side === "buy" ? 1 : -1) * fills[index].filled_notional_micro_usdc, 0);
    const signedRepair = (repairFill.side === "buy" ? 1 : -1) * repairFill.filled_notional_micro_usdc;
    const finalResidual = Math.abs(signedOriginal + signedRepair);
    sequence += 1;
    return persistAndReport({
      state, callback, plan, sequence,
      phase: finalResidual === 0 ? "complete" : "failed",
      legs: fills,
      repair_fills: [repairFill],
      hedge_slippage_bps: repaired.slippage_bps,
      unwind_loss_micro_usdc: repaired.realized_loss_micro_usdc,
      daily_realized_loss_micro_usdc: repaired.daily_realized_loss_micro_usdc,
      failure_code: finalResidual === 0 ? null : "automatic_hedge_incomplete",
    });
  } catch (error) {
    sequence += 1;
    return persistAndReport({
      state, callback, plan, sequence, phase: "failed", legs: [],
      failure_code: safeError(error),
    });
  }
}

async function persistAndReport({ state, callback, plan, sequence, phase, legs, ...metrics }) {
  const report = {
    sequence,
    phase,
    legs,
    ...metrics,
    observed_at: new Date().toISOString(),
  };
  await state.putExecutionAttempt(plan.execution_id, {
    version: 1,
    execution_id: plan.execution_id,
    owner_commitment: plan.owner_commitment,
    status: phase,
    sequence,
    plan: publicPlan(plan),
    legs,
    report,
    updated_at: report.observed_at,
  });
  await callback({ execution_id: plan.execution_id, owner_commitment: plan.owner_commitment, report });
  return report;
}

async function defaultCallback(payload) {
  const url = process.env.GHOLA_CROSS_VENUE_RECONCILIATION_URL || "";
  const token = process.env.GHOLA_RECONCILIATION_INGEST_TOKEN || process.env.PRIVATE_AGENT_RECONCILIATION_INGEST_TOKEN || "";
  if (!url || token.length < 32) throw Object.assign(new Error("cross_venue_reconciliation_callback_unavailable"), { code: "cross_venue_reconciliation_callback_unavailable" });
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5_000),
    }).catch((error) => { lastError = error; return null; });
    if (response?.ok) return;
    lastError = new Error(`cross_venue_reconciliation_callback_${response?.status || "unavailable"}`);
    await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
  }
  throw lastError || new Error("cross_venue_reconciliation_callback_unavailable");
}

function normalizeResult(result, leg) {
  if (result.status === "rejected") return { leg_id: leg.leg_id, status: "rejected", filled_notional_micro_usdc: 0 };
  const fill = result.value || {};
  const amount = boundedFill(fill.filled_notional_micro_usdc, leg.target_notional_micro_usdc);
  return {
    leg_id: leg.leg_id,
    status: amount === 0 ? "rejected" : amount === leg.target_notional_micro_usdc ? "filled" : "partially_filled",
    filled_notional_micro_usdc: amount,
    venue_order_reference: safeReference(fill.venue_order_reference),
  };
}

function normalizeRepair(value, maximum) {
  return {
    filled_notional_micro_usdc: boundedFill(value?.filled_notional_micro_usdc, maximum),
    venue_order_reference: safeReference(value?.venue_order_reference),
    slippage_bps: nonnegative(value?.slippage_bps),
    realized_loss_micro_usdc: nonnegative(value?.realized_loss_micro_usdc),
    daily_realized_loss_micro_usdc: nonnegative(value?.daily_realized_loss_micro_usdc),
    venue_id: VENUES.has(value?.venue_id) ? value.venue_id : null,
  };
}

function publicPlan(plan) {
  return {
    version: 1,
    execution_id: plan.execution_id,
    owner_commitment: plan.owner_commitment,
    opportunity_commitment: plan.opportunity_commitment,
    market: plan.market,
    matched_notional_micro_usdc: plan.matched_notional_micro_usdc,
    risk_budget: { ...plan.risk_budget },
    legs: plan.legs.map(publicLeg),
  };
}

function publicLeg(leg) {
  return {
    leg_id: leg.leg_id,
    venue_id: leg.venue_id,
    side: leg.side,
    symbol: leg.symbol,
    limit_price: leg.limit_price,
    target_notional_micro_usdc: leg.target_notional_micro_usdc,
    order_type: "ioc_limit",
  };
}

function publicReceipt(attempt) {
  return {
    execution_id: attempt.execution_id,
    status: attempt.status,
    sequence: attempt.sequence,
    receipt_commitment: `cross_venue_receipt_${digest({ execution_id: attempt.execution_id, status: attempt.status, sequence: attempt.sequence })}`,
  };
}

function preferredHedgeVenue(plan) {
  return plan.legs.find((leg) => leg.venue_id === "hyperliquid")?.venue_id || plan.legs[0].venue_id;
}

function validateLeg(leg) {
  const errors = [];
  if (!leg || typeof leg !== "object" || Array.isArray(leg)) return ["leg must be an object"];
  if (!isCommitment(leg.leg_id)) errors.push("leg_id is invalid");
  if (!VENUES.has(leg.venue_id)) errors.push("leg venue is unsupported");
  if (!new Set(["buy", "sell"]).has(leg.side)) errors.push("leg side is invalid");
  if (!/^[A-Z0-9/_:-]{1,32}$/.test(String(leg.symbol || ""))) errors.push("leg symbol is invalid");
  if (!(Number(leg.limit_price) > 0)) errors.push("leg limit price is invalid");
  if (leg.order_type !== "ioc_limit") errors.push("leg order type must be ioc_limit");
  if (!safePositive(leg.target_notional_micro_usdc)) errors.push("leg target notional is invalid");
  return errors;
}

function validateBudget(budget, notional) {
  if (!budget || typeof budget !== "object" || Array.isArray(budget)) return ["risk_budget is required"];
  const errors = [];
  if (!safePositive(budget.max_unhedged_notional_micro_usdc) || budget.max_unhedged_notional_micro_usdc > notional) errors.push("unhedged budget is invalid");
  if (!Number.isInteger(budget.max_hedge_slippage_bps) || budget.max_hedge_slippage_bps < 1 || budget.max_hedge_slippage_bps > 100) errors.push("hedge slippage budget is invalid");
  if (!Number.isInteger(budget.max_hedge_duration_ms) || budget.max_hedge_duration_ms < 500 || budget.max_hedge_duration_ms > 30_000) errors.push("hedge duration budget is invalid");
  if (!safePositive(budget.max_unwind_loss_micro_usdc)) errors.push("unwind loss budget is invalid");
  if (!safePositive(budget.max_daily_loss_micro_usdc)) errors.push("daily loss budget is invalid");
  return errors;
}

function isCommitment(value) { return typeof value === "string" && /^[A-Za-z0-9._:-]{8,180}$/.test(value); }
function safePositive(value) { return Number.isSafeInteger(value) && value > 0; }
function nonnegative(value) { return Number.isSafeInteger(value) && value >= 0 ? value : 0; }
function boundedFill(value, maximum) { return Math.min(maximum, nonnegative(value)); }
function safeReference(value) { return typeof value === "string" && value.length > 0 && value.length <= 180 ? value : null; }
function safeError(error) { return /^[a-z0-9_:-]{1,120}$/i.test(String(error?.code || error?.message || "")) ? String(error?.code || error?.message) : "cross_venue_execution_failed"; }
function digest(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 48); }
function withTimeout(promise, timeoutMs, code) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(code), { code })), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function resetCrossVenueCoordinatorForTests() {
  ACTIVE.clear();
}
