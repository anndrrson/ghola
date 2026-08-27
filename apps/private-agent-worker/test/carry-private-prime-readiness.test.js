import assert from "node:assert/strict";
import test from "node:test";
import { buildCarryPrivatePrimeReadiness } from "../src/execution/carry-private-prime-readiness.js";

const NOW = 1_800_000_000_000;

test("combines five-venue shadow and three-venue no-submit evidence without overstating live proof", () => {
  const result = buildCarryPrivatePrimeReadiness({
    readiness: {
      ready: true,
      owner_commitment: "owner_commitment_0001",
      image_digest: "sha256:abcdef123456",
      network: "mainnet",
      asset: "BTC",
      expires_at_ms: NOW + 120_000,
      registry_venue_ids: ["hyperliquid", "lighter", "aster"],
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
  assert.match(result.evidence_commitment, /^carry:private-prime:/);
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
      image_digest: "sha256:abcdef123456",
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
      image_digest: "sha256:abcdef123456",
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
  routeEvidence.routes[0].source_account_state_commitment = "carry:account-state:hyperliquid:old";
  const result = buildCarryPrivatePrimeReadiness({
    readiness: {
      ready: true,
      capital_ready: true,
      owner_commitment: "owner_commitment_0001",
      image_digest: "sha256:abcdef123456",
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

function verifiedRouteEvidence() {
  return {
    ok: true,
    evidence: {
      owner_commitment: "owner_commitment_0001",
      worker_image_digest: "sha256:abcdef123456",
      checked_at_ms: NOW,
      expires_at_ms: NOW + 30_000,
      evidence_commitment: "carry:transfer-routes:evidence:abcdef123456",
    },
    routes: [{
      source_account_state_commitment: "carry:account-state:hyperliquid:0001",
      destination_account_state_commitment: "carry:account-state:lighter:0001",
      status: "available",
      quote_verified: true,
      all_in_fee_verified: true,
      valuation_basis_verified: true,
      owner_approval_required: true,
      fund_movement_authorized: false,
      transaction_broadcast: false,
      automatic_transfer_permitted: false,
    }],
  };
}

function capitalPlan() {
  return ["hyperliquid", "lighter", "aster"].map((venueId) => ({
    venue_id: venueId,
    account_state_commitment: `carry:account-state:${venueId}:0001`,
  }));
}
