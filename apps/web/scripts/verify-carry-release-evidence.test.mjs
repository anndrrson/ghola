import assert from "node:assert/strict";
import test from "node:test";
import {
  assembleCarryReleaseEvidence,
  carryEvidenceCommitment,
  carryWorkerMaterialCommitment,
  verifyCarryReleaseEvidence,
} from "./verify-carry-release-evidence.mjs";
import { CARRY_EXECUTION_VENUES, CARRY_RECOVERY_POLICY, carryRiskMandateMessage } from "@ghola/execution-core";
import { hashMessage } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const MANDATE_OWNER = privateKeyToAccount(`0x${"22".repeat(32)}`);

async function fixture() {
  const signedMandate = {
    version: 1,
    kind: "ghola_carry_risk_mandate",
    strategy_id: "delta_neutral_carry_v1",
    network: "mainnet",
    owner_commitment: "owner:carry:mainnet:proof:0001",
    owner_wallet_address: MANDATE_OWNER.address.toLowerCase(),
    position_id: "carry:position:mainnet:proof:0001",
    mandate_id: "carry:mandate:mainnet:proof:0001",
    asset: "HYPE",
    long_venue_id: "hyperliquid",
    short_venue_id: "aster",
    target_notional_micro_usdc: 11_000_000,
    risk_mandate: {
      min_expected_net_benefit_bps: 5,
      exit_net_value_bps: 0,
      exit_after_consecutive_observations: 2,
      min_margin_runway_ms: 21_600_000,
      max_hedge_error_micro_usdc: 10_000,
      max_data_age_ms: 60_000,
      max_contract_data_skew_ms: 2_000,
      max_index_price_divergence_bps: 25,
      max_mark_price_divergence_bps: 50,
      allow_migration: false,
      owner_only_operations: ["fund", "withdraw", "transfer"],
    },
    issued_at_ms: Date.parse("2026-08-23T23:59:00.000Z"),
    expires_at_ms: Date.parse("2026-09-23T23:59:00.000Z"),
  };
  const mandateMessage = carryRiskMandateMessage(signedMandate);
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
    contract_equivalence: {
      verified: true,
      checked_at: "2026-08-23T23:59:59.000Z",
      economic_equivalence_id: "carry:HYPE-usd-linear",
      contract_type: "linear_perp",
      long_quote_asset: "USD",
      short_quote_asset: "USDT",
      contract_data_skew_ms: 400,
      max_contract_data_skew_ms: 2_000,
      index_price_divergence_bps: 3,
      mark_price_divergence_bps: 7,
      max_index_price_divergence_bps: 25,
      max_mark_price_divergence_bps: 50,
    },
    shadow_qualification: {
      proven: true,
      image_digest: "sha256:abcdef1234567890",
      checked_at: "2026-08-23T23:59:58.000Z",
      venues: 5,
      assets: 3,
      requested_assets: ["BTC", "ETH", "SOL"],
      required_samples: 3,
      completed_samples: 3,
      duration_ms: 120_000,
      expected_snapshots_per_sample: 15,
      sample_commitments: ["11", "22", "33"].map((value) => `carry:shadow:sample:${value.repeat(32)}`),
      transaction_broadcast: false,
      evidence_commitment: `carry:shadow:qualification:${"44".repeat(32)}`,
    },
    execution_readiness: executionReadiness(),
    mandate: {
      policy_commitment: hashMessage(mandateMessage),
      signed_mandate: signedMandate,
      owner_signature: await MANDATE_OWNER.signMessage({ message: mandateMessage }),
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
        leg("hyperliquid", "buy", false, "order:entry:hyperliquid:0001", 5_000, 1_000, 60_000),
        leg("aster", "sell", false, "order:entry:aster:0001", 5_000, 1_000, -10_000),
      ],
    },
    monitoring: {
      started_at: "2026-08-24T00:00:03.000Z",
      ended_at: "2026-08-24T00:00:05.000Z",
      observation_count: 2,
      funding_flip_checks: 2,
      supervision: {
        mode: "attested_worker_loop",
        automatic_observation_count: 2,
        first_automatic_observed_at: "2026-08-24T00:00:04.000Z",
        last_automatic_observed_at: "2026-08-24T00:00:05.000Z",
        max_observation_gap_ms: 2_000,
        max_allowed_gap_ms: 60_000,
        failure_count: 0,
        transaction_broadcast: false,
      },
      margin_runways: [
        { venue_id: "hyperliquid", status: "healthy", runway_ms: 86_400_000, stale: false },
        { venue_id: "aster", status: "healthy", runway_ms: 86_400_000, stale: false },
      ],
    },
    exit: {
      reason: "manual",
      trigger: {
        kind: "owner_request",
        observed_at: "2026-08-24T00:00:06.000Z",
        metric: "owner_request",
        observed_value: null,
        signed_threshold_value: null,
        effective_threshold_value: null,
        consecutive_observation_count: null,
        venue_id: null,
        status: null,
        transaction_broadcast: false,
      },
      requested_at: "2026-08-24T00:00:06.000Z",
      reconciled_at: "2026-08-24T00:00:07.000Z",
      legs: [
        leg("hyperliquid", "sell", true, "order:exit:hyperliquid:0001", 5_000, 1_500),
        leg("aster", "buy", true, "order:exit:aster:0001", 5_000, 1_500),
      ],
    },
    final_state: {
      owner_commitment: "owner:carry:mainnet:proof:0001",
      carry_position_id: "carry:position:mainnet:proof:0001",
      checked_at: "2026-08-24T00:00:08.000Z",
      gross_exposure_micro_usdc: 0,
      open_order_count: 0,
      venues: [
        { venue_id: "hyperliquid", account_commitment: "account:hyperliquid:release:0001", authorized: true, flat_zero_orders: true, nonzero_position_count: 0, open_order_count: 0, account_state_checked: true },
        { venue_id: "aster", account_commitment: "account:aster:release:0001", authorized: true, flat_zero_orders: true, nonzero_position_count: 0, open_order_count: 0, account_state_checked: true },
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

function executionReadiness() {
  return {
    ready: true,
    owner_commitment: "owner:carry:mainnet:proof:0001",
    asset: "HYPE",
    notional_usd: "11",
    horizon_days: "30",
    image_digest: "sha256:abcdef1234567890",
    checked_at: "2026-08-23T23:59:57.000Z",
    expires_at: "2026-08-24T00:14:57.000Z",
    registry_venue_ids: [...CARRY_EXECUTION_VENUES],
    recovery_ready: true,
    recovery_venue_ids: [...CARRY_EXECUTION_VENUES],
    recovery_policy: { ...CARRY_RECOVERY_POLICY },
    transaction_broadcast: false,
    evidence_commitment: `carry:readiness:evidence:${"55".repeat(20)}`,
    readiness_commitment: `carry:readiness:result:${"66".repeat(32)}`,
    venues: CARRY_EXECUTION_VENUES.map((venueId) => ({
      venue_id: venueId,
      account_commitment: `account:${venueId}:release:0001`,
      account_state_commitment: `carry:account-state:${venueId === "hyperliquid" ? "11".repeat(32) : venueId === "lighter" ? "22".repeat(32) : "33".repeat(32)}`,
      account_state_checked: true,
      transaction_broadcast: false,
    })),
  };
}

function leg(venue_id, side, reduce_only, client_order_commitment, fee_micro_usdc, slippage_micro_usdc, funding_micro_usdc = 0) {
  return {
    venue_id,
    account_commitment: `account:${venue_id}:release:0001`,
    side,
    reduce_only,
    client_order_commitment,
    submit_count: 1,
    ambiguity_retry_count: 0,
    live_order_broadcast: true,
    target_client_order_matched: true,
    final_venue_execution_proven: true,
    filled_base_size: "0.11",
    funding_micro_usdc,
    fee_micro_usdc,
    slippage_micro_usdc,
    receipt_commitment: `receipt:${client_order_commitment}`,
  };
}

test("accepts a capped paired mainnet lifecycle with exact evidence", async () => {
  assert.equal((await verifyCarryReleaseEvidence(await fixture())).ok, true);
});

test("assembles candidate metadata without changing worker-derived material", async () => {
  const evidence = await fixture();
  const candidate = evidence.candidate;
  const material = structuredClone(evidence);
  delete material.candidate;
  delete material.evidence_commitment;
  const assembled = assembleCarryReleaseEvidence({ material, candidate });
  assert.equal((await verifyCarryReleaseEvidence(assembled)).ok, true);
});

test("rejects an ambiguous resubmission", async () => {
  const evidence = await fixture();
  evidence.entry.legs[1].ambiguity_retry_count = 1;
  evidence.evidence_commitment = carryEvidenceCommitment(evidence);
  await assert.rejects(() => verifyCarryReleaseEvidence(evidence), /entry_ambiguity_retry_forbidden:aster/);
});

test("rejects release evidence without all three execution venue bindings", async () => {
  const evidence = await fixture();
  evidence.execution_readiness.venues = evidence.execution_readiness.venues.filter((venue) => venue.venue_id !== "lighter");
  evidence.worker_material_commitment = carryWorkerMaterialCommitment(evidence);
  evidence.evidence_commitment = carryEvidenceCommitment(evidence);
  await assert.rejects(() => verifyCarryReleaseEvidence(evidence), /three_venue_account_bindings_invalid/);
});

test("rejects release evidence whose three-venue recovery policy permits ambiguity retries", async () => {
  const evidence = await fixture();
  evidence.execution_readiness.recovery_policy.ambiguous_submission = "retry";
  evidence.worker_material_commitment = carryWorkerMaterialCommitment(evidence);
  evidence.evidence_commitment = carryEvidenceCommitment(evidence);
  await assert.rejects(() => verifyCarryReleaseEvidence(evidence), /three_venue_recovery_unproven/);
});

test("rejects a paired lifecycle without live broadcast proof on every leg", async () => {
  const evidence = await fixture();
  evidence.entry.legs[0].live_order_broadcast = false;
  evidence.worker_material_commitment = carryWorkerMaterialCommitment(evidence);
  evidence.evidence_commitment = carryEvidenceCommitment(evidence);
  await assert.rejects(() => verifyCarryReleaseEvidence(evidence), /entry_live_broadcast_unproven:hyperliquid/);
});

test("rejects an exit that is not exact and reduce-only", async () => {
  const evidence = await fixture();
  evidence.exit.legs[1].reduce_only = false;
  evidence.exit.legs[1].filled_base_size = "0.10";
  evidence.evidence_commitment = carryEvidenceCommitment(evidence);
  await assert.rejects(() => verifyCarryReleaseEvidence(evidence), /exit_reduce_only_invalid:aster|exact_exit_quantity_required:aster/);
});

test("rejects an exit without exact owner or signed-mandate trigger evidence", async () => {
  for (const [mutate, expected] of [
    [(evidence) => { delete evidence.exit.trigger; }, /exit_trigger_missing/],
    [(evidence) => { evidence.exit.trigger.kind = "net_carry_below_threshold"; }, /owner_exit_trigger_invalid/],
    [(evidence) => { evidence.exit.trigger.observed_at = evidence.monitoring.ended_at; }, /owner_exit_trigger_invalid/],
  ]) {
    const evidence = await fixture();
    mutate(evidence);
    evidence.worker_material_commitment = carryWorkerMaterialCommitment(evidence);
    evidence.evidence_commitment = carryEvidenceCommitment(evidence);
    await assert.rejects(() => verifyCarryReleaseEvidence(evidence), expected);
  }
});

test("accepts only a measured signed-threshold funding exit", async () => {
  const evidence = await fixture();
  evidence.exit.reason = "funding_flip";
  evidence.exit.trigger = {
    kind: "net_carry_below_threshold",
    observed_at: evidence.monitoring.ended_at,
    metric: "expected_net_value_bps",
    observed_value: -1,
    signed_threshold_value: 0,
    effective_threshold_value: 0,
    consecutive_observation_count: 2,
    venue_id: null,
    status: null,
    transaction_broadcast: false,
  };
  evidence.worker_material_commitment = carryWorkerMaterialCommitment(evidence);
  evidence.evidence_commitment = carryEvidenceCommitment(evidence);
  assert.equal((await verifyCarryReleaseEvidence(evidence)).ok, true);

  evidence.exit.trigger.consecutive_observation_count = 1;
  evidence.worker_material_commitment = carryWorkerMaterialCommitment(evidence);
  evidence.evidence_commitment = carryEvidenceCommitment(evidence);
  await assert.rejects(() => verifyCarryReleaseEvidence(evidence), /funding_exit_cadence_invalid/);
});

test("rejects missing monitoring and margin-runway proof", async () => {
  const evidence = await fixture();
  evidence.monitoring.ended_at = evidence.monitoring.started_at;
  evidence.monitoring.margin_runways = [];
  evidence.evidence_commitment = carryEvidenceCommitment(evidence);
  await assert.rejects(() => verifyCarryReleaseEvidence(evidence), /monitoring_period_required|margin_runway_venues_mismatch/);
});

test("rejects margin-runway proof without verified status", async () => {
  const evidence = await fixture();
  delete evidence.monitoring.margin_runways[0].status;
  evidence.evidence_commitment = carryEvidenceCommitment(evidence);
  await assert.rejects(() => verifyCarryReleaseEvidence(evidence), /margin_runway_status_missing:hyperliquid/);
});

test("rejects monitoring that was not produced by the unattended worker loop", async () => {
  const evidence = await fixture();
  evidence.monitoring.supervision.mode = "manual";
  evidence.worker_material_commitment = carryWorkerMaterialCommitment(evidence);
  evidence.evidence_commitment = carryEvidenceCommitment(evidence);
  await assert.rejects(() => verifyCarryReleaseEvidence(evidence), /supervised_monitoring_required/);
});

test("rejects a single unattended observation as continuous monitoring", async () => {
  const evidence = await fixture();
  evidence.monitoring.observation_count = 1;
  evidence.monitoring.funding_flip_checks = 1;
  evidence.monitoring.supervision.automatic_observation_count = 1;
  evidence.monitoring.supervision.first_automatic_observed_at = evidence.monitoring.supervision.last_automatic_observed_at;
  evidence.worker_material_commitment = carryWorkerMaterialCommitment(evidence);
  evidence.evidence_commitment = carryEvidenceCommitment(evidence);
  await assert.rejects(
    () => verifyCarryReleaseEvidence(evidence),
    /monitoring_observation_cadence_missing|supervised_monitoring_cadence_missing|supervised_monitoring_period_required/,
  );
});

test("rejects monitoring outages and gaps beyond the signed freshness budget", async () => {
  for (const mutate of [
    (evidence) => { evidence.monitoring.supervision.failure_count = 1; },
    (evidence) => { evidence.monitoring.supervision.max_observation_gap_ms = 60_001; },
    (evidence) => { evidence.monitoring.supervision.max_allowed_gap_ms = 120_000; },
  ]) {
    const evidence = await fixture();
    mutate(evidence);
    evidence.worker_material_commitment = carryWorkerMaterialCommitment(evidence);
    evidence.evidence_commitment = carryEvidenceCommitment(evidence);
    await assert.rejects(
      () => verifyCarryReleaseEvidence(evidence),
      /supervised_monitoring_failure_detected|supervised_monitoring_gap_exceeded|supervised_monitoring_gap_budget_mismatch/,
    );
  }
});

test("rejects same-ticker proof whose contract basis exceeds the verified budget", async () => {
  const evidence = await fixture();
  evidence.contract_equivalence.index_price_divergence_bps = 26;
  evidence.worker_material_commitment = carryWorkerMaterialCommitment(evidence);
  evidence.evidence_commitment = carryEvidenceCommitment(evidence);
  await assert.rejects(() => verifyCarryReleaseEvidence(evidence), /contract_index_basis_exceeded/);
});

test("rejects missing, incomplete, or image-mismatched five-venue shadow qualification", async () => {
  for (const [mutate, expected] of [
    [(evidence) => { evidence.shadow_qualification.proven = false; }, /shadow_qualification_unproven/],
    [(evidence) => { evidence.shadow_qualification.completed_samples = 2; }, /shadow_qualification_samples_incomplete|shadow_qualification_commitments_invalid/],
    [(evidence) => { evidence.shadow_qualification.image_digest = "sha256:fedcba9876543210"; }, /shadow_qualification_image_mismatch/],
  ]) {
    const evidence = await fixture();
    mutate(evidence);
    evidence.worker_material_commitment = carryWorkerMaterialCommitment(evidence);
    evidence.evidence_commitment = carryEvidenceCommitment(evidence);
    await assert.rejects(() => verifyCarryReleaseEvidence(evidence), expected);
  }
});

test("rejects contract limits that differ from the signed risk mandate", async () => {
  const evidence = await fixture();
  evidence.contract_equivalence.max_index_price_divergence_bps = 26;
  evidence.worker_material_commitment = carryWorkerMaterialCommitment(evidence);
  evidence.evidence_commitment = carryEvidenceCommitment(evidence);
  await assert.rejects(() => verifyCarryReleaseEvidence(evidence), /signed_index_basis_limit_mismatch/);
});

test("accepts a healthy null runway only as verified zero modeled burn", async () => {
  const evidence = await fixture();
  evidence.monitoring.margin_runways[0].runway_ms = null;
  evidence.worker_material_commitment = carryWorkerMaterialCommitment(evidence);
  evidence.evidence_commitment = carryEvidenceCommitment(evidence);
  assert.equal((await verifyCarryReleaseEvidence(evidence)).ok, true);
});

test("rejects residual exposure or orders", async () => {
  const evidence = await fixture();
  evidence.final_state.venues[0].open_order_count = 1;
  evidence.evidence_commitment = carryEvidenceCommitment(evidence);
  await assert.rejects(() => verifyCarryReleaseEvidence(evidence), /venue_open_orders_not_zero:hyperliquid/);
});

test("rejects final venue rows that are not directly authorized and flat", async () => {
  const evidence = await fixture();
  delete evidence.final_state.venues[0].authorized;
  delete evidence.final_state.venues[0].flat_zero_orders;
  evidence.evidence_commitment = carryEvidenceCommitment(evidence);
  await assert.rejects(
    () => verifyCarryReleaseEvidence(evidence),
    /venue_not_authorized:hyperliquid|venue_flat_state_unproven:hyperliquid/,
  );
});

test("rejects lifecycle proof whose owner, position, or leg belongs to another account", async () => {
  for (const [mutate, expected] of [
    [(evidence) => { evidence.final_state.owner_commitment = "owner:carry:mainnet:wrong:0001"; }, /final_owner_binding_mismatch/],
    [(evidence) => { evidence.final_state.carry_position_id = "carry:position:mainnet:wrong:0001"; }, /final_position_binding_mismatch/],
    [(evidence) => { evidence.entry.legs[1].account_commitment = "account:aster:wrong:0001"; }, /entry_account_binding_mismatch:aster/],
    [(evidence) => { evidence.exit.legs[0].account_commitment = "account:hyperliquid:wrong:0001"; }, /exit_account_binding_mismatch:hyperliquid/],
  ]) {
    const evidence = await fixture();
    mutate(evidence);
    evidence.worker_material_commitment = carryWorkerMaterialCommitment(evidence);
    evidence.evidence_commitment = carryEvidenceCommitment(evidence);
    await assert.rejects(() => verifyCarryReleaseEvidence(evidence), expected);
  }
});

test("rejects a value ledger that does not reconcile to leg costs", async () => {
  const evidence = await fixture();
  evidence.value_ledger.realized.fees_micro_usdc = 19_000;
  evidence.evidence_commitment = carryEvidenceCommitment(evidence);
  await assert.rejects(() => verifyCarryReleaseEvidence(evidence), /realized_net_value_mismatch|realized_fee_evidence_mismatch/);
});

test("rejects funding not reconciled to exact venue legs", async () => {
  const evidence = await fixture();
  evidence.entry.legs[0].funding_micro_usdc += 1;
  evidence.worker_material_commitment = carryWorkerMaterialCommitment(evidence);
  evidence.evidence_commitment = carryEvidenceCommitment(evidence);
  await assert.rejects(() => verifyCarryReleaseEvidence(evidence), /realized_funding_evidence_mismatch/);
});

test("rejects qualification from a different worker image", async () => {
  const evidence = await fixture();
  evidence.qualification.venues[1].image_digest = "sha256:fedcba9876543210";
  evidence.evidence_commitment = carryEvidenceCommitment(evidence);
  await assert.rejects(() => verifyCarryReleaseEvidence(evidence), /qualification_image_mismatch:aster/);
});

test("rejects a mutated or replayed owner mandate", async () => {
  const evidence = await fixture();
  evidence.mandate.signed_mandate.position_id = "carry:position:mainnet:replayed";
  evidence.worker_material_commitment = carryWorkerMaterialCommitment(evidence);
  evidence.evidence_commitment = carryEvidenceCommitment(evidence);
  await assert.rejects(() => verifyCarryReleaseEvidence(evidence), /signed_mandate_commitment_mismatch|signed_mandate_position_mismatch|owner_signature_mismatch/);
});
