import { createHash } from "node:crypto";
import { emitOperatorEvent } from "../observability/operator-events.js";

const ACTIVE = new Set();
const VENUES = new Set(["hyperliquid", "phoenix", "backpack"]);
const REQUIRED_STATE_METHODS = [
  "claimExecution",
  "recordExecutionClaimEvidence",
  "completeExecutionClaim",
  "markExecutionClaimReconcileRequired",
  "getExecutionClaimEvidence",
  "resolveExecutionClaim",
];

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

export function crossVenueExecutionRequestDigest(plan) {
  return createHash("sha256").update(stableJson(publicPlan(plan))).digest("hex");
}

export function createCrossVenueCoordinator({ state, adapter, callback = defaultCallback, schedule = queueMicrotask }) {
  const coordinator = {
    readiness() {
      const reasons = [];
      if (!REQUIRED_STATE_METHODS.every((method) => typeof state?.[method] === "function")) {
        reasons.push("cross_venue_durable_claim_store_unavailable");
      }
      if (!adapter || adapter.durable_claims !== true) reasons.push("cross_venue_durable_adapter_unavailable");
      for (const method of ["preflight", "submit", "hedge", "unwind", "cancel", "reconcile"]) {
        if (typeof adapter?.[method] !== "function") reasons.push(`cross_venue_adapter_${method}_unavailable`);
      }
      const adapterStatus = typeof adapter?.readiness === "function" ? adapter.readiness() : null;
      if (Array.isArray(adapterStatus?.reason_codes)) reasons.push(...adapterStatus.reason_codes.map(String));
      return { ready: reasons.length === 0, reason_codes: [...new Set(reasons)] };
    },

    ready() {
      return this.readiness().ready;
    },

    async submit(plan) {
      const errors = validateCrossVenueExecutionRequest(plan);
      if (errors.length) return { ok: false, status: 400, error: "invalid_cross_venue_execution", details: errors };
      const readiness = this.readiness();
      if (!readiness.ready) {
        return { ok: false, status: 503, error: readiness.reason_codes[0] || "cross_venue_byo_adapter_unavailable", details: readiness.reason_codes };
      }
      const claimContext = parentClaimContext(plan);
      const claim = await state.claimExecution(plan.execution_id, claimContext);
      if (claim?.status === "completed" && claim.receipt) {
        return { ok: true, status: 200, replayed: true, receipt: publicReceipt(claim.receipt) };
      }
      if (claim?.status === "context_mismatch") {
        return { ok: false, status: 409, error: "cross_venue_execution_context_mismatch" };
      }
      if (claim?.status === "rejected" && claim.rejection) {
        return { ok: false, status: 409, error: claim.rejection.error_code || "cross_venue_execution_rejected" };
      }
      if (claim?.status === "reconcile_required" || claim?.status === "in_progress") {
        return coordinator.reconcile(plan);
      }
      if (claim?.status !== "claimed" || !claim.claim_token) {
        return { ok: false, status: 409, error: "cross_venue_reconciliation_required" };
      }

      const accepted = parentCompletion({
        plan,
        claimContext,
        phase: "accepted",
        sequence: 1,
        legs: plan.legs.map((leg) => ({
          leg_id: leg.leg_id,
          status: "pending",
          filled_notional_micro_usdc: 0,
        })),
      });
      await state.recordExecutionClaimEvidence(plan.execution_id, claim.claim_token, accepted);
      await reportBestEffort(callback, plan, accepted.receipt.report);
      if (!ACTIVE.has(plan.execution_id)) {
        ACTIVE.add(plan.execution_id);
        schedule(() => run({
          plan,
          state,
          adapter,
          callback,
          claimContext,
          claimToken: claim.claim_token,
        }).catch((error) => {
          void emitOperatorEvent("cross_venue_execution_unhandled", {
            severity: "critical",
            execution_id: plan.execution_id,
            error_code: safeError(error),
          });
        }).finally(() => ACTIVE.delete(plan.execution_id)));
      }
      return { ok: true, status: 202, replayed: false, receipt: publicReceipt(accepted.receipt) };
    },

    async reconcile(plan) {
      const evidence = await state.getExecutionClaimEvidence(plan.execution_id);
      if (!evidence) return { ok: false, status: 404, error: "cross_venue_execution_not_found" };
      if (evidence.context?.request_digest !== crossVenueExecutionRequestDigest(plan)) {
        return { ok: false, status: 409, error: "cross_venue_execution_context_mismatch" };
      }
      let recovered;
      try {
        recovered = await adapter.reconcile({ plan: publicPlan(plan), evidence });
      } catch (error) {
        void emitOperatorEvent("cross_venue_reconciliation_failed", {
          severity: "critical",
          execution_id: plan.execution_id,
          error_code: safeError(error),
        });
        return { ok: false, status: 409, error: "cross_venue_reconciliation_required" };
      }
      if (!recovered?.terminal || !Array.isArray(recovered.legs)) {
        return { ok: false, status: 409, error: "cross_venue_reconciliation_required" };
      }
      const sequence = Math.max(2, Number(evidence.attempt?.sequence || 1) + 1);
      const phase = recovered.phase === "complete" ? "complete" : "failed";
      const completion = parentCompletion({
        plan,
        claimContext: parentClaimContext(plan),
        phase,
        sequence,
        legs: recovered.legs,
        repair_fills: recovered.repair_fills || [],
        failure_code: recovered.failure_code || null,
        finalProof: recovered.final_proof,
      });
      try {
        const resolved = await state.resolveExecutionClaim(plan.execution_id, completion);
        await reportBestEffort(callback, plan, completion.receipt.report);
        return { ok: true, status: 200, replayed: true, receipt: publicReceipt(resolved) };
      } catch (error) {
        void emitOperatorEvent("cross_venue_reconciliation_resolution_failed", {
          severity: "critical",
          execution_id: plan.execution_id,
          error_code: safeError(error),
        });
        return { ok: false, status: 409, error: "cross_venue_reconciliation_required" };
      }
    },

    async cancel(plan) {
      const errors = validateCrossVenueExecutionRequest(plan);
      if (errors.length) return { ok: false, status: 400, error: "invalid_cross_venue_execution", details: errors };
      const readiness = this.readiness();
      if (!readiness.ready) {
        return { ok: false, status: 503, error: readiness.reason_codes[0] || "cross_venue_byo_adapter_unavailable", details: readiness.reason_codes };
      }
      const evidence = await state.getExecutionClaimEvidence(plan.execution_id);
      if (!evidence) return { ok: false, status: 404, error: "cross_venue_execution_not_found" };
      if (evidence.context?.request_digest !== crossVenueExecutionRequestDigest(plan)) {
        return { ok: false, status: 409, error: "cross_venue_execution_context_mismatch" };
      }
      const result = await adapter.cancel({ plan: publicPlan(plan), evidence });
      return {
        ok: true,
        status: 202,
        replayed: result?.replayed === true,
        receipt: publicReceipt(evidence.receipt || evidence.attempt || { execution_id: plan.execution_id, status: "cancel_requested", sequence: 1 }),
      };
    },
  };
  return coordinator;
}

async function run({ plan, state, adapter, callback, claimContext, claimToken }) {
  let sequence = 1;
  let lastCompletion = null;
  try {
    await withTimeout(
      Promise.all(plan.legs.map((leg) => adapter.preflight({ plan: publicPlan(plan), leg: publicLeg(leg) }))),
      5_000,
      "cross_venue_preflight_timeout",
    );
    sequence += 1;
    lastCompletion = parentCompletion({
      plan,
      claimContext,
      phase: "legs_open",
      sequence,
      legs: plan.legs.map((leg) => ({ leg_id: leg.leg_id, status: "submitted", filled_notional_micro_usdc: 0 })),
    });
    await state.recordExecutionClaimEvidence(plan.execution_id, claimToken, lastCompletion);
    await reportBestEffort(callback, plan, lastCompletion.receipt.report);

    const submitted = await withTimeout(
      Promise.allSettled(plan.legs.map((leg) => adapter.submit({ plan: publicPlan(plan), leg: publicLeg(leg) }))),
      Math.max(12_000, plan.risk_budget.max_hedge_duration_ms),
      "cross_venue_submit_timeout",
    );
    const fills = submitted.map((result, index) => normalizeResult(result, plan.legs[index]));
    const residual = Math.abs(fills[0].filled_notional_micro_usdc - fills[1].filled_notional_micro_usdc);
    if (residual === 0) {
      sequence += 1;
      const phase = fills.every((fill) => fill.filled_notional_micro_usdc > 0) ? "complete" : "failed";
      const completion = parentCompletion({
        plan,
        claimContext,
        phase,
        sequence,
        legs: fills,
        failure_code: phase === "failed" ? "both_legs_unfilled" : null,
      });
      const receipt = await state.completeExecutionClaim(plan.execution_id, claimToken, completion);
      await reportBestEffort(callback, plan, completion.receipt.report);
      return receipt;
    }

    sequence += 1;
    lastCompletion = parentCompletion({ plan, claimContext, phase: "hedging", sequence, legs: fills });
    await state.recordExecutionClaimEvidence(plan.execution_id, claimToken, lastCompletion);
    await reportBestEffort(callback, plan, lastCompletion.receipt.report);
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
        dominant_leg: fills[dominant],
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
    const phase = finalResidual === 0 ? "complete" : "failed";
    const completion = parentCompletion({
      plan,
      claimContext,
      phase,
      sequence,
      legs: fills,
      repair_fills: [repairFill],
      hedge_slippage_bps: repaired.slippage_bps,
      unwind_loss_micro_usdc: repaired.realized_loss_micro_usdc,
      daily_realized_loss_micro_usdc: repaired.daily_realized_loss_micro_usdc,
      failure_code: finalResidual === 0 ? null : "automatic_hedge_incomplete",
    });
    const receipt = await state.completeExecutionClaim(plan.execution_id, claimToken, completion);
    await reportBestEffort(callback, plan, completion.receipt.report);
    return receipt;
  } catch (error) {
    const failure = {
      ...claimContext,
      error_code: safeError(error),
      status: "reconcile_required",
    };
    await state.markExecutionClaimReconcileRequired(
      plan.execution_id,
      claimToken,
      failure,
      lastCompletion,
    ).catch(() => null);
    void emitOperatorEvent("cross_venue_reconciliation_required", {
      severity: "critical",
      execution_id: plan.execution_id,
      error_code: safeError(error),
    });
    throw error;
  }
}

function parentClaimContext(plan) {
  return {
    venue_id: "cross_venue",
    platform_class: "coordinated_execution",
    execution_mode: "ghola_pooled",
    operation_class: "cross_venue_ioc_pair",
    request_digest: crossVenueExecutionRequestDigest(plan),
  };
}

function parentCompletion({
  plan,
  claimContext,
  phase,
  sequence,
  legs,
  repair_fills = [],
  failure_code = null,
  finalProof = null,
  ...metrics
}) {
  const observedAt = new Date().toISOString();
  const report = {
    sequence,
    phase,
    legs,
    repair_fills,
    ...metrics,
    failure_code,
    observed_at: observedAt,
  };
  const filled = phase === "complete" && legs.some((leg) => Number(leg.filled_notional_micro_usdc) > 0);
  const noBroadcast = phase === "failed" && legs.every((leg) => Number(leg.filled_notional_micro_usdc) === 0);
  const proof = finalProof || {
    version: 1,
    proof_kind: "cross_venue_coordinated_execution_v1",
    terminal_status: phase,
    atomic: false,
    broadcast_performed: filled,
    final_venue_execution_proven: phase === "complete" || noBroadcast,
    final_fill_proven: filled,
    final_no_broadcast_proven: noBroadcast,
    checked_at: observedAt,
  };
  const attempt = {
    version: 1,
    execution_id: plan.execution_id,
    owner_commitment: plan.owner_commitment,
    status: phase,
    sequence,
    plan: publicPlan(plan),
    legs,
    report,
    execution_request_digest: claimContext.request_digest,
    updated_at: observedAt,
  };
  const receipt = {
    version: 1,
    execution_id: plan.execution_id,
    status: phase,
    sequence,
    report,
    final_proof: proof,
    execution_request_digest: claimContext.request_digest,
  };
  return { attempt, receipt };
}

async function reportBestEffort(callback, plan, report) {
  try {
    await callback({ execution_id: plan.execution_id, owner_commitment: plan.owner_commitment, report });
  } catch (error) {
    void emitOperatorEvent("cross_venue_callback_failed", {
      severity: "error",
      execution_id: plan.execution_id,
      error_code: safeError(error),
    });
  }
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
    filled_base_size: safeDecimal(fill.filled_base_size),
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

function publicReceipt(receipt) {
  return {
    execution_id: receipt.execution_id,
    status: receipt.status,
    sequence: receipt.sequence,
    atomic: false,
    receipt_commitment: `cross_venue_receipt_${digest({ execution_id: receipt.execution_id, status: receipt.status, sequence: receipt.sequence })}`,
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
function safeDecimal(value) { return typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value) ? value : null; }
function safeError(error) { return /^[a-z0-9_:-]{1,120}$/i.test(String(error?.code || error?.message || "")) ? String(error?.code || error?.message) : "cross_venue_execution_failed"; }
function digest(value) { return createHash("sha256").update(stableJson(value)).digest("hex").slice(0, 48); }
function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}
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
