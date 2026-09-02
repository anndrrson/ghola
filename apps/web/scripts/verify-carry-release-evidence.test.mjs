import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assembleCarryReleaseEvidence,
  carryAccountStateCommitment,
  carryCreationInputEvidenceCommitment,
  carryEvidenceCommitment,
  carryReleaseEvidenceCommitment,
  carryWorkerMaterialCommitment,
  readCarryReleaseEvidenceFile,
  verifyCarryLifecycleEvidence,
  verifyCarryReleaseEvidence as verifyCommittedCarryReleaseEvidence,
} from "./verify-carry-release-evidence.mjs";
import {
  CARRY_EXECUTION_VENUES,
  CARRY_RECOVERY_POLICY,
  CARRY_SHADOW_ASSETS,
  CORE_PERP_VENUES,
  carryRiskMandateMessage,
  venueAdapterCapability,
} from "@ghola/execution-core";
import { hashMessage } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const MANDATE_OWNER = privateKeyToAccount(`0x${"22".repeat(32)}`);
const verifyCarryReleaseEvidence = verifyCarryLifecycleEvidence;
const SOURCE_TREE_DIGEST = `sha256:${"c".repeat(64)}`;

test("reports missing and malformed proof artifacts with deterministic readiness codes", () => {
  const directory = mkdtempSync(join(tmpdir(), "ghola-carry-proof-"));
  try {
    assert.throws(
      () => readCarryReleaseEvidenceFile(join(directory, "missing.json")),
      /carry_release_evidence_missing/,
    );
    const malformedPath = join(directory, "malformed.json");
    writeFileSync(malformedPath, "{", "utf8");
    assert.throws(
      () => readCarryReleaseEvidenceFile(malformedPath),
      /carry_release_evidence_json_invalid/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function fixture({
  longVenue = "hyperliquid",
  shortVenue = "aster",
  positionId = "carry:position:mainnet:proof:0001",
} = {}) {
  const signedMandate = {
    version: 1,
    kind: "ghola_carry_risk_mandate",
    strategy_id: "delta_neutral_carry_v1",
    network: "mainnet",
    owner_commitment: "owner:carry:mainnet:proof:0001",
    owner_wallet_address: MANDATE_OWNER.address.toLowerCase(),
    position_id: positionId,
    mandate_id: "carry:mandate:mainnet:proof:0001",
    asset: "HYPE",
    long_venue_id: longVenue,
    short_venue_id: shortVenue,
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
      source_tree_digest: SOURCE_TREE_DIGEST,
    },
    request: { ambiguity_retry_performed: false },
    position: {
      position_id: positionId,
      asset: "HYPE",
      target_notional_micro_usdc: 11_000_000,
      long_venue_id: longVenue,
      short_venue_id: shortVenue,
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
    creation_input_evidence: creationInputEvidence(longVenue, shortVenue),
    shadow_qualification: {
      proven: true,
      image_digest: "sha256:abcdef1234567890",
      checked_at: "2026-08-23T23:59:58.000Z",
      venues: CORE_PERP_VENUES.length,
      assets: CARRY_SHADOW_ASSETS.length,
      requested_assets: [...CARRY_SHADOW_ASSETS],
      required_samples: 3,
      completed_samples: 3,
      minimum_span_ms: 120_000,
      duration_ms: 120_000,
      expected_snapshots_per_sample: CORE_PERP_VENUES.length * CARRY_SHADOW_ASSETS.length,
      sample_commitments: ["11", "22", "33"].map((value) => `carry:shadow:sample:${value.repeat(32)}`),
      source_observation_commitments: ["55", "66", "77"].map((value) => `carry:shadow:sources:${value.repeat(32)}`),
      transaction_broadcast: false,
      evidence_commitment: `carry:shadow:qualification:${"44".repeat(32)}`,
    },
    execution_readiness: executionReadiness(),
    collateral_route_readiness: collateralRouteReadiness(),
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
        qualification(longVenue, carryAdapterId(longVenue), qualificationSource(longVenue)),
        qualification(shortVenue, carryAdapterId(shortVenue), qualificationSource(shortVenue)),
      ],
    },
    entry: {
      started_at: "2026-08-24T00:00:01.000Z",
      reconciled_at: "2026-08-24T00:00:02.000Z",
      legs: [
        leg(longVenue, "buy", false, `order:entry:${longVenue}:${positionId}`, 5_000, 1_000, 60_000),
        leg(shortVenue, "sell", false, `order:entry:${shortVenue}:${positionId}`, 5_000, 1_000, -10_000),
      ],
    },
    monitoring: {
      started_at: "2026-08-24T00:00:03.000Z",
      ended_at: "2026-08-24T00:00:05.000Z",
      observation_count: 2,
      funding_flip_checks: 2,
      funding_observations: [
        {
          observed_at: "2026-08-24T00:00:04.000Z",
          evidence_commitment: `carry:funding:current:${"11".repeat(32)}`,
          source_observed_at_ms_by_venue: {
            [longVenue]: Date.parse("2026-08-24T00:00:03.900Z"),
            [shortVenue]: Date.parse("2026-08-24T00:00:03.900Z"),
          },
        },
        {
          observed_at: "2026-08-24T00:00:05.000Z",
          evidence_commitment: `carry:funding:current:${"22".repeat(32)}`,
          source_observed_at_ms_by_venue: {
            [longVenue]: Date.parse("2026-08-24T00:00:04.900Z"),
            [shortVenue]: Date.parse("2026-08-24T00:00:04.900Z"),
          },
        },
      ],
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
        marginRunway(longVenue),
        marginRunway(shortVenue),
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
        leg(longVenue, "sell", true, `order:exit:${longVenue}:${positionId}`, 5_000, 1_500),
        leg(shortVenue, "buy", true, `order:exit:${shortVenue}:${positionId}`, 5_000, 1_500),
      ],
    },
    final_state: {
      owner_commitment: "owner:carry:mainnet:proof:0001",
      carry_position_id: positionId,
      checked_at: "2026-08-24T00:00:08.000Z",
      gross_exposure_micro_usdc: 0,
      open_order_count: 0,
      venues: [
        { venue_id: longVenue, account_commitment: `account:${longVenue}:release:0001`, authorized: true, flat_zero_orders: true, nonzero_position_count: 0, open_order_count: 0, account_state_checked: true },
        { venue_id: shortVenue, account_commitment: `account:${shortVenue}:release:0001`, authorized: true, flat_zero_orders: true, nonzero_position_count: 0, open_order_count: 0, account_state_checked: true },
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

function creationInputEvidence(longVenue, shortVenue) {
  const evidence = {
    verified: true,
    opportunity_evidence_commitment: `0x${"12".repeat(32)}`,
    legs: [
      creationInputLeg(longVenue, "buy", "34"),
      creationInputLeg(shortVenue, "sell", "56"),
    ],
  };
  evidence.evidence_commitment = carryCreationInputEvidenceCommitment(evidence);
  return evidence;
}

function creationInputLeg(venueId, side, seed) {
  const shadow = venueAdapterCapability(venueId, "perp_shadow");
  return {
    venue_id: venueId,
    side,
    shadow_snapshot_commitment: `carry:shadow:snapshot:${seed.repeat(32)}`,
    margin_model: shadow.margin_model,
    liquidation_model: shadow.liquidation_model,
    work_order_commitment: `carry:work-order:${venueId}:proof:0001`,
    verification_commitment: `carry:verification:${venueId}:proof:0001`,
    account_commitment: `account:${venueId}:release:0001`,
    account_state_commitment: `carry:account-state:${seed.repeat(20)}`,
  };
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

function carryAdapterId(venueId) {
  return venueAdapterCapability(venueId, "carry_execution")?.adapter_id;
}

function qualificationSource(venueId) {
  return venueAdapterCapability(venueId, "carry_execution")?.status === "proven"
    ? "registry_baseline"
    : "deployment_bound_lifecycle";
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
      account_state_commitment: `carry:account-state:${venueId === "hyperliquid" ? "11".repeat(20) : venueId === "lighter" ? "22".repeat(20) : "33".repeat(20)}`,
      position_count: 0,
      liquidation_distance_bps: null,
      liquidation_distance_verified: false,
      liquidation_distance_source: null,
      account_state_checked: true,
      transaction_broadcast: false,
    })),
  };
}

function collateralRouteReadiness() {
  const requiredRouteCount = CARRY_EXECUTION_VENUES.length * (CARRY_EXECUTION_VENUES.length - 1);
  return {
    proven: true,
    checked_at: "2026-08-24T00:00:09.000Z",
    expires_at: "2026-08-24T00:00:39.000Z",
    required_route_count: requiredRouteCount,
    available_route_count: requiredRouteCount,
    complete_directed_coverage: true,
    route_pairs: CARRY_EXECUTION_VENUES.flatMap((fromVenueId) => CARRY_EXECUTION_VENUES
      .filter((toVenueId) => toVenueId !== fromVenueId)
      .map((toVenueId) => `${fromVenueId}:${toVenueId}`)).sort(),
    venues: CARRY_EXECUTION_VENUES.map((venueId) => ({
      venue_id: venueId,
      account_commitment: `account:${venueId}:release:0001`,
    })),
    minimum_route_capacity_micro_usdc: 100_000_000,
    maximum_route_latency_ms: 60_000,
    owner_approval_required: true,
    fund_movement_authorized: false,
    transaction_broadcast: false,
    automatic_transfer_permitted: false,
    evidence_commitment: `carry:transfer-routes:evidence:${"77".repeat(20)}`,
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

function marginRunway(venueId, overrides = {}) {
  const checkedAt = "2026-08-24T00:00:05.000Z";
  const accountState = {
    venue_id: venueId,
    account_commitment: `account:${venueId}:release:0001`,
    verification_commitment: `carry:verification:${venueId}:proof:0001`,
    checked_at_ms: Date.parse(checkedAt),
    position_count: 1,
    open_order_count: 0,
    flat_zero_orders: false,
    liquidation_distance_bps: 2_500,
    liquidation_distance_verified: true,
    liquidation_distance_source: venueAdapterCapability(venueId, "carry_execution")?.liquidation_distance_source,
  };
  return {
    venue_id: venueId,
    status: "healthy",
    runway_ms: 86_400_000,
    stale: false,
    checked_at: checkedAt,
    account_commitment: accountState.account_commitment,
    verification_commitment: accountState.verification_commitment,
    account_state_checked_at_ms: accountState.checked_at_ms,
    account_state_commitment: carryAccountStateCommitment(accountState),
    position_open: true,
    position_count: accountState.position_count,
    open_order_count: accountState.open_order_count,
    flat_zero_orders: accountState.flat_zero_orders,
    liquidation_distance_bps: accountState.liquidation_distance_bps,
    minimum_liquidation_distance_bps: 1_000,
    liquidation_distance_verified: accountState.liquidation_distance_verified,
    liquidation_distance_source: accountState.liquidation_distance_source,
    ...overrides,
  };
}

async function committedReleaseFixture() {
  const lifecycleEvidence = [
    await fixture(),
    await fixture({
      longVenue: "lighter",
      shortVenue: "aster",
      positionId: "carry:position:mainnet:proof:0002",
    }),
  ];
  const candidate = lifecycleEvidence[0].candidate;
  const lifecycles = lifecycleEvidence.map((evidence) => {
    const material = structuredClone(evidence);
    delete material.candidate;
    delete material.evidence_commitment;
    return material;
  });
  return assembleCarryReleaseEvidence({ lifecycles, candidate });
}

test("accepts a capped paired mainnet lifecycle with exact evidence", async () => {
  assert.equal((await verifyCarryReleaseEvidence(await fixture())).ok, true);
});

test("accepts a registry-qualified lifecycle without a hard-coded Hyperliquid anchor", async () => {
  assert.equal((await verifyCarryReleaseEvidence(await fixture({
    longVenue: "lighter",
    shortVenue: "aster",
  }))).ok, true);
});

test("rejects creation evidence detached from its exact venue risk and account inputs", async () => {
  const evidence = await fixture();
  evidence.creation_input_evidence.legs[0].margin_model = "detached_margin_model";
  evidence.creation_input_evidence.evidence_commitment = carryCreationInputEvidenceCommitment(
    evidence.creation_input_evidence,
  );
  evidence.worker_material_commitment = carryWorkerMaterialCommitment(evidence);
  evidence.evidence_commitment = carryEvidenceCommitment(evidence);
  await assert.rejects(
    () => verifyCarryReleaseEvidence(evidence),
    /creation_risk_model_binding_invalid:hyperliquid/,
  );

  const accountDetached = await fixture();
  accountDetached.creation_input_evidence.legs[1].account_commitment = "account:aster:other:0001";
  accountDetached.creation_input_evidence.evidence_commitment = carryCreationInputEvidenceCommitment(
    accountDetached.creation_input_evidence,
  );
  accountDetached.worker_material_commitment = carryWorkerMaterialCommitment(accountDetached);
  accountDetached.evidence_commitment = carryEvidenceCommitment(accountDetached);
  await assert.rejects(
    () => verifyCarryReleaseEvidence(accountDetached),
    /creation_execution_commitment_invalid:aster/,
  );
});

test("accepts two unique flat lifecycles across two venue pairs and aggregates exact net value", async () => {
  const assembled = await committedReleaseFixture();
  const verified = await verifyCommittedCarryReleaseEvidence(assembled);
  assert.equal(verified.ok, true);
  assert.equal(verified.lifecycle_count, 2);
  assert.equal(verified.unique_position_count, 2);
  assert.equal(verified.distinct_venue_pair_count, 2);
  assert.equal(verified.realized_net_value_micro_usdc, 68_000);
});

test("rejects a release proof detached from the independently attested source tree", async () => {
  const assembled = await committedReleaseFixture();
  await assert.rejects(
    () => verifyCommittedCarryReleaseEvidence(assembled, {
      expected_source_tree_digest: `sha256:${"d".repeat(64)}`,
    }),
    /candidate_source_tree_digest_mismatch/,
  );
});

test("rejects fewer than two unique positions or distinct venue pairs", async () => {
  const one = await committedReleaseFixture();
  one.lifecycles = one.lifecycles.slice(0, 1);
  one.aggregate.lifecycle_count = 1;
  one.aggregate.unique_position_count = 1;
  one.aggregate.distinct_venue_pair_count = 1;
  one.aggregate.realized_net_value_micro_usdc = 34_000;
  one.evidence_commitment = carryReleaseEvidenceCommitment(one);
  await assert.rejects(
    () => verifyCommittedCarryReleaseEvidence(one),
    /lifecycle_count_insufficient|unique_position_count_insufficient|distinct_venue_pair_count_insufficient/,
  );

  const duplicatePosition = await committedReleaseFixture();
  duplicatePosition.lifecycles[1].position.position_id = duplicatePosition.lifecycles[0].position.position_id;
  duplicatePosition.aggregate.unique_position_count = 1;
  duplicatePosition.evidence_commitment = carryReleaseEvidenceCommitment(duplicatePosition);
  await assert.rejects(
    () => verifyCommittedCarryReleaseEvidence(duplicatePosition),
    /unique_position_count_insufficient/,
  );

  const duplicatePair = await committedReleaseFixture();
  duplicatePair.lifecycles[1] = structuredClone(duplicatePair.lifecycles[0]);
  duplicatePair.lifecycles[1].position.position_id = "carry:position:mainnet:proof:0002";
  duplicatePair.aggregate.unique_position_count = 2;
  duplicatePair.aggregate.distinct_venue_pair_count = 1;
  duplicatePair.evidence_commitment = carryReleaseEvidenceCommitment(duplicatePair);
  await assert.rejects(
    () => verifyCommittedCarryReleaseEvidence(duplicatePair),
    /distinct_venue_pair_count_insufficient/,
  );
});

test("rejects execution and lifecycle commitments reused across otherwise distinct lifecycles", async () => {
  const duplicateExecution = await committedReleaseFixture();
  duplicateExecution.lifecycles[1].entry.legs[1].client_order_commitment =
    duplicateExecution.lifecycles[0].entry.legs[1].client_order_commitment;
  duplicateExecution.lifecycles[1].entry.legs[1].receipt_commitment =
    duplicateExecution.lifecycles[0].entry.legs[1].receipt_commitment;
  duplicateExecution.lifecycles[1].worker_material_commitment = carryWorkerMaterialCommitment(
    duplicateExecution.lifecycles[1],
  );
  duplicateExecution.lifecycles[1].evidence_commitment = carryEvidenceCommitment(
    duplicateExecution.lifecycles[1],
  );
  duplicateExecution.evidence_commitment = carryReleaseEvidenceCommitment(duplicateExecution);
  await assert.rejects(
    () => verifyCommittedCarryReleaseEvidence(duplicateExecution),
    /cross_lifecycle_client_order_commitments_not_unique|cross_lifecycle_receipt_commitments_not_unique/,
  );

  const duplicateLifecycle = await committedReleaseFixture();
  duplicateLifecycle.lifecycles[1].evidence_commitment = duplicateLifecycle.lifecycles[0].evidence_commitment;
  duplicateLifecycle.lifecycles[1].worker_material_commitment =
    duplicateLifecycle.lifecycles[0].worker_material_commitment;
  duplicateLifecycle.evidence_commitment = carryReleaseEvidenceCommitment(duplicateLifecycle);
  await assert.rejects(
    () => verifyCommittedCarryReleaseEvidence(duplicateLifecycle),
    /lifecycle_evidence_commitments_not_unique|lifecycle_worker_commitments_not_unique/,
  );
});

test("rejects any non-flat lifecycle and an inexact aggregate realized net value", async () => {
  const nonFlat = await committedReleaseFixture();
  nonFlat.lifecycles[1].final_state.gross_exposure_micro_usdc = 1;
  nonFlat.lifecycles[1].worker_material_commitment = carryWorkerMaterialCommitment(nonFlat.lifecycles[1]);
  nonFlat.lifecycles[1].evidence_commitment = carryEvidenceCommitment(nonFlat.lifecycles[1]);
  nonFlat.evidence_commitment = carryReleaseEvidenceCommitment(nonFlat);
  await assert.rejects(
    () => verifyCommittedCarryReleaseEvidence(nonFlat),
    /lifecycle_invalid:1:.*final_exposure_not_flat/,
  );

  const incompleteCosts = await committedReleaseFixture();
  incompleteCosts.lifecycles[1].value_ledger.complete_costs = false;
  incompleteCosts.lifecycles[1].worker_material_commitment = carryWorkerMaterialCommitment(
    incompleteCosts.lifecycles[1],
  );
  incompleteCosts.lifecycles[1].evidence_commitment = carryEvidenceCommitment(incompleteCosts.lifecycles[1]);
  incompleteCosts.evidence_commitment = carryReleaseEvidenceCommitment(incompleteCosts);
  await assert.rejects(
    () => verifyCommittedCarryReleaseEvidence(incompleteCosts),
    /lifecycle_invalid:1:.*value_ledger_incomplete/,
  );

  const inexactAggregate = await committedReleaseFixture();
  inexactAggregate.aggregate.realized_net_value_micro_usdc += 1;
  inexactAggregate.evidence_commitment = carryReleaseEvidenceCommitment(inexactAggregate);
  await assert.rejects(
    () => verifyCommittedCarryReleaseEvidence(inexactAggregate),
    /aggregate_realized_net_value_mismatch/,
  );
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

test("rejects padded three-venue account-state commitments", async () => {
  const evidence = await fixture();
  evidence.execution_readiness.venues[0].account_state_commitment += "00";
  evidence.worker_material_commitment = carryWorkerMaterialCommitment(evidence);
  evidence.evidence_commitment = carryEvidenceCommitment(evidence);
  await assert.rejects(() => verifyCarryReleaseEvidence(evidence), /three_venue_account_state_commitment_invalid:hyperliquid/);
});

test("rejects three-venue readiness whose creation account is not flat", async () => {
  const evidence = await fixture();
  evidence.execution_readiness.venues[0].position_count = 1;
  evidence.worker_material_commitment = carryWorkerMaterialCommitment(evidence);
  evidence.evidence_commitment = carryEvidenceCommitment(evidence);
  await assert.rejects(() => verifyCarryReleaseEvidence(evidence), /three_venue_position_not_flat:hyperliquid/);
});

test("rejects fabricated liquidation distance for a flat readiness account", async () => {
  const evidence = await fixture();
  evidence.execution_readiness.venues[0].liquidation_distance_bps = 1;
  evidence.worker_material_commitment = carryWorkerMaterialCommitment(evidence);
  evidence.evidence_commitment = carryEvidenceCommitment(evidence);
  await assert.rejects(() => verifyCarryReleaseEvidence(evidence), /three_venue_liquidation_binding_invalid:hyperliquid/);
});

test("rejects release evidence without complete collateral-route coverage", async () => {
  const evidence = await fixture();
  evidence.collateral_route_readiness.available_route_count = 5;
  evidence.worker_material_commitment = carryWorkerMaterialCommitment(evidence);
  evidence.evidence_commitment = carryEvidenceCommitment(evidence);
  await assert.rejects(() => verifyCarryReleaseEvidence(evidence), /collateral_route_coverage_incomplete/);
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

test("rejects detached or unverifiable live liquidation evidence", async () => {
  for (const [mutate, expected] of [
    [(row) => { row.liquidation_distance_source = "aster_fapi_v3_position_risk_v1"; }, /margin_runway_liquidation_binding_invalid:hyperliquid/],
    [(row) => { row.liquidation_distance_verified = false; }, /margin_runway_liquidation_binding_invalid:hyperliquid/],
    [(row) => { row.position_open = false; }, /margin_runway_open_position_unproven:hyperliquid/],
    [(row) => { row.account_commitment = "account:hyperliquid:detached:0001"; }, /margin_runway_account_binding_invalid:hyperliquid/],
    [(row) => { row.account_state_commitment = `carry:account-state:${"ff".repeat(20)}`; }, /margin_runway_account_state_commitment_invalid:hyperliquid/],
    [(row) => { row.checked_at = "2026-08-24T00:00:04.000Z"; }, /margin_runway_account_state_timestamp_invalid:hyperliquid/],
  ]) {
    const evidence = await fixture();
    mutate(evidence.monitoring.margin_runways[0]);
    evidence.worker_material_commitment = carryWorkerMaterialCommitment(evidence);
    evidence.evidence_commitment = carryEvidenceCommitment(evidence);
    await assert.rejects(() => verifyCarryReleaseEvidence(evidence), expected);
  }
});

test("requires a breached status below the verified liquidation floor", async () => {
  const evidence = await fixture();
  const row = evidence.monitoring.margin_runways[0];
  row.liquidation_distance_bps = 999;
  row.account_state_commitment = carryAccountStateCommitment({
    venue_id: row.venue_id,
    account_commitment: row.account_commitment,
    verification_commitment: row.verification_commitment,
    checked_at_ms: row.account_state_checked_at_ms,
    position_count: row.position_count,
    open_order_count: row.open_order_count,
    flat_zero_orders: row.flat_zero_orders,
    liquidation_distance_bps: row.liquidation_distance_bps,
    liquidation_distance_verified: row.liquidation_distance_verified,
    liquidation_distance_source: row.liquidation_distance_source,
  });
  evidence.worker_material_commitment = carryWorkerMaterialCommitment(evidence);
  evidence.evidence_commitment = carryEvidenceCommitment(evidence);
  await assert.rejects(() => verifyCarryReleaseEvidence(evidence), /margin_runway_liquidation_status_invalid:hyperliquid/);
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

test("rejects fresh wrapper checks that reuse venue funding sources", async () => {
  const evidence = await fixture();
  evidence.monitoring.funding_observations[1].evidence_commitment =
    evidence.monitoring.funding_observations[0].evidence_commitment;
  evidence.monitoring.funding_observations[1].source_observed_at_ms_by_venue = {
    ...evidence.monitoring.funding_observations[0].source_observed_at_ms_by_venue,
  };
  evidence.worker_material_commitment = carryWorkerMaterialCommitment(evidence);
  evidence.evidence_commitment = carryEvidenceCommitment(evidence);
  await assert.rejects(() => verifyCarryReleaseEvidence(evidence), /funding_observation_source_reused/);
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
    [(evidence) => { evidence.shadow_qualification.completed_samples = 2; }, /shadow_qualification_sample_count_mismatch|shadow_qualification_commitments_invalid/],
    [(evidence) => { evidence.shadow_qualification.image_digest = "sha256:fedcba9876543210"; }, /shadow_qualification_image_mismatch/],
    [(evidence) => { evidence.shadow_qualification.source_observation_commitments[1] = evidence.shadow_qualification.source_observation_commitments[0]; }, /shadow_qualification_source_observations_invalid/],
    [(evidence) => { evidence.shadow_qualification.duration_ms = 2_000; }, /shadow_qualification_duration_invalid/],
  ]) {
    const evidence = await fixture();
    mutate(evidence);
    evidence.worker_material_commitment = carryWorkerMaterialCommitment(evidence);
    evidence.evidence_commitment = carryEvidenceCommitment(evidence);
    await assert.rejects(() => verifyCarryReleaseEvidence(evidence), expected);
  }
});

test("rejects a five-venue sample count the worker cannot attest", async () => {
  const evidence = await fixture();
  evidence.shadow_qualification.completed_samples = 4;
  evidence.shadow_qualification.sample_commitments.push(`carry:shadow:sample:${"88".repeat(32)}`);
  evidence.shadow_qualification.source_observation_commitments.push(`carry:shadow:sources:${"99".repeat(32)}`);
  evidence.worker_material_commitment = carryWorkerMaterialCommitment(evidence);
  evidence.evidence_commitment = carryEvidenceCommitment(evidence);
  await assert.rejects(
    () => verifyCarryReleaseEvidence(evidence),
    /shadow_qualification_sample_count_mismatch/,
  );
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
