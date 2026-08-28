import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { buildCarryPrivatePrimeReadiness } from "../src/execution/carry-private-prime-readiness.js";

const NOW = 1_800_000_000_000;
const IMAGE = `sha256:${"a".repeat(64)}`;

test("combines five-venue shadow and three-venue no-submit evidence without overstating live proof", () => {
  const result = buildCarryPrivatePrimeReadiness({
    readiness: {
      ready: true,
      owner_commitment: "owner_commitment_0001",
      image_digest: IMAGE,
      network: "mainnet",
      asset: "BTC",
      expires_at_ms: NOW + 120_000,
      registry_venue_ids: ["hyperliquid", "lighter", "aster"],
      ...recoveryReadiness(),
      capital_ready: true,
      capital_plan: capitalPlan(),
      evidence_commitment: "carry:readiness:evidence:0001",
    },
    diagnostic: { diagnostic_commitment: "carry:diagnostic:evidence:0001" },
    shadow_qualification: {
      ready: true,
      venues: 5,
      checked_at_ms: NOW,
      evidence_commitment: "carry:shadow:qualification:0001",
    },
    carry_supervision: { ready: true, status: "healthy" },
    route_observation_configured: true,
    route_evidence: verifiedRouteEvidence(),
    now_ms: NOW,
  });
  assert.equal(result.ready, true);
  assert.equal(result.proof_level, "pre_broadcast_readiness");
  assert.equal(result.live_paired_lifecycle_proven, false);
  assert.equal(result.transaction_broadcast, false);
  assert.equal(result.failure_recovery.ready, true);
  assert.deepEqual(result.failure_recovery.venue_ids, ["hyperliquid", "lighter", "aster"]);
  assert.match(result.evidence_commitment, /^carry:private-prime:/);
});

test("refuses private-prime readiness without exact three-venue recovery policy", () => {
  const result = buildCarryPrivatePrimeReadiness({
    readiness: {
      ready: true,
      owner_commitment: "owner_commitment_0001",
      image_digest: IMAGE,
      asset: "BTC",
      registry_venue_ids: ["hyperliquid", "lighter", "aster"],
      capital_ready: true,
      capital_plan: capitalPlan(),
      ...recoveryReadiness({
        recovery_policy: {
          ambiguous_submission: "retry",
          partial_fill: "exact_quantity_reduce_only",
          worker_restart: "reconcile_before_action",
        },
      }),
    },
    shadow_qualification: { ready: true, venues: 5 },
    carry_supervision: { ready: true, status: "healthy" },
    route_observation_configured: true,
    route_evidence: verifiedRouteEvidence(),
    now_ms: NOW,
  });
  assert.equal(result.ready, false);
  assert.deepEqual(result.reasons, ["three_venue_recovery_unproven"]);
  assert.equal(result.failure_recovery.ready, false);
});

test("upgrades only matching durable paired lifecycle evidence to live-proven", () => {
  const result = buildCarryPrivatePrimeReadiness({
    readiness: {
      ready: true,
      owner_commitment: "owner_commitment_0001",
      image_digest: IMAGE,
      network: "mainnet",
      asset: "BTC",
      expires_at_ms: NOW + 120_000,
      registry_venue_ids: ["hyperliquid", "lighter", "aster"],
      ...recoveryReadiness(),
      capital_ready: true,
      capital_plan: capitalPlan(),
      evidence_commitment: "carry:readiness:evidence:0001",
    },
    diagnostic: { diagnostic_commitment: "carry:diagnostic:evidence:0001" },
    shadow_qualification: {
      ready: true,
      venues: 5,
      checked_at_ms: NOW,
      evidence_commitment: "carry:shadow:qualification:0001",
    },
    carry_supervision: { ready: true, status: "healthy" },
    route_observation_configured: true,
    route_evidence: verifiedRouteEvidence(),
    lifecycle_proof: lifecycleProof(),
    now_ms: NOW,
  });
  assert.equal(result.ready, true);
  assert.equal(result.proof_level, "live_paired_lifecycle");
  assert.equal(result.live_paired_lifecycle_proven, true);
  assert.equal(result.paired_lifecycle.final_flat_zero_orders, true);
  assert.equal(result.paired_lifecycle.realized_net_value_micro_usdc, 34);
  assert.equal(result.paired_lifecycle.value_attribution.variance_from_modeled_micro_usdc, -166);
  assert.deepEqual(result.paired_lifecycle.venue_ids, ["hyperliquid", "aster"]);
});

test("never lets aggregate readiness outlive its paired lifecycle proof", () => {
  const lifecycleExpiresAt = NOW + 10_000;
  const result = buildCarryPrivatePrimeReadiness({
    readiness: {
      ready: true,
      owner_commitment: "owner_commitment_0001",
      image_digest: IMAGE,
      network: "mainnet",
      asset: "BTC",
      expires_at_ms: NOW + 120_000,
      registry_venue_ids: ["hyperliquid", "lighter", "aster"],
      ...recoveryReadiness(),
      capital_ready: true,
      capital_plan: capitalPlan(),
    },
    shadow_qualification: { ready: true, venues: 5, checked_at_ms: NOW },
    carry_supervision: { ready: true, status: "healthy" },
    route_observation_configured: true,
    route_evidence: verifiedRouteEvidence(),
    lifecycle_proof: lifecycleProof({ expires_at_ms: lifecycleExpiresAt }),
    now_ms: NOW,
  });
  assert.equal(result.proof_level, "live_paired_lifecycle");
  assert.equal(result.expires_at_ms, lifecycleExpiresAt);
});

test("keeps mismatched lifecycle evidence pre-broadcast", () => {
  const result = buildCarryPrivatePrimeReadiness({
    readiness: {
      ready: true,
      owner_commitment: "owner_commitment_0001",
      image_digest: IMAGE,
      network: "mainnet",
      asset: "BTC",
      expires_at_ms: NOW + 120_000,
      registry_venue_ids: ["hyperliquid", "lighter", "aster"],
      ...recoveryReadiness(),
      capital_ready: true,
      capital_plan: capitalPlan(),
    },
    shadow_qualification: { ready: true, venues: 5, checked_at_ms: NOW },
    carry_supervision: { ready: true, status: "healthy" },
    route_observation_configured: true,
    route_evidence: verifiedRouteEvidence(),
    lifecycle_proof: lifecycleProof({ owner_commitment: "owner_commitment_other" }),
    now_ms: NOW,
  });
  assert.equal(result.proof_level, "pre_broadcast_readiness");
  assert.equal(result.live_paired_lifecycle_proven, false);
});

test("does not promote live proof without exact realized after-cost value", () => {
  const result = buildCarryPrivatePrimeReadiness({
    readiness: {
      ready: true,
      owner_commitment: "owner_commitment_0001",
      image_digest: IMAGE,
      asset: "BTC",
      registry_venue_ids: ["hyperliquid", "lighter", "aster"],
      ...recoveryReadiness(),
    },
    lifecycle_proof: lifecycleProof({ realized_net_value_micro_usdc: null }),
    now_ms: NOW,
  });
  assert.equal(result.proof_level, "pre_broadcast_readiness");
  assert.equal(result.live_paired_lifecycle_proven, false);
  assert.equal(result.paired_lifecycle.realized_net_value_micro_usdc, null);
});

test("does not promote mathematically inconsistent value attribution", () => {
  const attribution = lifecycleValueAttribution();
  attribution.realized.fees_micro_usdc = 19;
  const result = buildCarryPrivatePrimeReadiness({
    readiness: {
      ready: true,
      owner_commitment: "owner_commitment_0001",
      image_digest: IMAGE,
      asset: "BTC",
      registry_venue_ids: ["hyperliquid", "lighter", "aster"],
      ...recoveryReadiness(),
    },
    lifecycle_proof: lifecycleProof({ value_attribution: attribution }),
    now_ms: NOW,
  });
  assert.equal(result.proof_level, "pre_broadcast_readiness");
  assert.equal(result.paired_lifecycle.value_attribution, null);
});

test("fails closed when shadow, supervision, or route evidence is missing", () => {
  const result = buildCarryPrivatePrimeReadiness({
    readiness: { ready: false },
    shadow_qualification: { ready: true, venues: 4 },
    carry_supervision: { ready: false, status: "starting" },
    route_observation_configured: false,
    now_ms: NOW,
  });
  assert.equal(result.ready, false);
  assert.deepEqual(result.reasons, [
    "three_venue_no_submit_unproven",
    "five_venue_shadow_unproven",
    "carry_supervision_unready",
    "collateral_route_observation_unavailable",
  ]);
});

test("keeps technically connected but unfunded accounts pre-broadcast blocked", () => {
  const result = buildCarryPrivatePrimeReadiness({
    readiness: {
      ready: true,
      capital_ready: false,
      owner_commitment: "owner_commitment_0001",
      image_digest: IMAGE,
      ...recoveryReadiness(),
      capital_plan: capitalPlan(),
    },
    shadow_qualification: { ready: true, venues: 5 },
    carry_supervision: { ready: true, status: "healthy" },
    route_observation_configured: true,
    route_evidence: verifiedRouteEvidence(),
    now_ms: NOW,
  });
  assert.equal(result.ready, false);
  assert.deepEqual(result.reasons, ["opening_capital_shortfall"]);
  assert.equal(result.three_venue_execution.ready, true);
  assert.equal(result.three_venue_execution.capital_ready, false);
});

test("rejects a configured route probe without fresh owner-bound route evidence", () => {
  const result = buildCarryPrivatePrimeReadiness({
    readiness: {
      ready: true,
      capital_ready: true,
      owner_commitment: "owner_commitment_0001",
      image_digest: IMAGE,
      ...recoveryReadiness(),
    },
    shadow_qualification: { ready: true, venues: 5 },
    carry_supervision: { ready: true, status: "healthy" },
    route_observation_configured: true,
    route_evidence: { ok: false, error: "carry_transfer_route_evidence_missing" },
    now_ms: NOW,
  });
  assert.equal(result.ready, false);
  assert.deepEqual(result.reasons, ["collateral_route_evidence_unverified"]);
  assert.equal(result.collateral_route_observation.configured, true);
  assert.equal(result.collateral_route_observation.verified, false);
  assert.equal(result.collateral_route_observation.available_route_count, 0);
});

test("rejects route evidence bound to an older account-state snapshot", () => {
  const routeEvidence = verifiedRouteEvidence();
  routeEvidence.evidence.routes[0].source_account_state_commitment = "carry:account-state:hyperliquid:old";
  refreshRouteEvidenceCommitment(routeEvidence.evidence);
  const result = buildCarryPrivatePrimeReadiness({
    readiness: {
      ready: true,
      capital_ready: true,
      owner_commitment: "owner_commitment_0001",
      image_digest: IMAGE,
      ...recoveryReadiness(),
      capital_plan: capitalPlan(),
    },
    shadow_qualification: { ready: true, venues: 5 },
    carry_supervision: { ready: true, status: "healthy" },
    route_observation_configured: true,
    route_evidence: routeEvidence,
    now_ms: NOW,
  });
  assert.equal(result.ready, false);
  assert.deepEqual(result.reasons, ["collateral_route_evidence_unverified"]);
});

test("rejects collateral-route evidence with a valid-looking but mismatched commitment", () => {
  const routeEvidence = verifiedRouteEvidence();
  routeEvidence.evidence.routes[0].maximum_transfer_micro_usdc -= 1;
  const result = buildCarryPrivatePrimeReadiness({
    readiness: {
      ready: true,
      capital_ready: true,
      owner_commitment: "owner_commitment_0001",
      image_digest: IMAGE,
      ...recoveryReadiness(),
      capital_plan: capitalPlan(),
    },
    shadow_qualification: { ready: true, venues: 5 },
    carry_supervision: { ready: true, status: "healthy" },
    route_observation_configured: true,
    route_evidence: routeEvidence,
    now_ms: NOW,
  });
  assert.equal(result.ready, false);
  assert.deepEqual(result.reasons, ["collateral_route_evidence_unverified"]);
  assert.equal(result.collateral_route_observation.verified, false);
});

function verifiedRouteEvidence() {
  const route = {
    version: 1,
    route_id: "carry:transfer-route:hyperliquid-lighter:0001",
    from_account_commitment: "account:hyperliquid:0001",
    from_venue_id: "hyperliquid",
    to_account_commitment: "account:lighter:0001",
    to_venue_id: "lighter",
    source_adapter_id: "hyperliquid_arbitrum_usdc_v1",
    destination_adapter_id: "lighter_arbitrum_usdc_v1",
    source_account_state_commitment: "carry:account-state:hyperliquid:0001",
    destination_account_state_commitment: "carry:account-state:lighter:0001",
    quote_commitment: "carry:transfer-quote:0001",
    valuation_asset: "USD",
    source_collateral_asset: "USDC",
    destination_collateral_asset: "USDC",
    conversion_required: false,
    status: "available",
    quote_verified: true,
    all_in_fee_verified: true,
    valuation_basis_verified: true,
    conversion_quote_verified: true,
    conversion_rate_e8: 100_000_000,
    minimum_transfer_micro_usdc: 0,
    maximum_transfer_micro_usdc: 100_000_000,
    withdrawal_fee_micro_usdc: 1_000,
    deposit_fee_micro_usdc: 0,
    conversion_fee_micro_usdc: 0,
    conversion_slippage_micro_usdc: 0,
    fee_micro_usdc: 1_000,
    estimated_latency_ms: 60_000,
    as_of_ms: NOW,
    owner_approval_required: true,
    fund_movement_authorized: false,
    transaction_broadcast: false,
    automatic_transfer_permitted: false,
  };
  const material = {
    version: 1,
    kind: "ghola_carry_transfer_route_evidence",
    owner_commitment: "owner_commitment_0001",
    worker_image_digest: IMAGE,
    routes: [route],
    checked_at_ms: NOW,
    expires_at_ms: NOW + 30_000,
    owner_approval_required: true,
    fund_movement_authorized: false,
    transaction_broadcast: false,
    automatic_transfer_permitted: false,
  };
  const evidence = {
    ...material,
    evidence_commitment: `carry:transfer-routes:evidence:${createHash("sha256")
      .update(JSON.stringify(material))
      .digest("hex")
      .slice(0, 40)}`,
  };
  return {
    ok: true,
    evidence,
    routes: evidence.routes.map((item) => ({
      ...item,
      evidence_source: "attested_worker",
      evidence_commitment: evidence.evidence_commitment,
      evidence_checked_at_ms: evidence.checked_at_ms,
      worker_image_digest: evidence.worker_image_digest,
    })),
  };
}

function refreshRouteEvidenceCommitment(evidence) {
  const { evidence_commitment: _ignored, ...material } = evidence;
  evidence.evidence_commitment = `carry:transfer-routes:evidence:${createHash("sha256")
    .update(JSON.stringify(material))
    .digest("hex")
    .slice(0, 40)}`;
}

function lifecycleProof(overrides = {}) {
  return {
    ok: true,
    proof: {
      version: 1,
      kind: "ghola_carry_live_paired_lifecycle_proof",
      network: "mainnet",
      owner_commitment: "owner_commitment_0001",
      worker_image_digest: IMAGE,
      position_id: "carry:position:live:0001",
      asset: "BTC",
      venue_ids: ["hyperliquid", "aster"],
      verified_at_ms: NOW - 1_000,
      expires_at_ms: NOW + 86_400_000,
      live_entry_exit_proven: true,
      supervised_monitoring_proven: true,
      final_flat_zero_orders: true,
      value_ledger_finalized: true,
      realized_net_value_micro_usdc: 34,
      value_attribution: lifecycleValueAttribution(),
      ambiguity_retry_count: 0,
      owner_only_funding: true,
      owner_only_transfers: true,
      owner_only_withdrawals: true,
      recording_transaction_broadcast: false,
      worker_material_commitment: `carry:release:material:${"a".repeat(64)}`,
      evidence_commitment: `carry:lifecycle-proof:evidence:${"b".repeat(64)}`,
      ...overrides,
    },
  };
}

function lifecycleValueAttribution() {
  return {
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
  };
}

function capitalPlan() {
  return ["hyperliquid", "lighter", "aster"].map((venueId) => ({
    venue_id: venueId,
    account_state_commitment: `carry:account-state:${venueId}:0001`,
  }));
}

function recoveryReadiness(overrides = {}) {
  return {
    recovery_ready: true,
    recovery_venue_ids: ["hyperliquid", "lighter", "aster"],
    recovery_policy: {
      ambiguous_submission: "freeze_reconcile_never_retry",
      partial_fill: "exact_quantity_reduce_only",
      worker_restart: "reconcile_before_action",
    },
    ...overrides,
  };
}
