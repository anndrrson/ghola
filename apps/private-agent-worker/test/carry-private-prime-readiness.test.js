import assert from "node:assert/strict";
import test from "node:test";
import { buildCarryPrivatePrimeReadiness } from "../src/execution/carry-private-prime-readiness.js";

const NOW = 1_800_000_000_000;

test("combines five-venue shadow and three-venue no-submit evidence without overstating live proof", () => {
  const result = buildCarryPrivatePrimeReadiness({
    readiness: {
      ready: true,
      owner_commitment: "owner_commitment_0001",
      network: "mainnet",
      asset: "BTC",
      expires_at_ms: NOW + 120_000,
      registry_venue_ids: ["hyperliquid", "lighter", "aster"],
      capital_ready: true,
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
