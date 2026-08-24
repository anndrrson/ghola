import assert from "node:assert/strict";
import test from "node:test";
import { buildCompletedCarryReleaseMaterial } from "../src/execution/carry-release-evidence.js";

const NOW = 1_800_000_010_000;
const IMAGE = "sha256:abcdef1234567890";
const OWNER = "owner:carry:release:0001";

test("derives release material only from a completed durable lifecycle", async () => {
  const fixture = stateFixture();
  const result = await buildCompletedCarryReleaseMaterial({
    state: fixture.state,
    owner_commitment: OWNER,
    position_id: fixture.record.position.position_id,
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
    now_ms: NOW,
  });
  assert.equal(result.ok, true);
  assert.equal(result.material.entry.legs.length, 2);
  assert.equal(result.material.exit.legs.every((leg) => leg.reduce_only), true);
  assert.equal(result.material.monitoring.observation_count, 1);
  assert.equal(result.material.final_state.open_order_count, 0);
  assert.equal(result.material.value_ledger.realized.net_value_micro_usdc, 34);
  assert.match(result.material.worker_material_commitment, /^carry:release:material:[0-9a-f]{64}$/);
});

test("refuses to manufacture proof without a monitoring period", async () => {
  const fixture = stateFixture();
  fixture.record.lifecycle_events = fixture.record.lifecycle_events.filter((event) => event.type !== "observation");
  const result = await buildCompletedCarryReleaseMaterial({
    state: fixture.state,
    owner_commitment: OWNER,
    position_id: fixture.record.position.position_id,
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
    now_ms: NOW,
  });
  assert.equal(result.error, "carry_release_monitoring_evidence_missing");
});

test("refuses to claim one-submit proof without a durable attempt counter", async () => {
  const fixture = stateFixture();
  fixture.attempts["work:carry:entry:aster"].submit_count = 2;
  const result = await buildCompletedCarryReleaseMaterial({
    state: fixture.state,
    owner_commitment: OWNER,
    position_id: fixture.record.position.position_id,
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
    now_ms: NOW,
  });
  assert.equal(result.error, "carry_release_entry_submission_count_unproven:aster");
});

function stateFixture() {
  const positionId = "carry:position:release:0001";
  const entrySaga = saga("entry", 1_800_000_000_500, 1_800_000_001_000, false);
  const exitSaga = saga("exit", 1_800_000_003_000, 1_800_000_004_000, true);
  const ledgerEntries = [...entrySaga.legs, ...exitSaga.legs].flatMap((leg, index) => [
    { leg_id: leg.leg_id, entry_type: "trading_fee", direction: "debit", amount_micro_usdc: 5 },
    { leg_id: leg.leg_id, entry_type: "slippage", direction: "debit", amount_micro_usdc: index === 3 ? 2 : 1 },
  ]);
  const record = {
    owner_commitment: OWNER,
    entry_saga_id: entrySaga.saga_id,
    exit_saga_id: exitSaga.saga_id,
    position: {
      position_id: positionId,
      mandate_id: "carry:mandate:release:0001",
      asset: "HYPE",
      long_venue_id: "hyperliquid",
      short_venue_id: "aster",
      target_notional_micro_usdc: 11_000_000,
      created_at_ms: 1_800_000_000_000,
      status: "reconciled",
    },
    lifecycle_events: [
      { type: "observation", recorded_at_ms: 1_800_000_002_000, margin_runway_ms_by_venue: { hyperliquid: 86_400_000, aster: 86_400_000 } },
      { type: "manual_exit_requested", recorded_at_ms: 1_800_000_003_000 },
    ],
    final_reconciliation_evidence: {
      account_state_checked: true,
      gross_exposure_micro_usdc: 0,
      open_order_count: 0,
      checked_at_ms: 1_800_000_005_000,
      reconciliation_commitment: "carry:reconciliation:release:0001",
    },
    value_evidence: {
      costs_complete: true,
      realized_economics: { contract_pnl_micro_usdc: 10 },
    },
    value_ledger: {
      status: "finalized",
      modeled: {
        gross_funding_micro_usdc: 400,
        trading_cost_micro_usdc: 100,
        capital_cost_micro_usdc: 50,
        risk_buffer_micro_usdc: 50,
        net_value_micro_usdc: 200,
      },
      realized: {
        funding_credit_micro_usdc: 50,
        funding_debit_micro_usdc: 0,
        trading_fee_micro_usdc: 20,
        slippage_micro_usdc: 5,
        gas_micro_usdc: 0,
        capital_cost_micro_usdc: 1,
        transfer_fee_micro_usdc: 0,
        rebate_micro_usdc: 0,
        net_value_micro_usdc: 34,
      },
      entries: ledgerEntries,
    },
  };
  const receipts = Object.fromEntries([
    ...entrySaga.execution_context.legs,
    ...exitSaga.execution_context.legs,
  ].map((context, index) => [
    context.work_order_commitment,
    {
      receipt: {
        provider_ref_commitment: `provider:carry:release:${index}`,
        result_commitment: `result:carry:release:${index}`,
        final_proof: {
          target_client_order_matched: true,
          final_venue_execution_proven: true,
          filled_base_size: "0.11",
        },
      },
    },
  ]));
  const qualification = qualificationEvidence();
  const attempts = Object.fromEntries([
    ...entrySaga.execution_context.legs,
    ...exitSaga.execution_context.legs,
  ].map((context) => [
    context.work_order_commitment,
    { submit_count: 1, ambiguity_retry_count: 0 },
  ]));
  const state = {
    getCarryPositionRecord: async () => record,
    getMultiLegSaga: async (id) => id === entrySaga.saga_id ? entrySaga : exitSaga,
    getExecutionAttempt: async (key) => attempts[key] || null,
    getIdempotency: async (key) => key.startsWith("carry:qualification:aster:")
      ? { receipt: qualification }
      : receipts[key] || null,
  };
  return { state, record, attempts };
}

function saga(phase, createdAt, updatedAt, reduceOnly) {
  const venues = ["hyperliquid", "aster"];
  const legs = venues.map((venue_id, index) => ({
    leg_id: `leg:carry:${phase}:${venue_id}`,
    venue_id,
    side: phase === "entry" ? index === 0 ? "buy" : "sell" : index === 0 ? "sell" : "buy",
  }));
  const contexts = legs.map((leg) => ({
    leg_id: leg.leg_id,
    work_order_commitment: `work:carry:${phase}:${leg.venue_id}`,
    instruction: { order: { side: leg.side, reduce_only: reduceOnly } },
  }));
  return {
    saga_id: `saga:carry:${phase}:release:0001`,
    status: "reconciled",
    created_at_ms: createdAt,
    updated_at_ms: updatedAt,
    legs,
    execution_context: { legs: contexts },
  };
}

function qualificationEvidence() {
  return {
    version: 1,
    venue_id: "aster",
    adapter_id: "aster_v1",
    image_digest: IMAGE,
    network: "mainnet",
    verified_at_ms: NOW - 1,
    no_submit: {
      transaction_broadcast: false,
      account_state_checked: true,
      order_request_checked: true,
      evidence_commitment: "qualification:no-submit:aster:0001",
    },
    entry_reconciliation: {
      live_order_broadcast: true,
      target_client_order_matched: true,
      final_venue_execution_proven: true,
      filled_base_size: "0.11",
      evidence_commitment: "qualification:entry:aster:0001",
    },
    exit_recovery: {
      live_order_broadcast: true,
      reduce_only: true,
      exact_base_quantity: true,
      final_venue_execution_proven: true,
      account_state_checked: true,
      gross_exposure_micro_usdc: 0,
      open_order_count: 0,
      evidence_commitment: "qualification:exit:aster:0001",
    },
    ambiguous_submission_retry_count: 0,
    authority_boundary_acceptable: true,
    authority_evidence_commitment: "qualification:authority:aster:0001",
  };
}
