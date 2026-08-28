import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CARRY_EXECUTION_VENUES } from "@ghola/execution-core";
import {
  applyDurableMultiLegEvent,
  createDurableMultiLegSaga,
  readDurableRecoveryAccounting,
  recoverDueMultiLegSagas,
  startMultiLegRecoveryLoop,
} from "../src/execution/multi-leg-orchestrator.js";
import { createWorkerState } from "../src/state/private-state.js";

const NOW = 1_800_000_000_000;

test("supervises multi-leg recovery failures and stalls", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-saga-loop-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = createWorkerState(dir);
  let nowMs = NOW;
  const loop = startMultiLegRecoveryLoop({
    state,
    now: () => nowMs,
    env: {
      PRIVATE_AGENT_MULTI_LEG_RECOVERY_ENABLED: "true",
      PRIVATE_AGENT_MULTI_LEG_RECOVERY_SWEEP_MS: "1000",
      PRIVATE_AGENT_MULTI_LEG_RECOVERY_INITIAL_DELAY_MS: "60000",
      PRIVATE_AGENT_MULTI_LEG_RECOVERY_STALL_MS: "2000",
    },
  });
  t.after(() => loop.stop());

  assert.equal(loop.health().status, "starting");
  assert.equal((await loop.runNow()).ok, true);
  assert.equal(loop.health().status, "healthy");
  nowMs += 2_001;
  assert.equal(loop.health().status, "stalled");
  assert.equal(loop.health().last_error_code, "multi_leg_recovery_stalled");
});

test("reports deliberately disabled multi-leg recovery", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-saga-loop-disabled-"));
  try {
    const loop = startMultiLegRecoveryLoop({
      state: createWorkerState(dir),
      env: { PRIVATE_AGENT_MULTI_LEG_RECOVERY_ENABLED: "false" },
    });
    assert.equal(loop.health().status, "disabled");
    assert.equal((await loop.runNow()).error, "multi_leg_recovery_disabled");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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

test("recovers a crash after exact cancel without cancelling twice", async (t) => {
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
  let cancelAcknowledged = false;
  let crashInjected = false;
  const executeOrder = async (args) => {
    calls.push(args);
    if (args.operation_class === "cancel") {
      cancelAcknowledged = true;
      return { status: "cancelled" };
    }
    if (args.operation_class === "reconcile") {
      if (cancelAcknowledged && !crashInjected) {
        crashInjected = true;
        throw new Error("simulated_worker_crash_after_cancel");
      }
      return cancelAcknowledged
        ? { status: "cancelled", fills: [], final_proof: { final_venue_execution_proven: true, final_fill_proven: false } }
        : { status: "open", fills: [] };
    }
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
  const firstRecovery = await recoverDueMultiLegSagas({
    state,
    now_ms: active.unhedged_deadline_ms,
    recipient: { recipient_id: "did:key:recovery-test" },
    executeOrder,
    verifyOrder: async (args) => {
      verified.push(args);
      return recoveryVerification(args);
    },
    env: { PRIVATE_AGENT_VENUE_DRY_RUN: "true" },
  });
  assert.equal(firstRecovery.ok, false);
  assert.equal(firstRecovery.recovered[0].saga.status, "compensating");
  const recovered = await recoverDueMultiLegSagas({
    state,
    now_ms: active.unhedged_deadline_ms + 1,
    recipient: { recipient_id: "did:key:recovery-test" },
    executeOrder,
    verifyOrder: async (args) => {
      verified.push(args);
      return recoveryVerification(args);
    },
    env: { PRIVATE_AGENT_VENUE_DRY_RUN: "true" },
  });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.recovered[0].saga.status, "unwound");
  assert.equal(recovered.recovered[0].saga.terminal, true);
  assert.equal(calls.filter((call) => call.operation_class === "cancel").length, 1);
  assert.equal(calls.filter((call) => call.operation_class === "reconcile").length, 3);
  assert.deepEqual(
    calls.filter((call) => call.venue_id === "hyperliquid").slice(0, 3).map((call) => call.operation_class),
    ["reconcile", "cancel", "reconcile"],
  );
  const unwind = calls.find((call) => call.instruction?.order?.reduce_only === true);
  assert.equal(unwind.venue_id, "coinbase_advanced");
  assert.equal(unwind.instruction.order.side, "sell");
  assert.equal(unwind.instruction.order.base_size, "0.1");
  assert.equal(verified.length, 1);
  const accounting = await readDurableRecoveryAccounting({
    state,
    saga_id: created.saga.saga_id,
    leg_id: "leg:coinbase:0001",
    action: "unwind",
  });
  assert.equal(accounting.executions.length, 1);
  assert.equal(accounting.executions[0].work_order_commitment, unwind.work_order_commitment);
  assert.equal(accounting.executions[0].reference_mark_price_e8 > 0, true);
  const positions = await state.listAutopilotPositions(context.autopilot_session_id);
  assert.equal(positions[0].signed_notional_micro_usdc, 0);
  assert.equal(positions[0].signed_base_size, 0);
  assert.equal((await state.getAutopilotSession(context.autopilot_session_id)).status, "paused");
});

test("reconciles a terminal late fill before cancel and never cancels or resubmits it", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-saga-late-fill-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = createWorkerState(dir);
  const sagaId = "saga:recovery:late-fill:0001";
  const asterLeg = `${sagaId}:aster`;
  const lighterLeg = `${sagaId}:lighter`;
  const asterWork = "work:recovery:late-fill:aster";
  const lighterWork = "work:recovery:late-fill:lighter";
  const instruction = (venue, side) => ({
    version: 1,
    kind: "ghola_private_execution_instruction",
    venue_id: venue,
    operation_class: "limit_order",
    order: {
      market: venue === "lighter" ? "BTC" : "BTC-PERP",
      side,
      base_size: "0.001",
      limit_price: "10000",
      reduce_only: false,
      tif: "Ioc",
    },
  });
  const created = await createDurableMultiLegSaga({
    state,
    definition: {
      version: 1,
      saga_id: sagaId,
      idempotency_key: "idem:recovery:late-fill:0001",
      plan_commitment: "plan:recovery:late-fill:0001",
      strategy_id: "delta_neutral_carry",
      max_unhedged_ms: 1_000,
      max_hedge_error_micro_usdc: 0,
      now_ms: NOW,
      legs: [
        { leg_id: asterLeg, venue_id: "aster", asset: "BTC", market: "BTC-PERP", product_type: "perp", operation_class: "limit_order", side: "buy", notional_micro_usdc: 10_000_000 },
        { leg_id: lighterLeg, venue_id: "lighter", asset: "BTC", market: "BTC-PERP", product_type: "perp", operation_class: "limit_order", side: "sell", notional_micro_usdc: 10_000_000 },
      ],
    },
    execution_context: {
      version: 1,
      carry_position_id: "carry:position:late-fill:0001",
      owner_commitment: "owner:recovery:late-fill:0001",
      policy_commitment: "policy:recovery:late-fill:0001",
      session_policy: { policy_commitment: "policy:recovery:late-fill:0001", market_allowlist: ["BTC", "BTC-PERP"], max_notional_bucket: "25", max_order_count: 4, max_slippage_bps: 10 },
      venue_access: {
        aster: { status: "ready", account_commitment: "account:carry:exit:aster" },
        lighter: { status: "ready", account_commitment: "account:carry:exit:lighter" },
      },
      legs: [
        { leg_id: asterLeg, work_order_commitment: asterWork, instruction: instruction("aster", "buy") },
        { leg_id: lighterLeg, work_order_commitment: lighterWork, instruction: instruction("lighter", "sell") },
      ],
    },
  });
  await apply(state, sagaId, 1, "preflight_passed", { leg_id: asterLeg });
  await apply(state, sagaId, 2, "preflight_passed", { leg_id: lighterLeg });
  await apply(state, sagaId, 3, "submission_started");
  await apply(state, sagaId, 4, "leg_fill", { leg_id: asterLeg, cumulative_filled_micro_usdc: 10_000_000 });
  await state.putIdempotency(asterWork, {
    status: "filled",
    final_proof: { final_venue_execution_proven: true, final_fill_proven: true, cumulative_filled_micro_usdc: 10_000_000, filled_base_size: "0.001" },
  });
  await state.putIdempotency(lighterWork, { status: "submitted" });

  const calls = [];
  const active = await state.getMultiLegSaga(created.saga.saga_id);
  const recovered = await recoverDueMultiLegSagas({
    state,
    now_ms: active.unhedged_deadline_ms,
    recipient: { recipient_id: "did:key:late-fill" },
    executeOrder: async (args) => {
      calls.push(args);
      if (args.operation_class === "reconcile") {
        return {
          status: "filled",
          fills: [{ size: "0.001", price: "10000" }],
          final_proof: {
            final_venue_execution_proven: true,
            final_fill_proven: true,
            cumulative_filled_micro_usdc: 10_000_000,
            filled_base_size: "0.001",
          },
        };
      }
      return {
        status: "filled",
        final_proof: { final_venue_execution_proven: true, final_fill_proven: true, filled_base_size: "0.001" },
      };
    },
    verifyOrder: async (args) => recoveryVerification(args),
    env: { PRIVATE_AGENT_VENUE_DRY_RUN: "true" },
  });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.recovered[0].saga.status, "unwound");
  assert.equal(calls.filter((call) => call.operation_class === "cancel").length, 0);
  assert.equal(calls.filter((call) => call.operation_class === "reconcile").length, 1);
  assert.equal(calls.filter((call) => call.instruction?.order?.reduce_only === true).length, 2);
  assert.equal(calls[0].instruction.reconcile.target_work_order_commitment, lighterWork);
});

for (const [filledVenue, hedgeVenue] of CARRY_EXECUTION_VENUES.flatMap((filledVenue) =>
  CARRY_EXECUTION_VENUES
    .filter((hedgeVenue) => hedgeVenue !== filledVenue)
    .map((hedgeVenue) => [filledVenue, hedgeVenue]),
)) {
  test(`exactly recovers a filled ${filledVenue} leg against an unfilled ${hedgeVenue} leg`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), `ghola-${filledVenue}-recovery-`));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const state = createWorkerState(dir);
    const suffix = `${filledVenue}:${hedgeVenue}`;
    const sagaId = `saga:perp:${suffix}`;
    const sessionId = `autopilot:perp:${suffix}`;
    const filledLegId = `leg:${filledVenue}:filled`;
    const hedgeLegId = `leg:${hedgeVenue}:hedge`;
    const filledWork = `work:${filledVenue}:filled`;
    const hedgeWork = `work:${hedgeVenue}:hedge`;
    const marketFor = (venue) => venue === "lighter" ? "BTC" : "BTC-PERP";
    const order = (venue, side) => ({
      version: 1,
      kind: "ghola_private_execution_instruction",
      venue_id: venue,
      operation_class: "limit_order",
      order: {
        market: marketFor(venue),
        side,
        base_size: "0.001",
        limit_price: "10000",
        reduce_only: false,
        tif: "Ioc",
      },
    });
    const definition = {
      version: 1,
      saga_id: sagaId,
      idempotency_key: `idem:perp:${suffix}`,
      plan_commitment: `plan:perp:${suffix}`,
      strategy_id: "delta_neutral_carry",
      max_unhedged_ms: 1_000,
      max_hedge_error_micro_usdc: 100_000,
      now_ms: NOW,
      legs: [
        { leg_id: filledLegId, venue_id: filledVenue, asset: "BTC", market: "BTC-PERP", product_type: "perp", operation_class: "limit_order", side: "buy", notional_micro_usdc: 10_000_000 },
        { leg_id: hedgeLegId, venue_id: hedgeVenue, asset: "BTC", market: "BTC-PERP", product_type: "perp", operation_class: "limit_order", side: "sell", notional_micro_usdc: 10_000_000 },
      ],
    };
    const context = {
      version: 1,
      autopilot_session_id: sessionId,
      policy_commitment: `policy:perp:${suffix}`,
      legs: [
        { leg_id: filledLegId, work_order_commitment: filledWork, instruction: order(filledVenue, "buy") },
        { leg_id: hedgeLegId, work_order_commitment: hedgeWork, instruction: order(hedgeVenue, "sell") },
      ],
    };
    await state.putAutopilotSession({
      autopilot_session_id: sessionId,
      status: "running",
      execution_enabled: true,
      session_policy: {
        policy_commitment: context.policy_commitment,
        market_allowlist: ["BTC", "BTC-PERP"],
        max_notional_bucket: "25",
        max_daily_notional_bucket: "100",
        max_order_count: 4,
        max_slippage_bps: 10,
      },
      venue_access: {
        [filledVenue]: { status: "ready", execution_mode: "byo_api_key" },
        [hedgeVenue]: { status: "ready", execution_mode: "byo_api_key" },
      },
      updated_at: new Date(NOW).toISOString(),
    });
    const created = await createDurableMultiLegSaga({ state, definition, execution_context: context });
    await apply(state, sagaId, 1, "preflight_passed", { leg_id: filledLegId });
    await apply(state, sagaId, 2, "preflight_passed", { leg_id: hedgeLegId });
    await apply(state, sagaId, 3, "submission_started");
    await apply(state, sagaId, 4, "leg_fill", { leg_id: filledLegId, cumulative_filled_micro_usdc: 10_000_000 });
    await state.putIdempotency(filledWork, {
      status: "filled",
      final_proof: {
        final_venue_execution_proven: true,
        final_fill_proven: true,
        cumulative_filled_micro_usdc: 10_000_000,
        filled_base_size: "0.001",
      },
    });
    await state.putIdempotency(hedgeWork, { status: "submitted" });

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
          filled_base_size: "0.001",
        },
      };
    };
    const active = await state.getMultiLegSaga(created.saga.saga_id);
    const recovered = await recoverDueMultiLegSagas({
      state,
      now_ms: active.unhedged_deadline_ms,
      recipient: { recipient_id: "did:key:perp-recovery-test" },
      executeOrder,
      verifyOrder: async (args) => recoveryVerification(args),
      env: { PRIVATE_AGENT_VENUE_DRY_RUN: "true" },
    });
    assert.equal(recovered.ok, true);
    assert.equal(recovered.recovered[0].saga.status, "unwound");
    const unwind = calls.find((call) => call.instruction?.order?.reduce_only === true);
    assert.equal(unwind.venue_id, filledVenue);
    assert.equal(unwind.instruction.order.side, "sell");
    assert.equal(unwind.instruction.order.base_size, "0.001");
    assert.equal(calls.some((call) => call.venue_id === hedgeVenue && call.operation_class === "cancel"), true);
    assert.equal(calls.some((call) => call.venue_id === hedgeVenue && call.operation_class === "reconcile"), true);
  });
}

test("reconciles a partial recovery child before submitting the residual unwind and rejects a mismatched target", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-partial-recovery-child-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = createWorkerState(dir);
  const sagaId = "saga:partial-recovery-child:0001";
  const filledLeg = `${sagaId}:aster`;
  const hedgeLeg = `${sagaId}:lighter`;
  const filledWork = "work:partial-recovery-child:aster";
  const hedgeWork = "work:partial-recovery-child:lighter";
  const instruction = (venue, side) => ({
    version: 1,
    kind: "ghola_private_execution_instruction",
    venue_id: venue,
    operation_class: "limit_order",
    order: {
      market: venue === "lighter" ? "BTC" : "BTC-PERP",
      side,
      base_size: "0.001",
      limit_price: "10000",
      reduce_only: false,
      tif: "Ioc",
    },
  });
  await state.putAutopilotSession({
    autopilot_session_id: "autopilot:partial-recovery-child:0001",
    status: "running",
    execution_enabled: true,
    session_policy: {
      policy_commitment: "policy:partial-recovery-child:0001",
      market_allowlist: ["BTC", "BTC-PERP"],
      max_notional_bucket: "25",
      max_order_count: 8,
      max_slippage_bps: 10,
    },
    venue_access: { aster: { status: "ready" }, lighter: { status: "ready" } },
    updated_at: new Date(NOW).toISOString(),
  });
  const created = await createDurableMultiLegSaga({
    state,
    definition: {
      version: 1,
      saga_id: sagaId,
      idempotency_key: "idem:partial-recovery-child:0001",
      plan_commitment: "plan:partial-recovery-child:0001",
      strategy_id: "delta_neutral_carry",
      max_unhedged_ms: 1_000,
      max_hedge_error_micro_usdc: 0,
      now_ms: NOW,
      legs: [
        { leg_id: filledLeg, venue_id: "aster", asset: "BTC", market: "BTC-PERP", product_type: "perp", operation_class: "limit_order", side: "buy", notional_micro_usdc: 10_000_000 },
        { leg_id: hedgeLeg, venue_id: "lighter", asset: "BTC", market: "BTC-PERP", product_type: "perp", operation_class: "limit_order", side: "sell", notional_micro_usdc: 10_000_000 },
      ],
    },
    execution_context: {
      version: 1,
      autopilot_session_id: "autopilot:partial-recovery-child:0001",
      policy_commitment: "policy:partial-recovery-child:0001",
      legs: [
        { leg_id: filledLeg, work_order_commitment: filledWork, instruction: instruction("aster", "buy") },
        { leg_id: hedgeLeg, work_order_commitment: hedgeWork, instruction: instruction("lighter", "sell") },
      ],
    },
  });
  await apply(state, sagaId, 1, "preflight_passed", { leg_id: filledLeg });
  await apply(state, sagaId, 2, "preflight_passed", { leg_id: hedgeLeg });
  await apply(state, sagaId, 3, "submission_started");
  await apply(state, sagaId, 4, "leg_fill", { leg_id: filledLeg, cumulative_filled_micro_usdc: 10_000_000 });
  await state.putIdempotency(filledWork, {
    status: "filled",
    final_proof: { target_client_order_matched: true, broadcast_performed: true, final_venue_execution_proven: true, final_fill_proven: true, cumulative_filled_micro_usdc: 10_000_000, filled_base_size: "0.001" },
  });
  await state.putIdempotency(hedgeWork, { status: "submitted" });

  const calls = [];
  let recoverySubmissions = 0;
  let childReconcileAttempts = 0;
  const executeOrder = async (args) => {
    calls.push(args);
    if (args.operation_class === "reconcile") {
      if (args.instruction.reconcile.target_work_order_commitment === hedgeWork) {
        return { status: "reconciled", final_proof: { target_client_order_matched: true, broadcast_performed: true, final_venue_execution_proven: true, final_fill_proven: true, cumulative_filled_micro_usdc: 0 } };
      }
      childReconcileAttempts += 1;
      return {
        status: "filled",
        final_proof: {
          target_client_order_matched: childReconcileAttempts > 1,
          broadcast_performed: true,
          final_venue_execution_proven: true,
          final_fill_proven: true,
          filled_base_size: "0.0006",
        },
      };
    }
    if (args.operation_class === "cancel") return { status: "cancelled" };
    recoverySubmissions += 1;
    return recoverySubmissions === 1
      ? { status: "open", final_proof: { target_client_order_matched: true, broadcast_performed: true, final_venue_execution_proven: false, final_fill_proven: false, filled_base_size: "0.0004" } }
      : { status: "filled", final_proof: { target_client_order_matched: true, broadcast_performed: true, final_venue_execution_proven: true, final_fill_proven: true, filled_base_size: "0.0004" } };
  };
  const fetchImpl = async () => ({ ok: true, json: async () => ({ markPrice: "10000" }) });
  const active = await state.getMultiLegSaga(created.saga.saga_id);
  const first = await recoverDueMultiLegSagas({
    state,
    now_ms: active.unhedged_deadline_ms,
    recipient: { recipient_id: "did:key:partial-recovery-child" },
    executeOrder,
    verifyOrder: async (args) => recoveryVerification(args),
    fetchImpl,
    env: { PRIVATE_AGENT_VENUE_DRY_RUN: "false" },
  });
  assert.equal(first.ok, false);
  assert.equal(recoverySubmissions, 1);
  let accounting = await readDurableRecoveryAccounting({ state, saga_id: sagaId, leg_id: filledLeg, action: "unwind" });
  assert.equal(accounting.executions[0].applied_filled_micro_usdc, 4_000_000);

  const second = await recoverDueMultiLegSagas({
    state,
    now_ms: active.unhedged_deadline_ms + 1,
    recipient: { recipient_id: "did:key:partial-recovery-child" },
    executeOrder,
    verifyOrder: async (args) => recoveryVerification(args),
    fetchImpl,
    env: { PRIVATE_AGENT_VENUE_DRY_RUN: "false" },
  });
  assert.equal(second.ok, false);
  assert.equal(second.recovered[0].saga.status, "compensating");
  assert.equal(childReconcileAttempts, 1);
  assert.equal(recoverySubmissions, 1);
  accounting = await readDurableRecoveryAccounting({ state, saga_id: sagaId, leg_id: filledLeg, action: "unwind" });
  assert.equal(accounting.executions[0].applied_filled_micro_usdc, 4_000_000);

  const third = await recoverDueMultiLegSagas({
    state,
    now_ms: active.unhedged_deadline_ms + 2,
    recipient: { recipient_id: "did:key:partial-recovery-child" },
    executeOrder,
    verifyOrder: async (args) => recoveryVerification(args),
    fetchImpl,
    env: { PRIVATE_AGENT_VENUE_DRY_RUN: "false" },
  });
  assert.equal(third.ok, true);
  assert.equal(third.recovered[0].saga.status, "unwound");
  assert.equal(childReconcileAttempts, 2);
  assert.equal(recoverySubmissions, 2);
  const childReconcile = calls.find((call) => call.operation_class === "reconcile" && call.instruction.reconcile.target_work_order_commitment !== hedgeWork);
  assert.equal(childReconcile.instruction.reconcile.target_work_order_commitment, accounting.executions[0].work_order_commitment);
  accounting = await readDurableRecoveryAccounting({ state, saga_id: sagaId, leg_id: filledLeg, action: "unwind" });
  assert.deepEqual(accounting.executions.map((execution) => execution.applied_filled_micro_usdc), [6_000_000, 4_000_000]);
});

test("recovers a Carry Position saga directly from its sealed venue context", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-carry-direct-recovery-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = createWorkerState(dir);
  const sagaId = "saga:carry:direct:0001";
  const longLeg = `${sagaId}:long`;
  const shortLeg = `${sagaId}:short`;
  const definition = {
    version: 1,
    saga_id: sagaId,
    idempotency_key: "idem:carry:direct:0001",
    plan_commitment: "plan:carry:direct:0001",
    strategy_id: "delta_neutral_carry",
    max_unhedged_ms: 1_000,
    max_hedge_error_micro_usdc: 0,
    now_ms: NOW,
    legs: [
      { leg_id: longLeg, venue_id: "aster", asset: "BTC", market: "BTC-PERP", product_type: "perp", operation_class: "limit_order", side: "buy", notional_micro_usdc: 10_000_000 },
      { leg_id: shortLeg, venue_id: "lighter", asset: "BTC", market: "BTC-PERP", product_type: "perp", operation_class: "limit_order", side: "sell", notional_micro_usdc: 10_000_000 },
    ],
  };
  const instruction = (venue, side) => ({
    version: 1,
    kind: "ghola_private_execution_instruction",
    venue_id: venue,
    operation_class: "limit_order",
    order: { market: venue === "lighter" ? "BTC" : "BTC-PERP", side, base_size: "0.001", limit_price: "10000", reduce_only: false, tif: "Ioc" },
  });
  const context = {
    version: 1,
    carry_position_id: "carry:position:direct:0001",
    owner_commitment: "owner:carry:direct:0001",
    policy_commitment: "policy:carry:direct:0001",
    session_policy: {
      policy_commitment: "policy:carry:direct:0001",
      market_allowlist: ["BTC", "BTC-PERP"],
      max_notional_bucket: "25",
      max_order_count: 4,
      max_slippage_bps: 10,
    },
    venue_access: {
      aster: { status: "ready", execution_mode: "byo_api_key", encrypted_execution_vault: { ciphertext: "aster-sealed" } },
      lighter: { status: "ready", execution_mode: "byo_api_key", encrypted_execution_vault: { ciphertext: "lighter-sealed" } },
    },
    legs: [
      { leg_id: longLeg, work_order_commitment: "work:carry:direct:long", instruction: instruction("aster", "buy") },
      { leg_id: shortLeg, work_order_commitment: "work:carry:direct:short", instruction: instruction("lighter", "sell") },
    ],
  };
  const created = await createDurableMultiLegSaga({ state, definition, execution_context: context });
  assert.equal(created.ok, true);
  await apply(state, sagaId, 1, "preflight_passed", { leg_id: longLeg });
  await apply(state, sagaId, 2, "preflight_passed", { leg_id: shortLeg });
  await apply(state, sagaId, 3, "submission_started");
  await apply(state, sagaId, 4, "leg_fill", { leg_id: longLeg, cumulative_filled_micro_usdc: 10_000_000 });
  await state.putIdempotency("work:carry:direct:long", {
    status: "filled",
    final_proof: { final_venue_execution_proven: true, final_fill_proven: true, cumulative_filled_micro_usdc: 10_000_000, filled_base_size: "0.001" },
  });
  await state.putIdempotency("work:carry:direct:short", { status: "submitted" });
  const calls = [];
  const active = await state.getMultiLegSaga(sagaId);
  const recovered = await recoverDueMultiLegSagas({
    state,
    now_ms: active.unhedged_deadline_ms,
    recipient: { recipient_id: "did:key:carry-direct" },
    executeOrder: async (args) => {
      calls.push(args);
      if (args.operation_class === "cancel") return { status: "cancelled" };
      if (args.operation_class === "reconcile") return { status: "reconciled", fills: [] };
      return { status: "filled", final_proof: { final_venue_execution_proven: true, final_fill_proven: true, filled_base_size: "0.001" } };
    },
    verifyOrder: async (args) => recoveryVerification(args),
    env: { PRIVATE_AGENT_VENUE_DRY_RUN: "true" },
  });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.recovered[0].saga.status, "unwound");
  const unwind = calls.find((call) => call.instruction?.order?.reduce_only === true);
  assert.equal(unwind.execution.carry_position_id, "carry:position:direct:0001");
  assert.equal(unwind.execution.encrypted_execution_vault.ciphertext, "aster-sealed");
});

for (const [filledVenue, completionVenue] of CARRY_EXECUTION_VENUES.flatMap((filledVenue) =>
  CARRY_EXECUTION_VENUES
    .filter((completionVenue) => completionVenue !== filledVenue)
    .map((completionVenue) => [filledVenue, completionVenue]),
)) {
  test(`reconciles a partial reduce-only completion for every ordered execution pair: ${filledVenue} then ${completionVenue}`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), `ghola-carry-exit-${filledVenue}-${completionVenue}-`));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const state = createWorkerState(dir);
    const suffix = `${filledVenue}:${completionVenue}`;
    const sagaId = `saga:carry:exit:${suffix}`;
    const filledLeg = `${sagaId}:${filledVenue}`;
    const completionLeg = `${sagaId}:${completionVenue}`;
    const policyCommitment = `policy:carry:exit:${suffix}`;
    const instruction = (venue, side) => ({
      version: 1,
      kind: "ghola_private_execution_instruction",
      venue_id: venue,
      operation_class: "limit_order",
      order: { market: venue === "lighter" ? "BTC" : "BTC-PERP", side, base_size: "0.001", limit_price: "10000", reduce_only: true, tif: "Ioc" },
    });
    const created = await createDurableMultiLegSaga({
      state,
      definition: {
        version: 1,
        saga_id: sagaId,
        idempotency_key: `idem:carry:exit:${suffix}`,
        plan_commitment: `plan:carry:exit:${suffix}`,
        strategy_id: "exposure_rebalance",
        recovery_mode: "complete_reduce_only",
        max_unhedged_ms: 1_000,
        max_hedge_error_micro_usdc: 0,
        now_ms: NOW,
        legs: [
          { leg_id: filledLeg, venue_id: filledVenue, asset: "BTC", market: "BTC-PERP", product_type: "perp", operation_class: "limit_order", side: "sell", notional_micro_usdc: 10_000_000 },
          { leg_id: completionLeg, venue_id: completionVenue, asset: "BTC", market: "BTC-PERP", product_type: "perp", operation_class: "limit_order", side: "buy", notional_micro_usdc: 10_000_000 },
        ],
      },
      execution_context: {
        version: 1,
        carry_position_id: `carry:position:exit:${suffix}`,
        owner_commitment: `owner:carry:exit:${suffix}`,
        policy_commitment: policyCommitment,
        session_policy: { policy_commitment: policyCommitment, market_allowlist: ["BTC", "BTC-PERP"], max_notional_bucket: "25", max_order_count: 4, max_slippage_bps: 10 },
        venue_access: { [filledVenue]: { status: "ready" }, [completionVenue]: { status: "ready" } },
        legs: [
          { leg_id: filledLeg, work_order_commitment: `work:carry:exit:${filledVenue}`, instruction: instruction(filledVenue, "sell") },
          { leg_id: completionLeg, work_order_commitment: `work:carry:exit:${completionVenue}`, instruction: instruction(completionVenue, "buy") },
        ],
      },
    });
    assert.equal(created.ok, true);
    await apply(state, sagaId, 1, "preflight_passed", { leg_id: filledLeg });
    await apply(state, sagaId, 2, "preflight_passed", { leg_id: completionLeg });
    await apply(state, sagaId, 3, "submission_started");
    await apply(state, sagaId, 4, "leg_fill", { leg_id: filledLeg, cumulative_filled_micro_usdc: 10_000_000 });
    await apply(state, sagaId, 5, "leg_failed", { leg_id: completionLeg, failure_code: "venue_rejected" });
    const active = await state.getMultiLegSaga(sagaId);
    const calls = [];
    let submissions = 0;
    const executeOrder = async (args) => {
      calls.push(args);
      if (args.operation_class === "reconcile") {
        return { status: "filled", final_proof: { target_client_order_matched: true, broadcast_performed: true, final_venue_execution_proven: true, final_fill_proven: true, filled_base_size: "0.001" } };
      }
      submissions += 1;
      return { status: "open", final_proof: { target_client_order_matched: true, broadcast_performed: true, final_venue_execution_proven: false, final_fill_proven: false, filled_base_size: "0.0004" } };
    };
    const fetchImpl = async () => ({
      ok: true,
      json: async () => ({
        BTC: "10000",
        markPrice: "10000",
        order_book_details: [{ symbol: "BTC", mark_price: "10000" }],
      }),
    });
    const rejected = await recoverDueMultiLegSagas({
      state,
      now_ms: active.unhedged_deadline_ms - 2,
      recipient: { recipient_id: "did:key:carry-exit" },
      executeOrder,
      verifyOrder: async (args) => recoveryVerification(args, {
        order_shape: { ...recoveryVerification(args).order_shape, reduce_only: false },
      }),
      fetchImpl,
      env: { PRIVATE_AGENT_VENUE_DRY_RUN: "false" },
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.recovered[0].error, "saga_recovery_no_submit_mismatch");
    assert.equal(submissions, 0);
    const first = await recoverDueMultiLegSagas({
      state,
      now_ms: active.unhedged_deadline_ms - 1,
      recipient: { recipient_id: "did:key:carry-exit" },
      executeOrder,
      verifyOrder: async (args) => recoveryVerification(args),
      fetchImpl,
      env: { PRIVATE_AGENT_VENUE_DRY_RUN: "false" },
    });
    assert.equal(first.ok, false);
    assert.equal(submissions, 1);
    const recovered = await recoverDueMultiLegSagas({
      state,
      now_ms: active.unhedged_deadline_ms,
      recipient: { recipient_id: "did:key:carry-exit" },
      executeOrder,
      verifyOrder: async (args) => recoveryVerification(args),
      fetchImpl,
      env: { PRIVATE_AGENT_VENUE_DRY_RUN: "false" },
    });
    assert.equal(recovered.ok, true);
    assert.equal(recovered.recovered[0].saga.status, "reconciled");
    assert.equal(submissions, 1);
    const completionOrders = calls.filter((call) => call.instruction?.order?.reduce_only === true);
    assert.equal(completionOrders.length, 1);
    assert.equal(completionOrders[0].venue_id, completionVenue);
    assert.equal(completionOrders[0].instruction.order.side, "buy");
    const childReconcile = calls.find((call) => call.instruction?.reconcile?.target_work_order_commitment === completionOrders[0].work_order_commitment);
    assert.equal(Boolean(childReconcile), true);
    const accounting = await readDurableRecoveryAccounting({ state, saga_id: sagaId, leg_id: completionLeg, action: "completion" });
    assert.equal(accounting.executions[0].applied_filled_micro_usdc, 10_000_000);
  });
}

function recoveryVerification(args, overrides = {}) {
  const order = args.instruction?.order || {};
  return {
    status: "verified_no_funds",
    account_commitment: args.account_commitment || null,
    checks: {
      order_request_checked: true,
      transaction_broadcast: false,
    },
    order_shape: {
      market: order.market,
      side: order.side,
      base_size: order.base_size,
      limit_price: order.limit_price,
      reduce_only: order.reduce_only === true,
    },
    ...overrides,
  };
}
