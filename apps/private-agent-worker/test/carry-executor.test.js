import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { executeStoredCarryEntry, executeStoredCarryExit, runCarryExecutionTick } from "../src/execution/carry-executor.js";
import { advanceStoredCarryPosition, createStoredCarryPosition } from "../src/execution/carry-positions.js";
import { readCarryVenueQualification } from "../src/execution/carry-qualification.js";
import { recoverDueMultiLegSagas } from "../src/execution/multi-leg-orchestrator.js";
import { createWorkerState } from "../src/state/private-state.js";

const NOW = 1_800_000_000_000;
const OWNER = "owner:carry:executor:0001";

test("executes and reconciles a qualified protected perp pair", async (t) => {
  const fixture = await setup(t, "success");
  const calls = [];
  const result = await executeStoredCarryEntry({
    ...fixture,
    executeOrder: async (args) => {
      calls.push(args);
      return {
        status: "filled",
        provider_ref_commitment: `provider:${args.venue_id}:0001`,
        final_proof: { final_venue_execution_proven: true, final_fill_proven: true, cumulative_filled_micro_usdc: 10_000_000, filled_base_size: "0.001" },
      };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.record.position.status, "active");
  assert.equal(result.saga.status, "reconciled");
  assert.equal(calls.length, 2);
  assert.equal(calls.every((call) => call.instruction.order.reduce_only === false), true);
  assert.equal(calls.every((call) => call.execution.carry_position_id === fixture.position_id), true);
});

test("bootstraps one capped candidate only after separate qualification confirmation", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-carry-executor-qualification-pilot-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = createWorkerState(dir);
  const positionId = "carry:position:executor:qualification-pilot";
  const env = {
    PRIVATE_AGENT_CARRY_POSITION_LIVE_SUBMIT: "true",
    PRIVATE_AGENT_CARRY_QUALIFICATION_PILOT_ENABLED: "true",
    PRIVATE_AGENT_CARRY_QUALIFICATION_PILOT_MAX_NOTIONAL_MICRO_USDC: "11000000",
    PHALA_CVM_IMAGE_DIGEST: "sha256:abcdef123456",
  };
  const access = (venueId) => ({
    status: "ready",
    owner_commitment: OWNER,
    account_commitment: `account:${venueId}:pilot`,
    vault_commitment: `vault:${venueId}:pilot`,
    encrypted_vault_commitment: `encrypted:${venueId}:pilot`,
    policy_commitment: `policy:${venueId}:pilot`,
    encrypted_execution_vault: { ciphertext: `sealed:${venueId}:pilot` },
  });
  const created = await createStoredCarryPosition({
    state,
    owner_commitment: OWNER,
    position_input: {
      ...positionInput(positionId),
      long_venue_id: "hyperliquid",
      short_venue_id: "aster",
    },
    opportunity: {
      ...opportunity(),
      long_venue_id: "hyperliquid",
      short_venue_id: "aster",
      live_creation_ready: false,
      qualification_pilot_ready: true,
      qualification_pilot_candidate_venue_id: "aster",
    },
    monitoring_context: { version: 1, venue_access: { hyperliquid: access("hyperliquid"), aster: access("aster") } },
    qualification_pilot: { enabled: true, candidate_venue_id: "aster" },
    env,
    now_ms: NOW,
  });
  assert.equal(created.ok, true);
  const proof = {
    version: 1,
    transaction_broadcast: false,
    no_submit_ready: true,
    live_creation_ready: false,
    qualification_pilot_ready: true,
    qualification_pilot_candidate_venue_id: "aster",
    evidence: [
      { venue_id: "hyperliquid", side: "buy", transaction_broadcast: false, verification_commitment: "verify_hyperliquid_pilot", checks: { account_state_checked: true, order_request_checked: true }, authority_boundary: { venue_native_trade_only: true }, reference_mark_price_e8: 1_000_000_000_000, order_shape: { market: "BTC", base_size: "0.001", limit_price: "10000" } },
      { venue_id: "aster", side: "sell", transaction_broadcast: false, verification_commitment: "verify_aster_pilot", checks: { account_state_checked: true, order_request_checked: true }, authority_boundary: { venue_native_trade_only: true }, reference_mark_price_e8: 1_000_000_000_000, order_shape: { market: "BTCUSDT", base_size: "0.001", limit_price: "10000" } },
    ],
  };
  const args = {
    state,
    owner_commitment: OWNER,
    position_id: positionId,
    recipient: {},
    verifyOrder: async () => ({}),
    preflight: async () => proof,
    executeOrder: async (order) => {
      const receipt = qualificationReceipt(order);
      await state.putIdempotency(order.work_order_commitment, receipt);
      return receipt;
    },
    env,
    now: (() => { let value = NOW; return () => ++value; })(),
  };
  const unconfirmed = await executeStoredCarryEntry(args);
  assert.equal(unconfirmed.error, "carry_qualification_pilot_confirmation_required");
  const confirmed = await executeStoredCarryEntry({ ...args, qualification_confirmed: true });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.record.qualification_pilot.status, "entry_started");
  const active = await state.getCarryPositionRecord(positionId);
  const exiting = await advanceStoredCarryPosition({
    state,
    owner_commitment: OWNER,
    position_id: positionId,
    event: {
      version: 1,
      event_id: "carry:qualification:pilot:exit:0001",
      sequence: active.position.last_event_sequence + 1,
      type: "manual_exit_requested",
    },
    now_ms: args.now(),
  });
  assert.equal(exiting.ok, true);
  const closed = await executeStoredCarryExit({
    ...args,
    preflight: async () => ({
      ...proof,
      account_readiness: [
        { venue_id: "hyperliquid", authorized: true, flat_zero_orders: true },
        { venue_id: "aster", authorized: true, flat_zero_orders: true },
      ],
    }),
  });
  assert.equal(closed.ok, true);
  assert.equal(closed.record.position.status, "reconciled");
  assert.equal(closed.qualification.ok, true);
  const restarted = createWorkerState(dir);
  const restored = await readCarryVenueQualification({
    state: restarted,
    venue_id: "aster",
    now_ms: args.now(),
    env,
  });
  assert.equal(restored.proven, true);
});

test("freezes an ambiguous leg and never submits the entry again", async (t) => {
  const fixture = await setup(t, "ambiguous");
  let calls = 0;
  const result = await executeStoredCarryEntry({
    ...fixture,
    executeOrder: async (args) => {
      calls += 1;
      if (args.venue_id === "lighter") {
        const error = new Error("submission outcome ambiguous");
        error.code = "submission_ambiguous";
        throw error;
      }
      return {
        status: "filled",
        provider_ref_commitment: "provider:aster:0001",
        final_proof: { final_venue_execution_proven: true, final_fill_proven: true, cumulative_filled_micro_usdc: 10_000_000, filled_base_size: "0.001" },
      };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "carry_entry_outcome_ambiguous");
  assert.equal(result.record.position.status, "frozen");
  assert.equal(result.record.position.retry_permitted, false);
  const retried = await executeStoredCarryEntry({ ...fixture, executeOrder: async () => { calls += 1; } });
  assert.equal(retried.error, "carry_entry_already_started");
  assert.equal(calls, 2);
});

test("records a fully rejected pair as flat with no recovery order", async (t) => {
  const fixture = await setup(t, "no-fill");
  const result = await executeStoredCarryEntry({
    ...fixture,
    executeOrder: async () => { throw new Error("venue rejected order"); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "carry_entry_failed_no_fill");
  assert.equal(result.record.position.status, "reconciled");
  assert.equal(result.record.position.terminal_reason, "entry_failed_no_fill");
});

test("records only receipt-proven fees and adverse slippage", async (t) => {
  const fixture = await setup(t, "exact-value-evidence");
  const result = await executeStoredCarryEntry({
    ...fixture,
    executeOrder: async (args) => ({
      ...filledReceipt(args),
      fills: [{
        size: "0.001",
        price: args.venue_id === "aster" ? "10001" : "9999",
        fee: args.venue_id === "aster" ? "0.003" : "0.004",
        fee_asset: "USDT",
      }],
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.accounting.complete, true);
  assert.equal(result.record.value_ledger.entries.length, 4);
  assert.equal(result.record.value_ledger.realized.trading_fee_micro_usdc, 7_000);
  assert.equal(result.record.value_ledger.realized.slippage_micro_usdc, 2_000);
});

test("routes equal partial IOC entry fills into a deterministic reduce-only exit", async (t) => {
  const fixture = await setup(t, "equal-partial-entry");
  const result = await executeStoredCarryEntry({
    ...fixture,
    executeOrder: async () => ({
      status: "filled",
      provider_ref_commitment: "provider:partial:0001",
      final_proof: {
        final_venue_execution_proven: true,
        final_fill_proven: false,
        cumulative_filled_micro_usdc: 5_000_000,
        filled_base_size: "0.0005",
        open_order_count: 0,
      },
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "carry_entry_requires_recovery");
  assert.equal(result.saga.status, "reconciled");
  assert.deepEqual(result.saga.legs.map((leg) => leg.filled_micro_usdc), [5_000_000, 5_000_000]);
  assert.equal(result.record.position.long_filled_micro_usdc, 5_000_000);
  assert.equal(result.record.position.short_filled_micro_usdc, 5_000_000);
  assert.equal(result.record.position.status, "exiting");
  assert.deepEqual(result.record.position.next_actions, ["cancel_open_orders", "reduce_only_close_filled_exposure"]);
});

test("closes both reconciled legs reduce-only and proves flat with zero orders", async (t) => {
  const fixture = await setup(t, "exit-success");
  await openActive(fixture);
  const active = await fixture.state.getCarryPositionRecord(fixture.position_id);
  await advanceStoredCarryPosition({
    state: fixture.state,
    owner_commitment: OWNER,
    position_id: fixture.position_id,
    event: { version: 1, event_id: "carry:exit:request:success", sequence: active.position.last_event_sequence + 1, type: "manual_exit_requested" },
    now_ms: NOW + 50,
  });
  const calls = [];
  const result = await executeStoredCarryExit({
    ...fixture,
    executeOrder: async (args) => {
      calls.push(args);
      const receipt = filledReceipt(args);
      await fixture.state.putIdempotency(args.work_order_commitment, receipt);
      return receipt;
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.record.position.status, "reconciled");
  assert.equal(calls.length, 2);
  assert.equal(calls.every((call) => call.instruction.order.reduce_only === true), true);
  assert.deepEqual(calls.map((call) => call.instruction.order.side).sort(), ["buy", "sell"]);
  assert.equal(result.record.final_reconciliation_evidence.account_state_checked, true);
  assert.equal(result.record.final_reconciliation_evidence.open_order_count, 0);
});

test("a failed exit leg completes reduce-only after recovery and syncs flat", async (t) => {
  const fixture = await setup(t, "exit-recovery");
  await openActive(fixture);
  const active = await fixture.state.getCarryPositionRecord(fixture.position_id);
  await advanceStoredCarryPosition({
    state: fixture.state,
    owner_commitment: OWNER,
    position_id: fixture.position_id,
    event: { version: 1, event_id: "carry:exit:request:recovery", sequence: active.position.last_event_sequence + 1, type: "manual_exit_requested" },
    now_ms: NOW + 50,
  });
  const started = await executeStoredCarryExit({
    ...fixture,
    executeOrder: async (args) => {
      if (args.venue_id === "lighter") throw new Error("venue rejected order");
      const receipt = filledReceipt(args);
      await fixture.state.putIdempotency(args.work_order_commitment, receipt);
      return receipt;
    },
  });
  assert.equal(started.ok, false);
  assert.equal(started.error, "carry_exit_requires_recovery");
  assert.equal(started.saga.recovery_mode, "complete_reduce_only");
  const restartedState = createWorkerState(fixture.state_dir);
  const recovered = await recoverDueMultiLegSagas({
    state: restartedState,
    now_ms: started.saga.unhedged_deadline_ms - 1,
    recipient: fixture.recipient,
    executeOrder: async (args) => filledReceipt(args),
    verifyOrder: fixture.verifyOrder,
    env: fixture.env,
  });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.recovered[0].saga.status, "reconciled");
  const synced = await runCarryExecutionTick({ ...fixture, state: restartedState, executeOrder: async () => { throw new Error("unexpected submit"); } });
  assert.equal(synced.ok, true);
  assert.equal(synced.results[0].record.position.status, "reconciled");
  assert.equal(synced.results[0].record.final_reconciliation_evidence.account_state_checked, true);
  assert.equal(synced.results[0].record.final_reconciliation_evidence.open_order_count, 0);
});

test("does not claim a recovered exit is flat until both account reads prove it", async (t) => {
  const fixture = await setup(t, "exit-proof-pending");
  await openActive(fixture);
  const active = await fixture.state.getCarryPositionRecord(fixture.position_id);
  await advanceStoredCarryPosition({
    state: fixture.state,
    owner_commitment: OWNER,
    position_id: fixture.position_id,
    event: { version: 1, event_id: "carry:exit:request:proof-pending", sequence: active.position.last_event_sequence + 1, type: "manual_exit_requested" },
    now_ms: NOW + 50,
  });
  const preflight = async () => ({
    ...preflightProof(),
    account_readiness: [
      { venue_id: "aster", authorized: true, flat_zero_orders: true },
      { venue_id: "lighter", authorized: true, flat_zero_orders: false },
    ],
  });
  const result = await executeStoredCarryExit({
    ...fixture,
    preflight,
    executeOrder: async (args) => {
      const receipt = filledReceipt(args);
      await fixture.state.putIdempotency(args.work_order_commitment, receipt);
      return receipt;
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "carry_exit_not_flat_or_open_orders_nonzero");
  assert.equal(result.record.position.status, "exiting");
  assert.equal(result.record.exit_verification.status, "pending");
  assert.equal(result.record.final_reconciliation_evidence, undefined);
});

test("finalizes modeled-versus-realized value only after exact costs, funding, and flat proof", async (t) => {
  const fixture = await setup(t, "final-value-ledger");
  const entry = await executeStoredCarryEntry({
    ...fixture,
    executeOrder: async (args) => {
      const receipt = exactValueReceipt(args);
      await fixture.state.putIdempotency(args.work_order_commitment, receipt);
      return receipt;
    },
  });
  assert.equal(entry.ok, true);
  assert.equal(entry.accounting.complete, true);
  const active = await fixture.state.getCarryPositionRecord(fixture.position_id);
  await advanceStoredCarryPosition({
    state: fixture.state,
    owner_commitment: OWNER,
    position_id: fixture.position_id,
    event: { version: 1, event_id: "carry:exit:request:final-ledger", sequence: active.position.last_event_sequence + 1, type: "manual_exit_requested" },
    now_ms: NOW + 50,
  });
  const result = await executeStoredCarryExit({
    ...fixture,
    readFundingSettlements: async ({ body }) => [{
      settlement_id: `${body.venue_id}:final:1`,
      occurred_at_ms: Math.min(body.end_time_ms, body.start_time_ms + 1),
      amount_quote: body.venue_id === "aster" ? "0.020" : "-0.005",
      quote_asset: "USDC",
    }],
    executeOrder: async (args) => {
      const receipt = exactValueReceipt(args);
      await fixture.state.putIdempotency(args.work_order_commitment, receipt);
      return receipt;
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.value_finalized, true);
  assert.equal(result.record.value_ledger.status, "finalized");
  assert.equal(result.record.value_ledger.realized.funding_credit_micro_usdc, 20_000);
  assert.equal(result.record.value_ledger.realized.funding_debit_micro_usdc, 5_000);
  assert.equal(result.record.value_ledger.realized.trading_fee_micro_usdc, 14_000);
  assert.equal(result.record.value_ledger.realized.net_value_micro_usdc, 19_000);
  assert.equal(result.record.value_ledger.finalization_evidence.open_order_count, 0);
});

async function setup(t, suffix) {
  const dir = mkdtempSync(join(tmpdir(), `ghola-carry-executor-${suffix}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = createWorkerState(dir);
  const positionId = `carry:position:executor:${suffix}`;
  const created = await createStoredCarryPosition({
    state,
    owner_commitment: OWNER,
    position_input: positionInput(positionId),
    opportunity: opportunity(),
    monitoring_context: monitoringContext(),
    now_ms: NOW,
  });
  assert.equal(created.ok, true);
  return {
    state,
    state_dir: dir,
    owner_commitment: OWNER,
    position_id: positionId,
    recipient: { recipient_id: "did:key:carry-executor" },
    verifyOrder: async () => ({ status: "verified_no_funds" }),
    preflight: async () => preflightProof(),
    env: { PRIVATE_AGENT_VENUE_DRY_RUN: "true" },
    now: (() => { let value = NOW + 1; return () => value += 1; })(),
  };
}

function positionInput(positionId) {
  return {
    version: 1,
    position_id: positionId,
    mandate_id: `carry:mandate:executor:${positionId.split(":").at(-1)}`,
    asset: "BTC",
    long_venue_id: "aster",
    short_venue_id: "lighter",
    target_notional_micro_usdc: 10_000_000,
    risk_mandate: {
      min_expected_net_benefit_bps: 1,
      exit_net_value_bps: 0,
      exit_after_consecutive_observations: 2,
      min_margin_runway_ms: 3_600_000,
      max_hedge_error_micro_usdc: 0,
      max_data_age_ms: 30_000,
      allow_migration: false,
    },
  };
}

function opportunity() {
  return {
    version: 1,
    eligible: true,
    reasons: [],
    asset: "BTC",
    long_venue_id: "aster",
    short_venue_id: "lighter",
    notional_micro_usdc: 10_000_000,
    capital_committed_micro_usdc: 4_000_000,
    horizon_ms: 86_400_000,
    projected_gross_funding_micro_usdc: 25_000,
    projected_trading_cost_micro_usdc: 3_000,
    projected_capital_cost_micro_usdc: 1_000,
    risk_buffer_micro_usdc: 1_000,
    projected_net_value_micro_usdc: 20_000,
    projected_net_value_bps: 20,
    break_even_ms: 3_600_000,
    checked_at_ms: NOW,
    all_venues_ready: true,
    live_creation_ready: true,
    long_margin_runway_ms: 7_200_000,
    short_margin_runway_ms: 7_200_000,
  };
}

function monitoringContext() {
  const access = (venue) => ({
    status: "ready",
    owner_commitment: OWNER,
    account_commitment: `account:${venue}:0001`,
    vault_commitment: `vault:${venue}:0001`,
    encrypted_vault_commitment: `encrypted:${venue}:0001`,
    policy_commitment: `policy:${venue}:0001`,
    encrypted_execution_vault: { ciphertext: `sealed:${venue}` },
  });
  return { version: 1, venue_access: { aster: access("aster"), lighter: access("lighter") } };
}

function preflightProof() {
  return {
    version: 1,
    transaction_broadcast: false,
    no_submit_ready: true,
    live_creation_ready: true,
    account_readiness: [
      { venue_id: "aster", authorized: true, flat_zero_orders: true },
      { venue_id: "lighter", authorized: true, flat_zero_orders: true },
    ],
    evidence: [
      { venue_id: "aster", side: "buy", transaction_broadcast: false, reference_mark_price_e8: 1_000_000_000_000, order_shape: { market: "BTCUSDT", base_size: "0.001", limit_price: "10000" } },
      { venue_id: "lighter", side: "sell", transaction_broadcast: false, reference_mark_price_e8: 1_000_000_000_000, order_shape: { market: "BTC", base_size: "0.001", limit_price: "10000" } },
    ],
  };
}

async function openActive(fixture) {
  const result = await executeStoredCarryEntry({
    ...fixture,
    executeOrder: async (args) => {
      const receipt = filledReceipt(args);
      await fixture.state.putIdempotency(args.work_order_commitment, receipt);
      return receipt;
    },
  });
  assert.equal(result.ok, true);
}

function filledReceipt(args) {
  return {
    status: "filled",
    provider_ref_commitment: `provider:${args.venue_id}:filled`,
    final_proof: {
      final_venue_execution_proven: true,
      final_fill_proven: true,
      cumulative_filled_micro_usdc: 10_000_000,
      filled_base_size: "0.001",
      open_order_count: 0,
    },
  };
}

function qualificationReceipt(args) {
  return {
    ...filledReceipt(args),
    result_commitment: `result:${args.venue_id}:qualification`,
    fills: [{ size: "0.001", price: "10000", fee: "0.001", fee_asset: "USDC" }],
    final_proof: {
      ...filledReceipt(args).final_proof,
      broadcast_performed: true,
      target_client_order_matched: true,
      average_fill_price: "10000",
      fee_quote_amount: "0.001",
      fee_asset: "USDC",
    },
  };
}

function exactValueReceipt(args) {
  const exit = args.instruction.order.reduce_only === true;
  const price = exit
    ? args.venue_id === "aster" ? "10010" : "9990"
    : args.venue_id === "aster" ? "10001" : "9999";
  const fee = args.venue_id === "aster" ? "0.003" : "0.004";
  return {
    ...filledReceipt(args),
    fills: [{ size: "0.001", price, fee, fee_asset: "USDC" }],
    final_proof: {
      ...filledReceipt(args).final_proof,
      average_fill_price: price,
      fee_quote_amount: fee,
      fee_asset: "USDC",
    },
  };
}
