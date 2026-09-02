import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  carryLifecycleProofKey,
  carryLifecycleProofReferenceKey,
  readCompletedCarryLifecycleProofs,
} from "../src/execution/carry-release-evidence.js";
import { carrySupervisionHealth } from "../src/execution/carry-loop-supervisor.js";
import { buildCarryPrivatePrimeReadiness } from "../src/execution/carry-private-prime-readiness.js";

const NOW = 1_800_000_000_000;
const IMAGE = `sha256:${"a".repeat(64)}`;

test("combines five-venue shadow and three-venue no-submit evidence without overstating live proof", () => {
  const result = buildCarryPrivatePrimeReadiness({
    readiness: {
      ...readinessProof(),
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
    diagnostic: { diagnostic_commitment: "carry:diagnostic:evidence:0001" },
    shadow_qualification: shadowQualification(),
    carry_supervision: healthySupervision(),
    route_observation_configured: true,
    route_evidence: verifiedRouteEvidence(),
    now_ms: NOW,
  });
  assert.equal(result.ready, true);
  assert.equal(result.no_submit_ready, true);
  assert.equal(result.ready_for_live_users, false);
  assert.deepEqual(result.live_launch_blockers, ["live_paired_lifecycle_unproven"]);
  assert.equal(result.proof_level, "pre_broadcast_readiness");
  assert.equal(result.live_paired_lifecycle_proven, false);
  assert.equal(result.transaction_broadcast, false);
  assert.equal(result.failure_recovery.ready, true);
  assert.deepEqual(result.failure_recovery.venue_ids, ["hyperliquid", "lighter", "aster"]);
  assert.match(result.evidence_commitment, /^carry:private-prime:/);
});

test("refuses private-prime readiness without exact three-venue recovery policy", () => {
  const result = buildCarryPrivatePrimeReadiness({
    readiness: readinessProof({
      ...recoveryReadiness({
        recovery_policy: {
          ambiguous_submission: "retry",
          partial_fill: "exact_quantity_reduce_only",
          worker_restart: "reconcile_before_action",
        },
      }),
    }),
    shadow_qualification: shadowQualification(),
    carry_supervision: healthySupervision(),
    route_observation_configured: true,
    route_evidence: verifiedRouteEvidence(),
    now_ms: NOW,
  });
  assert.equal(result.ready, false);
  assert.deepEqual(result.reasons, ["three_venue_recovery_unproven"]);
  assert.equal(result.failure_recovery.ready, false);
});

test("upgrades only release-equivalent lifecycle coverage to live-proven", () => {
  const secondLifecycle = lifecycleProofForPair({
    venueIds: ["hyperliquid", "lighter"],
    positionId: "carry:position:live:0002",
    expiresAtMs: NOW + 3_000,
  });
  const result = buildCarryPrivatePrimeReadiness({
    readiness: {
      ...readinessProof(),
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
    diagnostic: { diagnostic_commitment: "carry:diagnostic:evidence:0001" },
    shadow_qualification: shadowQualification(),
    carry_supervision: healthySupervision(),
    route_observation_configured: true,
    route_evidence: verifiedRouteEvidence(),
    lifecycle_proof: lifecycleProof(),
    lifecycle_proofs: [secondLifecycle],
    now_ms: NOW,
  });
  assert.equal(result.ready, true);
  assert.equal(result.no_submit_ready, true);
  assert.equal(result.ready_for_live_users, true);
  assert.deepEqual(result.live_launch_blockers, []);
  assert.equal(result.proof_level, "live_paired_lifecycle");
  assert.equal(result.live_paired_lifecycle_proven, true);
  assert.equal(result.paired_lifecycle.final_flat_zero_orders, true);
  assert.equal(result.paired_lifecycle.realized_net_value_micro_usdc, 34);
  assert.match(result.paired_lifecycle.creation_input_evidence_commitment, /^carry:creation-inputs:[0-9a-f]{64}$/);
  assert.equal(result.paired_lifecycle.value_attribution.variance_from_modeled_micro_usdc, -166);
  assert.deepEqual(result.paired_lifecycle.venue_ids, ["hyperliquid", "aster"]);
  assert.deepEqual(result.paired_lifecycle.first_exposure_observed_at_ms_by_venue, {
    hyperliquid: NOW - 10_000,
    aster: NOW - 9_000,
  });
  assert.equal(result.release_equivalent_lifecycles.verified, true);
  assert.equal(result.release_equivalent_lifecycles.lifecycle_count, 2);
  assert.equal(result.release_equivalent_lifecycles.distinct_position_count, 2);
  assert.equal(result.release_equivalent_lifecycles.distinct_venue_pair_count, 2);
  assert.equal(result.release_equivalent_lifecycles.expires_at_ms, NOW + 3_000);
  assert.equal(result.expires_at_ms, NOW + 3_000);
  assert.deepEqual(result.release_equivalent_lifecycles.normalized_venue_pairs, [
    "aster:hyperliquid",
    "hyperliquid:lighter",
  ]);
});

test("counts distinct positions and venue pairs independently without duplicate inflation", () => {
  const second = lifecycleProofForPair({
    venueIds: ["hyperliquid", "lighter"],
    positionId: "carry:position:live:0002",
  });
  const third = lifecycleProofForPair({
    venueIds: ["hyperliquid", "aster"],
    positionId: "carry:position:live:0002",
  });
  const result = buildCarryPrivatePrimeReadiness({
    readiness: readinessProof(),
    shadow_qualification: shadowQualification(),
    carry_supervision: healthySupervision(),
    route_observation_configured: true,
    route_evidence: verifiedRouteEvidence(),
    lifecycle_proof: lifecycleProof(),
    lifecycle_proofs: [second, third, second],
    now_ms: NOW,
  });
  assert.equal(result.ready_for_live_users, true);
  assert.equal(result.release_equivalent_lifecycles.lifecycle_count, 3);
  assert.equal(result.release_equivalent_lifecycles.distinct_position_count, 2);
  assert.equal(result.release_equivalent_lifecycles.distinct_venue_pair_count, 2);
  assert.equal(result.release_equivalent_lifecycles.position_ids.length, 2);
});

test("aggregates only immutable persisted lifecycle proofs into live route readiness", async () => {
  const first = lifecycleProof();
  const second = lifecycleProofForPair({
    venueIds: ["hyperliquid", "lighter"],
    positionId: "carry:position:live:0002",
    expiresAtMs: NOW + 3_000,
  });
  const persisted = await readCompletedCarryLifecycleProofs({
    state: immutableLifecycleState([first, second]),
    owner_commitment: "owner_commitment_0001",
    asset: "BTC",
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
    now_ms: NOW,
  });
  assert.equal(persisted.ok, true);
  assert.equal(persisted.proof_count, 2);
  assert.equal(persisted.proofs.every((item) => item.ok === true && item.proof), true);
  const ready = buildCarryPrivatePrimeReadiness({
    readiness: readinessProof(),
    shadow_qualification: shadowQualification(),
    carry_supervision: healthySupervision(),
    route_observation_configured: true,
    route_evidence: verifiedRouteEvidence(),
    lifecycle_proof: persisted.proofs[0],
    lifecycle_proofs: persisted.proofs,
    now_ms: NOW,
  });
  assert.equal(ready.ready_for_live_users, true);

  const legacyOnlySecond = await readCompletedCarryLifecycleProofs({
    state: immutableLifecycleState([first], second),
    owner_commitment: "owner_commitment_0001",
    asset: "BTC",
    env: { PHALA_CVM_IMAGE_DIGEST: IMAGE },
    now_ms: NOW,
  });
  assert.equal(legacyOnlySecond.scanned_position_count, 2);
  assert.equal(legacyOnlySecond.proof_count, 1);
  const blocked = buildCarryPrivatePrimeReadiness({
    readiness: readinessProof(),
    shadow_qualification: shadowQualification(),
    carry_supervision: healthySupervision(),
    route_observation_configured: true,
    route_evidence: verifiedRouteEvidence(),
    lifecycle_proof: legacyOnlySecond.proofs[0],
    lifecycle_proofs: legacyOnlySecond.proofs,
    now_ms: NOW,
  });
  assert.equal(blocked.ready_for_live_users, false);
});

test("keeps one completed paired lifecycle below the live-user release threshold", () => {
  const result = buildCarryPrivatePrimeReadiness({
    readiness: readinessProof(),
    shadow_qualification: shadowQualification(),
    carry_supervision: healthySupervision(),
    route_observation_configured: true,
    route_evidence: verifiedRouteEvidence(),
    lifecycle_proof: lifecycleProof(),
    now_ms: NOW,
  });
  assert.equal(result.live_paired_lifecycle_proven, true);
  assert.equal(result.release_equivalent_lifecycles.lifecycle_count, 1);
  assert.equal(result.release_equivalent_lifecycles.distinct_position_count, 1);
  assert.equal(result.release_equivalent_lifecycles.distinct_venue_pair_count, 1);
  assert.equal(result.release_equivalent_lifecycles.verified, false);
  assert.equal(result.ready_for_live_users, false);
  assert.deepEqual(result.live_launch_blockers, ["live_release_lifecycle_coverage_unproven"]);
});

test("normalizes venue direction before counting distinct release pairs", () => {
  const result = buildCarryPrivatePrimeReadiness({
    readiness: readinessProof(),
    shadow_qualification: shadowQualification(),
    carry_supervision: healthySupervision(),
    route_observation_configured: true,
    route_evidence: verifiedRouteEvidence(),
    lifecycle_proof: lifecycleProof(),
    lifecycle_proofs: [lifecycleProofForPair({
      venueIds: ["aster", "hyperliquid"],
      positionId: "carry:position:live:0002",
    })],
    now_ms: NOW,
  });
  assert.equal(result.release_equivalent_lifecycles.lifecycle_count, 2);
  assert.equal(result.release_equivalent_lifecycles.distinct_venue_pair_count, 1);
  assert.deepEqual(result.release_equivalent_lifecycles.normalized_venue_pairs, ["aster:hyperliquid"]);
  assert.equal(result.release_equivalent_lifecycles.verified, false);
  assert.equal(result.ready_for_live_users, false);
});

test("keeps live proof blocked without exact creation-input lineage", () => {
  const result = buildCarryPrivatePrimeReadiness({
    readiness: readinessProof({ capital_ready: true }),
    shadow_qualification: shadowQualification(),
    carry_supervision: healthySupervision(),
    route_observation_configured: true,
    route_evidence: verifiedRouteEvidence(),
    lifecycle_proof: lifecycleProof({ creation_input_evidence_commitment: null }),
    now_ms: NOW,
  });
  assert.equal(result.proof_level, "pre_broadcast_readiness");
  assert.equal(result.live_paired_lifecycle_proven, false);
  assert.equal(result.paired_lifecycle.creation_input_evidence_commitment, null);
});

test("never lets aggregate readiness outlive its paired lifecycle proof", () => {
  const lifecycleExpiresAt = NOW + 4_000;
  const result = buildCarryPrivatePrimeReadiness({
    readiness: {
      ...readinessProof(),
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
    shadow_qualification: shadowQualification(),
    carry_supervision: healthySupervision(),
    route_observation_configured: true,
    route_evidence: verifiedRouteEvidence(),
    lifecycle_proof: lifecycleProof({ expires_at_ms: lifecycleExpiresAt }),
    now_ms: NOW,
  });
  assert.equal(result.proof_level, "live_paired_lifecycle");
  assert.equal(result.expires_at_ms, lifecycleExpiresAt);
});

test("never lets aggregate readiness outlive its supervision heartbeat", () => {
  const result = buildCarryPrivatePrimeReadiness({
    readiness: readinessProof(),
    shadow_qualification: shadowQualification(),
    carry_supervision: healthySupervision(),
    route_observation_configured: true,
    route_evidence: verifiedRouteEvidence(),
    now_ms: NOW,
  });
  assert.equal(result.ready, true);
  assert.equal(result.expires_at_ms, NOW + 5_000);
});

test("keeps mismatched lifecycle evidence pre-broadcast", () => {
  const result = buildCarryPrivatePrimeReadiness({
    readiness: {
      ...readinessProof(),
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
    shadow_qualification: shadowQualification(),
    carry_supervision: healthySupervision(),
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
      ...readinessProof(),
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

test("legacy global-only exposure provenance cannot promote live readiness", () => {
  const result = buildCarryPrivatePrimeReadiness({
    readiness: readinessProof({ capital_ready: true }),
    shadow_qualification: shadowQualification(),
    carry_supervision: healthySupervision(),
    route_observation_configured: true,
    route_evidence: verifiedRouteEvidence(),
    lifecycle_proof: lifecycleProof({
      first_exposure_observed_at_ms_by_venue: undefined,
      exposure_boundary_provenance_by_venue: undefined,
    }),
    now_ms: NOW,
  });
  assert.equal(result.proof_level, "pre_broadcast_readiness");
  assert.equal(result.live_paired_lifecycle_proven, false);
  assert.equal(result.paired_lifecycle.value_boundary_authoritative, false);
});

test("does not promote nonfinite finalized value as REAL", () => {
  const result = buildCarryPrivatePrimeReadiness({
    readiness: {
      ...readinessProof(),
      ...recoveryReadiness(),
      capital_ready: true,
      capital_plan: capitalPlan(),
    },
    shadow_qualification: shadowQualification(),
    carry_supervision: healthySupervision(),
    route_observation_configured: true,
    route_evidence: verifiedRouteEvidence(),
    lifecycle_proof: lifecycleProof({ realized_net_value_micro_usdc: Number.POSITIVE_INFINITY }),
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
      ...readinessProof(),
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

test("rejects lifecycle proof with a valid-looking but mismatched commitment", () => {
  const lifecycle = lifecycleProof();
  lifecycle.proof.position_id = "carry:position:live:tampered";
  const result = buildCarryPrivatePrimeReadiness({
    readiness: {
      ...readinessProof(),
      ...recoveryReadiness(),
      capital_ready: true,
      capital_plan: capitalPlan(),
    },
    shadow_qualification: shadowQualification(),
    carry_supervision: healthySupervision(),
    route_observation_configured: true,
    route_evidence: verifiedRouteEvidence(),
    lifecycle_proof: lifecycle,
    now_ms: NOW,
  });
  assert.equal(result.ready, true);
  assert.equal(result.proof_level, "pre_broadcast_readiness");
  assert.equal(result.live_paired_lifecycle_proven, false);
  assert.equal(result.paired_lifecycle.evidence_commitment, null);
});

test("fails closed when shadow, supervision, or route evidence is missing", () => {
  const result = buildCarryPrivatePrimeReadiness({
    readiness: { ...readinessProof(), ready: false },
    shadow_qualification: shadowQualification({ venues: 4 }),
    carry_supervision: unreadySupervision(),
    route_observation_configured: false,
    now_ms: NOW,
  });
  assert.equal(result.ready, false);
  assert.equal(result.ready_for_live_users, false);
  assert.deepEqual(result.live_launch_blockers, [
    "three_venue_no_submit_unproven",
    "five_venue_shadow_unproven",
    "carry_supervision_unready",
    "collateral_route_observation_unavailable",
    "live_paired_lifecycle_unproven",
  ]);
  assert.deepEqual(result.reasons, [
    "three_venue_no_submit_unproven",
    "five_venue_shadow_unproven",
    "carry_supervision_unready",
    "collateral_route_observation_unavailable",
  ]);
});

test("rejects tampered supervision health wrappers", () => {
  const supervision = structuredClone(healthySupervision());
  supervision.monitoring.run_count += 1;
  const result = buildCarryPrivatePrimeReadiness({
    readiness: {
      ...readinessProof(),
      ...recoveryReadiness(),
      capital_ready: true,
      capital_plan: capitalPlan(),
    },
    shadow_qualification: shadowQualification(),
    carry_supervision: supervision,
    route_observation_configured: true,
    route_evidence: verifiedRouteEvidence(),
    now_ms: NOW,
  });
  assert.equal(result.ready, false);
  assert.deepEqual(result.reasons, ["carry_supervision_unready"]);
  assert.equal(result.supervision.ready, false);
  assert.equal(result.supervision.evidence_commitment, null);
});

test("keeps capital-free technical readiness separate from live-entry funding", () => {
  const result = buildCarryPrivatePrimeReadiness({
    readiness: readinessProof({
      capital_ready: false,
    }),
    shadow_qualification: shadowQualification(),
    carry_supervision: healthySupervision(),
    route_observation_configured: true,
    route_evidence: verifiedRouteEvidence(),
    now_ms: NOW,
  });
  assert.equal(result.ready, true);
  assert.equal(result.no_submit_ready, true);
  assert.equal(result.ready_for_live_users, false);
  assert.deepEqual(result.reasons, ["opening_capital_shortfall"]);
  assert.deepEqual(result.live_launch_blockers, [
    "opening_capital_shortfall",
    "live_paired_lifecycle_unproven",
  ]);
  assert.equal(result.three_venue_execution.ready, true);
  assert.equal(result.three_venue_execution.capital_ready, false);
});

test("rejects a configured route probe without fresh owner-bound route evidence", () => {
  const result = buildCarryPrivatePrimeReadiness({
    readiness: {
      ...readinessProof(),
      ready: true,
      capital_ready: true,
      owner_commitment: "owner_commitment_0001",
      image_digest: IMAGE,
      ...recoveryReadiness(),
    },
    shadow_qualification: shadowQualification(),
    carry_supervision: healthySupervision(),
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

test("rejects private-prime readiness without complete directed collateral routes", () => {
  const routeEvidence = verifiedRouteEvidence();
  routeEvidence.evidence.routes.pop();
  refreshRouteEvidenceCommitment(routeEvidence.evidence);
  const result = buildCarryPrivatePrimeReadiness({
    readiness: {
      ...readinessProof(),
      capital_plan: capitalPlan(),
    },
    shadow_qualification: shadowQualification(),
    carry_supervision: healthySupervision(),
    route_observation_configured: true,
    route_evidence: routeEvidence,
    now_ms: NOW,
  });
  assert.equal(result.ready, false);
  assert.deepEqual(result.reasons, ["collateral_route_coverage_incomplete"]);
  assert.equal(result.collateral_route_observation.verified, true);
  assert.equal(result.collateral_route_observation.required_route_count, 6);
  assert.equal(result.collateral_route_observation.available_route_count, 5);
  assert.equal(result.collateral_route_observation.complete_directed_coverage, false);
});

test("rejects route evidence bound to an older account-state snapshot", () => {
  const routeEvidence = verifiedRouteEvidence();
  routeEvidence.evidence.routes[0].source_account_state_commitment = "carry:account-state:hyperliquid:old";
  refreshRouteEvidenceCommitment(routeEvidence.evidence);
  const result = buildCarryPrivatePrimeReadiness({
    readiness: {
      ...readinessProof(),
      ready: true,
      capital_ready: true,
      owner_commitment: "owner_commitment_0001",
      image_digest: IMAGE,
      ...recoveryReadiness(),
      capital_plan: capitalPlan(),
    },
    shadow_qualification: shadowQualification(),
    carry_supervision: healthySupervision(),
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
      ...readinessProof(),
      ready: true,
      capital_ready: true,
      owner_commitment: "owner_commitment_0001",
      image_digest: IMAGE,
      ...recoveryReadiness(),
      capital_plan: capitalPlan(),
    },
    shadow_qualification: shadowQualification(),
    carry_supervision: healthySupervision(),
    route_observation_configured: true,
    route_evidence: routeEvidence,
    now_ms: NOW,
  });
  assert.equal(result.ready, false);
  assert.deepEqual(result.reasons, ["collateral_route_evidence_unverified"]);
  assert.equal(result.collateral_route_observation.verified, false);
});

test("rejects stale or image-unbound five-venue qualification wrappers", () => {
  const invalidQualifications = [
    shadowQualification({ checked_at_ms: NOW - 60_001 }),
    shadowQualification({ image_digest: `sha256:${"b".repeat(64)}` }),
  ];
  for (const shadowQualificationValue of invalidQualifications) {
    const result = buildCarryPrivatePrimeReadiness({
      readiness: {
        ...readinessProof(),
        ...recoveryReadiness(),
        capital_ready: true,
        capital_plan: capitalPlan(),
      },
      shadow_qualification: shadowQualificationValue,
      carry_supervision: healthySupervision(),
      route_observation_configured: true,
      route_evidence: verifiedRouteEvidence(),
      now_ms: NOW,
    });
    assert.equal(result.ready, false);
    assert.deepEqual(result.reasons, ["five_venue_shadow_unproven"]);
    assert.equal(result.five_venue_shadow.ready, false);
    assert.equal(result.five_venue_shadow.evidence_commitment, null);
  }
});

test("rejects malformed three-venue readiness wrappers", () => {
  const result = buildCarryPrivatePrimeReadiness({
    readiness: {
      ...readinessProof(),
      ...recoveryReadiness(),
      capital_ready: true,
      capital_plan: capitalPlan(),
      evidence_commitment: "carry:readiness:evidence:valid-looking",
    },
    shadow_qualification: shadowQualification(),
    carry_supervision: healthySupervision(),
    route_observation_configured: true,
    route_evidence: verifiedRouteEvidence(),
    now_ms: NOW,
  });
  assert.equal(result.ready, false);
  assert.deepEqual(result.reasons, ["three_venue_no_submit_unproven"]);
  assert.equal(result.three_venue_execution.ready, false);
  assert.equal(result.three_venue_execution.evidence_commitment, null);
});

test("rejects tampered three-venue readiness summaries", () => {
  const readiness = readinessProof();
  readiness.notional_usd = "101";
  const result = buildCarryPrivatePrimeReadiness({
    readiness,
    shadow_qualification: shadowQualification(),
    carry_supervision: healthySupervision(),
    route_observation_configured: true,
    route_evidence: verifiedRouteEvidence(),
    now_ms: NOW,
  });
  assert.equal(result.ready, false);
  assert.deepEqual(result.reasons, ["three_venue_no_submit_unproven"]);
  assert.equal(result.three_venue_execution.readiness_commitment, null);
});

test("rejects tampered five-venue qualification summaries", () => {
  const qualification = shadowQualification();
  qualification.duration_ms += 1;
  const result = buildCarryPrivatePrimeReadiness({
    readiness: readinessProof(),
    shadow_qualification: qualification,
    carry_supervision: healthySupervision(),
    route_observation_configured: true,
    route_evidence: verifiedRouteEvidence(),
    now_ms: NOW,
  });
  assert.equal(result.ready, false);
  assert.deepEqual(result.reasons, ["five_venue_shadow_unproven"]);
  assert.equal(result.five_venue_shadow.qualification_commitment, null);
});

function readinessProof(overrides = {}) {
  const material = {
    version: 1,
    ready: true,
    reasons: [],
    owner_commitment: "owner_commitment_0001",
    image_digest: IMAGE,
    network: "mainnet",
    asset: "BTC",
    notional_usd: "100",
    horizon_days: "30",
    checked_at_ms: NOW,
    expires_at_ms: NOW + 120_000,
    registry_venue_ids: ["hyperliquid", "lighter", "aster"],
    evidence_commitment: `carry:readiness:evidence:${"b".repeat(40)}`,
    ...recoveryReadiness(),
    capital_ready: true,
    capital_plan: capitalPlan(),
    ...overrides,
  };
  material.readiness_commitment = `carry:readiness:result:${createHash("sha256")
    .update(stableJson(material))
    .digest("hex")}`;
  return material;
}

function healthySupervision() {
  const loop = (name) => ({
    health: () => ({
      name,
      status: "healthy",
      running: false,
      run_count: 1,
      consecutive_failures: 0,
      last_started_at: new Date(NOW - 1_000).toISOString(),
      last_completed_at: new Date(NOW).toISOString(),
      last_success_at: new Date(NOW).toISOString(),
      last_error_code: null,
      max_silence_ms: 60_000,
      heartbeat_deadline_at: new Date(NOW + 60_000).toISOString(),
    }),
  });
  return carrySupervisionHealth({
    monitoring: loop("carry_monitor"),
    execution: loop("carry_execution"),
    recovery: loop("multi_leg_recovery"),
    observation: loop("carry_shadow_observer"),
    checked_at_ms: NOW,
  });
}

function unreadySupervision() {
  return carrySupervisionHealth({
    monitoring: null,
    execution: null,
    recovery: null,
    observation: null,
    checked_at_ms: NOW,
  });
}

function shadowQualification(overrides = {}) {
  const material = {
    version: 1,
    kind: "carry_shadow_qualification",
    ready: true,
    release_bound: true,
    transaction_broadcast: false,
    image_digest: IMAGE,
    checked_at_ms: NOW,
    required_samples: 3,
    completed_samples: 3,
    minimum_span_ms: 120_000,
    duration_ms: 120_000,
    venues: 5,
    assets: 3,
    requested_assets: ["BTC", "ETH", "SOL"],
    expected_snapshots_per_sample: 15,
    degraded_snapshots: 0,
    sample_commitments: ["c", "d", "e"].map((value) => `carry:shadow:sample:${value.repeat(64)}`),
    source_observation_commitments: ["7", "8", "9"].map((value) => `carry:shadow:sources:${value.repeat(64)}`),
    evidence_commitment: `carry:shadow:qualification:${"f".repeat(64)}`,
    failures: [],
    ...overrides,
  };
  material.qualification_commitment = `carry:shadow:result:${createHash("sha256")
    .update(stableJson(material))
    .digest("hex")}`;
  return material;
}

function verifiedRouteEvidence() {
  const venueIds = ["hyperliquid", "lighter", "aster"];
  const adapters = {
    hyperliquid: "hyperliquid_arbitrum_usdc_v1",
    lighter: "lighter_arbitrum_usdc_v1",
    aster: "aster_arbitrum_usdt_v1",
  };
  const collateral = { hyperliquid: "USDC", lighter: "USDC", aster: "USDT" };
  const accountStateAttestations = venueIds.map((venueId) => routeAccountAttestation(venueId))
    .sort((left, right) => left.venue_id.localeCompare(right.venue_id));
  const attestationByVenue = new Map(accountStateAttestations.map((item) => [item.venue_id, item]));
  const routes = venueIds.flatMap((fromVenueId) => venueIds
    .filter((toVenueId) => toVenueId !== fromVenueId)
    .map((toVenueId) => {
      const conversionRequired = collateral[fromVenueId] !== collateral[toVenueId];
      return {
        version: 1,
        route_id: `carry:transfer-route:${fromVenueId}-${toVenueId}:0001`,
        from_account_commitment: `account:${fromVenueId}:0001`,
        from_venue_id: fromVenueId,
        to_account_commitment: `account:${toVenueId}:0001`,
        to_venue_id: toVenueId,
        source_adapter_id: adapters[fromVenueId],
        destination_adapter_id: adapters[toVenueId],
        source_account_state_commitment: `carry:account-state:${fromVenueId}:0001`,
        destination_account_state_commitment: `carry:account-state:${toVenueId}:0001`,
        source_account_state_attestation_commitment: attestationByVenue.get(fromVenueId).attestation_commitment,
        destination_account_state_attestation_commitment: attestationByVenue.get(toVenueId).attestation_commitment,
        quote_commitment: `carry:transfer-quote:${fromVenueId}-${toVenueId}:0001`,
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
    }))
    .sort((left, right) => left.route_id.localeCompare(right.route_id));
  const material = {
    version: 1,
    kind: "ghola_carry_transfer_route_evidence",
    owner_commitment: "owner_commitment_0001",
    worker_image_digest: IMAGE,
    account_state_attestations: accountStateAttestations,
    routes,
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

function routeAccountAttestation(venueId) {
  const inventory = {
    version: 1,
    target_market: "BTC",
    position_inventory_verified: true,
    open_order_inventory_verified: true,
    target_positions: [],
    target_open_orders: [],
  };
  const state = {
    venue_id: venueId,
    account_commitment: `account:${venueId}:0001`,
    position_count: 0,
    open_order_count: 0,
    flat_zero_orders: true,
    liquidation_distance_bps: null,
    liquidation_distance_verified: false,
    liquidation_distance_source: null,
    inventory,
  };
  const material = {
    version: 1,
    kind: "ghola_carry_route_account_state_attestation",
    venue_id: venueId,
    account_commitment: state.account_commitment,
    expected_account_state_commitment: `carry:account-state:${venueId}:0001`,
    observed_state_fingerprint: `carry:route-account-state:${createHash("sha256").update(stableJson(state)).digest("hex").slice(0, 40)}`,
    observed_at_ms: NOW,
    ...state,
    available_balance_micro_usdc: 100_000_000,
    margin_balance_micro_usdc: 100_000_000,
    initial_margin_micro_usdc: 0,
    maintenance_margin_micro_usdc: 0,
    withdrawal_quote: null,
    read_only: true,
    owner_approval_required: true,
    fund_movement_authorized: false,
    transaction_broadcast: false,
  };
  return {
    ...material,
    attestation_commitment: `carry:route-account-attestation:${createHash("sha256")
      .update(stableJson(material)).digest("hex").slice(0, 40)}`,
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
  const proof = {
    version: 1,
    kind: "ghola_carry_live_paired_lifecycle_proof",
    network: "mainnet",
    owner_commitment: "owner_commitment_0001",
    worker_image_digest: IMAGE,
    position_id: "carry:position:live:0001",
    asset: "BTC",
    venue_ids: ["hyperliquid", "aster"],
    account_commitments: {
      hyperliquid: "account:hyperliquid:0001",
      aster: "account:aster:0001",
    },
    verified_at_ms: NOW - 1_000,
    expires_at_ms: NOW + 86_400_000,
    live_entry_exit_proven: true,
    supervised_monitoring_proven: true,
    final_flat_zero_orders: true,
    value_ledger_finalized: true,
    value_boundary_authoritative: true,
    exposure_boundary_provenance: "authoritative_exchange_fill_time",
    first_exposure_observed_at_ms: NOW - 10_000,
    first_exposure_observed_at_ms_by_venue: {
      hyperliquid: NOW - 10_000,
      aster: NOW - 9_000,
    },
    exposure_boundary_provenance_by_venue: {
      hyperliquid: "authoritative_exchange_fill_time",
      aster: "authoritative_exchange_fill_time",
    },
    collateral_route_coverage_proven: true,
    collateral_route_evidence_commitment: `carry:transfer-routes:evidence:${"b".repeat(40)}`,
    creation_input_evidence_commitment: `carry:creation-inputs:${"c".repeat(64)}`,
    realized_net_value_micro_usdc: 34,
    settlement_evidence_commitment: `carry:settlement:evidence:${"d".repeat(64)}`,
    value_attribution: lifecycleValueAttribution(),
    ambiguity_retry_count: 0,
    owner_only_funding: true,
    owner_only_transfers: true,
    owner_only_withdrawals: true,
    recording_transaction_broadcast: false,
    worker_material_commitment: `carry:release:material:${"a".repeat(64)}`,
    ...overrides,
  };
  proof.evidence_commitment = lifecycleProofCommitment(proof);
  return {
    ok: true,
    proof,
  };
}

function lifecycleProofForPair({ venueIds, positionId, expiresAtMs = NOW + 86_400_000 }) {
  const [left, right] = venueIds;
  return lifecycleProof({
    position_id: positionId,
    expires_at_ms: expiresAtMs,
    venue_ids: venueIds,
    account_commitments: {
      [left]: `account:${left}:0001`,
      [right]: `account:${right}:0001`,
    },
    first_exposure_observed_at_ms: NOW - 10_000,
    first_exposure_observed_at_ms_by_venue: {
      [left]: NOW - 10_000,
      [right]: NOW - 9_000,
    },
    exposure_boundary_provenance_by_venue: {
      [left]: "authoritative_exchange_fill_time",
      [right]: "authoritative_exchange_fill_time",
    },
  });
}

function lifecycleProofCommitment(proof) {
  const { evidence_commitment: _ignored, ...material } = proof;
  return `carry:lifecycle-proof:evidence:${createHash("sha256").update(stableJson(material)).digest("hex")}`;
}

function immutableLifecycleState(proofWrappers, legacyProofWrapper = null) {
  const rows = new Map();
  const allWrappers = legacyProofWrapper ? [...proofWrappers, legacyProofWrapper] : proofWrappers;
  for (const wrapper of proofWrappers) {
    const proof = wrapper.proof;
    const proofKey = carryLifecycleProofKey(
      proof.owner_commitment,
      proof.worker_image_digest,
      proof.asset,
      proof.position_id,
      proof.venue_ids,
    );
    const reference = {
      version: 1,
      kind: "ghola_carry_lifecycle_proof_reference",
      owner_commitment: proof.owner_commitment,
      worker_image_digest: proof.worker_image_digest,
      asset: proof.asset,
      position_id: proof.position_id,
      venue_ids: [...proof.venue_ids],
      proof_key: proofKey,
      proof_evidence_commitment: proof.evidence_commitment,
      worker_material_commitment: proof.worker_material_commitment,
      verified_at_ms: proof.verified_at_ms,
      expires_at_ms: proof.expires_at_ms,
    };
    reference.evidence_commitment = `carry:lifecycle-proof-reference:evidence:${createHash("sha256")
      .update(stableJson(reference))
      .digest("hex")}`;
    rows.set(proofKey, { receipt: structuredClone(proof) });
    rows.set(carryLifecycleProofReferenceKey(
      proof.owner_commitment,
      proof.worker_image_digest,
      proof.asset,
      proof.position_id,
    ), { receipt: reference });
  }
  if (legacyProofWrapper) {
    const proof = legacyProofWrapper.proof;
    rows.set(carryLifecycleProofKey(
      proof.owner_commitment,
      proof.worker_image_digest,
      proof.asset,
    ), { receipt: structuredClone(proof) });
  }
  return {
    listCarryPositionRecords: async ({ owner_commitment: ownerCommitment }) => {
      assert.equal(ownerCommitment, "owner_commitment_0001");
      return allWrappers.map(({ proof }, index) => ({
        updated_at: new Date(NOW - index).toISOString(),
        position: { position_id: proof.position_id },
      }));
    },
    getIdempotency: async (key) => rows.get(key) || null,
  };
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
    recovery_reasons: [],
    recovery_policy: {
      ambiguous_submission: "freeze_reconcile_never_retry",
      partial_fill: "exact_quantity_reduce_only",
      worker_restart: "reconcile_before_action",
    },
    ...overrides,
  };
}
