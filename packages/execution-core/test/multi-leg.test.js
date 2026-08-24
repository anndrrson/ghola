import assert from "node:assert/strict";
import test from "node:test";
import { advanceMultiLegSaga, createMultiLegSaga } from "../index.js";

const NOW = 1_800_000_000_000;

function create(overrides = {}) {
  return createMultiLegSaga({
    version: 1,
    saga_id: "saga:carry:0001",
    idempotency_key: "idempotency:carry:0001",
    plan_commitment: "plan:commitment:0001",
    strategy_id: "delta_neutral_carry",
    max_unhedged_ms: 2_000,
    max_hedge_error_micro_usdc: 10_000,
    now_ms: NOW,
    legs: [
      {
        leg_id: "leg:spot:0001",
        venue_id: "jupiter",
        asset: "SOL",
        market: "SOL-USD",
        product_type: "spot",
        operation_class: "swap",
        side: "buy",
        notional_micro_usdc: 10_000_000,
      },
      {
        leg_id: "leg:perp:0001",
        venue_id: "hyperliquid",
        asset: "SOL",
        market: "SOL-USD",
        product_type: "perp",
        operation_class: "limit_order",
        side: "sell",
        notional_micro_usdc: 10_000_000,
      },
    ],
    ...overrides,
  });
}

function event(sequence, type, values = {}) {
  return {
    version: 1,
    event_id: `event:${String(sequence).padStart(4, "0")}:${type}`,
    sequence,
    type,
    ...values,
  };
}

function advance(saga, sequence, type, values = {}, nowMs = NOW + sequence * 100) {
  const result = advanceMultiLegSaga({ saga, event: event(sequence, type, values), now_ms: nowMs });
  assert.equal(result.ok, true, result.error);
  return result.saga;
}

function readySaga() {
  let saga = create();
  saga = advance(saga, 1, "preflight_passed", { leg_id: "leg:spot:0001" });
  saga = advance(saga, 2, "preflight_passed", { leg_id: "leg:perp:0001" });
  assert.equal(saga.status, "ready");
  return saga;
}

test("preflights every leg before exposing a protected submit action", () => {
  const created = create();
  assert.equal(created.status, "preflighting");
  assert.equal(created.next_actions.every((action) => action.no_submit === true), true);
  const ready = readySaga();
  assert.equal(ready.next_actions.length, 1);
  assert.equal(ready.next_actions[0].type, "submit_protected_legs");
  assert.equal(new Set(ready.next_actions[0].legs.map((leg) => leg.submit_key)).size, 2);
});

test("reconciles a fully hedged pair and records zero hedge error", () => {
  let saga = readySaga();
  saga = advance(saga, 3, "submission_started");
  saga = advance(saga, 4, "leg_fill", {
    leg_id: "leg:spot:0001",
    cumulative_filled_micro_usdc: 10_000_000,
  });
  assert.equal(saga.status, "partially_hedged");
  saga = advance(saga, 5, "leg_fill", {
    leg_id: "leg:perp:0001",
    cumulative_filled_micro_usdc: 10_000_000,
  });
  assert.equal(saga.status, "reconciling");
  assert.equal(saga.hedge_error_micro_usdc, 0);
  saga = advance(saga, 6, "leg_reconciled", { leg_id: "leg:spot:0001" });
  saga = advance(saga, 7, "leg_reconciled", { leg_id: "leg:perp:0001" });
  assert.equal(saga.status, "reconciled");
  assert.equal(saga.terminal, true);
  assert.deepEqual(saga.next_actions, []);
});

test("reconciles equally partial IOC fills after both remainders are final", () => {
  let saga = readySaga();
  saga = advance(saga, 3, "submission_started");
  saga = advance(saga, 4, "leg_fill", {
    leg_id: "leg:spot:0001",
    cumulative_filled_micro_usdc: 4_000_000,
  });
  saga = advance(saga, 5, "cancel_confirmed", {
    leg_id: "leg:spot:0001",
    cumulative_filled_micro_usdc: 4_000_000,
  });
  saga = advance(saga, 6, "leg_fill", {
    leg_id: "leg:perp:0001",
    cumulative_filled_micro_usdc: 4_000_000,
  });
  saga = advance(saga, 7, "cancel_confirmed", {
    leg_id: "leg:perp:0001",
    cumulative_filled_micro_usdc: 4_000_000,
  });
  assert.equal(saga.status, "reconciling");
  assert.equal(saga.hedge_error_micro_usdc, 0);
});

test("preflight failure is terminal and never creates an unwind or submit", () => {
  let saga = create();
  saga = advance(saga, 1, "preflight_failed", {
    leg_id: "leg:spot:0001",
    failure_code: "quote_stale",
  });
  assert.equal(saga.status, "failed_no_submit");
  assert.equal(saga.terminal, true);
  assert.deepEqual(saga.compensation, []);
  assert.deepEqual(saga.next_actions, []);
});

test("partial fill plus peer failure creates deterministic inverse compensation", () => {
  let saga = readySaga();
  saga = advance(saga, 3, "submission_started");
  saga = advance(saga, 4, "leg_fill", {
    leg_id: "leg:spot:0001",
    cumulative_filled_micro_usdc: 4_000_000,
  });
  saga = advance(saga, 5, "leg_failed", {
    leg_id: "leg:perp:0001",
    failure_code: "venue_rejected",
  });
  assert.equal(saga.status, "compensating");
  assert.equal(saga.hedge_error_micro_usdc, 4_000_000);
  assert.equal(saga.compensation.length, 1);
  assert.equal(saga.compensation[0].side, "sell");
  assert.equal(saga.compensation[0].target_unwind_micro_usdc, 4_000_000);
  assert.ok(saga.next_actions.some((action) => action.type === "cancel_leg"));
  assert.ok(saga.next_actions.some((action) => action.type === "submit_unwind"));
  saga = advance(saga, 6, "cancel_confirmed", {
    leg_id: "leg:spot:0001",
    cumulative_filled_micro_usdc: 4_000_000,
  });
  saga = advance(saga, 7, "unwind_fill", {
    leg_id: "leg:spot:0001",
    cumulative_filled_micro_usdc: 4_000_000,
  });
  assert.equal(saga.status, "unwound");
  assert.equal(saga.hedge_error_micro_usdc, 0);
});

test("risk-reducing exits complete the missing close instead of reopening exposure", () => {
  let saga = create({ recovery_mode: "complete_reduce_only" });
  saga = advance(saga, 1, "preflight_passed", { leg_id: "leg:spot:0001" });
  saga = advance(saga, 2, "preflight_passed", { leg_id: "leg:perp:0001" });
  saga = advance(saga, 3, "submission_started");
  saga = advance(saga, 4, "leg_fill", {
    leg_id: "leg:spot:0001",
    cumulative_filled_micro_usdc: 10_000_000,
  });
  saga = advance(saga, 5, "leg_failed", {
    leg_id: "leg:perp:0001",
    failure_code: "venue_rejected",
  });
  assert.equal(saga.status, "compensating");
  assert.equal(saga.compensation.length, 0);
  assert.equal(saga.next_actions.some((action) => action.type === "submit_unwind"), false);
  const completion = saga.next_actions.find((action) => action.type === "submit_completion");
  assert.equal(completion.leg_id, "leg:perp:0001");
  assert.equal(completion.reduce_only, true);
  saga = advance(saga, 6, "completion_fill", {
    leg_id: "leg:perp:0001",
    cumulative_filled_micro_usdc: 10_000_000,
  });
  assert.equal(saga.status, "reconciling");
  saga = advance(saga, 7, "leg_reconciled", { leg_id: "leg:spot:0001" });
  saga = advance(saga, 8, "leg_reconciled", { leg_id: "leg:perp:0001" });
  assert.equal(saga.status, "reconciled");
  assert.equal(saga.terminal, true);
});

test("late fills during compensation revise, rather than bypass, unwind targets", () => {
  let saga = readySaga();
  saga = advance(saga, 3, "submission_started");
  saga = advance(saga, 4, "leg_fill", {
    leg_id: "leg:spot:0001",
    cumulative_filled_micro_usdc: 4_000_000,
  });
  saga = advance(saga, 5, "leg_failed", {
    leg_id: "leg:perp:0001",
    failure_code: "venue_timeout",
  });
  const revision = saga.compensation_revision;
  saga = advance(saga, 6, "leg_fill", {
    leg_id: "leg:perp:0001",
    cumulative_filled_micro_usdc: 1_000_000,
  });
  assert.equal(saga.status, "compensating");
  assert.ok(saga.compensation_revision > revision);
  assert.equal(saga.compensation.length, 2);
  assert.equal(saga.hedge_error_micro_usdc, 3_000_000);
});

test("event IDs are idempotent and sequence gaps fail closed", () => {
  const saga = create();
  const firstEvent = event(1, "preflight_passed", { leg_id: "leg:spot:0001" });
  const first = advanceMultiLegSaga({ saga, event: firstEvent, now_ms: NOW + 100 });
  assert.equal(first.ok, true);
  const duplicate = advanceMultiLegSaga({ saga: first.saga, event: firstEvent, now_ms: NOW + 200 });
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.saga.last_event_sequence, 1);
  const gap = advanceMultiLegSaga({
    saga: first.saga,
    event: event(3, "preflight_passed", { leg_id: "leg:perp:0001" }),
    now_ms: NOW + 300,
  });
  assert.equal(gap.ok, false);
  assert.equal(gap.error, "event_sequence_invalid");
});

test("submission timeout always compensates because venue fill state is unknown", () => {
  let partiallyFilled = readySaga();
  partiallyFilled = advance(partiallyFilled, 3, "submission_started");
  partiallyFilled = advance(partiallyFilled, 4, "leg_fill", {
    leg_id: "leg:spot:0001",
    cumulative_filled_micro_usdc: 1_000_000,
  });
  partiallyFilled = advance(
    partiallyFilled,
    5,
    "timeout",
    {},
    partiallyFilled.unhedged_deadline_ms,
  );
  assert.equal(partiallyFilled.status, "compensating");

  let noFill = readySaga();
  noFill = advance(noFill, 3, "submission_started");
  noFill = advance(noFill, 4, "timeout", {}, noFill.unhedged_deadline_ms);
  assert.equal(noFill.status, "compensating");
  assert.equal(noFill.terminal, false);
  assert.equal(noFill.next_actions.filter((action) => action.type === "cancel_leg").length, 2);
  noFill = advance(noFill, 5, "cancel_confirmed", {
    leg_id: "leg:spot:0001",
    cumulative_filled_micro_usdc: 0,
  });
  noFill = advance(noFill, 6, "cancel_confirmed", {
    leg_id: "leg:perp:0001",
    cumulative_filled_micro_usdc: 0,
  });
  assert.equal(noFill.status, "unwound");
  assert.equal(noFill.terminal_reason, "cancelled_with_zero_fill");
});
