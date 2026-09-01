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

  const wrongAccount = structuredClone(valid);
  wrongAccount.exit_recovery.account_commitment = "account:lighter:wrong:0001";
  assert.ok(assessCarryVenueQualification({
    venue_id: "lighter",
    evidence: wrongAccount,
    image_digest: IMAGE,
    now_ms: NOW,
  }).reasons.includes("exit_account_binding_mismatch"));
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
    [entryWork, { receipt: executionReceipt("0.001", "account:aster:qualification:0001") }],
    [exitWork, { receipt: executionReceipt("0.001", "account:aster:qualification:0001") }],
  ]);
  const attempts = new Map([
    [entryWork, executionAttempt("account:aster:qualification:0001")],
    [exitWork, executionAttempt("account:aster:qualification:0001")],
  ]);
  const record = {
    owner_commitment: "owner:carry:qualification:0001",
    position: { position_id: "carry:position:0001", status: "reconciled", long_venue_id: "hyperliquid", short_venue_id: "aster" },
    entry_saga_id: "saga:entry:0001",
    exit_saga_id: "saga:exit:0001",
    monitoring_context: {
      venue_access: {
        hyperliquid: { account_commitment: "account:hyperliquid:qualification:0001" },
        aster: { account_commitment: "account:aster:qualification:0001" },
      },
    },
    final_reconciliation_evidence: {
      owner_commitment: "owner:carry:qualification:0001",
      carry_position_id: "carry:position:0001",
      account_state_checked: true,
      transaction_broadcast: false,
      gross_exposure_micro_usdc: 0,
      open_order_count: 0,
      checked_at_ms: NOW,
      reconciliation_commitment: "carry:reconciliation:qualification:0001",
      venues: [
        { venue_id: "hyperliquid", account_commitment: "account:hyperliquid:qualification:0001", authorized: true, flat_zero_orders: true, position_count: 0, open_order_count: 0, account_state_checked: true },
        { venue_id: "aster", account_commitment: "account:aster:qualification:0001", authorized: true, flat_zero_orders: true, position_count: 0, open_order_count: 0, account_state_checked: true },
      ],
    },
    qualification_context: {
      venues: {
        aster: {
          account_commitment: "account:aster:qualification:0001",
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
    getExecutionAttempt: async (key) => attempts.get(key) || null,
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

  attempts.get(entryWork).ambiguity_retry_count = 1;
  const retried = await recordCompletedCarryVenueQualifications({
    state,
    position_id: record.position.position_id,
    now_ms: NOW,
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
  });
  assert.equal(retried.ok, false);
  assert.equal(retried.error, "entry_submission_attempt_proof_incomplete");

  attempts.get(entryWork).ambiguity_retry_count = 0;
  attempts.delete(exitWork);
  const missing = await recordCompletedCarryVenueQualifications({
    state,
    position_id: record.position.position_id,
    now_ms: NOW,
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, "exit_submission_attempt_proof_incomplete");
});

function evidence(venueId) {
  const accountCommitment = `account:${venueId}:qualification:0001`;
  return {
    version: 1,
    venue_id: venueId,
    owner_commitment: "owner:carry:qualification:0001",
    carry_position_id: "carry:position:qualification:0001",
    account_commitment: accountCommitment,
    adapter_id: executionVenueSpec(venueId).exact_quantity_recovery_adapter,
    image_digest: IMAGE,
    network: "mainnet",
    verified_at_ms: NOW,
    no_submit: {
      account_commitment: accountCommitment,
      transaction_broadcast: false,
      account_state_checked: true,
      order_request_checked: true,
      evidence_commitment: "no_submit_evidence_0001",
    },
    entry_reconciliation: {
      account_commitment: accountCommitment,
      live_order_broadcast: true,
      target_client_order_matched: true,
      final_venue_execution_proven: true,
      filled_base_size: "0.001",
      evidence_commitment: "entry_evidence_0001",
    },
    exit_recovery: {
      account_commitment: accountCommitment,
      live_order_broadcast: true,
      reduce_only: true,
      exact_base_quantity: true,
      final_venue_execution_proven: true,
      account_state_checked: true,
      gross_exposure_micro_usdc: 0,
      open_order_count: 0,
      evidence_commitment: "exit_evidence_0001",
    },
    submission_attempts: submissionAttempts(accountCommitment),
    ambiguous_submission_retry_count: 0,
    authority_boundary_acceptable: true,
    authority_evidence_commitment: "authority_evidence_0001",
  };
}

function submissionAttempts(accountCommitment) {
  return {
    entry: {
      work_order_commitment: "work:carry:entry:qualification:0001",
      account_commitment: accountCommitment,
      submit_count: 1,
      ambiguity_retry_count: 0,
      evidence_commitment: "attempt:entry:qualification:0001",
    },
    exit: {
      work_order_commitment: "work:carry:exit:qualification:0001",
      account_commitment: accountCommitment,
      submit_count: 1,
      ambiguity_retry_count: 0,
      evidence_commitment: "attempt:exit:qualification:0001",
    },
  };
}

function executionAttempt(accountCommitment) {
  return {
    venue_id: "aster",
    account_commitment: accountCommitment,
    submit_count: 1,
    ambiguity_retry_count: 0,
    status: "filled",
    provider_ref_seed: { order_id: "42" },
    result_seed: { kind: "aster_order_filled" },
    final_proof: { final_venue_execution_proven: true },
  };
}

function executionReceipt(filledBaseSize, accountCommitment) {
  return {
    account_commitment: accountCommitment,
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
