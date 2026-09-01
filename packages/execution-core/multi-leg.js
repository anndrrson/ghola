const ID = /^[A-Za-z0-9:_-]{8,180}$/;
const ASSET = /^[A-Z0-9][A-Z0-9._-]{0,31}$/;
import { SUPPORTED_EXECUTION_VENUES } from "./venues.js";

const VENUES = new Set(SUPPORTED_EXECUTION_VENUES);
const STRATEGIES = new Set(["spot_perp_hedge", "delta_neutral_carry", "exposure_rebalance", "hedged_spread_arbitrage"]);
const EVENT_TYPES = new Set([
  "preflight_passed", "preflight_failed", "cancel_before_submit", "submission_started", "leg_acknowledged",
  "leg_fill", "leg_failed", "leg_finalized", "leg_reconciled", "reconciliation_failed",
  "cancel_confirmed", "unwind_fill", "unwind_failed", "completion_fill", "completion_failed", "timeout",
]);
const RECOVERY_MODES = new Set(["unwind", "complete_reduce_only"]);

export function createMultiLegSaga(value) {
  const raw = object(value, "saga_required");
  version(raw.version, "saga_version");
  const nowMs = positiveInteger(raw.now_ms, "saga_now");
  const legs = array(raw.legs, "saga_legs", 2, 8).map(normalizeLeg);
  if (new Set(legs.map((leg) => leg.leg_id)).size !== legs.length) fail("duplicate_leg_id");
  const saga = {
    version: 1,
    saga_id: identifier(raw.saga_id, "saga_id"),
    idempotency_key: identifier(raw.idempotency_key, "idempotency_key"),
    plan_commitment: identifier(raw.plan_commitment, "plan_commitment"),
    strategy_id: enumValue(raw.strategy_id, STRATEGIES, "strategy_id"),
    recovery_mode: enumValue(raw.recovery_mode || "unwind", RECOVERY_MODES, "recovery_mode"),
    status: "preflighting",
    terminal: false,
    max_unhedged_ms: boundedInteger(raw.max_unhedged_ms, 50, 300_000, "max_unhedged_ms"),
    max_hedge_error_micro_usdc: nonNegativeInteger(raw.max_hedge_error_micro_usdc, "max_hedge_error"),
    legs: legs.map((leg) => ({
      ...leg,
      preflight_status: "pending",
      submission_status: "pending",
      provider_ref_commitment: null,
      filled_micro_usdc: 0,
      reconciled: false,
      cancel_confirmed: false,
      unwind_filled_micro_usdc: 0,
      failure_code: null,
    })),
    signed_filled_exposure_micro_usdc_by_asset: {},
    hedge_error_micro_usdc: 0,
    compensation_revision: 0,
    compensation: [],
    next_actions: [],
    processed_event_ids: [],
    last_event_sequence: 0,
    unhedged_deadline_ms: null,
    created_at_ms: nowMs,
    updated_at_ms: nowMs,
    terminal_reason: null,
  };
  refreshDerived(saga);
  return deepFreeze(saga);
}

export function advanceMultiLegSaga({ saga: sagaInput, event: eventInput, now_ms = Date.now() }) {
  let saga;
  let event;
  try {
    saga = mutableSaga(sagaInput);
    event = normalizeEvent(eventInput);
    positiveInteger(now_ms, "event_now");
  } catch (error) {
    return resultFailure(errorCode(error), sagaInput);
  }
  if (saga.processed_event_ids.includes(event.event_id)) {
    return deepFreeze({ ok: true, duplicate: true, saga: deepFreeze(sagaInput) });
  }
  if (event.sequence !== saga.last_event_sequence + 1) return resultFailure("event_sequence_invalid", sagaInput);
  if (saga.terminal) return resultFailure("saga_terminal", sagaInput);
  if (!allowedEvents(saga.status).has(event.type)) return resultFailure("event_not_allowed_in_state", sagaInput);
  try {
    applyEvent(saga, event, now_ms);
    saga.last_event_sequence = event.sequence;
    saga.processed_event_ids.push(event.event_id);
    if (saga.processed_event_ids.length > 256) saga.processed_event_ids.shift();
    saga.updated_at_ms = now_ms;
    refreshDerived(saga);
    return deepFreeze({ ok: true, duplicate: false, saga: deepFreeze(saga) });
  } catch (error) {
    return resultFailure(errorCode(error), sagaInput);
  }
}

function applyEvent(saga, event, nowMs) {
  if (event.type === "preflight_passed") {
    const leg = sagaLeg(saga, event.leg_id);
    if (leg.preflight_status === "failed") fail("preflight_already_failed");
    leg.preflight_status = "passed";
    if (saga.legs.every((item) => item.preflight_status === "passed")) saga.status = "ready";
    return;
  }
  if (event.type === "preflight_failed") {
    const leg = sagaLeg(saga, event.leg_id);
    leg.preflight_status = "failed";
    leg.failure_code = failureCode(event.failure_code);
    terminal(saga, "failed_no_submit", "preflight_failed");
    return;
  }
  if (event.type === "cancel_before_submit") {
    terminal(saga, "failed_no_submit", "cancelled_before_submit");
    return;
  }
  if (event.type === "submission_started") {
    saga.status = "submitting";
    saga.unhedged_deadline_ms = nowMs + saga.max_unhedged_ms;
    for (const leg of saga.legs) leg.submission_status = "submitted";
    return;
  }
  if (event.type === "leg_acknowledged") {
    const leg = sagaLeg(saga, event.leg_id);
    leg.submission_status = "acknowledged";
    leg.provider_ref_commitment = optionalIdentifier(event.provider_ref_commitment, "provider_ref_commitment");
    return;
  }
  if (event.type === "leg_fill") {
    applyFill(sagaLeg(saga, event.leg_id), event.cumulative_filled_micro_usdc, "filled_micro_usdc");
    if (saga.status !== "compensating") settleFillState(saga, nowMs);
    return;
  }
  if (event.type === "leg_failed") {
    const leg = sagaLeg(saga, event.leg_id);
    leg.submission_status = "failed";
    leg.failure_code = failureCode(event.failure_code);
    if (saga.status === "compensating") settleCompensation(saga);
    else if (hasUncertainPeer(saga, leg.leg_id) || totalFilled(saga) > 0) enterCompensating(saga, nowMs);
    else terminal(saga, "failed_no_fill", "all_legs_rejected_before_fill");
    return;
  }
  if (event.type === "leg_finalized") {
    const leg = sagaLeg(saga, event.leg_id);
    applyFill(leg, event.cumulative_filled_micro_usdc, "filled_micro_usdc");
    leg.submission_status = "finalized";
    if (saga.status === "compensating") settleCompensation(saga);
    else settleFinalizedFillState(saga, nowMs);
    return;
  }
  if (event.type === "leg_reconciled") {
    sagaLeg(saga, event.leg_id).reconciled = true;
    if (saga.legs.every((leg) => leg.reconciled)) terminal(saga, "reconciled", "all_legs_reconciled");
    return;
  }
  if (event.type === "reconciliation_failed") {
    sagaLeg(saga, event.leg_id).failure_code = failureCode(event.failure_code);
    if (totalFilled(saga) > 0) enterCompensating(saga, nowMs);
    else terminal(saga, "failed_no_fill", "reconciliation_failed_without_fill");
    return;
  }
  if (event.type === "cancel_confirmed") {
    const leg = sagaLeg(saga, event.leg_id);
    applyFill(leg, event.cumulative_filled_micro_usdc, "filled_micro_usdc");
    leg.cancel_confirmed = true;
    if (saga.status === "compensating") settleCompensation(saga);
    else settleFinalizedFillState(saga, nowMs);
    return;
  }
  if (event.type === "unwind_fill") {
    const leg = sagaLeg(saga, event.leg_id);
    applyFill(leg, event.cumulative_filled_micro_usdc, "unwind_filled_micro_usdc", leg.filled_micro_usdc);
    settleCompensation(saga);
    return;
  }
  if (event.type === "unwind_failed") {
    sagaLeg(saga, event.leg_id).failure_code = failureCode(event.failure_code);
    terminal(saga, "manual_intervention", "deterministic_unwind_failed");
    return;
  }
  if (event.type === "completion_fill") {
    const leg = sagaLeg(saga, event.leg_id);
    const originalSubmissionStatus = leg.submission_status;
    applyFill(leg, event.cumulative_filled_micro_usdc, "filled_micro_usdc");
    leg.submission_status = originalSubmissionStatus;
    settleCompensation(saga);
    return;
  }
  if (event.type === "completion_failed") {
    sagaLeg(saga, event.leg_id).failure_code = failureCode(event.failure_code);
    terminal(saga, "manual_intervention", "risk_reducing_completion_failed");
    return;
  }
  if (event.type === "timeout") {
    if (saga.unhedged_deadline_ms !== null && nowMs < saga.unhedged_deadline_ms) fail("timeout_not_due");
    if (saga.status === "compensating") terminal(saga, "manual_intervention", saga.recovery_mode === "complete_reduce_only" ? "completion_timeout" : "unwind_timeout");
    else enterCompensating(saga, nowMs);
  }
}

function settleFillState(saga, nowMs) {
  const allFilled = saga.legs.every((leg) => leg.filled_micro_usdc === leg.notional_micro_usdc);
  if (!allFilled) {
    if (submissionsFinal(saga)) {
      settleFinalizedFillState(saga, nowMs);
      return;
    }
    saga.status = totalFilled(saga) > 0 ? "partially_hedged" : "submitting";
    return;
  }
  refreshExposure(saga);
  if (saga.hedge_error_micro_usdc <= saga.max_hedge_error_micro_usdc) saga.status = "reconciling";
  else enterCompensating(saga, nowMs);
}

function settleFinalizedFillState(saga, nowMs) {
  if (!submissionsFinal(saga)) return;
  if (totalFilled(saga) === 0) {
    terminal(saga, "failed_no_fill", "all_legs_final_without_fill");
    return;
  }
  refreshExposure(saga);
  if (saga.hedge_error_micro_usdc <= saga.max_hedge_error_micro_usdc) saga.status = "reconciling";
  else enterCompensating(saga, nowMs);
}

function enterCompensating(saga, nowMs) {
  if (saga.status !== "compensating") {
    saga.status = "compensating";
    saga.unhedged_deadline_ms = nowMs + saga.max_unhedged_ms;
  }
}

function hasUncertainPeer(saga, failedLegId) {
  return saga.legs.some((leg) =>
    leg.leg_id !== failedLegId &&
    (leg.submission_status === "submitted" || leg.submission_status === "acknowledged" || leg.submission_status === "filled")
  );
}

function settleCompensation(saga) {
  if (saga.recovery_mode === "complete_reduce_only") {
    if (saga.legs.every((leg) => leg.filled_micro_usdc === leg.notional_micro_usdc)) {
      saga.status = "reconciling";
      saga.unhedged_deadline_ms = null;
    }
    return;
  }
  const allSubmissionsFinal = submissionsFinal(saga);
  const exposureClosed = saga.legs.every((leg) => leg.unwind_filled_micro_usdc === leg.filled_micro_usdc);
  if (allSubmissionsFinal && exposureClosed) {
    terminal(
      saga,
      "unwound",
      totalFilled(saga) > 0 ? "deterministic_unwind_complete" : "cancelled_with_zero_fill",
    );
  }
}

function submissionsFinal(saga) {
  return saga.legs.every((leg) =>
    leg.submission_status === "failed" ||
    leg.submission_status === "finalized" ||
    leg.cancel_confirmed ||
    leg.filled_micro_usdc === leg.notional_micro_usdc
  );
}

function refreshDerived(saga) {
  refreshExposure(saga);
  const previous = JSON.stringify(saga.compensation.map((item) => [item.leg_id, item.target_unwind_micro_usdc]));
  saga.compensation = saga.recovery_mode === "complete_reduce_only" ? [] : saga.legs
    .filter((leg) => leg.filled_micro_usdc > leg.unwind_filled_micro_usdc)
    .map((leg) => ({
      version: 1,
      unwind_id: `${saga.saga_id}:unwind:${leg.leg_id}:${leg.filled_micro_usdc}`,
      leg_id: leg.leg_id,
      venue_id: leg.venue_id,
      asset: leg.asset,
      market: leg.market,
      product_type: leg.product_type,
      operation_class: leg.operation_class,
      side: leg.side === "buy" ? "sell" : "buy",
      target_unwind_micro_usdc: leg.filled_micro_usdc,
      remaining_unwind_micro_usdc: leg.filled_micro_usdc - leg.unwind_filled_micro_usdc,
      reduce_only: leg.product_type === "perp",
      risk_effect: "reduce",
    }));
  const next = JSON.stringify(saga.compensation.map((item) => [item.leg_id, item.target_unwind_micro_usdc]));
  if (previous !== next) saga.compensation_revision += 1;
  saga.next_actions = nextActions(saga);
}

function refreshExposure(saga) {
  const exposure = {};
  for (const leg of saga.legs) {
    const effective = leg.filled_micro_usdc - leg.unwind_filled_micro_usdc;
    const signed = leg.side === "buy" ? effective : -effective;
    exposure[leg.asset] = safeAdd(exposure[leg.asset] || 0, signed);
  }
  saga.signed_filled_exposure_micro_usdc_by_asset = exposure;
  saga.hedge_error_micro_usdc = Object.values(exposure).reduce((sum, value) => safeAdd(sum, Math.abs(value)), 0);
}

function nextActions(saga) {
  if (saga.terminal) return [];
  if (saga.status === "preflighting") {
    return saga.legs.filter((leg) => leg.preflight_status === "pending")
      .map((leg) => ({ type: "preflight_leg", leg_id: leg.leg_id, no_submit: true }));
  }
  if (saga.status === "ready") {
    return [{
      type: "submit_protected_legs",
      idempotency_key: saga.idempotency_key,
      legs: saga.legs.map((leg) => ({ leg_id: leg.leg_id, submit_key: `${saga.idempotency_key}:${leg.leg_id}` })),
    }];
  }
  if (saga.status === "submitting" || saga.status === "partially_hedged") {
    return [{ type: "reconcile_submitted_legs", deadline_ms: saga.unhedged_deadline_ms }];
  }
  if (saga.status === "reconciling") {
    return saga.legs.filter((leg) => !leg.reconciled).map((leg) => ({ type: "reconcile_leg", leg_id: leg.leg_id }));
  }
  if (saga.status === "compensating") {
    if (saga.recovery_mode === "complete_reduce_only") {
      return [
        ...saga.legs.filter((leg) =>
          leg.filled_micro_usdc < leg.notional_micro_usdc &&
          leg.submission_status !== "failed" &&
          leg.submission_status !== "finalized" &&
          !leg.cancel_confirmed
        ).map((leg) => ({ type: "cancel_leg", leg_id: leg.leg_id })),
        ...saga.legs.filter((leg) => leg.filled_micro_usdc < leg.notional_micro_usdc).map((leg) => ({
          type: "submit_completion",
          leg_id: leg.leg_id,
          remaining_completion_micro_usdc: leg.notional_micro_usdc - leg.filled_micro_usdc,
          reduce_only: true,
        })),
      ];
    }
    return [
      ...saga.legs.filter((leg) =>
        leg.filled_micro_usdc < leg.notional_micro_usdc &&
        leg.submission_status !== "failed" &&
        leg.submission_status !== "finalized" &&
        !leg.cancel_confirmed
      )
        .map((leg) => ({ type: "cancel_leg", leg_id: leg.leg_id })),
      ...saga.compensation.map((item) => ({
        type: "submit_unwind",
        unwind_id: item.unwind_id,
        leg_id: item.leg_id,
        remaining_unwind_micro_usdc: item.remaining_unwind_micro_usdc,
        reduce_only: item.reduce_only,
      })),
    ];
  }
  return [];
}

function normalizeLeg(value) {
  const raw = object(value, "saga_leg_invalid");
  return {
    leg_id: identifier(raw.leg_id, "leg_id"),
    venue_id: enumValue(raw.venue_id, VENUES, "leg_venue"),
    asset: normalized(raw.asset, ASSET, "leg_asset"),
    market: text(raw.market, "leg_market").toUpperCase(),
    product_type: enumValue(raw.product_type, new Set(["spot", "perp"]), "leg_product_type"),
    operation_class: text(raw.operation_class, "leg_operation_class"),
    side: enumValue(raw.side, new Set(["buy", "sell"]), "leg_side"),
    notional_micro_usdc: positiveInteger(raw.notional_micro_usdc, "leg_notional"),
  };
}

function normalizeEvent(value) {
  const raw = object(value, "saga_event_required");
  version(raw.version, "saga_event_version");
  return {
    ...raw,
    version: 1,
    event_id: identifier(raw.event_id, "event_id"),
    sequence: positiveInteger(raw.sequence, "event_sequence"),
    type: enumValue(raw.type, EVENT_TYPES, "event_type"),
    leg_id: raw.leg_id === undefined ? null : identifier(raw.leg_id, "event_leg_id"),
  };
}

function mutableSaga(value) {
  const raw = object(value, "existing_saga_required");
  version(raw.version, "existing_saga_version");
  identifier(raw.saga_id, "existing_saga_id");
  array(raw.legs, "existing_saga_legs", 2, 8);
  array(raw.processed_event_ids, "existing_event_ids", 0, 256);
  return JSON.parse(JSON.stringify(raw));
}

function allowedEvents(status) {
  if (status === "preflighting") return new Set(["preflight_passed", "preflight_failed", "cancel_before_submit"]);
  if (status === "ready") return new Set(["submission_started", "cancel_before_submit"]);
  if (status === "submitting" || status === "partially_hedged") {
    return new Set(["leg_acknowledged", "leg_fill", "leg_failed", "leg_finalized", "cancel_confirmed", "timeout"]);
  }
  if (status === "reconciling") return new Set(["leg_reconciled", "reconciliation_failed"]);
  if (status === "compensating") return new Set(["leg_fill", "leg_failed", "leg_finalized", "cancel_confirmed", "unwind_fill", "unwind_failed", "completion_fill", "completion_failed", "timeout"]);
  return new Set();
}

function applyFill(leg, value, field, maximum = leg.notional_micro_usdc) {
  const cumulative = nonNegativeInteger(value, field);
  if (cumulative < leg[field]) fail("cumulative_fill_regressed");
  if (cumulative > maximum) fail("cumulative_fill_exceeds_target");
  leg[field] = cumulative;
  if (field === "filled_micro_usdc" && cumulative > 0) leg.submission_status = "filled";
}

function sagaLeg(saga, legId) {
  if (!legId) fail("event_leg_required");
  const leg = saga.legs.find((item) => item.leg_id === legId);
  if (!leg) fail("event_leg_unknown");
  return leg;
}

function totalFilled(saga) {
  return saga.legs.reduce((sum, leg) => safeAdd(sum, leg.filled_micro_usdc), 0);
}

function terminal(saga, status, reason) {
  saga.status = status;
  saga.terminal = true;
  saga.terminal_reason = reason;
  saga.unhedged_deadline_ms = null;
}

function resultFailure(error, saga) {
  return deepFreeze({ ok: false, error, saga: saga ? deepFreeze(saga) : null });
}

function errorCode(error) {
  return typeof error?.code === "string" ? error.code : "saga_invalid";
}

function failureCode(value) {
  const code = text(value, "failure_code");
  if (!/^[a-z0-9:_-]{3,80}$/.test(code)) fail("failure_code_invalid");
  return code;
}

function optionalIdentifier(value, code) {
  return value === undefined || value === null || value === "" ? null : identifier(value, code);
}

function identifier(value, code) {
  const result = text(value, code);
  if (!ID.test(result)) fail(code);
  return result;
}

function normalized(value, pattern, code) {
  const result = text(value, code).toUpperCase();
  if (!pattern.test(result)) fail(code);
  return result;
}

function enumValue(value, allowed, code) {
  if (!allowed.has(value)) fail(code);
  return value;
}

function version(value, code) {
  if (value !== 1) fail(code);
}

function object(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value;
}

function array(value, code, min, max) {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(code);
  return value;
}

function text(value, code) {
  if (typeof value !== "string" || value.trim() === "") fail(code);
  return value.trim();
}

function positiveInteger(value, code) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(code);
  return value;
}

function nonNegativeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

function boundedInteger(value, min, max, code) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(code);
  return value;
}

function safeAdd(left, right) {
  const value = left + right;
  if (!Number.isSafeInteger(value)) fail("integer_overflow");
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}
