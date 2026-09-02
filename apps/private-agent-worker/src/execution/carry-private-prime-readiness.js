import { createHash } from "node:crypto";
import {
  CARRY_EXECUTION_VENUES,
  CARRY_RECOVERY_POLICY,
  canonicalCarryCommitmentJson,
  normalizeCarryLifecycleValueAttribution,
} from "@ghola/execution-core";
import { assessCompletedCarryLifecycleProof } from "./carry-release-evidence.js";
import { verifyCarryExecutionReadinessResult } from "./carry-readiness.js";
import { verifyCarrySupervisionHealth } from "./carry-loop-supervisor.js";
import { verifyCarryShadowQualification } from "./carry-shadow-qualification.js";
import { verifyCarryTransferRouteEvidence } from "./carry-transfer-routes.js";

export function buildCarryPrivatePrimeReadiness({
  readiness,
  diagnostic,
  shadow_qualification: shadowQualification,
  carry_supervision: carrySupervision,
  route_observation_configured: routeObservationConfigured,
  route_evidence: routeEvidence,
  lifecycle_proof: lifecycleProof,
  lifecycle_proofs: lifecycleProofs,
  now_ms: nowMs = Date.now(),
}) {
  const assessedReadiness = verifyCarryExecutionReadinessResult(readiness, { now_ms: nowMs });
  const executionReadinessVerified = assessedReadiness.ok === true;
  const assessedShadowQualification = verifyCarryShadowQualification(shadowQualification, {
    image_digest: readiness?.image_digest,
    now_ms: nowMs,
    max_age_ms: 60_000,
  });
  const shadowQualificationVerified = assessedShadowQualification.ok === true;
  const assessedSupervision = verifyCarrySupervisionHealth(carrySupervision, { now_ms: nowMs });
  const supervisionVerified = assessedSupervision.ok === true && assessedSupervision.health.ready === true;
  const routeObservation = verifiedRouteObservation({
    readiness,
    routeEvidence,
    routeObservationConfigured,
    nowMs,
  });
  const pairedLifecycle = verifiedPairedLifecycle({ readiness, lifecycleProof, nowMs });
  const releaseEquivalentLifecycles = verifiedReleaseEquivalentLifecycles({
    readiness,
    lifecycleProofs: [
      lifecycleProof,
      ...(Array.isArray(lifecycleProofs) ? lifecycleProofs : []),
    ],
    nowMs,
  });
  const failureRecovery = verifiedFailureRecovery(readiness);
  const technicalReasons = [];
  if (!executionReadinessVerified) technicalReasons.push("three_venue_no_submit_unproven");
  if (executionReadinessVerified && failureRecovery.ready !== true) technicalReasons.push("three_venue_recovery_unproven");
  if (!shadowQualificationVerified) technicalReasons.push("five_venue_shadow_unproven");
  if (!supervisionVerified) technicalReasons.push("carry_supervision_unready");
  if (routeObservationConfigured !== true) technicalReasons.push("collateral_route_observation_unavailable");
  else if (routeObservation.verified !== true) technicalReasons.push("collateral_route_evidence_unverified");
  else if (routeObservation.available_route_count < 1) technicalReasons.push("collateral_route_unavailable");
  else if (routeObservation.complete_directed_coverage !== true) technicalReasons.push("collateral_route_coverage_incomplete");
  const noSubmitReady = technicalReasons.length === 0;
  const capitalReady = executionReadinessVerified && readiness?.capital_ready === true;
  const reasons = [
    ...technicalReasons,
    ...(executionReadinessVerified && !capitalReady ? ["opening_capital_shortfall"] : []),
  ];
  const readyForLiveUsers = noSubmitReady
    && capitalReady
    && pairedLifecycle.verified
    && releaseEquivalentLifecycles.verified;
  const liveLaunchBlockers = [
    ...reasons,
    ...(pairedLifecycle.verified ? [] : ["live_paired_lifecycle_unproven"]),
    ...(pairedLifecycle.verified && !releaseEquivalentLifecycles.verified
      ? ["live_release_lifecycle_coverage_unproven"]
      : []),
  ];
  const material = {
    version: 1,
    kind: "ghola_private_prime_no_submit_readiness",
    ready: noSubmitReady,
    no_submit_ready: noSubmitReady,
    ready_for_live_users: readyForLiveUsers,
    live_launch_blockers: liveLaunchBlockers,
    proof_level: pairedLifecycle.verified ? "live_paired_lifecycle" : "pre_broadcast_readiness",
    owner_commitment: readiness?.owner_commitment || null,
    network: readiness?.network || "mainnet",
    asset: readiness?.asset || null,
    checked_at_ms: nowMs,
    expires_at_ms: minimumExpiry(
      readiness?.expires_at_ms,
      shadowQualification?.checked_at_ms,
      routeObservation.expires_at_ms,
      supervisionVerified ? assessedSupervision.health.checked_at_ms + 5_000 : null,
      pairedLifecycle.verified ? pairedLifecycle.expires_at_ms : null,
      releaseEquivalentLifecycles.verified ? releaseEquivalentLifecycles.expires_at_ms : null,
    ),
    five_venue_shadow: {
      ready: shadowQualificationVerified,
      venue_count: shadowQualificationVerified ? assessedShadowQualification.qualification.venues : 0,
      evidence_commitment: shadowQualificationVerified ? assessedShadowQualification.qualification.evidence_commitment : null,
      qualification_commitment: shadowQualificationVerified
        ? assessedShadowQualification.qualification.qualification_commitment
        : null,
    },
    three_venue_execution: {
      ready: executionReadinessVerified,
      venue_ids: executionReadinessVerified ? assessedReadiness.readiness.registry_venue_ids : [],
      capital_ready: capitalReady,
      evidence_commitment: executionReadinessVerified ? assessedReadiness.readiness.evidence_commitment : null,
      readiness_commitment: executionReadinessVerified ? assessedReadiness.readiness.readiness_commitment : null,
      diagnostic_commitment: diagnostic?.diagnostic_commitment || null,
    },
    failure_recovery: failureRecovery,
    collateral_route_observation: routeObservation,
    supervision: {
      ready: supervisionVerified,
      status: assessedSupervision.ok ? assessedSupervision.health.status : "unavailable",
      checked_at_ms: assessedSupervision.ok ? assessedSupervision.health.checked_at_ms : null,
      evidence_commitment: assessedSupervision.ok ? assessedSupervision.health.evidence_commitment : null,
    },
    paired_lifecycle: pairedLifecycle,
    release_equivalent_lifecycles: releaseEquivalentLifecycles,
    live_paired_lifecycle_proven: pairedLifecycle.verified,
    owner_only_funding: true,
    owner_only_transfers: true,
    owner_only_withdrawals: true,
    transaction_broadcast: false,
    reasons,
  };
  material.evidence_commitment = evidenceCommitment(material);
  return Object.freeze(material);
}

function verifiedReleaseEquivalentLifecycles({ readiness, lifecycleProofs, nowMs }) {
  const lifecycles = [];
  const seenEvidenceCommitments = new Set();
  for (const lifecycleProof of lifecycleProofs) {
    const lifecycle = verifiedPairedLifecycle({ readiness, lifecycleProof, nowMs });
    if (!lifecycle.verified || seenEvidenceCommitments.has(lifecycle.evidence_commitment)) continue;
    seenEvidenceCommitments.add(lifecycle.evidence_commitment);
    lifecycles.push(lifecycle);
  }
  const positionIds = lifecycles.map((item) => item.position_id);
  const evidenceCommitments = lifecycles.map((item) => item.evidence_commitment);
  const normalizedVenuePairs = lifecycles.map((item) => normalizedVenuePair(item.venue_ids));
  const uniquePositionIds = new Set(positionIds);
  const uniqueVenuePairs = new Set(normalizedVenuePairs);
  const verified = uniquePositionIds.size >= 2
    && uniqueVenuePairs.size >= 2;
  return Object.freeze({
    verified,
    lifecycle_count: lifecycles.length,
    distinct_position_count: uniquePositionIds.size,
    distinct_venue_pair_count: uniqueVenuePairs.size,
    normalized_venue_pairs: Object.freeze([...uniqueVenuePairs].sort()),
    position_ids: Object.freeze([...uniquePositionIds].sort()),
    lifecycle_evidence_commitments: Object.freeze([...evidenceCommitments].sort()),
    expires_at_ms: verified ? Math.min(...lifecycles.map((item) => item.expires_at_ms)) : null,
    lifecycles: Object.freeze(lifecycles),
  });
}

function normalizedVenuePair(venueIds) {
  return [...venueIds].sort().join(":");
}

function verifiedFailureRecovery(readiness) {
  const venueIds = Array.isArray(readiness?.recovery_venue_ids) ? readiness.recovery_venue_ids : [];
  const reasons = Array.isArray(readiness?.recovery_reasons) ? readiness.recovery_reasons : null;
  const policy = readiness?.recovery_policy;
  const ready = readiness?.recovery_ready === true
    && reasons !== null
    && reasons.length === 0
    && venueIds.length === CARRY_EXECUTION_VENUES.length
    && CARRY_EXECUTION_VENUES.every((venueId, index) => venueIds[index] === venueId)
    && policy && typeof policy === "object" && !Array.isArray(policy)
    && Object.entries(CARRY_RECOVERY_POLICY).every(([key, expected]) => policy[key] === expected)
    && Object.keys(policy).length === Object.keys(CARRY_RECOVERY_POLICY).length;
  return Object.freeze({
    ready,
    venue_ids: ready ? Object.freeze([...venueIds]) : Object.freeze([]),
    reasons: Object.freeze(reasons || ["carry_recovery_qualification_evidence_missing"]),
    policy: Object.freeze({ ...CARRY_RECOVERY_POLICY }),
  });
}

function verifiedPairedLifecycle({ readiness, lifecycleProof, nowMs }) {
  const assessedLifecycle = assessCompletedCarryLifecycleProof({
    proof: lifecycleProof?.proof,
    owner_commitment: readiness?.owner_commitment,
    image_digest: readiness?.image_digest,
    asset: readiness?.asset,
    now_ms: nowMs,
  });
  const proof = assessedLifecycle.ok ? assessedLifecycle.proof : null;
  const venueIds = Array.isArray(proof?.venue_ids) ? proof.venue_ids : [];
  const registryVenueIds = new Set(Array.isArray(readiness?.registry_venue_ids) ? readiness.registry_venue_ids : []);
  const valueAttribution = safeLifecycleValueAttribution(proof?.value_attribution);
  const exposureBoundaryVerified = authoritativeLifecycleExposureBoundary(proof, venueIds);
  const verified = lifecycleProof?.ok === true
    && assessedLifecycle.ok === true
    && proof?.version === 1
    && proof?.kind === "ghola_carry_live_paired_lifecycle_proof"
    && proof?.network === "mainnet"
    && proof?.owner_commitment === readiness?.owner_commitment
    && proof?.worker_image_digest === readiness?.image_digest
    && proof?.asset === readiness?.asset
    && venueIds.length === 2
    && new Set(venueIds).size === 2
    && venueIds.every((venueId) => registryVenueIds.has(venueId))
    && Number.isSafeInteger(proof?.verified_at_ms)
    && proof.verified_at_ms <= nowMs + 5_000
    && Number.isSafeInteger(proof?.expires_at_ms)
    && proof.expires_at_ms > nowMs
    && proof?.live_entry_exit_proven === true
    && proof?.supervised_monitoring_proven === true
    && proof?.final_flat_zero_orders === true
    && proof?.value_ledger_finalized === true
    && proof?.value_boundary_authoritative === true
    && proof?.exposure_boundary_provenance === "authoritative_exchange_fill_time"
    && exposureBoundaryVerified
    && proof?.ambiguity_retry_count === 0
    && proof?.owner_only_funding === true
    && proof?.owner_only_transfers === true
    && proof?.owner_only_withdrawals === true
    && proof?.recording_transaction_broadcast === false
    && Number.isSafeInteger(proof?.realized_net_value_micro_usdc)
    && valueAttribution?.realized.net_value_micro_usdc === proof.realized_net_value_micro_usdc
    && valueAttribution?.realized_total_cost_micro_usdc === proof?.value_attribution?.realized_total_cost_micro_usdc
    && /^carry:creation-inputs:[0-9a-f]{64}$/.test(String(proof?.creation_input_evidence_commitment || ""))
    && /^carry:release:material:[0-9a-f]{64}$/.test(String(proof?.worker_material_commitment || ""))
    && /^carry:lifecycle-proof:evidence:[0-9a-f]{64}$/.test(String(proof?.evidence_commitment || ""));
  return Object.freeze({
    verified,
    position_id: verified ? proof.position_id : null,
    asset: verified ? proof.asset : null,
    venue_ids: verified ? venueIds : [],
    verified_at_ms: verified ? proof.verified_at_ms : null,
    expires_at_ms: verified ? proof.expires_at_ms : null,
    account_bindings_verified: verified,
    live_entry_exit_proven: verified,
    supervised_monitoring_proven: verified,
    final_flat_zero_orders: verified,
    value_ledger_finalized: verified,
    value_boundary_authoritative: verified,
    exposure_boundary_provenance: verified ? proof.exposure_boundary_provenance : null,
    first_exposure_observed_at_ms: verified ? proof.first_exposure_observed_at_ms : null,
    first_exposure_observed_at_ms_by_venue: verified
      ? Object.freeze({ ...proof.first_exposure_observed_at_ms_by_venue })
      : Object.freeze({}),
    exposure_boundary_provenance_by_venue: verified
      ? Object.freeze({ ...proof.exposure_boundary_provenance_by_venue })
      : Object.freeze({}),
    realized_net_value_micro_usdc: verified ? proof.realized_net_value_micro_usdc : null,
    value_attribution: verified ? valueAttribution : null,
    ambiguity_retry_count: verified ? 0 : null,
    owner_only_funding: true,
    owner_only_transfers: true,
    owner_only_withdrawals: true,
    transaction_broadcast: false,
    creation_input_evidence_commitment: verified ? proof.creation_input_evidence_commitment : null,
    worker_material_commitment: verified ? proof.worker_material_commitment : null,
    evidence_commitment: verified ? proof.evidence_commitment : null,
  });
}

function authoritativeLifecycleExposureBoundary(proof, venueIds) {
  const boundaries = proof?.first_exposure_observed_at_ms_by_venue;
  const provenances = proof?.exposure_boundary_provenance_by_venue;
  const exactKeys = (value) => value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === venueIds.length
    && venueIds.every((venueId) => Object.hasOwn(value, venueId));
  return venueIds.length === 2
    && new Set(venueIds).size === 2
    && exactKeys(boundaries)
    && exactKeys(provenances)
    && venueIds.every((venueId) => Number.isSafeInteger(boundaries[venueId])
      && boundaries[venueId] > 0
      && provenances[venueId] === "authoritative_exchange_fill_time")
    && Number.isSafeInteger(proof?.first_exposure_observed_at_ms)
    && proof.first_exposure_observed_at_ms
      === Math.min(...venueIds.map((venueId) => boundaries[venueId]));
}

function safeLifecycleValueAttribution(value) {
  try {
    return normalizeCarryLifecycleValueAttribution(value);
  } catch {
    return null;
  }
}

function verifiedRouteObservation({ readiness, routeEvidence, routeObservationConfigured, nowMs }) {
  const assessedEvidence = verifyCarryTransferRouteEvidence(routeEvidence?.evidence);
  const evidence = assessedEvidence.ok ? assessedEvidence.evidence : null;
  const routes = Array.isArray(evidence?.routes) ? evidence.routes : [];
  const checkedAtMs = Number.isSafeInteger(evidence?.checked_at_ms) ? evidence.checked_at_ms : null;
  const expiresAtMs = Number.isSafeInteger(evidence?.expires_at_ms) ? evidence.expires_at_ms : null;
  const effectiveExpiresAtMs = checkedAtMs !== null && expiresAtMs !== null
    ? Math.min(expiresAtMs, checkedAtMs + 30_000)
    : null;
  const evidenceCommitment = typeof evidence?.evidence_commitment === "string"
    ? evidence.evidence_commitment
    : null;
  const currentAccountStates = new Set((Array.isArray(readiness?.capital_plan) ? readiness.capital_plan : [])
    .map((item) => item?.account_state_commitment)
    .filter((item) => typeof item === "string"));
  const routesBoundToCurrentAccounts = currentAccountStates.size > 1
    && routes.length > 0
    && routes.every((route) => currentAccountStates.has(route?.source_account_state_commitment)
      && currentAccountStates.has(route?.destination_account_state_commitment));
  const expectedVenueIds = Array.isArray(readiness?.registry_venue_ids)
    ? readiness.registry_venue_ids.filter((venueId) => CARRY_EXECUTION_VENUES.includes(venueId))
    : [];
  const requiredRoutePairs = directedRoutePairs(expectedVenueIds);
  const verified = routeObservationConfigured === true
    && routeEvidence?.ok === true
    && assessedEvidence.ok === true
    && evidence?.owner_commitment === readiness?.owner_commitment
    && evidence?.worker_image_digest === readiness?.image_digest
    && checkedAtMs !== null
    && checkedAtMs <= nowMs + 5_000
    && nowMs - checkedAtMs <= 30_000
    && effectiveExpiresAtMs !== null
    && effectiveExpiresAtMs > nowMs
    && routesBoundToCurrentAccounts
    && evidenceCommitment?.startsWith("carry:transfer-routes:evidence:") === true;
  const availableRoutes = verified
    ? routes.filter((route) => route?.status === "available"
      && route?.quote_verified === true
      && route?.all_in_fee_verified === true
      && route?.valuation_basis_verified === true
      && route?.owner_approval_required === true
      && route?.fund_movement_authorized === false
      && route?.transaction_broadcast === false
      && route?.automatic_transfer_permitted === false)
    : [];
  const availableRoutePairs = new Set(availableRoutes.map((route) => `${route.from_venue_id}:${route.to_venue_id}`));
  const completeDirectedCoverage = verified
    && expectedVenueIds.length === CARRY_EXECUTION_VENUES.length
    && requiredRoutePairs.length === routes.length
    && requiredRoutePairs.length === availableRoutePairs.size
    && requiredRoutePairs.every((pair) => availableRoutePairs.has(pair));
  return Object.freeze({
    configured: routeObservationConfigured === true,
    verified,
    route_count: verified ? routes.length : 0,
    required_route_count: requiredRoutePairs.length,
    available_route_count: availableRoutes.length,
    complete_directed_coverage: completeDirectedCoverage,
    checked_at_ms: verified ? checkedAtMs : null,
    expires_at_ms: verified ? effectiveExpiresAtMs : null,
    evidence_commitment: verified ? evidenceCommitment : null,
    read_only: true,
    owner_approval_required: true,
    fund_movement_authorized: false,
    transaction_broadcast: false,
    automatic_transfer_permitted: false,
  });
}

function directedRoutePairs(venueIds) {
  return venueIds.flatMap((fromVenueId) => venueIds
    .filter((toVenueId) => toVenueId !== fromVenueId)
    .map((toVenueId) => `${fromVenueId}:${toVenueId}`));
}

function minimumExpiry(
  readinessExpiry,
  shadowCheckedAt,
  routeExpiry,
  supervisionExpiry,
  lifecycleExpiry,
  releaseEquivalentExpiry,
) {
  const values = [
    readinessExpiry,
    Number.isSafeInteger(shadowCheckedAt) ? shadowCheckedAt + 60_000 : null,
    routeExpiry,
    supervisionExpiry,
    lifecycleExpiry,
    releaseEquivalentExpiry,
  ]
    .filter((value) => Number.isSafeInteger(value) && value > 0);
  return values.length > 0 ? Math.min(...values) : null;
}

function evidenceCommitment(value) {
  const { evidence_commitment: _ignored, ...material } = value;
  return `carry:private-prime:${createHash("sha256")
    .update(canonicalCarryCommitmentJson(material))
    .digest("hex")
    .slice(0, 40)}`;
}
