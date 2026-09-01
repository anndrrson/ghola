import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assessCompletedCarryLifecycleProof,
  buildCompletedCarryReleaseMaterial,
  carryLifecycleProofIndexKey,
  carryLifecycleProofKey,
  carryLifecycleProofReferenceKey,
  readCompletedCarryLifecycleProof,
  recordCompletedCarryLifecycleProof,
} from "../src/execution/carry-release-evidence.js";
import { carryPositionLegId } from "../src/execution/carry-positions.js";
import { authenticateCarryCreationOpportunity } from "../src/execution/carry-opportunity-authentication.js";
import { observeCarryShadowQualification } from "../src/execution/carry-shadow-qualification.js";
import {
  carryAccountStateCommitment,
  storeCarryExecutionReadiness,
} from "../src/execution/carry-readiness.js";
import { storeCarryTransferRouteEvidence } from "../src/execution/carry-transfer-routes.js";
import { carryShadowFixture } from "./carry-shadow-fixture.js";
import { finalizeCarryLifecycleEventRecord } from "../src/state/private-state.js";
import {
  CARRY_EXECUTION_VENUES,
  cashflowValuationEvidenceMessage,
  carryRiskMandateMessage,
  normalizeCashflowValuation,
  normalizeCarryRiskMandateAuthorization,
  normalizeCarryRiskMandatePayload,
  venueAdapterCapability,
} from "@ghola/execution-core";
import { hashMessage } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { carryOpportunityInputEvidence } from "./carry-mandate-fixture.js";
import { createWorkerState } from "../src/state/private-state.js";

const NOW = 1_800_000_010_000;
const IMAGE = `sha256:${"ab".repeat(32)}`;
const OWNER = "owner:carry:release:0001";
const MANDATE_OWNER = privateKeyToAccount(`0x${"33".repeat(32)}`);

test("derives release material only from a completed durable lifecycle", async () => {
  const fixture = await stateFixture();
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
  assert.equal(result.material.monitoring.observation_count, 2);
  assert.equal(result.material.monitoring.supervision.mode, "attested_worker_loop");
  assert.equal(result.material.monitoring.supervision.automatic_observation_count, 2);
  assert.equal(result.material.monitoring.supervision.max_observation_gap_ms, 1_000);
  assert.equal(result.material.monitoring.supervision.failure_count, 0);
  assert.deepEqual(
    result.material.monitoring.funding_observations.map((item) => item.evidence_commitment),
    [`carry:funding:current:${"11".repeat(32)}`, `carry:funding:current:${"22".repeat(32)}`],
  );
  assert.equal(result.material.exit.reason, "manual");
  assert.equal(result.material.exit.trigger.kind, "owner_request");
  assert.equal(result.material.exit.trigger.observed_at, "2027-01-15T08:00:03.000Z");
  assert.equal(result.material.monitoring.margin_runways[0].status, "healthy");
  assert.deepEqual(result.material.monitoring.margin_runways.map((runway) => ({
    venue_id: runway.venue_id,
    checked_at: runway.checked_at,
    account_state_checked_at_ms: runway.account_state_checked_at_ms,
    account_commitment: runway.account_commitment,
    position_count: runway.position_count,
    open_order_count: runway.open_order_count,
    flat_zero_orders: runway.flat_zero_orders,
    position_open: runway.position_open,
    liquidation_distance_bps: runway.liquidation_distance_bps,
    minimum_liquidation_distance_bps: runway.minimum_liquidation_distance_bps,
    liquidation_distance_verified: runway.liquidation_distance_verified,
    liquidation_distance_source: runway.liquidation_distance_source,
  })), [
    {
      venue_id: "hyperliquid",
      checked_at: "2027-01-15T08:00:02.500Z",
      account_state_checked_at_ms: 1_800_000_002_500,
      account_commitment: "account:hyperliquid:release:0001",
      position_count: 1,
      open_order_count: 0,
      flat_zero_orders: false,
      position_open: true,
      liquidation_distance_bps: 2_400,
      minimum_liquidation_distance_bps: 1_000,
      liquidation_distance_verified: true,
      liquidation_distance_source: "hyperliquid_clearinghouse_state_asset_positions_v1",
    },
    {
      venue_id: "aster",
      checked_at: "2027-01-15T08:00:02.500Z",
      account_state_checked_at_ms: 1_800_000_002_500,
      account_commitment: "account:aster:release:0001",
      position_count: 1,
      open_order_count: 0,
      flat_zero_orders: false,
      position_open: true,
      liquidation_distance_bps: 2_100,
      minimum_liquidation_distance_bps: 1_000,
      liquidation_distance_verified: true,
      liquidation_distance_source: "aster_fapi_v3_position_risk_v1",
    },
  ]);
  assert.equal(result.material.monitoring.margin_runways.every((runway) =>
    /^carry:account-state:[0-9a-f]{40}$/.test(runway.account_state_commitment)
    && /^verification:carry:monitor:/.test(runway.verification_commitment)), true);
  assert.equal(result.material.contract_equivalence.index_price_divergence_bps, 3);
  assert.equal(result.material.creation_input_evidence.verified, true);
  assert.equal(
    result.material.creation_input_evidence.opportunity_evidence_commitment,
    fixture.record.position.opportunity_evidence_commitment,
  );
  assert.deepEqual(
    result.material.creation_input_evidence.legs.map((leg) => [leg.venue_id, leg.side]),
    [["hyperliquid", "buy"], ["aster", "sell"]],
  );
  assert.match(result.material.creation_input_evidence.evidence_commitment, /^carry:creation-inputs:[0-9a-f]{64}$/);
  assert.equal(result.material.shadow_qualification.proven, true);
  assert.equal(result.material.shadow_qualification.completed_samples, 3);
  assert.equal(result.material.execution_readiness.ready, true);
  assert.deepEqual(result.material.execution_readiness.registry_venue_ids, [...CARRY_EXECUTION_VENUES]);
  assert.equal(result.material.execution_readiness.recovery_ready, true);
  assert.equal(result.material.execution_readiness.venues.length, 3);
  assert.equal(result.material.execution_readiness.venues.every((venue) =>
    venue.position_count === 0
    && venue.liquidation_distance_bps === null
    && venue.liquidation_distance_verified === false
    && venue.liquidation_distance_source === null), true);
  assert.equal(result.material.collateral_route_readiness.complete_directed_coverage, true);
  assert.equal(result.material.collateral_route_readiness.available_route_count, 6);
  assert.equal(result.material.final_state.open_order_count, 0);
  assert.equal(result.material.final_state.owner_commitment, OWNER);
  assert.equal(result.material.final_state.carry_position_id, fixture.record.position.position_id);
  assert.deepEqual(result.material.entry.legs.map((item) => item.funding_micro_usdc), [60, -10]);
  assert.deepEqual(result.material.exit.legs.map((item) => item.funding_micro_usdc), [0, 0]);
  assert.deepEqual(result.material.entry.legs.map((item) => item.account_commitment), [
    "account:hyperliquid:release:0001",
    "account:aster:release:0001",
  ]);
  assert.deepEqual(result.material.exit.legs.map((item) => item.account_commitment), [
    "account:hyperliquid:release:0001",
    "account:aster:release:0001",
  ]);
  assert.deepEqual(result.material.final_state.venues.map((item) => ({
    venue_id: item.venue_id,
    authorized: item.authorized,
    flat_zero_orders: item.flat_zero_orders,
    nonzero_position_count: item.nonzero_position_count,
    open_order_count: item.open_order_count,
  })), [
    { venue_id: "hyperliquid", authorized: true, flat_zero_orders: true, nonzero_position_count: 0, open_order_count: 0 },
    { venue_id: "aster", authorized: true, flat_zero_orders: true, nonzero_position_count: 0, open_order_count: 0 },
  ]);
  assert.equal(result.material.value_ledger.realized.contract_pnl_micro_usdc, 10);
  assert.equal(result.material.value_ledger.realized.execution_slippage_micro_usdc, 5);
  assert.equal(result.material.value_ledger.realized.slippage_reversal_micro_usdc, 5);
  assert.equal(result.material.value_ledger.realized.slippage_micro_usdc, 0);
  assert.equal(result.material.value_ledger.realized.settlement_adjustment_micro_usdc, 15);
  assert.deepEqual(result.material.value_ledger.realized.pnl_components.map((component) => ({
    venue_id: component.venue_id,
    source_asset: component.source_asset,
    source_amount_micro: component.source_amount_micro,
    converted_amount_micro_usdc: component.converted_amount_micro_usdc,
  })), [
    { venue_id: "hyperliquid", source_asset: "USDC", source_amount_micro: 6, converted_amount_micro_usdc: 6 },
    { venue_id: "aster", source_asset: "USDT", source_amount_micro: 5, converted_amount_micro_usdc: 4 },
  ]);
  assert.deepEqual(result.material.value_ledger.realized.execution_bindings.map((binding) => ({
    venue_id: binding.venue_id,
    pnl_settlement_asset: binding.pnl_settlement_asset,
    source_amount_micro: binding.source_amount_micro,
  })), [
    { venue_id: "hyperliquid", pnl_settlement_asset: "USDC", source_amount_micro: 6 },
    { venue_id: "aster", pnl_settlement_asset: "USDT", source_amount_micro: 5 },
  ]);
  assert.match(result.material.value_ledger.realized.settlement_evidence_commitment, /^carry:settlement:evidence:[0-9a-f]{64}$/);
  assert.equal(result.material.value_ledger.realized.net_value_micro_usdc, 39);
  assert.match(result.material.worker_material_commitment, /^carry:release:material:[0-9a-f]{64}$/);
});

test("release accepts complete terminal partial-fill evidence without requiring full fill", async () => {
  const fixture = await stateFixture();
  for (const [workOrder, stored] of Object.entries(fixture.receipts)) {
    if (workOrder.includes(":entry:")) stored.receipt.final_proof.final_fill_proven = false;
  }
  const result = await buildCompletedCarryReleaseMaterial({
    state: fixture.state,
    owner_commitment: OWNER,
    position_id: fixture.record.position.position_id,
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
    now_ms: NOW,
  });
  assert.equal(result.ok, true, result.error);
});

test("release rejects terminal-looking fills when the target fill set is incomplete", async () => {
  const fixture = await stateFixture();
  fixture.receipts["work:carry:entry:aster"].receipt.final_proof.target_fill_set_complete = false;
  const result = await buildCompletedCarryReleaseMaterial({
    state: fixture.state,
    owner_commitment: OWNER,
    position_id: fixture.record.position.position_id,
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
    now_ms: NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "carry_release_entry_terminal_proof_missing:aster");
});

test("legacy conservative exposure provenance cannot produce a REAL lifecycle proof", async () => {
  const fixture = await stateFixture();
  fixture.record.position.active_boundary_provenance = "legacy_conservative_position_creation";
  fixture.record.position.active_boundary_provenance_by_venue = {
    hyperliquid: "legacy_conservative_position_creation",
    aster: "legacy_conservative_position_creation",
  };
  const result = await buildCompletedCarryReleaseMaterial({
    state: fixture.state,
    owner_commitment: OWNER,
    position_id: fixture.record.position.position_id,
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
    now_ms: NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "carry_release_authoritative_exposure_boundary_unproven");
});

test("fails closed when settlement conversion or slippage-reversal evidence is missing or tampered", async (t) => {
  const mutations = [
    ["missing durable components", (record) => { delete record.value_evidence.realized_economics.pnl_components; }],
    ["durable converted PnL mismatch", (record) => {
      record.value_evidence.realized_economics.pnl_components[1].converted_amount_micro_usdc += 1;
    }],
    ["ledger exact-amount binding mismatch", (record) => {
      const entry = record.value_ledger.entries.find((item) => item.entry_type === "settlement_adjustment");
      entry.pnl_components[1].cashflow_valuation.bound_source_amount_micro += 1;
    }],
    ["USDC identity value changed with a recomputed commitment", (record) => {
      const entry = record.value_ledger.entries.find((item) => item.entry_type === "settlement_adjustment");
      const component = entry.pnl_components.find((item) => item.source_asset === "USDC");
      component.converted_amount_micro_usdc += 1;
      component.cashflow_valuation.bound_value_micro_usdc += 1;
      component.cashflow_valuation.evidence_message = cashflowValuationEvidenceMessage(component.cashflow_valuation);
      component.cashflow_valuation.evidence_commitment = `carry:cashflow-valuation:evidence:${createHash("sha256")
        .update(component.cashflow_valuation.evidence_message)
        .digest("hex")}`;
      entry.amount_micro_usdc += 1;
      record.value_evidence.realized_economics.pnl_components = structuredClone(entry.pnl_components);
      record.value_evidence.realized_economics.contract_pnl_micro_usdc += 1;
      record.value_evidence.realized_economics.settlement_adjustment_micro_usdc += 1;
      record.value_ledger.realized.settlement_adjustment_micro_usdc += 1;
      record.value_ledger.realized.net_value_micro_usdc += 1;
    }],
    ["ledger slippage reversal mismatch", (record) => {
      const entry = record.value_ledger.entries.find((item) => item.entry_type === "settlement_adjustment");
      entry.slippage_reversal_micro_usdc -= 1;
    }],
    ["durable settlement adjustment mismatch", (record) => {
      record.value_evidence.realized_economics.settlement_adjustment_micro_usdc += 1;
    }],
  ];
  for (const [name, mutate] of mutations) {
    await t.test(name, async () => {
      const fixture = await stateFixture();
      mutate(fixture.record);
      const result = await buildCompletedCarryReleaseMaterial({
        state: fixture.state,
        owner_commitment: OWNER,
        position_id: fixture.record.position.position_id,
        env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
        now_ms: NOW,
      });
      assert.equal(result.error, "carry_release_settlement_evidence_unproven");
    });
  }
});

test("refuses release material when durable opportunity evidence was altered", async () => {
  const fixture = await stateFixture();
  fixture.record.opportunity.horizon_ms += 1;
  const result = await buildCompletedCarryReleaseMaterial({
    state: fixture.state,
    owner_commitment: OWNER,
    position_id: fixture.record.position.position_id,
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
    now_ms: NOW,
  });
  assert.equal(result.error, "carry_release_opportunity_provenance_unproven");
});

test("binds liquidation evidence through release material commitment", async () => {
  const fixture = await stateFixture();
  const result = await buildCompletedCarryReleaseMaterial({
    state: fixture.state,
    owner_commitment: OWNER,
    position_id: fixture.record.position.position_id,
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
    now_ms: NOW,
  });
  assert.equal(result.ok, true);
  const tampered = structuredClone(result.material);
  tampered.monitoring.margin_runways[0].liquidation_distance_bps = 1;
  assert.notEqual(
    workerMaterialCommitmentForTest(tampered),
    result.material.worker_material_commitment,
  );
});

test("refuses release material without creation-time three-venue readiness", async () => {
  const fixture = await stateFixture();
  const getIdempotency = fixture.state.getIdempotency;
  fixture.state.getIdempotency = async (key) => key.startsWith("carry:readiness:")
    ? null
    : getIdempotency(key);
  const result = await buildCompletedCarryReleaseMaterial({
    state: fixture.state,
    owner_commitment: OWNER,
    position_id: fixture.record.position.position_id,
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
    now_ms: NOW,
  });
  assert.equal(result.error, "carry_release_three_venue_readiness_unproven");
});

test("refuses release material without fresh six-route collateral coverage", async () => {
  const fixture = await stateFixture();
  const getIdempotency = fixture.state.getIdempotency;
  fixture.state.getIdempotency = async (key) => key.startsWith("carry:transfer-routes:latest:")
    ? null
    : getIdempotency(key);
  const result = await buildCompletedCarryReleaseMaterial({
    state: fixture.state,
    owner_commitment: OWNER,
    position_id: fixture.record.position.position_id,
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
    now_ms: NOW,
  });
  assert.equal(result.error, "carry_release_collateral_routes_unproven");
});

test("records a durable owner- and image-bound paired lifecycle proof", async () => {
  const fixture = await stateFixture();
  const recorded = await recordCompletedCarryLifecycleProof({
    state: fixture.state,
    owner_commitment: OWNER,
    position_id: fixture.record.position.position_id,
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
    now_ms: NOW,
  });
  assert.equal(recorded.ok, true, JSON.stringify(recorded));
  assert.equal(recorded.proof.live_entry_exit_proven, true);
  assert.equal(recorded.proof.final_flat_zero_orders, true);
  assert.equal(recorded.proof.collateral_route_coverage_proven, true);
  assert.match(recorded.proof.collateral_route_evidence_commitment, /^carry:transfer-routes:evidence:/);
  assert.match(recorded.proof.creation_input_evidence_commitment, /^carry:creation-inputs:[0-9a-f]{64}$/);
  assert.match(recorded.proof.settlement_evidence_commitment, /^carry:settlement:evidence:[0-9a-f]{64}$/);
  assert.equal(recorded.proof.ambiguity_retry_count, 0);
  assert.equal(recorded.proof.first_exposure_observed_at_ms, 1_800_000_000_700);
  assert.deepEqual(recorded.proof.first_exposure_observed_at_ms_by_venue, {
    hyperliquid: 1_800_000_000_700,
    aster: 1_800_000_000_800,
  });
  assert.deepEqual(recorded.proof.exposure_boundary_provenance_by_venue, {
    hyperliquid: "authoritative_exchange_fill_time",
    aster: "authoritative_exchange_fill_time",
  });
  assert.deepEqual(recorded.proof.value_attribution, {
    modeled: {
      gross_funding_micro_usdc: 400,
      total_cost_micro_usdc: 200,
      expected_net_micro_usdc: 200,
    },
    realized: {
      contract_pnl_micro_usdc: 10,
      funding_micro_usdc: 50,
      fees_micro_usdc: 20,
      slippage_micro_usdc: 0,
      gas_micro_usdc: 0,
      capital_cost_micro_usdc: 1,
      transfer_fees_micro_usdc: 0,
      rebates_micro_usdc: 0,
      net_value_micro_usdc: 39,
    },
    realized_total_cost_micro_usdc: 21,
    variance_from_modeled_micro_usdc: -161,
  });
  assert.deepEqual(recorded.proof.venue_ids, ["hyperliquid", "aster"]);
  assert.match(recorded.proof.evidence_commitment, /^carry:lifecycle-proof:evidence:[0-9a-f]{64}$/);
  const referenceKey = carryLifecycleProofReferenceKey(
    OWNER,
    IMAGE,
    "HYPE",
    fixture.record.position.position_id,
  );
  const storedReference = (await fixture.state.getIdempotency(
    referenceKey,
  ))?.receipt;
  assert.deepEqual(storedReference.venue_ids, ["hyperliquid", "aster"]);
  assert.equal(storedReference.position_id, fixture.record.position.position_id);
  assert.equal(storedReference.proof_evidence_commitment, recorded.proof.evidence_commitment);
  assert.equal(storedReference.worker_material_commitment, recorded.proof.worker_material_commitment);
  assert.equal(storedReference.verified_at_ms, recorded.proof.verified_at_ms);
  assert.equal(storedReference.expires_at_ms, recorded.proof.expires_at_ms);
  assert.equal(
    storedReference.proof_key,
    carryLifecycleProofKey(
      OWNER,
      IMAGE,
      "HYPE",
      fixture.record.position.position_id,
      ["hyperliquid", "aster"],
    ),
  );

  const loaded = await readCompletedCarryLifecycleProof({
    state: fixture.state,
    owner_commitment: OWNER,
    asset: "HYPE",
    position_id: fixture.record.position.position_id,
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
    now_ms: NOW + 1,
  });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.proof.position_id, fixture.record.position.position_id);
  assert.equal(loaded.proof.worker_image_digest, IMAGE);
  const unscopedLoaded = await readCompletedCarryLifecycleProof({
    state: fixture.state,
    owner_commitment: OWNER,
    asset: "HYPE",
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
    now_ms: NOW + 1,
  });
  assert.equal(unscopedLoaded.ok, true, JSON.stringify(unscopedLoaded));
  assert.deepEqual(unscopedLoaded.proof, recorded.proof);
  const missingReference = await readCompletedCarryLifecycleProof({
    state: {
      ...fixture.state,
      getIdempotency: async (key) => key === referenceKey ? null : fixture.state.getIdempotency(key),
      hasIdempotencyReceipt: async () => false,
    },
    owner_commitment: OWNER,
    asset: "HYPE",
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
    now_ms: NOW + 1,
  });
  assert.equal(missingReference.error, "carry_lifecycle_proof_reference_missing");
  const legacyKey = carryLifecycleProofKey(OWNER, IMAGE, "HYPE");
  const legacyLoaded = await readCompletedCarryLifecycleProof({
    state: {
      getIdempotency: async (key) => key === legacyKey
        ? { receipt: structuredClone(recorded.proof) }
        : null,
      hasIdempotencyReceipt: async () => false,
    },
    owner_commitment: OWNER,
    asset: "HYPE",
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
    now_ms: NOW + 1,
  });
  assert.equal(legacyLoaded.ok, true, JSON.stringify(legacyLoaded));
  assert.deepEqual(legacyLoaded.proof, recorded.proof);
  const legacyPositionLoaded = await readCompletedCarryLifecycleProof({
    state: {
      getIdempotency: async (key) => key === legacyKey
        ? { receipt: structuredClone(recorded.proof) }
        : null,
    },
    owner_commitment: OWNER,
    asset: "HYPE",
    position_id: recorded.proof.position_id,
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
    now_ms: NOW + 1,
  });
  assert.equal(legacyPositionLoaded.ok, true, JSON.stringify(legacyPositionLoaded));
  assert.deepEqual(legacyPositionLoaded.proof, recorded.proof);
  assert.equal(assessCompletedCarryLifecycleProof({
    proof: loaded.proof,
    owner_commitment: OWNER,
    image_digest: IMAGE,
    asset: "BTC",
    now_ms: NOW + 1,
  }).error, "carry_lifecycle_proof_invalid");
});

test("does not reuse lifecycle proof across owners or worker images", async () => {
  const fixture = await stateFixture();
  await recordCompletedCarryLifecycleProof({
    state: fixture.state,
    owner_commitment: OWNER,
    position_id: fixture.record.position.position_id,
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
    now_ms: NOW,
  });
  const wrongOwner = await readCompletedCarryLifecycleProof({
    state: fixture.state,
    owner_commitment: "owner:carry:release:other",
    asset: "HYPE",
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
    now_ms: NOW,
  });
  const wrongImage = await readCompletedCarryLifecycleProof({
    state: fixture.state,
    owner_commitment: OWNER,
    asset: "HYPE",
    env: { PHALA_CVM_IMAGE_DIGEST: "sha256:123456abcdef" },
    now_ms: NOW,
  });
  const wrongAsset = await readCompletedCarryLifecycleProof({
    state: fixture.state,
    owner_commitment: OWNER,
    asset: "BTC",
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
    now_ms: NOW,
  });
  const wrongPosition = await readCompletedCarryLifecycleProof({
    state: fixture.state,
    owner_commitment: OWNER,
    asset: "HYPE",
    position_id: "carry:position:release:other",
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
    now_ms: NOW,
  });
  assert.equal(wrongOwner.error, "carry_lifecycle_proof_missing");
  assert.equal(wrongImage.error, "carry_lifecycle_proof_missing");
  assert.equal(wrongAsset.error, "carry_lifecycle_proof_missing");
  assert.equal(wrongPosition.error, "carry_lifecycle_proof_missing");
});

test("keeps lifecycle proof storage isolated per asset, position, and venue pair", () => {
  assert.notEqual(
    carryLifecycleProofKey(OWNER, IMAGE, "BTC", "carry:position:0001", ["hyperliquid", "aster"]),
    carryLifecycleProofKey(OWNER, IMAGE, "ETH", "carry:position:0001", ["hyperliquid", "aster"]),
  );
  assert.equal(
    carryLifecycleProofKey(OWNER, IMAGE, "hype", "carry:position:0001", ["hyperliquid", "aster"]),
    carryLifecycleProofKey(OWNER, IMAGE, "HYPE", "carry:position:0001", ["hyperliquid", "aster"]),
  );
  assert.notEqual(
    carryLifecycleProofKey(OWNER, IMAGE, "HYPE", "carry:position:0001", ["hyperliquid", "aster"]),
    carryLifecycleProofKey(OWNER, IMAGE, "HYPE", "carry:position:0002", ["lighter", "aster"]),
  );
  assert.notEqual(
    carryLifecycleProofKey(OWNER, IMAGE, "HYPE", "carry:position:0001", ["hyperliquid", "aster"]),
    carryLifecycleProofKey(OWNER, IMAGE, "HYPE", "carry:position:0001", ["hyperliquid", "lighter"]),
  );
  assert.equal(
    carryLifecycleProofReferenceKey(OWNER, IMAGE, "hype", "carry:position:0001"),
    carryLifecycleProofReferenceKey(OWNER, IMAGE, "HYPE", "carry:position:0001"),
  );
  const legacyKey = `carry:lifecycle-proof:${createHash("sha256")
    .update(`${OWNER}\0${IMAGE}\0HYPE`)
    .digest("hex")
    .slice(0, 40)}`;
  assert.equal(carryLifecycleProofKey(OWNER, IMAGE, "HYPE"), legacyKey);
});

test("atomically claims immutable lifecycle references under concurrent writes", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-carry-proof-references-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = createWorkerState(dir);
  const positions = ["carry:position:concurrent:0001", "carry:position:concurrent:0002"];
  const claims = await Promise.all(positions.map((positionId) => state.claimIdempotency(
    carryLifecycleProofReferenceKey(OWNER, IMAGE, "HYPE", positionId),
    { position_id: positionId },
  )));
  assert.deepEqual(claims.map((claim) => claim.ok), [true, true]);
  const stored = await Promise.all(positions.map((positionId) => state.getIdempotency(
    carryLifecycleProofReferenceKey(OWNER, IMAGE, "HYPE", positionId),
  )));
  assert.deepEqual(stored.map((item) => item.receipt.position_id), positions);
  const conflictKey = carryLifecycleProofReferenceKey(OWNER, IMAGE, "HYPE", "carry:position:conflict");
  const conflicts = await Promise.all([
    state.claimIdempotency(conflictKey, { venue_ids: ["hyperliquid", "aster"] }),
    state.claimIdempotency(conflictKey, { venue_ids: ["hyperliquid", "lighter"] }),
  ]);
  assert.equal(conflicts.filter((claim) => claim.ok).length, 1);
  assert.equal(conflicts.filter((claim) => !claim.ok).length, 1);
  assert.deepEqual(
    conflicts.find((claim) => !claim.ok).existing,
    conflicts.find((claim) => claim.ok).receipt,
  );
  await state.claimIdempotency("carry:test:reference-discovery", {
    kind: "ghola_carry_lifecycle_proof_reference",
    owner_commitment: OWNER,
    worker_image_digest: IMAGE,
    asset: "HYPE",
  });
  assert.equal(await state.hasIdempotencyReceipt({
    kind: "ghola_carry_lifecycle_proof_reference",
    owner_commitment: OWNER,
    worker_image_digest: IMAGE,
    asset: "HYPE",
  }), true);
  assert.equal(await state.hasIdempotencyReceipt({
    kind: "ghola_carry_lifecycle_proof_reference",
    owner_commitment: OWNER,
    worker_image_digest: IMAGE,
    asset: "BTC",
  }), false);
});

test("returns the original immutable proof on a default fresh-timestamp retry without refreshing expiry", async (t) => {
  const fixture = await stateFixture();
  const input = {
    state: fixture.state,
    owner_commitment: OWNER,
    position_id: fixture.record.position.position_id,
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
    now_ms: NOW,
  };
  const first = await recordCompletedCarryLifecycleProof(input);
  const legacyAfterFirst = structuredClone((await fixture.state.getIdempotency(
    carryLifecycleProofKey(OWNER, IMAGE, "HYPE"),
  )).receipt);
  t.mock.method(Date, "now", () => NOW + 1);
  const repeated = await recordCompletedCarryLifecycleProof({ ...input, now_ms: undefined });
  t.mock.restoreAll();
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(repeated.ok, true, JSON.stringify(repeated));
  assert.deepEqual(repeated.proof, first.proof);
  assert.deepEqual(
    (await fixture.state.getIdempotency(carryLifecycleProofKey(OWNER, IMAGE, "HYPE"))).receipt,
    legacyAfterFirst,
  );

  const proofKey = `carry:lifecycle-proof:${createHash("sha256").update([
    OWNER,
    IMAGE,
    "HYPE",
    fixture.record.position.position_id,
    "hyperliquid:aster",
  ].join("\0")).digest("hex").slice(0, 40)}`;
  assert.equal(proofKey, carryLifecycleProofKey(
    OWNER,
    IMAGE,
    "HYPE",
    fixture.record.position.position_id,
    ["hyperliquid", "aster"],
  ));
  const before = structuredClone((await fixture.state.getIdempotency(proofKey)).receipt);
  fixture.record.final_reconciliation_evidence.reconciliation_commitment =
    "carry:reconciliation:release:changed:0001";
  const divergent = await recordCompletedCarryLifecycleProof({ ...input, now_ms: NOW + 2 });
  const after = (await fixture.state.getIdempotency(proofKey)).receipt;
  assert.equal(divergent.error, "carry_lifecycle_proof_conflict");
  assert.deepEqual(after, before);
  assert.equal(after.expires_at_ms, first.proof.expires_at_ms);
  assert.deepEqual(
    (await fixture.state.getIdempotency(carryLifecycleProofKey(OWNER, IMAGE, "HYPE"))).receipt,
    legacyAfterFirst,
  );
});

test("returns one immutable proof when fresh-timestamp retries race", async () => {
  const fixture = await stateFixture();
  const base = {
    state: fixture.state,
    owner_commitment: OWNER,
    position_id: fixture.record.position.position_id,
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
  };
  const results = await Promise.all([
    recordCompletedCarryLifecycleProof({ ...base, now_ms: NOW }),
    recordCompletedCarryLifecycleProof({ ...base, now_ms: NOW + 1 }),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 2);
  assert.deepEqual(results[0].proof, results[1].proof);
  const winner = results[0].proof;
  const proofKey = `carry:lifecycle-proof:${createHash("sha256").update([
    OWNER,
    IMAGE,
    "HYPE",
    fixture.record.position.position_id,
    "hyperliquid:aster",
  ].join("\0")).digest("hex").slice(0, 40)}`;
  assert.equal(proofKey, carryLifecycleProofKey(
    OWNER,
    IMAGE,
    "HYPE",
    fixture.record.position.position_id,
    ["hyperliquid", "aster"],
  ));
  assert.deepEqual((await fixture.state.getIdempotency(proofKey)).receipt, winner);
});

test("reads and atomically migrates a real pre-reference lifecycle proof index", async () => {
  const fixture = await stateFixture();
  const recorded = await recordCompletedCarryLifecycleProof({
    state: fixture.state,
    owner_commitment: OWNER,
    position_id: fixture.record.position.position_id,
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
    now_ms: NOW,
  });
  assert.equal(recorded.ok, true, JSON.stringify(recorded));
  const proofKey = `carry:lifecycle-proof:${createHash("sha256").update([
    OWNER,
    IMAGE,
    "HYPE",
    fixture.record.position.position_id,
    "hyperliquid:aster",
  ].join("\0")).digest("hex").slice(0, 40)}`;
  assert.equal(proofKey, carryLifecycleProofKey(
    OWNER,
    IMAGE,
    "HYPE",
    fixture.record.position.position_id,
    ["hyperliquid", "aster"],
  ));
  const indexKey = carryLifecycleProofIndexKey(OWNER, IMAGE, "HYPE");
  const index = {
    version: 1,
    kind: "ghola_carry_lifecycle_proof_index",
    owner_commitment: OWNER,
    worker_image_digest: IMAGE,
    asset: "HYPE",
    entries: [{
      position_id: recorded.proof.position_id,
      venue_ids: [...recorded.proof.venue_ids],
      proof_key: proofKey,
      verified_at_ms: recorded.proof.verified_at_ms,
    }],
  };
  index.evidence_commitment = lifecycleProofIndexCommitmentForTest(index);
  const legacyRows = () => new Map([
    [proofKey, { receipt: structuredClone(recorded.proof) }],
    [indexKey, { receipt: structuredClone(index) }],
  ]);
  const preReferenceState = (rows) => ({
    getIdempotency: async (key) => structuredClone(rows.get(key) || null),
    claimIdempotency: async (key, receipt) => {
      const existing = rows.get(key)?.receipt;
      if (existing) return { ok: false, existing: structuredClone(existing) };
      rows.set(key, { receipt: structuredClone(receipt) });
      return { ok: true, receipt: structuredClone(receipt) };
    },
  });
  const unscopedRows = legacyRows();
  const unscoped = await readCompletedCarryLifecycleProof({
    state: preReferenceState(unscopedRows),
    owner_commitment: OWNER,
    asset: "HYPE",
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
    now_ms: NOW + 1,
  });
  assert.equal(unscoped.ok, true, JSON.stringify(unscoped));
  assert.deepEqual(unscoped.proof, recorded.proof);
  const unscopedMigrated = unscopedRows.get(carryLifecycleProofReferenceKey(
    OWNER,
    IMAGE,
    "HYPE",
    recorded.proof.position_id,
  ))?.receipt;
  assert.equal(unscopedMigrated.proof_key, proofKey);
  assert.equal(unscopedMigrated.proof_evidence_commitment, recorded.proof.evidence_commitment);

  const rows = legacyRows();
  const loaded = await readCompletedCarryLifecycleProof({
    state: preReferenceState(rows),
    owner_commitment: OWNER,
    asset: "HYPE",
    position_id: recorded.proof.position_id,
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
    now_ms: NOW + 1,
  });
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  assert.deepEqual(loaded.proof, recorded.proof);
  const migrated = rows.get(carryLifecycleProofReferenceKey(
    OWNER,
    IMAGE,
    "HYPE",
    recorded.proof.position_id,
  ))?.receipt;
  assert.equal(migrated.proof_key, proofKey);
  assert.equal(migrated.proof_evidence_commitment, recorded.proof.evidence_commitment);
  assert.equal(migrated.worker_material_commitment, recorded.proof.worker_material_commitment);

  const invalidRows = legacyRows();
  invalidRows.get(indexKey).receipt.evidence_commitment = `carry:lifecycle-proof-index:evidence:${"ff".repeat(32)}`;
  const invalid = await readCompletedCarryLifecycleProof({
    state: preReferenceState(invalidRows),
    owner_commitment: OWNER,
    asset: "HYPE",
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
    now_ms: NOW + 1,
  });
  assert.equal(invalid.error, "carry_lifecycle_proof_legacy_index_invalid");

  const indexedMissRows = legacyRows();
  const unindexedSingleton = structuredClone(recorded.proof);
  unindexedSingleton.position_id = "carry:position:release:unindexed:0002";
  unindexedSingleton.evidence_commitment = lifecycleProofCommitmentForTest(unindexedSingleton);
  indexedMissRows.set(carryLifecycleProofKey(OWNER, IMAGE, "HYPE"), {
    receipt: unindexedSingleton,
  });
  const indexedMiss = await readCompletedCarryLifecycleProof({
    state: preReferenceState(indexedMissRows),
    owner_commitment: OWNER,
    asset: "HYPE",
    position_id: unindexedSingleton.position_id,
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
    now_ms: NOW + 1,
  });
  assert.equal(indexedMiss.error, "carry_lifecycle_proof_missing");
});

test("reads exact 86b JSON-pair references with and without a position without overwriting them", async () => {
  const fixture = await stateFixture();
  const recorded = await recordCompletedCarryLifecycleProof({
    state: fixture.state,
    owner_commitment: OWNER,
    position_id: fixture.record.position.position_id,
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
    now_ms: NOW,
  });
  assert.equal(recorded.ok, true, JSON.stringify(recorded));
  const jsonPairProofKey = legacyJsonPairProofKeyForTest(recorded.proof);
  assert.notEqual(jsonPairProofKey, carryLifecycleProofKey(
    OWNER,
    IMAGE,
    "HYPE",
    recorded.proof.position_id,
    recorded.proof.venue_ids,
  ));
  const referenceKey = carryLifecycleProofReferenceKey(
    OWNER,
    IMAGE,
    "HYPE",
    recorded.proof.position_id,
  );
  const oldReference = {
    version: 1,
    kind: "ghola_carry_lifecycle_proof_reference",
    owner_commitment: OWNER,
    worker_image_digest: IMAGE,
    asset: "HYPE",
    position_id: recorded.proof.position_id,
    venue_ids: [...recorded.proof.venue_ids],
    proof_key: jsonPairProofKey,
  };
  oldReference.evidence_commitment = lifecycleProofReferenceCommitmentForTest(oldReference);
  const oldRows = () => new Map([
    [jsonPairProofKey, { receipt: structuredClone(recorded.proof) }],
    [referenceKey, { receipt: structuredClone(oldReference) }],
    [carryLifecycleProofKey(OWNER, IMAGE, "HYPE"), { receipt: structuredClone(recorded.proof) }],
  ]);
  const oldState = (rows) => ({
    getIdempotency: async (key) => structuredClone(rows.get(key) || null),
    hasIdempotencyReceipt: async (expected) => [...rows.values()].some(
      (stored) => Object.entries(expected).every(([key, value]) => stored?.receipt?.[key] === value),
    ),
    claimIdempotency: async () => assert.fail("86b compatibility reads must not overwrite old references"),
  });

  const positionedRows = oldRows();
  const positioned = await readCompletedCarryLifecycleProof({
    state: oldState(positionedRows),
    owner_commitment: OWNER,
    asset: "HYPE",
    position_id: recorded.proof.position_id,
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
    now_ms: NOW + 1,
  });
  assert.equal(positioned.ok, true, JSON.stringify(positioned));
  assert.deepEqual(positioned.proof, recorded.proof);
  assert.deepEqual(positionedRows.get(referenceKey).receipt, oldReference);

  const unscopedRows = oldRows();
  const unscoped = await readCompletedCarryLifecycleProof({
    state: oldState(unscopedRows),
    owner_commitment: OWNER,
    asset: "HYPE",
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
    now_ms: NOW + 1,
  });
  assert.equal(unscoped.ok, true, JSON.stringify(unscoped));
  assert.deepEqual(unscoped.proof, recorded.proof);
  assert.deepEqual(unscopedRows.get(referenceKey).receipt, oldReference);

  const mismatchedRows = oldRows();
  const mismatchedProof = structuredClone(recorded.proof);
  mismatchedProof.venue_ids.reverse();
  mismatchedProof.evidence_commitment = lifecycleProofCommitmentForTest(mismatchedProof);
  mismatchedRows.set(jsonPairProofKey, { receipt: mismatchedProof });
  const mismatched = await readCompletedCarryLifecycleProof({
    state: oldState(mismatchedRows),
    owner_commitment: OWNER,
    asset: "HYPE",
    position_id: recorded.proof.position_id,
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
    now_ms: NOW + 1,
  });
  assert.equal(mismatched.error, "carry_lifecycle_proof_reference_mismatch");
  const unscopedMismatchedRows = oldRows();
  unscopedMismatchedRows.set(jsonPairProofKey, { receipt: mismatchedProof });
  const unscopedMismatched = await readCompletedCarryLifecycleProof({
    state: oldState(unscopedMismatchedRows),
    owner_commitment: OWNER,
    asset: "HYPE",
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
    now_ms: NOW + 1,
  });
  assert.equal(unscopedMismatched.error, "carry_lifecycle_proof_reference_mismatch");

  const hybridRows = oldRows();
  const hybridReference = structuredClone(oldReference);
  hybridReference.proof_evidence_commitment = recorded.proof.evidence_commitment;
  hybridReference.evidence_commitment = lifecycleProofReferenceCommitmentForTest(hybridReference);
  hybridRows.set(referenceKey, { receipt: hybridReference });
  const hybrid = await readCompletedCarryLifecycleProof({
    state: oldState(hybridRows),
    owner_commitment: OWNER,
    asset: "HYPE",
    position_id: recorded.proof.position_id,
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
    now_ms: NOW + 1,
  });
  assert.equal(hybrid.error, "carry_lifecycle_proof_reference_invalid");
  const unscopedHybridRows = oldRows();
  unscopedHybridRows.set(referenceKey, { receipt: hybridReference });
  const unscopedHybrid = await readCompletedCarryLifecycleProof({
    state: oldState(unscopedHybridRows),
    owner_commitment: OWNER,
    asset: "HYPE",
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
    now_ms: NOW + 1,
  });
  assert.equal(unscopedHybrid.error, "carry_lifecycle_proof_reference_invalid");

  const redirectedRows = oldRows();
  const redirectedAlias = structuredClone(recorded.proof);
  redirectedAlias.position_id = "carry:position:redirected:0001";
  redirectedAlias.evidence_commitment = lifecycleProofCommitmentForTest(redirectedAlias);
  redirectedRows.set(carryLifecycleProofKey(OWNER, IMAGE, "HYPE"), { receipt: redirectedAlias });
  const redirected = await readCompletedCarryLifecycleProof({
    state: oldState(redirectedRows),
    owner_commitment: OWNER,
    asset: "HYPE",
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
    now_ms: NOW + 1,
  });
  assert.equal(redirected.error, "carry_lifecycle_proof_reference_mismatch");
});

test("rejects tampered current references on unscoped reads", async () => {
  const fixture = await stateFixture();
  const recorded = await recordCompletedCarryLifecycleProof({
    state: fixture.state,
    owner_commitment: OWNER,
    position_id: fixture.record.position.position_id,
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
    now_ms: NOW,
  });
  const referenceKey = carryLifecycleProofReferenceKey(
    OWNER,
    IMAGE,
    "HYPE",
    recorded.proof.position_id,
  );
  const tamperedReference = structuredClone(
    (await fixture.state.getIdempotency(referenceKey)).receipt,
  );
  tamperedReference.proof_evidence_commitment = `carry:lifecycle-proof:evidence:${"ff".repeat(32)}`;
  tamperedReference.evidence_commitment = lifecycleProofReferenceCommitmentForTest(tamperedReference);
  const result = await readCompletedCarryLifecycleProof({
    state: {
      ...fixture.state,
      getIdempotency: async (key) => key === referenceKey
        ? { receipt: structuredClone(tamperedReference) }
        : fixture.state.getIdempotency(key),
    },
    owner_commitment: OWNER,
    asset: "HYPE",
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
    now_ms: NOW + 1,
  });
  assert.equal(result.error, "carry_lifecycle_proof_reference_mismatch");
});

test("rejects a fetched proof whose venue roles differ from its immutable reference", async () => {
  const fixture = await stateFixture();
  const recorded = await recordCompletedCarryLifecycleProof({
    state: fixture.state,
    owner_commitment: OWNER,
    position_id: fixture.record.position.position_id,
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
    now_ms: NOW,
  });
  const referenceKey = carryLifecycleProofReferenceKey(
    OWNER,
    IMAGE,
    "HYPE",
    fixture.record.position.position_id,
  );
  const reference = (await fixture.state.getIdempotency(referenceKey)).receipt;
  const mismatched = structuredClone(recorded.proof);
  mismatched.venue_ids.reverse();
  mismatched.evidence_commitment = lifecycleProofCommitmentForTest(mismatched);
  const result = await readCompletedCarryLifecycleProof({
    state: {
      ...fixture.state,
      getIdempotency: async (key) => key === reference.proof_key
        ? { receipt: mismatched }
        : fixture.state.getIdempotency(key),
    },
    owner_commitment: OWNER,
    asset: "HYPE",
    position_id: fixture.record.position.position_id,
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
    now_ms: NOW + 1,
  });
  assert.equal(result.error, "carry_lifecycle_proof_reference_mismatch");
});

test("refuses to manufacture proof without a monitoring period", async () => {
  const fixture = await stateFixture();
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

test("refuses release evidence without verified margin-runway status", async () => {
  const fixture = await stateFixture();
  const latestObservation = fixture.record.lifecycle_events.filter((event) => event.type === "observation").at(-1);
  delete latestObservation.margin_runway_status_by_venue;
  const result = await buildCompletedCarryReleaseMaterial({
    state: fixture.state,
    owner_commitment: OWNER,
    position_id: fixture.record.position.position_id,
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
    now_ms: NOW,
  });
  assert.equal(result.error, "carry_release_margin_runway_evidence_missing");
});

test("refuses release evidence without raw live account-state lineage", async () => {
  const fixture = await stateFixture();
  const latestObservation = fixture.record.lifecycle_events.filter((event) => event.type === "observation").at(-1);
  delete latestObservation.account_state_evidence;
  const result = await buildCompletedCarryReleaseMaterial({
    state: fixture.state,
    owner_commitment: OWNER,
    position_id: fixture.record.position.position_id,
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
    now_ms: NOW,
  });
  assert.equal(result.error, "carry_release_margin_runway_evidence_missing");
});

test("refuses swapped venue liquidation sources even when commitments are recomputed", async () => {
  const fixture = await stateFixture();
  const latestObservation = fixture.record.lifecycle_events.filter((event) => event.type === "observation").at(-1);
  const sources = latestObservation.account_state_evidence.map((state) => state.liquidation_distance_source).reverse();
  latestObservation.account_state_evidence.forEach((state, index) => {
    state.liquidation_distance_source = sources[index];
    state.account_state_commitment = carryAccountStateCommitment(state);
    const leg = latestObservation.capital_action_plan.legs.find((item) => item.venue_id === state.venue_id);
    leg.liquidation_distance_source = state.liquidation_distance_source;
    leg.account_state_commitment = state.account_state_commitment;
  });
  const result = await buildCompletedCarryReleaseMaterial({
    state: fixture.state,
    owner_commitment: OWNER,
    position_id: fixture.record.position.position_id,
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
    now_ms: NOW,
  });
  assert.equal(result.error, "carry_release_margin_runway_liquidation_binding_invalid");
});

test("refuses swapped monitoring accounts even when account-state commitments are recomputed", async () => {
  const fixture = await stateFixture();
  const latestObservation = fixture.record.lifecycle_events.filter((event) => event.type === "observation").at(-1);
  const accounts = latestObservation.account_state_evidence.map((state) => state.account_commitment).reverse();
  latestObservation.account_state_evidence.forEach((state, index) => {
    state.account_commitment = accounts[index];
    state.account_state_commitment = carryAccountStateCommitment(state);
    const leg = latestObservation.capital_action_plan.legs.find((item) => item.venue_id === state.venue_id);
    leg.account_commitment = state.account_commitment;
    leg.account_state_commitment = state.account_state_commitment;
  });
  const result = await buildCompletedCarryReleaseMaterial({
    state: fixture.state,
    owner_commitment: OWNER,
    position_id: fixture.record.position.position_id,
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
    now_ms: NOW,
  });
  assert.equal(result.error, "carry_release_margin_runway_account_binding_invalid");
});

test("refuses detached account-state and capital-plan evidence", async () => {
  for (const [mutate, expected] of [
    [
      (observation) => {
        const state = observation.account_state_evidence[0];
        state.account_state_commitment = `carry:account-state:${"ab".repeat(20)}`;
        observation.capital_action_plan.legs[0].account_state_commitment = state.account_state_commitment;
      },
      "carry_release_margin_runway_account_state_invalid",
    ],
    [
      (observation) => { observation.capital_action_plan.position_id = "carry:position:detached:0001"; },
      "carry_release_margin_runway_plan_detached",
    ],
    [
      (observation) => { observation.account_state_evidence[0].checked_at_ms -= 1; },
      "carry_release_margin_runway_account_state_invalid",
    ],
  ]) {
    const fixture = await stateFixture();
    const latestObservation = fixture.record.lifecycle_events.filter((event) => event.type === "observation").at(-1);
    mutate(latestObservation);
    const result = await buildCompletedCarryReleaseMaterial({
      state: fixture.state,
      owner_commitment: OWNER,
      position_id: fixture.record.position.position_id,
      env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
      now_ms: NOW,
    });
    assert.equal(result.error, expected);
  }
});

test("refuses release evidence assembled from manual-only monitoring", async () => {
  const fixture = await stateFixture();
  fixture.record.lifecycle_events
    .filter((event) => event.type === "observation")
    .forEach((event) => { event.observation_source = "manual"; });
  const result = await buildCompletedCarryReleaseMaterial({
    state: fixture.state,
    owner_commitment: OWNER,
    position_id: fixture.record.position.position_id,
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
    now_ms: NOW,
  });
  assert.equal(result.error, "carry_release_supervised_monitoring_missing");
});

test("refuses a single unattended observation as a monitoring period", async () => {
  const fixture = await stateFixture();
  fixture.record.lifecycle_events = fixture.record.lifecycle_events.filter(
    (event) => event.type !== "observation" || event.recorded_at_ms === 1_800_000_002_500,
  );
  const result = await buildCompletedCarryReleaseMaterial({
    state: fixture.state,
    owner_commitment: OWNER,
    position_id: fixture.record.position.position_id,
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
    now_ms: NOW,
  });
  assert.equal(result.error, "carry_release_supervised_monitoring_insufficient");
});

test("refuses wrapper observations that reuse venue funding sources", async () => {
  const fixture = await stateFixture();
  const observations = fixture.record.lifecycle_events.filter((event) => event.type === "observation");
  observations[1].funding_observation_commitment = observations[0].funding_observation_commitment;
  observations[1].funding_source_observed_at_ms_by_venue = {
    ...observations[0].funding_source_observed_at_ms_by_venue,
  };
  const result = await buildCompletedCarryReleaseMaterial({
    state: fixture.state,
    owner_commitment: OWNER,
    position_id: fixture.record.position.position_id,
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
    now_ms: NOW,
  });
  assert.equal(result.error, "carry_release_funding_observation_reused");
});

test("refuses a lifecycle with a monitoring outage", async () => {
  const fixture = await stateFixture();
  fixture.record.lifecycle_events.splice(1, 0, {
    type: "observation_unavailable",
    recorded_at_ms: 1_800_000_002_250,
    reason: "venue_read_unavailable",
  });
  const result = await buildCompletedCarryReleaseMaterial({
    state: fixture.state,
    owner_commitment: OWNER,
    position_id: fixture.record.position.position_id,
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
    now_ms: NOW,
  });
  assert.equal(result.error, "carry_release_monitoring_failure_detected");
});

test("uses the full durable lifecycle journal after the 256-event UI tail rolls over", async () => {
  const fixture = await stateFixture();
  const observations = Array.from({ length: 300 }, (_, index) => {
    const recordedAtMs = 1_800_000_001_001 + index * 5;
    const observation = monitoringObservation(
      fixture.record.position.position_id,
      recordedAtMs,
      "aa",
      recordedAtMs - 1,
    );
    observation.funding_observation_commitment = `carry:funding:current:${index.toString(16).padStart(64, "0")}`;
    return observation;
  });
  fixture.lifecycle.events = [
    ...observations,
    { type: "manual_exit_requested", recorded_at_ms: 1_800_000_003_000 },
  ];
  const result = await buildCompletedCarryReleaseMaterial({
    state: fixture.state,
    owner_commitment: OWNER,
    position_id: fixture.record.position.position_id,
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
    now_ms: NOW,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(fixture.record.lifecycle_events.length, 256);
  assert.equal(result.material.monitoring.observation_count, 300);
});

test("rejects a pre-tail monitoring failure from the full durable lifecycle journal", async () => {
  const fixture = await stateFixture();
  const observations = Array.from({ length: 300 }, (_, index) => {
    const recordedAtMs = 1_800_000_001_010 + index * 5;
    const observation = monitoringObservation(
      fixture.record.position.position_id,
      recordedAtMs,
      "bb",
      recordedAtMs - 1,
    );
    observation.funding_observation_commitment = `carry:funding:current:${(index + 1_000).toString(16).padStart(64, "0")}`;
    return observation;
  });
  fixture.lifecycle.events = [
    { type: "observation_unavailable", recorded_at_ms: 1_800_000_001_001, reason: "venue_read_unavailable" },
    ...observations,
    { type: "manual_exit_requested", recorded_at_ms: 1_800_000_003_000 },
  ];
  const result = await buildCompletedCarryReleaseMaterial({
    state: fixture.state,
    owner_commitment: OWNER,
    position_id: fixture.record.position.position_id,
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
    now_ms: NOW,
  });
  assert.equal(fixture.record.lifecycle_events.some((event) => event.type === "observation_unavailable"), false);
  assert.equal(result.error, "carry_release_monitoring_failure_detected");
});

test("refuses a tampered durable lifecycle journal", async () => {
  const fixture = await stateFixture();
  const listLifecycleEvents = fixture.state.listCarryLifecycleEvents;
  fixture.state.listCarryLifecycleEvents = async (input) => {
    const rows = await listLifecycleEvents(input);
    return input.after_sequence === 0 && rows[0]
      ? [{ ...rows[0], event_commitment: `carry:lifecycle-event:${"0".repeat(64)}` }, ...rows.slice(1)]
      : rows;
  };
  const result = await buildCompletedCarryReleaseMaterial({
    state: fixture.state,
    owner_commitment: OWNER,
    position_id: fixture.record.position.position_id,
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
    now_ms: NOW,
  });
  assert.equal(result.error, "carry_release_lifecycle_journal_unproven");
});

test("refuses release proof for a legacy-anchored lifecycle journal", async () => {
  const fixture = await stateFixture();
  fixture.record.lifecycle_journal.origin_sequence = 4;
  const result = await buildCompletedCarryReleaseMaterial({
    state: fixture.state,
    owner_commitment: OWNER,
    position_id: fixture.record.position.position_id,
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
    now_ms: NOW,
  });
  assert.equal(result.error, "carry_release_lifecycle_journal_unproven");
});

test("refuses monitoring gaps beyond the signed freshness budget", async () => {
  const fixture = await stateFixture();
  fixture.record.position.risk_mandate.max_data_age_ms = 2_000;
  fixture.record.position.mandate_authorization = await signedMandateAuthorization(fixture.record.position);
  const observations = fixture.record.lifecycle_events.filter((event) => event.type === "observation");
  observations[0].recorded_at_ms = 1_800_000_003_500;
  observations[1].recorded_at_ms = 1_800_000_003_750;
  fixture.record.lifecycle_events.find((event) => event.type === "manual_exit_requested").recorded_at_ms = 1_800_000_004_000;
  const result = await buildCompletedCarryReleaseMaterial({
    state: fixture.state,
    owner_commitment: OWNER,
    position_id: fixture.record.position.position_id,
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
    now_ms: NOW,
  });
  assert.equal(result.error, "carry_release_monitoring_cadence_exceeded");
});

test("refuses a release without an owner request or measured mandate breach", async () => {
  const fixture = await stateFixture();
  fixture.record.lifecycle_events = fixture.record.lifecycle_events.filter(
    (event) => event.type !== "manual_exit_requested",
  );
  const result = await buildCompletedCarryReleaseMaterial({
    state: fixture.state,
    owner_commitment: OWNER,
    position_id: fixture.record.position.position_id,
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
    now_ms: NOW,
  });
  assert.equal(result.error, "carry_release_exit_trigger_unproven");
});

test("binds an automatic exit to the signed net-carry threshold", async () => {
  const fixture = await stateFixture();
  fixture.record.lifecycle_events = fixture.record.lifecycle_events.filter(
    (event) => event.type !== "manual_exit_requested",
  );
  fixture.record.lifecycle_events
    .filter((event) => event.type === "observation")
    .forEach((event) => { event.expected_net_value_bps = -1; });
  const result = await buildCompletedCarryReleaseMaterial({
    state: fixture.state,
    owner_commitment: OWNER,
    position_id: fixture.record.position.position_id,
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
    now_ms: NOW,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.material.exit.reason, "funding_flip");
  assert.equal(result.material.exit.trigger.kind, "net_carry_below_threshold");
  assert.equal(result.material.exit.trigger.observed_value, -1);
  assert.equal(result.material.exit.trigger.signed_threshold_value, 0);
  assert.equal(result.material.exit.trigger.consecutive_observation_count, 2);
});

test("refuses release evidence without bounded contract equivalence", async () => {
  const fixture = await stateFixture();
  fixture.record.opportunity_authentication_material.index_price_divergence_bps = 26;
  fixture.record.opportunity.index_price_divergence_bps = 26;
  fixture.record.opportunity_provenance = authenticateCarryCreationOpportunity({
    owner_commitment: OWNER,
    opportunity: fixture.record.opportunity_authentication_material,
  });
  fixture.record.position.opportunity_evidence_commitment = fixture.record.opportunity_provenance.evidence_commitment;
  fixture.record.position.mandate_authorization = await signedMandateAuthorization(fixture.record.position);
  const result = await buildCompletedCarryReleaseMaterial({
    state: fixture.state,
    owner_commitment: OWNER,
    position_id: fixture.record.position.position_id,
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
    now_ms: NOW,
  });
  assert.equal(result.error, "carry_release_contract_equivalence_exceeded");
});

test("refuses to claim one-submit proof without a durable attempt counter", async () => {
  const fixture = await stateFixture();
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

test("refuses to promote a lifecycle without live broadcast proof on every leg", async () => {
  const fixture = await stateFixture();
  fixture.receipts["work:carry:entry:hyperliquid"].receipt.final_proof.broadcast_performed = false;
  const result = await recordCompletedCarryLifecycleProof({
    state: fixture.state,
    owner_commitment: OWNER,
    position_id: fixture.record.position.position_id,
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
    now_ms: NOW,
  });
  assert.equal(result.error, "carry_release_entry_terminal_proof_missing:hyperliquid");
});

test("refuses aggregate-only final reconciliation evidence", async () => {
  const fixture = await stateFixture();
  delete fixture.record.final_reconciliation_evidence.venues;
  const result = await buildCompletedCarryReleaseMaterial({
    state: fixture.state,
    owner_commitment: OWNER,
    position_id: fixture.record.position.position_id,
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
    now_ms: NOW,
  });
  assert.equal(result.error, "carry_release_final_state_unproven");
});

test("refuses duplicate, mismatched, or non-flat venue final state", async () => {
  for (const mutate of [
    (venues) => { venues[1].venue_id = venues[0].venue_id; },
    (venues) => { venues[1].venue_id = "lighter"; },
    (venues) => { venues[1].position_count = 1; venues[1].flat_zero_orders = false; },
    (venues) => { venues[1].open_order_count = 1; venues[1].flat_zero_orders = false; },
    (venues) => { venues[1].account_commitment = "account:aster:wrong:0001"; },
  ]) {
    const fixture = await stateFixture();
    mutate(fixture.record.final_reconciliation_evidence.venues);
    const result = await buildCompletedCarryReleaseMaterial({
      state: fixture.state,
      owner_commitment: OWNER,
      position_id: fixture.record.position.position_id,
      env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
      now_ms: NOW,
    });
    assert.equal(result.error, "carry_release_final_state_unproven");
  }
});

test("refuses release evidence assembled from another account's execution receipt", async () => {
  const fixture = await stateFixture();
  fixture.receipts["work:carry:entry:aster"].receipt.account_commitment = "account:aster:wrong:0001";
  const result = await buildCompletedCarryReleaseMaterial({
    state: fixture.state,
    owner_commitment: OWNER,
    position_id: fixture.record.position.position_id,
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
    now_ms: NOW,
  });
  assert.equal(result.error, "carry_release_entry_account_binding_mismatch:aster");
});

test("binds settlement PnL to immutable entry and exit fill evidence", async () => {
  const fixture = await stateFixture();
  fixture.receipts["work:carry:exit:aster"].receipt.final_proof.average_fill_price = "9999.99994545";
  fixture.record.value_evidence.exit.venues.aster.average_fill_price_e8 = "999999994545";
  const result = await buildCompletedCarryReleaseMaterial({
    state: fixture.state,
    owner_commitment: OWNER,
    position_id: fixture.record.position.position_id,
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
    now_ms: NOW,
  });
  assert.equal(result.error, "carry_release_settlement_evidence_unproven");
});

function releasePnlComponents(valuedAtMs) {
  const identityMaterial = {
    version: 1,
    source_asset: "USDC",
    valuation_asset: "USDC",
    verified: true,
    bound_source_amount_micro: 6,
    bound_value_micro_usdc: 6,
    credit_rate_e8: 100_000_000,
    debit_rate_e8: 100_000_000,
    observed_at_ms: valuedAtMs,
    expires_at_ms: valuedAtMs + 30_000,
    evidence_source: "identity:usdc:v1",
  };
  const identityMessage = cashflowValuationEvidenceMessage(identityMaterial);
  const identityValuation = normalizeCashflowValuation({
    ...identityMaterial,
    evidence_message: identityMessage,
    evidence_commitment: `carry:cashflow-valuation:evidence:${createHash("sha256").update(identityMessage).digest("hex")}`,
  });
  const asterPayload = {
    venue_id: "aster",
    market: "USDCUSDT",
    book_time_ms: valuedAtMs,
    source_amount_micro: 5,
    source_amount_decimal: "0.000005",
    source_amount_scale: 6,
    bids: [{ price_e8: 120_000_000, size_micro: 1_000_000 }],
    asks: [{ price_e8: 125_000_000, size_micro: 1_000_000 }],
  };
  const asterMaterial = {
    version: 1,
    source_asset: "USDT",
    valuation_asset: "USDC",
    verified: true,
    bound_source_amount_micro: 5,
    bound_value_micro_usdc: 4,
    credit_rate_e8: 80_000_000,
    debit_rate_e8: 100_000_000,
    observed_at_ms: valuedAtMs,
    expires_at_ms: valuedAtMs + 30_000,
    evidence_source: "aster:USDCUSDT:book:v1",
  };
  const asterMessage = cashflowValuationEvidenceMessage(asterMaterial);
  const asterValuation = normalizeCashflowValuation({
    ...asterMaterial,
    evidence_message: asterMessage,
    evidence_payload: asterPayload,
    evidence_commitment: `carry:cashflow-valuation:evidence:${createHash("sha256")
      .update(stableJson({ evidence_message: asterMessage, evidence_payload: asterPayload }))
      .digest("hex")}`,
  });
  return [
    {
      venue_id: "hyperliquid",
      source_asset: "USDC",
      source_amount_micro: 6,
      source_amount_decimal: "0.000006",
      source_amount_scale: 6,
      converted_amount_micro_usdc: 6,
      valued_at_ms: valuedAtMs,
      cashflow_valuation: identityValuation,
    },
    {
      venue_id: "aster",
      source_asset: "USDT",
      source_amount_micro: 5,
      source_amount_decimal: "0.000005",
      source_amount_scale: 6,
      converted_amount_micro_usdc: 4,
      valued_at_ms: valuedAtMs,
      cashflow_valuation: asterValuation,
    },
  ];
}

async function stateFixture() {
  const positionId = "carry:position:release:0001";
  const entrySaga = saga("entry", 1_800_000_000_500, 1_800_000_001_000, false);
  const exitSaga = saga("exit", 1_800_000_003_000, 1_800_000_004_000, true);
  const settlementValuedAtMs = 1_800_000_005_000;
  const pnlComponents = releasePnlComponents(settlementValuedAtMs);
  const settlementEvidenceCommitment = `carry:value:economics:${"ef".repeat(20)}`;
  const ledgerEntries = [...entrySaga.legs, ...exitSaga.legs].flatMap((leg, index) => [
    { leg_id: leg.leg_id, entry_type: "trading_fee", direction: "debit", amount_micro_usdc: 5 },
    { leg_id: leg.leg_id, entry_type: "slippage", direction: "debit", amount_micro_usdc: index === 3 ? 2 : 1 },
  ]);
  ledgerEntries.push(
    {
      venue_id: "hyperliquid",
      leg_id: carryPositionLegId({ position_id: positionId, long_venue_id: "hyperliquid", short_venue_id: "aster" }, "hyperliquid"),
      entry_type: "funding",
      direction: "credit",
      amount_micro_usdc: 60,
    },
    {
      venue_id: "aster",
      leg_id: carryPositionLegId({ position_id: positionId, long_venue_id: "hyperliquid", short_venue_id: "aster" }, "aster"),
      entry_type: "funding",
      direction: "debit",
      amount_micro_usdc: 10,
    },
    {
      version: 1,
      entry_id: "carry:value:realized:contract-pnl",
      sequence: ledgerEntries.length + 1,
      entry_type: "settlement_adjustment",
      direction: "credit",
      amount_micro_usdc: 15,
      venue_id: null,
      leg_id: null,
      occurred_at_ms: settlementValuedAtMs,
      evidence_commitment: settlementEvidenceCommitment,
      pnl_components: structuredClone(pnlComponents),
      slippage_reversal_micro_usdc: 5,
    },
  );
  const opportunityMaterial = {
    version: 1,
    eligible: true,
    reasons: [],
    asset: "HYPE",
    long_venue_id: "hyperliquid",
    short_venue_id: "aster",
    notional_micro_usdc: 11_000_000,
    capital_committed_micro_usdc: 5_000_000,
    horizon_ms: 86_400_000,
    projected_gross_funding_micro_usdc: 400,
    projected_funding_credit_micro_usdc: 400,
    projected_funding_debit_micro_usdc: 0,
    projected_trading_fee_micro_usdc: 100,
    projected_slippage_micro_usdc: 0,
    projected_gas_micro_usdc: 0,
    projected_latency_buffer_micro_usdc: 0,
    projected_trading_cost_micro_usdc: 100,
    projected_capital_cost_micro_usdc: 50,
    risk_buffer_micro_usdc: 50,
    projected_net_value_micro_usdc: 200,
    projected_net_value_bps: 18,
    break_even_ms: 21_600_000,
    contract_data_skew_ms: 400,
    max_contract_data_skew_ms: 2_000,
    index_price_divergence_bps: 3,
    mark_price_divergence_bps: 7,
    max_index_price_divergence_bps: 25,
    max_mark_price_divergence_bps: 50,
    economic_equivalence_id: "carry:HYPE-usd-linear",
    contract_type: "linear_perp",
    long_quote_asset: "USD",
    short_quote_asset: "USDT",
    checked_at_ms: 1_800_000_000_000,
    all_venues_ready: true,
    live_creation_ready: true,
    long_margin_runway_ms: 86_400_000,
    short_margin_runway_ms: 86_400_000,
    input_evidence: carryOpportunityInputEvidence("hyperliquid", "aster"),
  };
  const opportunityProvenance = authenticateCarryCreationOpportunity({
    owner_commitment: OWNER,
    opportunity: opportunityMaterial,
  });
  const record = {
    owner_commitment: OWNER,
    lifecycle_journal: { version: 1, origin_sequence: 1 },
    entry_saga_id: entrySaga.saga_id,
    exit_saga_id: exitSaga.saga_id,
    monitoring_context: {
      venue_access: {
        hyperliquid: releaseVenueAccess("hyperliquid"),
        lighter: releaseVenueAccess("lighter"),
        aster: releaseVenueAccess("aster"),
      },
    },
    position: {
      version: 1,
      position_id: positionId,
      mandate_id: "carry:mandate:release:0001",
      asset: "HYPE",
      long_venue_id: "hyperliquid",
      short_venue_id: "aster",
      target_notional_micro_usdc: 11_000_000,
      opportunity_evidence_commitment: opportunityProvenance.evidence_commitment,
      risk_mandate: riskMandate(),
      created_at_ms: 1_800_000_000_000,
      active_observed_at_ms: 1_800_000_000_700,
      active_boundary_provenance: "authoritative_exchange_fill_time",
      active_observed_at_ms_by_venue: {
        hyperliquid: 1_800_000_000_700,
        aster: 1_800_000_000_800,
      },
      active_boundary_provenance_by_venue: {
        hyperliquid: "authoritative_exchange_fill_time",
        aster: "authoritative_exchange_fill_time",
      },
      status: "reconciled",
    },
    opportunity: structuredClone(opportunityMaterial),
    opportunity_provenance: opportunityProvenance,
    opportunity_authentication_material: structuredClone(opportunityMaterial),
    lifecycle_events: [
      monitoringObservation(positionId, 1_800_000_002_000, "11", 1_800_000_001_900),
      monitoringObservation(positionId, 1_800_000_002_500, "22", 1_800_000_002_400),
      { type: "manual_exit_requested", recorded_at_ms: 1_800_000_003_000 },
    ],
    final_reconciliation_evidence: {
      owner_commitment: OWNER,
      carry_position_id: positionId,
      account_state_checked: true,
      transaction_broadcast: false,
      gross_exposure_micro_usdc: 0,
      open_order_count: 0,
      checked_at_ms: 1_800_000_005_000,
      reconciliation_commitment: "carry:reconciliation:release:0001",
      venues: [
        { venue_id: "hyperliquid", account_commitment: "account:hyperliquid:release:0001", authorized: true, flat_zero_orders: true, position_count: 0, open_order_count: 0, account_state_checked: true },
        { venue_id: "aster", account_commitment: "account:aster:release:0001", authorized: true, flat_zero_orders: true, position_count: 0, open_order_count: 0, account_state_checked: true },
      ],
    },
    value_evidence: {
      costs_complete: true,
      entry: releaseExecutionValueEvidence(entrySaga),
      exit: releaseExecutionValueEvidence(exitSaga),
      funding: {
        exposure_boundary_observed_at_ms: 1_800_000_000_700,
        exposure_boundary_provenance: "authoritative_exchange_fill_time",
        exposure_boundary_observed_at_ms_by_venue: {
          hyperliquid: 1_800_000_000_700,
          aster: 1_800_000_000_800,
        },
        exposure_boundary_provenance_by_venue: {
          hyperliquid: "authoritative_exchange_fill_time",
          aster: "authoritative_exchange_fill_time",
        },
      },
      realized_economics: {
        status: "complete",
        contract_pnl_micro_usdc: 10,
        pnl_components: structuredClone(pnlComponents),
        slippage_reversal_micro_usdc: 5,
        settlement_adjustment_micro_usdc: 15,
        capital_cost_micro_usdc: 1,
        evidence_commitment: settlementEvidenceCommitment,
        checked_at_ms: settlementValuedAtMs,
        active_observed_at_ms: 1_800_000_000_700,
        exposure_boundary_provenance: "authoritative_exchange_fill_time",
        active_observed_at_ms_by_venue: {
          hyperliquid: 1_800_000_000_700,
          aster: 1_800_000_000_800,
        },
        exposure_boundary_provenance_by_venue: {
          hyperliquid: "authoritative_exchange_fill_time",
          aster: "authoritative_exchange_fill_time",
        },
      },
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
        funding_credit_micro_usdc: 60,
        funding_debit_micro_usdc: 10,
        trading_fee_micro_usdc: 20,
        slippage_micro_usdc: 5,
        gas_micro_usdc: 0,
        capital_cost_micro_usdc: 1,
        transfer_fee_micro_usdc: 0,
        rebate_micro_usdc: 0,
        settlement_adjustment_micro_usdc: 15,
        net_value_micro_usdc: 39,
      },
      entries: ledgerEntries,
    },
  };
  record.position.mandate_authorization = await signedMandateAuthorization(record.position);
  const receipts = Object.fromEntries([
    ...entrySaga.execution_context.legs,
    ...exitSaga.execution_context.legs,
  ].map((context, index) => {
    const venueId = context.work_order_commitment.endsWith(":aster") ? "aster" : "hyperliquid";
    const firstFillAtMs = releaseFillTiming(context.work_order_commitment);
    return [
    context.work_order_commitment,
    {
      receipt: {
        account_commitment: venueId === "aster"
          ? "account:aster:release:0001"
          : "account:hyperliquid:release:0001",
        provider_ref_commitment: `provider:carry:release:${index}`,
        result_commitment: `result:carry:release:${index}`,
        fills: [{
          size: "0.11",
          price: releaseFillPrice(context.work_order_commitment),
          executed_at_ms: firstFillAtMs,
        }],
        final_proof: {
          broadcast_performed: true,
          target_client_order_matched: true,
          final_venue_execution_proven: true,
          final_fill_proven: true,
          target_fill_set_complete: true,
          filled_base_size: "0.11",
          average_fill_price: releaseFillPrice(context.work_order_commitment),
          first_fill_at_ms: firstFillAtMs,
          last_fill_at_ms: firstFillAtMs,
          fill_times_authoritative: true,
          fill_time_provenance: venueId === "aster"
            ? "aster_fapi_v3_user_trades_time_v1"
            : "hyperliquid_user_fills_time_v1",
        },
      },
    },
  ];
  }));
  const qualification = qualificationEvidence();
  const attempts = Object.fromEntries([
    ...entrySaga.execution_context.legs,
    ...exitSaga.execution_context.legs,
  ].map((context) => [
    context.work_order_commitment,
    { submit_count: 1, ambiguity_retry_count: 0 },
  ]));
  const shadowRows = new Map();
  const shadowState = {
    getIdempotency: async (key) => shadowRows.get(key) || null,
    putIdempotency: async (key, receipt) => {
      shadowRows.set(key, { receipt: structuredClone(receipt) });
      return receipt;
    },
  };
  for (let index = 0; index < 3; index += 1) {
    const nowMs = NOW - 120_000 + index * 60_000;
    await observeCarryShadowQualification({
      state: shadowState,
      venues: carryShadowFixture(nowMs),
      now_ms: nowMs,
      env: {
        PHALA_CVM_IMAGE_DIGEST: IMAGE,
        PRIVATE_AGENT_CARRY_SHADOW_QUALIFICATION_SAMPLES: "3",
      },
    });
  }
  const lifecycle = { events: null };
  const prepareLifecycle = () => {
    const events = normalizeFixtureLifecycle(lifecycle.events || record.lifecycle_events);
    if (lifecycle.events) lifecycle.events = events;
    record.position.last_event_sequence = events.length;
    record.lifecycle_events = events.slice(-256);
    return fixtureLifecycleJournal(record.position.position_id, events);
  };
  const state = {
    getCarryPositionRecord: async () => {
      prepareLifecycle();
      return record;
    },
    listCarryLifecycleEvents: async ({ after_sequence: afterSequence = 0, limit = 1_000 } = {}) => prepareLifecycle()
      .filter((item) => item.sequence > afterSequence)
      .slice(0, limit),
    getMultiLegSaga: async (id) => id === entrySaga.saga_id ? entrySaga : exitSaga,
    getExecutionAttempt: async (key) => attempts[key] || null,
    getIdempotency: async (key) => key.startsWith("carry:qualification:aster:")
      ? { receipt: qualification }
      : shadowRows.get(key) || receipts[key] || null,
    hasIdempotencyReceipt: async (expected) => [...shadowRows.values(), ...Object.values(receipts)].some(
      (stored) => Object.entries(expected).every(([key, value]) => stored?.receipt?.[key] === value),
    ),
    putIdempotency: async (key, receipt) => {
      shadowRows.set(key, { receipt: structuredClone(receipt) });
      return receipt;
    },
    claimIdempotency: async (key, receipt) => {
      const existing = shadowRows.get(key)?.receipt;
      if (existing) return { ok: false, existing: structuredClone(existing) };
      shadowRows.set(key, { receipt: structuredClone(receipt) });
      return { ok: true, receipt: structuredClone(receipt) };
    },
  };
  const readinessRequest = {
    owner_commitment: OWNER,
    operation_class: "matrix_no_submit",
    work_order_commitment: "carry_matrix_release_0001",
    asset: record.position.asset,
    notional_usd: String(record.position.target_notional_micro_usdc / 1_000_000),
    horizon_days: "1",
    venue_access: record.monitoring_context.venue_access,
  };
  const readiness = await storeCarryExecutionReadiness({
    state,
    request: readinessRequest,
    matrix: releaseReadinessMatrix(readinessRequest, record.position.created_at_ms),
    now_ms: record.position.created_at_ms,
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
  });
  assert.equal(readiness.ok, true, JSON.stringify(readiness));
  await storeCarryTransferRouteEvidence({
    state,
    owner_commitment: OWNER,
    worker_image_digest: IMAGE,
    routes: releaseTransferRoutes(readiness.readiness),
    checked_at_ms: NOW,
    expires_at_ms: NOW + 30_000,
    now_ms: NOW,
  });
  return { state, record, attempts, receipts, lifecycle };
}

function releaseTransferRoutes(readiness) {
  const adapters = {
    hyperliquid: "hyperliquid_arbitrum_usdc_v1",
    lighter: "lighter_arbitrum_usdc_v1",
    aster: "aster_arbitrum_usdt_v1",
  };
  const collateral = { hyperliquid: "USDC", lighter: "USDC", aster: "USDT" };
  const capitalByVenue = new Map(readiness.capital_plan.map((item) => [item.venue_id, item]));
  return CARRY_EXECUTION_VENUES.flatMap((fromVenueId) => CARRY_EXECUTION_VENUES
    .filter((toVenueId) => toVenueId !== fromVenueId)
    .map((toVenueId) => {
      const conversionRequired = collateral[fromVenueId] !== collateral[toVenueId];
      return {
        version: 1,
        route_id: `carry:transfer-route:${fromVenueId}-${toVenueId}:release`,
        from_account_commitment: releaseVenueAccess(fromVenueId).account_commitment,
        from_venue_id: fromVenueId,
        to_account_commitment: releaseVenueAccess(toVenueId).account_commitment,
        to_venue_id: toVenueId,
        source_adapter_id: adapters[fromVenueId],
        destination_adapter_id: adapters[toVenueId],
        source_account_state_commitment: capitalByVenue.get(fromVenueId).account_state_commitment,
        destination_account_state_commitment: capitalByVenue.get(toVenueId).account_state_commitment,
        quote_commitment: `carry:transfer-quote:${fromVenueId}-${toVenueId}:release`,
        valuation_asset: "USD",
        source_collateral_asset: collateral[fromVenueId],
        destination_collateral_asset: collateral[toVenueId],
        conversion_required: conversionRequired,
        status: "available",
        quote_verified: true,
        all_in_fee_verified: true,
        valuation_basis_verified: true,
        conversion_quote_verified: true,
        conversion_rate_e8: conversionRequired ? 99_950_000 : 100_000_000,
        minimum_transfer_micro_usdc: 0,
        maximum_transfer_micro_usdc: 100_000_000,
        withdrawal_fee_micro_usdc: 1_000,
        deposit_fee_micro_usdc: 0,
        conversion_fee_micro_usdc: conversionRequired ? 500 : 0,
        conversion_slippage_micro_usdc: conversionRequired ? 500 : 0,
        fee_micro_usdc: conversionRequired ? 2_000 : 1_000,
        estimated_latency_ms: 60_000,
        as_of_ms: NOW,
        owner_approval_required: true,
        fund_movement_authorized: false,
        transaction_broadcast: false,
        automatic_transfer_permitted: false,
      };
    }));
}

function releaseVenueAccess(venueId) {
  return {
    account_commitment: `account:${venueId}:release:0001`,
    vault_commitment: `vault:${venueId}:release:0001`,
    policy_commitment: `policy:${venueId}:release:0001`,
  };
}

function monitoringObservation(positionId, checkedAtMs, fundingByte, fundingSourceObservedAtMs) {
  const accountStateEvidence = ["hyperliquid", "aster"].map((venueId, index) => {
    const state = {
      venue_id: venueId,
      account_commitment: releaseVenueAccess(venueId).account_commitment,
      verification_commitment: `verification:carry:monitor:${venueId}:${checkedAtMs}`,
      checked_at_ms: checkedAtMs,
      position_count: 1,
      open_order_count: 0,
      flat_zero_orders: false,
      liquidation_distance_bps: index === 0 ? 2_400 : 2_100,
      liquidation_distance_verified: true,
      liquidation_distance_source: venueAdapterCapability(venueId, "carry_execution").liquidation_distance_source,
    };
    state.account_state_commitment = carryAccountStateCommitment(state);
    return state;
  });
  return {
    type: "observation",
    observation_source: "supervised_loop",
    recorded_at_ms: checkedAtMs,
    funding_observation_commitment: `carry:funding:current:${fundingByte.repeat(32)}`,
    funding_source_observed_at_ms_by_venue: {
      hyperliquid: fundingSourceObservedAtMs,
      aster: fundingSourceObservedAtMs,
    },
    margin_runway_ms_by_venue: { hyperliquid: 86_400_000, aster: 86_400_000 },
    margin_runway_status_by_venue: { hyperliquid: "healthy", aster: "healthy" },
    account_state_evidence: accountStateEvidence,
    capital_action_plan: {
      version: 1,
      kind: "ghola_carry_capital_action_plan",
      position_id: positionId,
      asset: "HYPE",
      status: "balanced",
      recommended_action: "none",
      reasons: [],
      legs: accountStateEvidence.map((state) => ({
        venue_id: state.venue_id,
        account_commitment: state.account_commitment,
        account_state_commitment: state.account_state_commitment,
        status: "healthy",
        runway_ms: 86_400_000,
        position_open: true,
        liquidation_distance_bps: state.liquidation_distance_bps,
        minimum_liquidation_distance_bps: 1_000,
        liquidation_distance_verified: true,
        liquidation_distance_source: state.liquidation_distance_source,
      })),
      proposal_only: true,
      transaction_broadcast: false,
      automatic_transfer_permitted: false,
      checked_at_ms: checkedAtMs,
    },
  };
}

function releaseReadinessMatrix(request, checkedAtMs) {
  const venues = CARRY_EXECUTION_VENUES.map((venueId) => ({
    venue_id: venueId,
    qualification: releaseRecoveryQualification(venueId, checkedAtMs),
    account_commitment: releaseVenueAccess(venueId).account_commitment,
    transaction_broadcast: false,
    work_order_commitments: [],
    verification_commitments: [],
    account_state_commitments: [],
    checks: {
      transaction_broadcast: false,
      account_state_checked: true,
      order_request_checked: true,
    },
  }));
  const pairs = CARRY_EXECUTION_VENUES.flatMap((left, leftIndex) =>
    CARRY_EXECUTION_VENUES.slice(leftIndex + 1).map((right) => [left, right]))
    .map(([left, right], index) => {
      const pairWorkOrder = `${request.work_order_commitment}_pair_${index + 1}`;
      const legEvidence = [left, right].map((venueId) => {
        const workOrderCommitment = `${pairWorkOrder}_${venueId}`;
        const verificationCommitment = `verification:carry:release:${venueId}:${index + 1}`;
        const accountState = {
          venue_id: venueId,
          account_commitment: releaseVenueAccess(venueId).account_commitment,
          verification_commitment: verificationCommitment,
          checked_at_ms: checkedAtMs,
          position_count: 0,
          open_order_count: 0,
          flat_zero_orders: true,
          liquidation_distance_bps: null,
          liquidation_distance_verified: false,
          liquidation_distance_source: null,
        };
        accountState.account_state_commitment = carryAccountStateCommitment(accountState);
        const venue = venues.find((item) => item.venue_id === venueId);
        venue.work_order_commitments.push(workOrderCommitment);
        venue.verification_commitments.push(verificationCommitment);
        venue.account_state_commitments.push(accountState.account_state_commitment);
        return {
          venue_id: venueId,
          account_commitment: releaseVenueAccess(venueId).account_commitment,
          work_order_commitment: workOrderCommitment,
          verification_commitment: verificationCommitment,
          account_state: accountState,
          transaction_broadcast: false,
          account_state_checked: true,
          order_request_checked: true,
        };
      });
      return {
        long_venue_id: left,
        short_venue_id: right,
        work_order_commitment: pairWorkOrder,
        no_submit_ready: true,
        capital_ready: true,
        transaction_broadcast: false,
        account_readiness: [left, right].map((venueId) => ({
          venue_id: venueId,
          authorized: true,
          flat_zero_orders: true,
          position_count: 0,
          open_order_count: 0,
          liquidation_distance_bps: null,
          liquidation_distance_verified: false,
          liquidation_distance_source: null,
          account_state_checked_at_ms: checkedAtMs,
          account_state_commitment: legEvidence.find((item) => item.venue_id === venueId).account_state.account_state_commitment,
          capital_ready: true,
          available_balance_micro_usdc: 11_000_000,
          venue_minimum_margin_micro_usdc: 550_000,
          required_opening_collateral_micro_usdc: 11_000_000,
          opening_collateral_shortfall_micro_usdc: 0,
          execution_leverage: 1,
          owner_only_funding: true,
        })),
        leg_evidence: legEvidence,
      };
    });
  return { transaction_broadcast: false, venues, pairs };
}

function releaseRecoveryQualification(venueId, checkedAtMs) {
  const capability = venueAdapterCapability(venueId, "exact_quantity_recovery");
  return capability?.status === "proven"
    ? {
        proven: true,
        source: "registry_baseline",
        adapter_id: capability.adapter_id,
        image_digest: IMAGE,
      }
    : {
        proven: true,
        source: "deployment_bound_lifecycle",
        adapter_id: capability?.adapter_id,
        image_digest: IMAGE,
        verified_at_ms: checkedAtMs - 1,
        evidence_commitment: `carry:qualification:evidence:${venueId}:release`,
      };
}

async function signedMandateAuthorization(position) {
  const signedMandate = normalizeCarryRiskMandatePayload({
    version: 1,
    kind: "ghola_carry_risk_mandate",
    strategy_id: "delta_neutral_carry_v1",
    network: "mainnet",
    owner_commitment: OWNER,
    owner_wallet_address: MANDATE_OWNER.address.toLowerCase(),
    position_id: position.position_id,
    mandate_id: position.mandate_id,
    asset: position.asset,
    long_venue_id: position.long_venue_id,
    short_venue_id: position.short_venue_id,
    target_notional_micro_usdc: position.target_notional_micro_usdc,
    opportunity_evidence_commitment: position.opportunity_evidence_commitment,
    risk_mandate: position.risk_mandate,
    issued_at_ms: position.created_at_ms - 1_000,
    expires_at_ms: position.created_at_ms + 30 * 86_400_000,
  });
  const message = carryRiskMandateMessage(signedMandate);
  return normalizeCarryRiskMandateAuthorization({
    version: 1,
    signed_mandate: signedMandate,
    signature: await MANDATE_OWNER.signMessage({ message }),
    mandate_commitment: hashMessage(message),
  });
}

function riskMandate() {
  return {
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
  };
}

function saga(phase, createdAt, updatedAt, reduceOnly) {
  const venues = ["hyperliquid", "aster"];
  const legs = venues.map((venue_id, index) => ({
    leg_id: `leg:carry:${phase}:${venue_id}`,
    venue_id,
    side: phase === "entry" ? index === 0 ? "buy" : "sell" : index === 0 ? "sell" : "buy",
    ...(phase === "entry" ? {
      first_exposure_observed_at_ms: venue_id === "hyperliquid"
        ? 1_800_000_000_700
        : 1_800_000_000_800,
      exposure_boundary_provenance: "authoritative_exchange_fill_time",
    } : {}),
  }));
  const contexts = legs.map((leg) => ({
    leg_id: leg.leg_id,
    work_order_commitment: `work:carry:${phase}:${leg.venue_id}`,
    accounting_pnl_settlement_asset: leg.venue_id === "aster" ? "USDT" : "USDC",
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

function releaseFillPrice(workOrderCommitment) {
  if (workOrderCommitment === "work:carry:exit:hyperliquid") return "10000.00005455";
  if (workOrderCommitment === "work:carry:exit:aster") return "9999.99995455";
  return "10000";
}

function releaseFillTiming(workOrderCommitment) {
  if (workOrderCommitment === "work:carry:entry:hyperliquid") return 1_800_000_000_700;
  if (workOrderCommitment === "work:carry:entry:aster") return 1_800_000_000_800;
  if (workOrderCommitment === "work:carry:exit:hyperliquid") return 1_800_000_003_500;
  return 1_800_000_003_600;
}

function releaseExecutionValueEvidence(sagaValue) {
  return {
    status: "complete",
    venues: Object.fromEntries(sagaValue.execution_context.legs.map((context) => [
      context.work_order_commitment.endsWith(":aster") ? "aster" : "hyperliquid",
      {
        filled_base_e8: "11000000",
        average_fill_price_e8: context.work_order_commitment === "work:carry:exit:hyperliquid"
          ? "1000000005455"
          : context.work_order_commitment === "work:carry:exit:aster"
            ? "999999995455"
            : "1000000000000",
        side: context.instruction.order.side,
        pnl_settlement_asset: context.accounting_pnl_settlement_asset,
        evidence_commitment: `carry:value:execution:${context.work_order_commitment}`,
      },
    ])),
  };
}

function qualificationEvidence() {
  const accountCommitment = "account:aster:release:0001";
  return {
    version: 1,
    venue_id: "aster",
    owner_commitment: OWNER,
    carry_position_id: "carry:position:release:0001",
    account_commitment: accountCommitment,
    adapter_id: "aster_v1",
    image_digest: IMAGE,
    network: "mainnet",
    verified_at_ms: NOW - 1,
    no_submit: {
      account_commitment: accountCommitment,
      transaction_broadcast: false,
      account_state_checked: true,
      order_request_checked: true,
      evidence_commitment: "qualification:no-submit:aster:0001",
    },
    entry_reconciliation: {
      account_commitment: accountCommitment,
      live_order_broadcast: true,
      target_client_order_matched: true,
      final_venue_execution_proven: true,
      target_fill_set_complete: true,
      filled_base_size: "0.11",
      evidence_commitment: "qualification:entry:aster:0001",
    },
    exit_recovery: {
      account_commitment: accountCommitment,
      live_order_broadcast: true,
      reduce_only: true,
      exact_base_quantity: true,
      final_venue_execution_proven: true,
      target_fill_set_complete: true,
      account_state_checked: true,
      gross_exposure_micro_usdc: 0,
      open_order_count: 0,
      evidence_commitment: "qualification:exit:aster:0001",
    },
    submission_attempts: {
      entry: {
        work_order_commitment: "work:carry:entry:aster:release:0001",
        account_commitment: accountCommitment,
        submit_count: 1,
        ambiguity_retry_count: 0,
        evidence_commitment: "attempt:entry:aster:release:0001",
      },
      exit: {
        work_order_commitment: "work:carry:exit:aster:release:0001",
        account_commitment: accountCommitment,
        submit_count: 1,
        ambiguity_retry_count: 0,
        evidence_commitment: "attempt:exit:aster:release:0001",
      },
    },
    ambiguous_submission_retry_count: 0,
    authority_boundary_acceptable: true,
    authority_evidence_commitment: "qualification:authority:aster:0001",
  };
}

function lifecycleProofCommitmentForTest(proof) {
  const payload = { ...proof };
  delete payload.evidence_commitment;
  return `carry:lifecycle-proof:evidence:${createHash("sha256").update(stableJson(payload)).digest("hex")}`;
}

function workerMaterialCommitmentForTest(material) {
  const payload = { ...material };
  delete payload.worker_material_commitment;
  return `carry:release:material:${createHash("sha256").update(stableJson(payload)).digest("hex")}`;
}

function lifecycleProofIndexCommitmentForTest(index) {
  const payload = { ...index };
  delete payload.evidence_commitment;
  return `carry:lifecycle-proof-index:evidence:${createHash("sha256").update(stableJson(payload)).digest("hex")}`;
}

function lifecycleProofReferenceCommitmentForTest(reference) {
  const payload = { ...reference };
  delete payload.evidence_commitment;
  return `carry:lifecycle-proof-reference:evidence:${createHash("sha256").update(stableJson(payload)).digest("hex")}`;
}

function legacyJsonPairProofKeyForTest(proof) {
  return `carry:lifecycle-proof:${createHash("sha256").update([
    OWNER,
    IMAGE,
    proof.asset,
    proof.position_id,
    stableJson(proof.venue_ids),
  ].join("\0")).digest("hex").slice(0, 40)}`;
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(",")}}`;
}

function normalizeFixtureLifecycle(events) {
  return events.map((event, index) => ({
    ...event,
    version: 1,
    event_id: `carry:event:release:${index + 1}`,
    sequence: index + 1,
  }));
}

function fixtureLifecycleJournal(positionId, events) {
  let previousEventCommitment = null;
  return events.map((event) => {
    const entry = finalizeCarryLifecycleEventRecord({
      position_id: positionId,
      event,
      previous_event_commitment: previousEventCommitment,
    });
    previousEventCommitment = entry.event_commitment;
    return entry;
  });
}
