import assert from "node:assert/strict";
import test from "node:test";
import { executionVenueSpec } from "@ghola/execution-core";
import {
  assessCarryVenueQualification,
  readCarryVenueQualification,
  recordCompletedCarryVenueQualifications,
  storeCarryVenueQualification,
} from "../src/execution/carry-qualification.js";

const NOW = 1_800_000_000_000;
const IMAGE = "sha256:abcdef123456";

test("accepts only complete deployment-bound mainnet lifecycle evidence", () => {
  const valid = evidence("lighter");
  assert.equal(assessCarryVenueQualification({
    venue_id: "lighter",
    evidence: valid,
    image_digest: IMAGE,
    now_ms: NOW,
  }).proven, true);

  const wrongImage = assessCarryVenueQualification({
    venue_id: "lighter",
    evidence: valid,
    image_digest: "sha256:000000123456",
    now_ms: NOW,
  });
  assert.equal(wrongImage.proven, false);
  assert.ok(wrongImage.reasons.includes("qualification_image_mismatch"));

  const partial = structuredClone(valid);
  partial.exit_recovery.open_order_count = 1;
  assert.ok(assessCarryVenueQualification({
    venue_id: "lighter",
    evidence: partial,
    image_digest: IMAGE,
    now_ms: NOW,
  }).reasons.includes("exit_recovery_proof_incomplete"));
});

test("expires stale lifecycle evidence", () => {
  const result = assessCarryVenueQualification({
    venue_id: "aster",
    evidence: evidence("aster"),
    image_digest: IMAGE,
    now_ms: NOW + 91 * 86_400_000,
  });
  assert.equal(result.proven, false);
  assert.ok(result.reasons.includes("qualification_stale"));
});

test("survives restart only for the same adapter and worker image", async () => {
  const map = new Map();
  const state = {
    getIdempotency: async (key) => map.get(key) || null,
    putIdempotency: async (key, receipt) => { map.set(key, { receipt }); return receipt; },
  };
  const stored = await storeCarryVenueQualification({
    state,
    evidence: evidence("aster"),
    now_ms: NOW,
    env: { PRIVATE_AGENT_IMAGE_DIGEST: IMAGE },
  });
  assert.equal(stored.ok, true);

  const restartedState = { getIdempotency: state.getIdempotency };
  const restored = await readCarryVenueQualification({
    state: restartedState,
    venue_id: "aster",
    now_ms: NOW + 1,
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
  });
  assert.equal(restored.proven, true);

  const replacementImage = await readCarryVenueQualification({
    state: restartedState,
    venue_id: "aster",
    now_ms: NOW + 1,
    env: { PHALA_CVM_IMAGE_DIGEST: "sha256:123456abcdef" },
  });
  assert.equal(replacementImage.proven, false);
});

test("keeps the already-proven Hyperliquid baseline independent of candidate storage", async () => {
  const result = await readCarryVenueQualification({ state: {}, venue_id: "hyperliquid", now_ms: NOW, env: {} });
  assert.equal(result.proven, true);
  assert.equal(result.source, "registry_baseline");
});

test("derives qualification only from a completed durable flat lifecycle", async () => {
  const entryWork = "work:carry:aster:entry:0001";
  const exitWork = "work:carry:aster:exit:0001";
  const map = new Map([
    [entryWork, { receipt: executionReceipt("0.001") }],
    [exitWork, { receipt: executionReceipt("0.001") }],
  ]);
  const record = {
    position: { position_id: "carry:position:0001", status: "reconciled", long_venue_id: "hyperliquid", short_venue_id: "aster" },
    entry_saga_id: "saga:entry:0001",
    exit_saga_id: "saga:exit:0001",
    final_reconciliation_evidence: {
      account_state_checked: true,
      transaction_broadcast: false,
      gross_exposure_micro_usdc: 0,
      open_order_count: 0,
      checked_at_ms: NOW,
      reconciliation_commitment: "carry:reconciliation:qualification:0001",
      venues: [
        { venue_id: "hyperliquid", authorized: true, flat_zero_orders: true, position_count: 0, open_order_count: 0, account_state_checked: true },
        { venue_id: "aster", authorized: true, flat_zero_orders: true, position_count: 0, open_order_count: 0, account_state_checked: true },
      ],
    },
    qualification_context: {
      venues: {
        aster: {
          transaction_broadcast: false,
          account_state_checked: true,
          order_request_checked: true,
          evidence_commitment: "aster_no_submit_0001",
          authority_boundary: {
            venue_native_trade_only: true,
            withdrawal_request_permitted: false,
            non_owner_fund_movement_possible: false,
          },
        },
      },
    },
  };
  const sagas = {
    "saga:entry:0001": reconciledSaga("entry", entryWork, false),
    "saga:exit:0001": reconciledSaga("exit", exitWork, true),
  };
  const state = {
    getCarryPositionRecord: async () => record,
    getMultiLegSaga: async (id) => sagas[id],
    getIdempotency: async (key) => map.get(key) || null,
    getExecutionAttempt: async () => null,
    putIdempotency: async (key, receipt) => { map.set(key, { receipt }); return receipt; },
  };
  const result = await recordCompletedCarryVenueQualifications({
    state,
    position_id: record.position.position_id,
    now_ms: NOW,
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
  });
  assert.equal(result.ok, true);
  assert.equal(result.qualifications[0].venue_id, "aster");
  assert.equal((await readCarryVenueQualification({
    state,
    venue_id: "aster",
    now_ms: NOW + 1,
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
  })).proven, true);
});

function evidence(venueId) {
  return {
    version: 1,
    venue_id: venueId,
    adapter_id: executionVenueSpec(venueId).exact_quantity_recovery_adapter,
    image_digest: IMAGE,
    network: "mainnet",
    verified_at_ms: NOW,
    no_submit: {
      transaction_broadcast: false,
      account_state_checked: true,
      order_request_checked: true,
      evidence_commitment: "no_submit_evidence_0001",
    },
    entry_reconciliation: {
      live_order_broadcast: true,
      target_client_order_matched: true,
      final_venue_execution_proven: true,
      filled_base_size: "0.001",
      evidence_commitment: "entry_evidence_0001",
    },
    exit_recovery: {
      live_order_broadcast: true,
      reduce_only: true,
      exact_base_quantity: true,
      final_venue_execution_proven: true,
      account_state_checked: true,
      gross_exposure_micro_usdc: 0,
      open_order_count: 0,
      evidence_commitment: "exit_evidence_0001",
    },
    ambiguous_submission_retry_count: 0,
    authority_boundary_acceptable: true,
    authority_evidence_commitment: "authority_evidence_0001",
  };
}

function executionReceipt(filledBaseSize) {
  return {
    provider_ref_commitment: "provider_reference_0001",
    result_commitment: "result_commitment_0001",
    final_proof: {
      broadcast_performed: true,
      target_client_order_matched: true,
      final_venue_execution_proven: true,
      filled_base_size: filledBaseSize,
      open_order_count: 0,
    },
  };
}

function reconciledSaga(phase, workOrder, reduceOnly) {
  const legId = `leg:${phase}:aster:0001`;
  return {
    status: "reconciled",
    legs: [{ leg_id: legId, venue_id: "aster" }],
    execution_context: {
      legs: [{
        leg_id: legId,
        work_order_commitment: workOrder,
        instruction: { order: { reduce_only: reduceOnly } },
      }],
    },
  };
}
