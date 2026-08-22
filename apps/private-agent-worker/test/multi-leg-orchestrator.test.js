import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyDurableMultiLegEvent,
  createDurableMultiLegSaga,
  recoverDueMultiLegSagas,
} from "../src/execution/multi-leg-orchestrator.js";
import { createWorkerState } from "../src/state/private-state.js";

const NOW = 1_800_000_000_000;

function definition() {
  return {
    version: 1,
    saga_id: "saga:carry:0001",
    idempotency_key: "idem:carry:0001",
    plan_commitment: "plan:carry:0001",
    strategy_id: "delta_neutral_carry",
    max_unhedged_ms: 1_000,
    max_hedge_error_micro_usdc: 100_000,
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
  };
}

function executionContext() {
  return {
    version: 1,
    autopilot_session_id: "autopilot:carry:0001",
    policy_commitment: "policy:carry:0001",
    legs: [
      { leg_id: "leg:spot:0001", work_order_commitment: "work:spot:0001", instruction: { version: 1, operation_class: "swap" } },
      { leg_id: "leg:perp:0001", work_order_commitment: "work:perp:0001", instruction: { version: 1, operation_class: "limit_order" } },
    ],
  };
}

async function apply(state, sagaId, sequence, type, extra = {}, nowMs = NOW + sequence * 10) {
  return applyDurableMultiLegEvent({
    state,
    saga_id: sagaId,
    now_ms: nowMs,
    event: {
      version: 1,
      event_id: `event:${sequence}:${type}`,
      sequence,
      type,
      ...extra,
    },
  });
}

test("persists protected multi-leg recovery across restart and bounds unwind time", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-saga-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let state = createWorkerState(dir);
  await state.putAutopilotSession({
    autopilot_session_id: "autopilot:carry:0001",
    status: "running",
    execution_enabled: true,
    updated_at: new Date(NOW).toISOString(),
  });
  const created = await createDurableMultiLegSaga({
    state,
    definition: definition(),
    execution_context: executionContext(),
  });
  assert.equal(created.ok, true);
  assert.equal(created.duplicate, false);
  const duplicateCreate = await createDurableMultiLegSaga({
    state,
    definition: definition(),
    execution_context: executionContext(),
  });
  assert.equal(duplicateCreate.ok, true);
  assert.equal(duplicateCreate.duplicate, true);

  const first = await apply(state, created.saga.saga_id, 1, "preflight_passed", { leg_id: "leg:spot:0001" });
  assert.equal(first.ok, true);
  const duplicateEvent = await apply(state, created.saga.saga_id, 1, "preflight_passed", { leg_id: "leg:spot:0001" });
  assert.equal(duplicateEvent.ok, true);
  assert.equal(duplicateEvent.duplicate, true);
  await apply(state, created.saga.saga_id, 2, "preflight_passed", { leg_id: "leg:perp:0001" });
  await apply(state, created.saga.saga_id, 3, "submission_started");
  await apply(state, created.saga.saga_id, 4, "leg_fill", {
    leg_id: "leg:spot:0001",
    cumulative_filled_micro_usdc: 10_000_000,
  });

  const firstDeadline = (await state.getMultiLegSaga(created.saga.saga_id)).unhedged_deadline_ms;
  const recovered = await recoverDueMultiLegSagas({ state, now_ms: firstDeadline });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.recovered.length, 1);
  assert.equal(recovered.recovered[0].saga.status, "compensating");
  assert.equal(recovered.recovered[0].saga.unhedged_deadline_ms, firstDeadline + 1_000);
  assert.equal((await state.getAutopilotSession("autopilot:carry:0001")).status, "paused");

  state = createWorkerState(dir);
  const resumed = await state.getMultiLegSaga(created.saga.saga_id);
  assert.equal(resumed.status, "compensating");
  assert.ok(resumed.next_actions.some((action) => action.type === "cancel_leg"));
  assert.ok(resumed.next_actions.some((action) => action.type === "submit_unwind"));

  const finalRecovery = await recoverDueMultiLegSagas({ state, now_ms: resumed.unhedged_deadline_ms });
  assert.equal(finalRecovery.recovered[0].saga.status, "manual_intervention");
  assert.equal(finalRecovery.recovered[0].saga.terminal, true);
});

test("rejects a stale saga writer instead of losing an event", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-saga-cas-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = createWorkerState(dir);
  const created = await createDurableMultiLegSaga({ state, definition: definition() });
  const stale = structuredClone(created.saga);
  await apply(state, created.saga.saga_id, 1, "preflight_passed", { leg_id: "leg:spot:0001" });
  const conflict = await state.putMultiLegSaga(stale, { expected_sequence: 0 });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error, "saga_version_conflict");
  assert.equal(conflict.saga.last_event_sequence, 1);
});

test("cancels, reconciles, and exactly unwinds a one-leg fill", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-saga-recovery-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = createWorkerState(dir);
  const sagaDefinition = {
    ...definition(),
    saga_id: "saga:recovery:0001",
    idempotency_key: "idem:recovery:0001",
    plan_commitment: "plan:recovery:0001",
    legs: [
      {
        leg_id: "leg:coinbase:0001",
        venue_id: "coinbase_advanced",
        asset: "SOL",
        market: "SOL-USD",
        product_type: "spot",
        operation_class: "spot_market_order",
        side: "buy",
        notional_micro_usdc: 10_000_000,
      },
      {
        leg_id: "leg:hyperliquid:0001",
        venue_id: "hyperliquid",
        asset: "SOL",
        market: "SOL-USD",
        product_type: "perp",
        operation_class: "limit_order",
        side: "sell",
        notional_micro_usdc: 10_000_000,
      },
    ],
  };
  const context = {
    version: 1,
    autopilot_session_id: "autopilot:recovery:0001",
    policy_commitment: "policy:recovery:0001",
    legs: [
      {
        leg_id: "leg:coinbase:0001",
        work_order_commitment: "work:coinbase:0001",
        instruction: {
          version: 1,
          kind: "ghola_private_execution_instruction",
          operation_class: "spot_market_order",
          order: { market: "SOL-USD", side: "buy", base_size: "0.1", limit_price: "100" },
        },
      },
      {
        leg_id: "leg:hyperliquid:0001",
        work_order_commitment: "work:hyperliquid:0001",
        instruction: {
          version: 1,
          kind: "ghola_private_execution_instruction",
          operation_class: "limit_order",
          order: { market: "SOL", side: "sell", base_size: "0.1", limit_price: "100" },
        },
      },
    ],
  };
  await state.putAutopilotSession({
    autopilot_session_id: context.autopilot_session_id,
    status: "running",
    execution_enabled: true,
    session_policy: {
      policy_commitment: context.policy_commitment,
      market_allowlist: ["SOL-USD"],
      max_notional_bucket: "10",
      max_daily_notional_bucket: "10",
      max_order_count: 2,
      max_slippage_bps: 5,
    },
    venue_access: {
      coinbase_advanced: { status: "ready", execution_mode: "byo_api_key" },
      hyperliquid: { status: "ready", execution_mode: "byo_api_key" },
    },
    updated_at: new Date(NOW).toISOString(),
  });
  const created = await createDurableMultiLegSaga({ state, definition: sagaDefinition, execution_context: context });
  await apply(state, created.saga.saga_id, 1, "preflight_passed", { leg_id: "leg:coinbase:0001" });
  await apply(state, created.saga.saga_id, 2, "preflight_passed", { leg_id: "leg:hyperliquid:0001" });
  await apply(state, created.saga.saga_id, 3, "submission_started");
  await apply(state, created.saga.saga_id, 4, "leg_fill", {
    leg_id: "leg:coinbase:0001",
    cumulative_filled_micro_usdc: 10_000_000,
  });
  await state.putIdempotency("work:coinbase:0001", {
    status: "filled",
    final_proof: {
      final_venue_execution_proven: true,
      final_fill_proven: true,
      cumulative_filled_micro_usdc: 10_000_000,
      filled_base_size: "0.1",
    },
  });
  await state.putIdempotency("work:hyperliquid:0001", { status: "submitted" });

  const calls = [];
  const executeOrder = async (args) => {
    calls.push(args);
    if (args.operation_class === "cancel") return { status: "cancelled" };
    if (args.operation_class === "reconcile") return { status: "reconciled", fills: [] };
    return {
      status: "filled",
      final_proof: {
        final_venue_execution_proven: true,
        final_fill_proven: true,
        cumulative_filled_micro_usdc: 10_000_000,
        filled_base_size: "0.1",
      },
    };
  };
  const verified = [];
  const active = await state.getMultiLegSaga(created.saga.saga_id);
  const recovered = await recoverDueMultiLegSagas({
    state,
    now_ms: active.unhedged_deadline_ms,
    recipient: { recipient_id: "did:key:recovery-test" },
    executeOrder,
    verifyOrder: async (args) => {
      verified.push(args);
      return { status: "verified_no_funds" };
    },
    env: { PRIVATE_AGENT_VENUE_DRY_RUN: "true" },
  });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.recovered[0].saga.status, "unwound");
  assert.equal(recovered.recovered[0].saga.terminal, true);
  assert.equal(calls.filter((call) => call.operation_class === "cancel").length, 1);
  assert.equal(calls.filter((call) => call.operation_class === "reconcile").length, 1);
  const unwind = calls.find((call) => call.instruction?.order?.reduce_only === true);
  assert.equal(unwind.venue_id, "coinbase_advanced");
  assert.equal(unwind.instruction.order.side, "sell");
  assert.equal(unwind.instruction.order.base_size, "0.1");
  assert.equal(verified.length, 1);
  const positions = await state.listAutopilotPositions(context.autopilot_session_id);
  assert.equal(positions[0].signed_notional_micro_usdc, 0);
  assert.equal(positions[0].signed_base_size, 0);
  assert.equal((await state.getAutopilotSession(context.autopilot_session_id)).status, "paused");
});
