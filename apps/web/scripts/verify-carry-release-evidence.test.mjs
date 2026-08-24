import assert from "node:assert/strict";
import test from "node:test";
import {
  assembleCarryReleaseEvidence,
  carryEvidenceCommitment,
  carryWorkerMaterialCommitment,
  verifyCarryReleaseEvidence,
} from "./verify-carry-release-evidence.mjs";

function fixture() {
  const evidence = {
    version: 1,
    kind: "ghola_cross_venue_carry_mainnet_lifecycle_proof",
    network: "mainnet",
    candidate: {
      web_commit_sha: "5b487f6f",
      preview_url: "https://ghola-carry-proof.vercel.app",
      worker_image_digest: "sha256:abcdef1234567890",
    },
    request: { ambiguity_retry_performed: false },
    position: {
      position_id: "carry:position:mainnet:proof:0001",
      asset: "HYPE",
      target_notional_micro_usdc: 11_000_000,
      long_venue_id: "hyperliquid",
      short_venue_id: "aster",
      created_at: "2026-08-24T00:00:00.000Z",
    },
    mandate: {
      policy_commitment: "policy:carry:mainnet:0001",
      ai_execution_authority: false,
      funding_owner_only: true,
      transfers_owner_only: true,
      withdrawals_owner_only: true,
    },
    qualification: {
      venues: [
        qualification("hyperliquid", "hyperliquid_v1", "registry_baseline"),
        qualification("aster", "aster_v1", "deployment_bound_lifecycle"),
      ],
    },
    entry: {
      started_at: "2026-08-24T00:00:01.000Z",
      reconciled_at: "2026-08-24T00:00:02.000Z",
      legs: [
        leg("hyperliquid", "buy", false, "order:entry:hyperliquid:0001", 5_000, 1_000),
        leg("aster", "sell", false, "order:entry:aster:0001", 5_000, 1_000),
      ],
    },
    monitoring: {
      started_at: "2026-08-24T00:00:03.000Z",
      ended_at: "2026-08-24T00:00:05.000Z",
      observation_count: 1,
      funding_flip_checks: 1,
      margin_runways: [
        { venue_id: "hyperliquid", runway_ms: 86_400_000, stale: false },
        { venue_id: "aster", runway_ms: 86_400_000, stale: false },
      ],
    },
    exit: {
      reason: "manual",
      requested_at: "2026-08-24T00:00:06.000Z",
      reconciled_at: "2026-08-24T00:00:07.000Z",
      legs: [
        leg("hyperliquid", "sell", true, "order:exit:hyperliquid:0001", 5_000, 1_500),
        leg("aster", "buy", true, "order:exit:aster:0001", 5_000, 1_500),
      ],
    },
    final_state: {
      checked_at: "2026-08-24T00:00:08.000Z",
      gross_exposure_micro_usdc: 0,
      open_order_count: 0,
      venues: [
        { venue_id: "hyperliquid", nonzero_position_count: 0, open_order_count: 0, account_state_checked: true },
        { venue_id: "aster", nonzero_position_count: 0, open_order_count: 0, account_state_checked: true },
      ],
    },
    value_ledger: {
      finalized: true,
      complete_costs: true,
      modeled: {
        gross_funding_micro_usdc: 400_000,
        total_cost_micro_usdc: 200_000,
        expected_net_micro_usdc: 200_000,
      },
      realized: {
        contract_pnl_micro_usdc: 10_000,
        funding_micro_usdc: 50_000,
        fees_micro_usdc: 20_000,
        slippage_micro_usdc: 5_000,
        gas_micro_usdc: 0,
        capital_cost_micro_usdc: 1_000,
        transfer_fees_micro_usdc: 0,
        rebates_micro_usdc: 0,
        net_value_micro_usdc: 34_000,
      },
      evidence_commitment: "carry:value:evidence:0001",
    },
  };
  evidence.worker_material_commitment = carryWorkerMaterialCommitment(evidence);
  evidence.evidence_commitment = carryEvidenceCommitment(evidence);
  return evidence;
}

function qualification(venue_id, adapter_id, source) {
  return {
    venue_id,
    proven: true,
    adapter_id,
    image_digest: "sha256:abcdef1234567890",
    source,
    no_submit_ready: true,
    transaction_broadcast: false,
    evidence_commitment: `qualification:${venue_id}:0001`,
  };
}

function leg(venue_id, side, reduce_only, client_order_commitment, fee_micro_usdc, slippage_micro_usdc) {
  return {
    venue_id,
    side,
    reduce_only,
    client_order_commitment,
    submit_count: 1,
    ambiguity_retry_count: 0,
    target_client_order_matched: true,
    final_venue_execution_proven: true,
    filled_base_size: "0.11",
    fee_micro_usdc,
    slippage_micro_usdc,
    receipt_commitment: `receipt:${client_order_commitment}`,
  };
}

test("accepts a capped paired mainnet lifecycle with exact evidence", () => {
  assert.equal(verifyCarryReleaseEvidence(fixture()).ok, true);
});

test("assembles candidate metadata without changing worker-derived material", () => {
  const evidence = fixture();
  const candidate = evidence.candidate;
  const material = structuredClone(evidence);
  delete material.candidate;
  delete material.evidence_commitment;
  const assembled = assembleCarryReleaseEvidence({ material, candidate });
  assert.equal(verifyCarryReleaseEvidence(assembled).ok, true);
});

test("rejects an ambiguous resubmission", () => {
  const evidence = fixture();
  evidence.entry.legs[1].ambiguity_retry_count = 1;
  evidence.evidence_commitment = carryEvidenceCommitment(evidence);
  assert.throws(() => verifyCarryReleaseEvidence(evidence), /entry_ambiguity_retry_forbidden:aster/);
});

test("rejects an exit that is not exact and reduce-only", () => {
  const evidence = fixture();
  evidence.exit.legs[1].reduce_only = false;
  evidence.exit.legs[1].filled_base_size = "0.10";
  evidence.evidence_commitment = carryEvidenceCommitment(evidence);
  assert.throws(() => verifyCarryReleaseEvidence(evidence), /exit_reduce_only_invalid:aster|exact_exit_quantity_required:aster/);
});

test("rejects missing monitoring and margin-runway proof", () => {
  const evidence = fixture();
  evidence.monitoring.ended_at = evidence.monitoring.started_at;
  evidence.monitoring.margin_runways = [];
  evidence.evidence_commitment = carryEvidenceCommitment(evidence);
  assert.throws(() => verifyCarryReleaseEvidence(evidence), /monitoring_period_required|margin_runway_venues_mismatch/);
});

test("rejects residual exposure or orders", () => {
  const evidence = fixture();
  evidence.final_state.venues[0].open_order_count = 1;
  evidence.evidence_commitment = carryEvidenceCommitment(evidence);
  assert.throws(() => verifyCarryReleaseEvidence(evidence), /venue_open_orders_not_zero:hyperliquid/);
});

test("rejects a value ledger that does not reconcile to leg costs", () => {
  const evidence = fixture();
  evidence.value_ledger.realized.fees_micro_usdc = 19_000;
  evidence.evidence_commitment = carryEvidenceCommitment(evidence);
  assert.throws(() => verifyCarryReleaseEvidence(evidence), /realized_net_value_mismatch|realized_fee_evidence_mismatch/);
});

test("rejects qualification from a different worker image", () => {
  const evidence = fixture();
  evidence.qualification.venues[1].image_digest = "sha256:fedcba9876543210";
  evidence.evidence_commitment = carryEvidenceCommitment(evidence);
  assert.throws(() => verifyCarryReleaseEvidence(evidence), /qualification_image_mismatch:aster/);
});
