import assert from "node:assert/strict";
import test from "node:test";
import {
  assessCompletedCarryLifecycleProof,
  buildCompletedCarryReleaseMaterial,
  carryLifecycleProofKey,
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
import { carryShadowFixture } from "./carry-shadow-fixture.js";
import {
  CARRY_EXECUTION_VENUES,
  carryRiskMandateMessage,
  normalizeCarryRiskMandateAuthorization,
  normalizeCarryRiskMandatePayload,
} from "@ghola/execution-core";
import { hashMessage } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const NOW = 1_800_000_010_000;
const IMAGE = "sha256:abcdef1234567890";
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
  assert.equal(result.material.exit.reason, "manual");
  assert.equal(result.material.exit.trigger.kind, "owner_request");
  assert.equal(result.material.exit.trigger.observed_at, "2027-01-15T08:00:03.000Z");
  assert.equal(result.material.monitoring.margin_runways[0].status, "healthy");
  assert.equal(result.material.contract_equivalence.index_price_divergence_bps, 3);
  assert.equal(result.material.shadow_qualification.proven, true);
  assert.equal(result.material.shadow_qualification.completed_samples, 3);
  assert.equal(result.material.execution_readiness.ready, true);
  assert.deepEqual(result.material.execution_readiness.registry_venue_ids, [...CARRY_EXECUTION_VENUES]);
  assert.equal(result.material.execution_readiness.recovery_ready, true);
  assert.equal(result.material.execution_readiness.venues.length, 3);
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
  assert.equal(result.material.value_ledger.realized.net_value_micro_usdc, 34);
  assert.match(result.material.worker_material_commitment, /^carry:release:material:[0-9a-f]{64}$/);
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
  assert.equal(recorded.proof.ambiguity_retry_count, 0);
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
      slippage_micro_usdc: 5,
      gas_micro_usdc: 0,
      capital_cost_micro_usdc: 1,
      transfer_fees_micro_usdc: 0,
      rebates_micro_usdc: 0,
      net_value_micro_usdc: 34,
    },
    realized_total_cost_micro_usdc: 26,
    variance_from_modeled_micro_usdc: -166,
  });
  assert.deepEqual(recorded.proof.venue_ids, ["hyperliquid", "aster"]);
  assert.match(recorded.proof.evidence_commitment, /^carry:lifecycle-proof:evidence:[0-9a-f]{64}$/);

  const loaded = await readCompletedCarryLifecycleProof({
    state: fixture.state,
    owner_commitment: OWNER,
    asset: "HYPE",
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
    now_ms: NOW + 1,
  });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.proof.position_id, fixture.record.position.position_id);
  assert.equal(loaded.proof.worker_image_digest, IMAGE);
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
  assert.equal(wrongOwner.error, "carry_lifecycle_proof_missing");
  assert.equal(wrongImage.error, "carry_lifecycle_proof_missing");
  assert.equal(wrongAsset.error, "carry_lifecycle_proof_missing");
});

test("keeps lifecycle proof storage isolated per asset", () => {
  assert.notEqual(
    carryLifecycleProofKey(OWNER, IMAGE, "BTC"),
    carryLifecycleProofKey(OWNER, IMAGE, "ETH"),
  );
  assert.equal(
    carryLifecycleProofKey(OWNER, IMAGE, "hype"),
    carryLifecycleProofKey(OWNER, IMAGE, "HYPE"),
  );
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

async function stateFixture() {
  const positionId = "carry:position:release:0001";
  const entrySaga = saga("entry", 1_800_000_000_500, 1_800_000_001_000, false);
  const exitSaga = saga("exit", 1_800_000_003_000, 1_800_000_004_000, true);
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
  };
  const opportunityProvenance = authenticateCarryCreationOpportunity({
    owner_commitment: OWNER,
    opportunity: opportunityMaterial,
  });
  const record = {
    owner_commitment: OWNER,
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
      status: "reconciled",
    },
    opportunity: structuredClone(opportunityMaterial),
    opportunity_provenance: opportunityProvenance,
    opportunity_authentication_material: structuredClone(opportunityMaterial),
    lifecycle_events: [
      {
        type: "observation",
        observation_source: "supervised_loop",
        recorded_at_ms: 1_800_000_002_000,
        margin_runway_ms_by_venue: { hyperliquid: 86_400_000, aster: 86_400_000 },
        margin_runway_status_by_venue: { hyperliquid: "healthy", aster: "healthy" },
      },
      {
        type: "observation",
        observation_source: "supervised_loop",
        recorded_at_ms: 1_800_000_002_500,
        margin_runway_ms_by_venue: { hyperliquid: 86_400_000, aster: 86_400_000 },
        margin_runway_status_by_venue: { hyperliquid: "healthy", aster: "healthy" },
      },
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
        funding_credit_micro_usdc: 60,
        funding_debit_micro_usdc: 10,
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
  record.position.mandate_authorization = await signedMandateAuthorization(record.position);
  const receipts = Object.fromEntries([
    ...entrySaga.execution_context.legs,
    ...exitSaga.execution_context.legs,
  ].map((context, index) => [
    context.work_order_commitment,
    {
      receipt: {
        account_commitment: context.work_order_commitment.endsWith(":aster")
          ? "account:aster:release:0001"
          : "account:hyperliquid:release:0001",
        provider_ref_commitment: `provider:carry:release:${index}`,
        result_commitment: `result:carry:release:${index}`,
        final_proof: {
          broadcast_performed: true,
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
  const state = {
    getCarryPositionRecord: async () => record,
    getMultiLegSaga: async (id) => id === entrySaga.saga_id ? entrySaga : exitSaga,
    getExecutionAttempt: async (key) => attempts[key] || null,
    getIdempotency: async (key) => key.startsWith("carry:qualification:aster:")
      ? { receipt: qualification }
      : shadowRows.get(key) || receipts[key] || null,
    putIdempotency: async (key, receipt) => {
      shadowRows.set(key, { receipt: structuredClone(receipt) });
      return receipt;
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
  return { state, record, attempts, receipts };
}

function releaseVenueAccess(venueId) {
  return {
    account_commitment: `account:${venueId}:release:0001`,
    vault_commitment: `vault:${venueId}:release:0001`,
    policy_commitment: `policy:${venueId}:release:0001`,
  };
}

function releaseReadinessMatrix(request, checkedAtMs) {
  const venues = CARRY_EXECUTION_VENUES.map((venueId) => ({
    venue_id: venueId,
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
      filled_base_size: "0.11",
      evidence_commitment: "qualification:entry:aster:0001",
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
      evidence_commitment: "qualification:exit:aster:0001",
    },
    ambiguous_submission_retry_count: 0,
    authority_boundary_acceptable: true,
    authority_evidence_commitment: "qualification:authority:aster:0001",
  };
}
