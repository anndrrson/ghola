#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CARRY_EXECUTION_VENUES,
  CARRY_RECOVERY_POLICY,
  CORE_PERP_VENUES,
  carryRiskMandateMessage,
  venueAdapterCapability,
} from "@ghola/execution-core";
import { hashMessage, recoverMessageAddress } from "viem";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CARRY_EVIDENCE_PATH = resolve(
  HERE,
  "../../../deploy/evidence/carry-mainnet-proof.json",
);

const CARRY_RELEASE_SHADOW_ASSETS = Object.freeze(["BTC", "ETH", "SOL"]);
const CARRY_ADAPTERS = Object.freeze(Object.fromEntries(CARRY_EXECUTION_VENUES.map((venueId) => [
  venueId,
  venueAdapterCapability(venueId, "carry_execution")?.adapter_id,
])));

export async function verifyCarryReleaseEvidence(evidence) {
  const failures = [];
  const fail = (condition, code) => {
    if (!condition) failures.push(code);
  };

  fail(evidence?.version === 1, "version_invalid");
  fail(evidence?.kind === "ghola_cross_venue_carry_mainnet_lifecycle_proof", "kind_invalid");
  fail(evidence?.network === "mainnet", "mainnet_required");
  fail(evidence?.request?.ambiguity_retry_performed === false, "ambiguity_retry_forbidden");
  fail(evidence?.worker_material_commitment === carryWorkerMaterialCommitment(evidence), "worker_material_commitment_mismatch");

  const commitSha = String(evidence?.candidate?.web_commit_sha || "");
  const previewUrl = String(evidence?.candidate?.preview_url || "");
  const imageDigest = String(evidence?.candidate?.worker_image_digest || "").toLowerCase();
  fail(/^[0-9a-f]{7,40}$/i.test(commitSha), "candidate_sha_invalid");
  fail(/^https:\/\/[^/]+\.vercel\.app$/i.test(previewUrl), "candidate_url_invalid");
  fail(/^sha256:[0-9a-f]{12,128}$/.test(imageDigest), "worker_image_digest_invalid");

  const shadowQualification = evidence?.shadow_qualification || {};
  const shadowCheckedAt = timestamp(shadowQualification.checked_at);
  const shadowRequiredSamples = positiveInteger(shadowQualification.required_samples);
  const shadowCompletedSamples = positiveInteger(shadowQualification.completed_samples);
  const shadowSampleCommitments = array(shadowQualification.sample_commitments);
  const shadowSourceObservationCommitments = array(shadowQualification.source_observation_commitments);
  fail(shadowQualification.proven === true, "shadow_qualification_unproven");
  fail(String(shadowQualification.image_digest || "").toLowerCase() === imageDigest,
    "shadow_qualification_image_mismatch");
  fail(shadowQualification.venues === CORE_PERP_VENUES.length, "shadow_qualification_venue_coverage_invalid");
  fail(shadowQualification.assets === CARRY_RELEASE_SHADOW_ASSETS.length, "shadow_qualification_asset_coverage_invalid");
  fail(sameStrings(shadowQualification.requested_assets, CARRY_RELEASE_SHADOW_ASSETS),
    "shadow_qualification_assets_invalid");
  fail(shadowRequiredSamples >= 3, "shadow_qualification_sample_floor_invalid");
  fail(shadowCompletedSamples >= shadowRequiredSamples, "shadow_qualification_samples_incomplete");
  const shadowMinimumSpanMs = positiveInteger(shadowQualification.minimum_span_ms);
  const shadowDurationMs = nonNegativeInteger(shadowQualification.duration_ms);
  fail(shadowMinimumSpanMs >= 120_000 && shadowDurationMs >= shadowMinimumSpanMs,
    "shadow_qualification_duration_invalid");
  fail(shadowQualification.expected_snapshots_per_sample === CORE_PERP_VENUES.length * CARRY_RELEASE_SHADOW_ASSETS.length,
    "shadow_qualification_snapshot_coverage_invalid");
  fail(shadowSampleCommitments.length === shadowCompletedSamples
    && new Set(shadowSampleCommitments).size === shadowSampleCommitments.length
    && shadowSampleCommitments.every((value) => /^carry:shadow:sample:[0-9a-f]{64}$/.test(String(value || ""))),
  "shadow_qualification_commitments_invalid");
  fail(shadowSourceObservationCommitments.length === shadowCompletedSamples
    && new Set(shadowSourceObservationCommitments).size === shadowSourceObservationCommitments.length
    && shadowSourceObservationCommitments.every((value) => /^carry:shadow:sources:[0-9a-f]{64}$/.test(String(value || ""))),
  "shadow_qualification_source_observations_invalid");
  fail(shadowQualification.transaction_broadcast === false, "shadow_qualification_broadcast_detected");
  fail(/^carry:shadow:qualification:[0-9a-f]{64}$/.test(String(shadowQualification.evidence_commitment || "")),
    "shadow_qualification_commitment_invalid");

  const executionReadiness = evidence?.execution_readiness || {};
  const readinessCheckedAt = timestamp(executionReadiness.checked_at);
  const readinessExpiresAt = timestamp(executionReadiness.expires_at);
  const readinessVenues = array(executionReadiness.venues);
  fail(executionReadiness.ready === true, "three_venue_readiness_unproven");
  fail(executionReadiness.owner_commitment === evidence?.final_state?.owner_commitment,
    "three_venue_owner_binding_mismatch");
  fail(executionReadiness.asset === evidence?.position?.asset, "three_venue_asset_mismatch");
  fail(scaledDecimal(executionReadiness.notional_usd, 6) === BigInt(positiveInteger(evidence?.position?.target_notional_micro_usdc)),
    "three_venue_notional_mismatch");
  fail(positiveDecimal(executionReadiness.horizon_days), "three_venue_horizon_invalid");
  fail(String(executionReadiness.image_digest || "").toLowerCase() === imageDigest,
    "three_venue_image_mismatch");
  fail(sameStrings(executionReadiness.registry_venue_ids, CARRY_EXECUTION_VENUES),
    "three_venue_registry_invalid");
  fail(executionReadiness.recovery_ready === true
    && sameStrings(executionReadiness.recovery_venue_ids, CARRY_EXECUTION_VENUES)
    && sameRecord(executionReadiness.recovery_policy, CARRY_RECOVERY_POLICY),
  "three_venue_recovery_unproven");
  fail(executionReadiness.transaction_broadcast === false, "three_venue_broadcast_detected");
  fail(/^carry:readiness:evidence:[0-9a-f]{40}$/.test(String(executionReadiness.evidence_commitment || "")),
    "three_venue_evidence_commitment_invalid");
  fail(/^carry:readiness:result:[0-9a-f]{64}$/.test(String(executionReadiness.readiness_commitment || "")),
    "three_venue_result_commitment_invalid");
  fail(sameVenueSet(readinessVenues, CARRY_EXECUTION_VENUES), "three_venue_account_bindings_invalid");
  for (const venue of readinessVenues) {
    fail(commitment(venue?.account_commitment), `three_venue_account_commitment_invalid:${String(venue?.venue_id || "")}`);
    fail(/^carry:account-state:[0-9a-f]{64}$/.test(String(venue?.account_state_commitment || "")),
      `three_venue_account_state_commitment_invalid:${String(venue?.venue_id || "")}`);
    fail(venue?.account_state_checked === true, `three_venue_account_state_unchecked:${String(venue?.venue_id || "")}`);
    fail(venue?.transaction_broadcast === false, `three_venue_account_broadcast_detected:${String(venue?.venue_id || "")}`);
  }

  const collateralRoutes = evidence?.collateral_route_readiness || {};
  const collateralCheckedAt = timestamp(collateralRoutes.checked_at);
  const collateralExpiresAt = timestamp(collateralRoutes.expires_at);
  const requiredRoutePairs = CARRY_EXECUTION_VENUES.flatMap((fromVenueId) => CARRY_EXECUTION_VENUES
    .filter((toVenueId) => toVenueId !== fromVenueId)
    .map((toVenueId) => `${fromVenueId}:${toVenueId}`)).sort();
  const collateralRoutePairs = array(collateralRoutes.route_pairs).map(String).sort();
  const collateralVenues = array(collateralRoutes.venues);
  fail(collateralRoutes.proven === true, "collateral_route_coverage_unproven");
  fail(collateralRoutes.required_route_count === requiredRoutePairs.length
    && collateralRoutes.available_route_count === requiredRoutePairs.length
    && collateralRoutes.complete_directed_coverage === true,
  "collateral_route_coverage_incomplete");
  fail(sameStrings(collateralRoutePairs, requiredRoutePairs), "collateral_route_pairs_invalid");
  fail(sameVenueSet(collateralVenues, CARRY_EXECUTION_VENUES), "collateral_route_venue_bindings_invalid");
  for (const venue of collateralVenues) {
    const readinessVenue = readinessVenues.find((item) => item?.venue_id === venue?.venue_id);
    fail(commitment(venue?.account_commitment)
      && venue.account_commitment === readinessVenue?.account_commitment,
    `collateral_route_account_binding_invalid:${String(venue?.venue_id || "")}`);
  }
  fail(positiveInteger(collateralRoutes.minimum_route_capacity_micro_usdc) > 0,
    "collateral_route_capacity_invalid");
  fail(nonNegativeInteger(collateralRoutes.maximum_route_latency_ms) !== null,
    "collateral_route_latency_invalid");
  fail(collateralRoutes.owner_approval_required === true
    && collateralRoutes.fund_movement_authorized === false
    && collateralRoutes.transaction_broadcast === false
    && collateralRoutes.automatic_transfer_permitted === false,
  "collateral_route_authority_invalid");
  fail(/^carry:transfer-routes:evidence:[0-9a-f]{40}$/.test(String(collateralRoutes.evidence_commitment || "")),
    "collateral_route_evidence_commitment_invalid");

  const position = evidence?.position || {};
  const notional = positiveInteger(position.target_notional_micro_usdc);
  const pair = [String(position.long_venue_id || ""), String(position.short_venue_id || "")];
  fail(identifier(position.position_id), "position_id_invalid");
  fail(/^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(String(position.asset || "")), "asset_invalid");
  fail(notional > 0 && notional <= 25_000_000, "proof_notional_cap_exceeded");
  fail(pair[0] !== pair[1] && pair.every((venue) => CARRY_EXECUTION_VENUES.includes(venue)), "venue_pair_invalid");
  fail(pair.every((venue) => typeof CARRY_ADAPTERS[venue] === "string"), "venue_adapter_registry_invalid");

  const createdAt = timestamp(position.created_at);
  fail(createdAt > 0, "position_timestamp_invalid");
  fail(shadowCheckedAt > 0 && shadowCheckedAt <= createdAt, "shadow_qualification_timestamp_invalid");
  fail(readinessCheckedAt > 0 && readinessCheckedAt <= createdAt && readinessExpiresAt > createdAt,
    "three_venue_readiness_timestamp_invalid");
  fail(collateralCheckedAt > 0 && collateralExpiresAt > collateralCheckedAt,
    "collateral_route_timestamp_invalid");
  const contractEquivalence = evidence?.contract_equivalence || {};
  const equivalenceCheckedAt = timestamp(contractEquivalence.checked_at);
  const dataSkewMs = nonNegativeInteger(contractEquivalence.contract_data_skew_ms);
  const maxDataSkewMs = nonNegativeInteger(contractEquivalence.max_contract_data_skew_ms);
  const indexDivergenceBps = nonNegativeInteger(contractEquivalence.index_price_divergence_bps);
  const markDivergenceBps = nonNegativeInteger(contractEquivalence.mark_price_divergence_bps);
  const maxIndexDivergenceBps = nonNegativeInteger(contractEquivalence.max_index_price_divergence_bps);
  const maxMarkDivergenceBps = nonNegativeInteger(contractEquivalence.max_mark_price_divergence_bps);
  fail(contractEquivalence.verified === true, "contract_equivalence_unverified");
  fail(contractEquivalence.economic_equivalence_id === `carry:${position.asset}-usd-linear`, "economic_equivalence_id_invalid");
  fail(contractEquivalence.contract_type === "linear_perp", "contract_type_not_equivalent");
  fail([contractEquivalence.long_quote_asset, contractEquivalence.short_quote_asset]
    .every((asset) => ["USD", "USDC", "USDT"].includes(asset)), "contract_quote_basis_unmodeled");
  fail(dataSkewMs !== null && maxDataSkewMs !== null && dataSkewMs <= maxDataSkewMs, "contract_data_skew_exceeded");
  fail(indexDivergenceBps !== null && maxIndexDivergenceBps !== null
    && maxIndexDivergenceBps <= 10_000 && indexDivergenceBps <= maxIndexDivergenceBps, "contract_index_basis_exceeded");
  fail(markDivergenceBps !== null && maxMarkDivergenceBps !== null
    && maxMarkDivergenceBps <= 10_000 && markDivergenceBps <= maxMarkDivergenceBps, "contract_mark_basis_exceeded");
  fail(evidence?.mandate?.ai_execution_authority === false, "ai_must_be_proposal_only");
  fail(evidence?.mandate?.funding_owner_only === true, "funding_owner_only_required");
  fail(evidence?.mandate?.transfers_owner_only === true, "transfers_owner_only_required");
  fail(evidence?.mandate?.withdrawals_owner_only === true, "withdrawals_owner_only_required");
  const signedMandate = evidence?.mandate?.signed_mandate;
  const ownerSignature = String(evidence?.mandate?.owner_signature || "").toLowerCase();
  let mandateMessage = "";
  try {
    mandateMessage = carryRiskMandateMessage(signedMandate);
  } catch {
    failures.push("signed_mandate_invalid");
  }
  const mandateCommitment = mandateMessage ? hashMessage(mandateMessage) : "";
  fail(evidence?.mandate?.policy_commitment === mandateCommitment, "signed_mandate_commitment_mismatch");
  fail(/^0x[0-9a-f]{130}$/.test(ownerSignature), "owner_signature_invalid");
  if (mandateMessage && /^0x[0-9a-f]{130}$/.test(ownerSignature)) {
    try {
      const recovered = await recoverMessageAddress({ message: mandateMessage, signature: ownerSignature });
      fail(recovered.toLowerCase() === signedMandate.owner_wallet_address, "owner_signature_mismatch");
    } catch {
      failures.push("owner_signature_invalid");
    }
  }
  fail(signedMandate?.network === "mainnet", "signed_mandate_mainnet_required");
  fail(signedMandate?.position_id === position.position_id, "signed_mandate_position_mismatch");
  fail(signedMandate?.asset === position.asset, "signed_mandate_asset_mismatch");
  fail(signedMandate?.long_venue_id === pair[0] && signedMandate?.short_venue_id === pair[1], "signed_mandate_pair_mismatch");
  fail(signedMandate?.target_notional_micro_usdc === notional, "signed_mandate_notional_mismatch");
  fail(positiveInteger(signedMandate?.issued_at_ms) <= createdAt, "signed_mandate_issued_at_invalid");
  fail(positiveInteger(signedMandate?.expires_at_ms) > createdAt, "signed_mandate_expired_at_creation");
  fail(Array.isArray(signedMandate?.risk_mandate?.owner_only_operations)
    && ["fund", "withdraw", "transfer"].every((item) => signedMandate.risk_mandate.owner_only_operations.includes(item)),
  "signed_mandate_owner_only_operations_missing");
  const maxDataAgeMs = positiveInteger(signedMandate?.risk_mandate?.max_data_age_ms);
  fail(signedMandate?.risk_mandate?.max_contract_data_skew_ms === maxDataSkewMs,
    "signed_contract_data_skew_limit_mismatch");
  fail(signedMandate?.risk_mandate?.max_index_price_divergence_bps === maxIndexDivergenceBps,
    "signed_index_basis_limit_mismatch");
  fail(signedMandate?.risk_mandate?.max_mark_price_divergence_bps === maxMarkDivergenceBps,
    "signed_mark_basis_limit_mismatch");
  fail(equivalenceCheckedAt > 0 && equivalenceCheckedAt <= createdAt
    && createdAt - equivalenceCheckedAt <= maxDataAgeMs, "contract_equivalence_timestamp_invalid");
  fail(maxDataSkewMs !== null && maxDataSkewMs <= maxDataAgeMs, "contract_data_skew_budget_invalid");

  const qualifications = array(evidence?.qualification?.venues);
  fail(sameVenueSet(qualifications, pair), "qualification_venues_mismatch");
  for (const qualification of qualifications) {
    const venue = String(qualification?.venue_id || "");
    fail(qualification?.proven === true, `qualification_not_proven:${venue}`);
    fail(qualification?.adapter_id === CARRY_ADAPTERS[venue], `qualification_adapter_mismatch:${venue}`);
    fail(String(qualification?.image_digest || "").toLowerCase() === imageDigest, `qualification_image_mismatch:${venue}`);
    fail(qualification?.no_submit_ready === true, `no_submit_not_ready:${venue}`);
    fail(qualification?.transaction_broadcast === false, `no_submit_broadcast_detected:${venue}`);
    fail(commitment(qualification?.evidence_commitment), `qualification_commitment_missing:${venue}`);
    if (venue !== "hyperliquid") {
      fail(qualification?.source === "deployment_bound_lifecycle", `candidate_lifecycle_qualification_required:${venue}`);
    }
  }

  const entry = evidence?.entry || {};
  const entryStartedAt = timestamp(entry.started_at);
  const entryReconciledAt = timestamp(entry.reconciled_at);
  fail(entryStartedAt >= createdAt, "entry_start_invalid");
  fail(entryReconciledAt >= entryStartedAt, "entry_reconciliation_timestamp_invalid");
  const entryLegs = verifyLegs({
    legs: entry.legs,
    pair,
    longVenue: pair[0],
    reduceOnly: false,
    failures,
    phase: "entry",
  });

  const monitoring = evidence?.monitoring || {};
  const monitoringStartedAt = timestamp(monitoring.started_at);
  const monitoringEndedAt = timestamp(monitoring.ended_at);
  fail(monitoringStartedAt >= entryReconciledAt, "monitoring_start_invalid");
  fail(monitoringEndedAt > monitoringStartedAt, "monitoring_period_required");
  fail(positiveInteger(monitoring.observation_count) >= 2, "monitoring_observation_cadence_missing");
  fail(positiveInteger(monitoring.funding_flip_checks) >= 2, "funding_flip_check_cadence_missing");
  const fundingObservations = array(monitoring.funding_observations);
  fail(fundingObservations.length === positiveInteger(monitoring.observation_count),
    "funding_observation_count_mismatch");
  let priorFundingObservation = null;
  for (const observation of fundingObservations) {
    const observedAt = timestamp(observation?.observed_at);
    const sources = observation?.source_observed_at_ms_by_venue;
    const sourcesValid = sources
      && typeof sources === "object"
      && !Array.isArray(sources)
      && Object.keys(sources).length === pair.length
      && pair.every((venueId) => positiveInteger(sources[venueId]) > 0
        && sources[venueId] <= observedAt
        && observedAt - sources[venueId] <= maxDataAgeMs);
    fail(/^carry:funding:current:[0-9a-f]{64}$/.test(String(observation?.evidence_commitment || "")),
      "funding_observation_commitment_invalid");
    fail(observedAt >= monitoringStartedAt && observedAt <= monitoringEndedAt,
      "funding_observation_timestamp_invalid");
    fail(sourcesValid, "funding_observation_sources_invalid");
    if (priorFundingObservation && sourcesValid) {
      const priorSources = priorFundingObservation.source_observed_at_ms_by_venue;
      fail(pair.every((venueId) => sources[venueId] >= priorSources[venueId]),
        "funding_observation_source_regressed");
      fail(pair.some((venueId) => sources[venueId] > priorSources[venueId])
        && observation.evidence_commitment !== priorFundingObservation.evidence_commitment,
      "funding_observation_source_reused");
    }
    if (sourcesValid) priorFundingObservation = observation;
  }
  const supervision = monitoring.supervision || {};
  const automaticObservations = positiveInteger(supervision.automatic_observation_count);
  const firstAutomaticObservation = timestamp(supervision.first_automatic_observed_at);
  const lastAutomaticObservation = timestamp(supervision.last_automatic_observed_at);
  const maxObservationGapMs = nonNegativeInteger(supervision.max_observation_gap_ms);
  const maxAllowedGapMs = positiveInteger(supervision.max_allowed_gap_ms);
  fail(supervision.mode === "attested_worker_loop", "supervised_monitoring_required");
  fail(automaticObservations >= 2, "supervised_monitoring_cadence_missing");
  fail(automaticObservations === positiveInteger(monitoring.observation_count), "supervised_observation_count_mismatch");
  fail(firstAutomaticObservation >= monitoringStartedAt && firstAutomaticObservation <= monitoringEndedAt,
    "supervised_monitoring_start_invalid");
  fail(firstAutomaticObservation < lastAutomaticObservation, "supervised_monitoring_period_required");
  fail(lastAutomaticObservation === monitoringEndedAt, "supervised_monitoring_end_invalid");
  fail(supervision.failure_count === 0, "supervised_monitoring_failure_detected");
  fail(maxAllowedGapMs === maxDataAgeMs, "supervised_monitoring_gap_budget_mismatch");
  fail(maxObservationGapMs !== null && maxObservationGapMs <= maxAllowedGapMs,
    "supervised_monitoring_gap_exceeded");
  fail(supervision.transaction_broadcast === false, "supervised_monitoring_broadcast_detected");
  fail(sameVenueSet(monitoring.margin_runways, pair), "margin_runway_venues_mismatch");
  for (const runway of array(monitoring.margin_runways)) {
    const venue = String(runway?.venue_id || "");
    const status = String(runway?.status || "");
    fail(["healthy", "warning", "critical", "breached"].includes(status), `margin_runway_status_missing:${venue}`);
    fail(
      runway?.runway_ms === null
        ? status === "healthy"
        : nonNegativeInteger(runway?.runway_ms) !== null,
      `margin_runway_missing:${venue}`,
    );
    fail(runway?.stale === false, `margin_runway_stale:${String(runway?.venue_id || "")}`);
  }

  const exit = evidence?.exit || {};
  const exitRequestedAt = timestamp(exit.requested_at);
  const exitReconciledAt = timestamp(exit.reconciled_at);
  fail(exitRequestedAt >= monitoringEndedAt, "exit_request_timestamp_invalid");
  fail(exitReconciledAt >= exitRequestedAt, "exit_reconciliation_timestamp_invalid");
  const exitReason = String(exit.reason || "");
  fail(["manual", "funding_flip", "margin_runway", "risk_mandate"].includes(exitReason), "exit_reason_invalid");
  verifyExitTrigger({
    trigger: exit.trigger,
    reason: exitReason,
    exitRequestedAt,
    monitoringEndedAt,
    pair,
    signedMandate,
    fail,
  });
  const exitLegs = verifyLegs({
    legs: exit.legs,
    pair,
    longVenue: pair[0],
    reduceOnly: true,
    failures,
    phase: "exit",
  });

  for (const venue of pair) {
    const opened = entryLegs.find((leg) => leg.venue_id === venue);
    const closed = exitLegs.find((leg) => leg.venue_id === venue);
    fail(equalPositiveDecimal(opened?.filled_base_size, closed?.filled_base_size), `exact_exit_quantity_required:${venue}`);
  }
  const clientOrderCommitments = [...entryLegs, ...exitLegs].map((leg) => leg.client_order_commitment);
  fail(clientOrderCommitments.length === 4 && new Set(clientOrderCommitments).size === 4, "client_order_commitments_not_unique");

  const finalState = evidence?.final_state || {};
  const finalCheckedAt = timestamp(finalState.checked_at);
  fail(commitment(finalState.owner_commitment), "final_owner_commitment_invalid");
  fail(finalState.owner_commitment === signedMandate?.owner_commitment, "final_owner_binding_mismatch");
  fail(finalState.carry_position_id === position.position_id, "final_position_binding_mismatch");
  fail(finalCheckedAt >= exitReconciledAt, "final_state_timestamp_invalid");
  fail(collateralCheckedAt >= finalCheckedAt && collateralCheckedAt - finalCheckedAt <= 30_000,
    "collateral_route_final_state_binding_invalid");
  fail(finalState.gross_exposure_micro_usdc === 0, "final_exposure_not_flat");
  fail(finalState.open_order_count === 0, "final_open_orders_not_zero");
  fail(sameVenueSet(finalState.venues, pair), "final_state_venues_mismatch");
  for (const venueState of array(finalState.venues)) {
    const venue = String(venueState?.venue_id || "");
    const opened = entryLegs.find((leg) => leg.venue_id === venue);
    const closed = exitLegs.find((leg) => leg.venue_id === venue);
    fail(commitment(venueState?.account_commitment), `final_account_commitment_invalid:${venue}`);
    fail(opened?.account_commitment === venueState?.account_commitment, `entry_account_binding_mismatch:${venue}`);
    fail(closed?.account_commitment === venueState?.account_commitment, `exit_account_binding_mismatch:${venue}`);
    fail(venueState?.authorized === true, `venue_not_authorized:${venue}`);
    fail(venueState?.flat_zero_orders === true, `venue_flat_state_unproven:${venue}`);
    fail(venueState?.nonzero_position_count === 0, `venue_position_not_flat:${venue}`);
    fail(venueState?.open_order_count === 0, `venue_open_orders_not_zero:${venue}`);
    fail(venueState?.account_state_checked === true, `venue_account_state_unverified:${venue}`);
    const readinessVenue = readinessVenues.find((item) => item?.venue_id === venue);
    fail(readinessVenue?.account_commitment === venueState?.account_commitment,
      `three_venue_final_account_binding_mismatch:${venue}`);
  }

  verifyValueLedger({ ledger: evidence?.value_ledger, entryLegs, exitLegs, failures });
  fail(evidence?.evidence_commitment === carryEvidenceCommitment(evidence), "evidence_commitment_mismatch");

  if (failures.length > 0) {
    throw new Error(`Carry release evidence failed: ${[...new Set(failures)].join(", ")}`);
  }
  return {
    ok: true,
    evidence_commitment: evidence.evidence_commitment,
    position_id: position.position_id,
    venues: pair,
  };
}

export function carryEvidenceCommitment(evidence) {
  const payload = { ...evidence };
  delete payload.evidence_commitment;
  return `carryproof_${createHash("sha256").update(stableJson(payload)).digest("hex")}`;
}

export function assembleCarryReleaseEvidence({ material, candidate }) {
  const evidence = { ...structuredClone(material), candidate: structuredClone(candidate) };
  if (evidence.worker_material_commitment !== carryWorkerMaterialCommitment(evidence)) {
    throw new Error("Carry release material commitment mismatch");
  }
  evidence.evidence_commitment = carryEvidenceCommitment(evidence);
  return evidence;
}

export function carryWorkerMaterialCommitment(evidence) {
  const payload = { ...evidence };
  delete payload.candidate;
  delete payload.evidence_commitment;
  delete payload.worker_material_commitment;
  return `carry:release:material:${createHash("sha256").update(stableJson(payload)).digest("hex")}`;
}

function verifyExitTrigger({ trigger: rawTrigger, reason, exitRequestedAt, monitoringEndedAt, pair, signedMandate, fail }) {
  const trigger = rawTrigger && typeof rawTrigger === "object" ? rawTrigger : {};
  const kind = String(trigger.kind || "");
  const metric = String(trigger.metric || "");
  const observedAt = timestamp(trigger.observed_at);
  const observed = signedInteger(trigger.observed_value);
  const signedThreshold = signedInteger(trigger.signed_threshold_value);
  const effectiveThreshold = signedInteger(trigger.effective_threshold_value);
  const consecutiveObservations = trigger.consecutive_observation_count == null
    ? null
    : positiveInteger(trigger.consecutive_observation_count) || null;
  const venueId = trigger.venue_id == null ? null : String(trigger.venue_id || "");
  const status = trigger.status == null ? null : String(trigger.status || "");
  const mandate = signedMandate?.risk_mandate || {};

  fail(kind.length > 0, "exit_trigger_missing");
  fail(observedAt >= monitoringEndedAt && observedAt <= exitRequestedAt, "exit_trigger_timestamp_invalid");
  fail(trigger.transaction_broadcast === false, "exit_trigger_broadcast_detected");
  if (reason === "manual") {
    fail(kind === "owner_request" && metric === "owner_request" && observedAt === exitRequestedAt,
      "owner_exit_trigger_invalid");
    fail([observed, signedThreshold, effectiveThreshold, consecutiveObservations, venueId, status]
      .every((value) => value === null), "owner_exit_trigger_overclaimed");
    return;
  }
  if (reason === "funding_flip") {
    fail(kind === "net_carry_below_threshold" && metric === "expected_net_value_bps",
      "funding_exit_trigger_invalid");
    fail(signedThreshold === mandate.exit_net_value_bps && effectiveThreshold === signedThreshold,
      "funding_exit_threshold_mismatch");
    fail(observed !== null && observed <= effectiveThreshold, "funding_exit_observation_invalid");
    fail(consecutiveObservations !== null
      && consecutiveObservations >= positiveInteger(mandate.exit_after_consecutive_observations),
    "funding_exit_cadence_invalid");
    fail(venueId === null && status === null, "funding_exit_scope_invalid");
    return;
  }
  if (reason === "margin_runway") {
    fail(["margin_runway_below_threshold", "margin_runway_unverifiable"].includes(kind)
      && metric === "margin_runway_ms", "margin_exit_trigger_invalid");
    fail(pair.includes(venueId), "margin_exit_venue_invalid");
    fail(signedThreshold === mandate.min_margin_runway_ms && effectiveThreshold === signedThreshold,
      "margin_exit_threshold_mismatch");
    fail(["healthy", "warning", "critical", "breached", null].includes(status), "margin_exit_status_invalid");
    if (kind === "margin_runway_unverifiable") {
      fail(observed === null && status !== "healthy", "margin_exit_unverifiable_claim_invalid");
    } else {
      fail((observed !== null && observed < effectiveThreshold) || ["critical", "breached"].includes(status),
        "margin_exit_observation_invalid");
    }
    fail(consecutiveObservations === null, "margin_exit_cadence_overclaimed");
    return;
  }
  if (reason === "risk_mandate") {
    if (kind === "mandate_expired") {
      fail(metric === "expires_at_ms", "mandate_expiry_trigger_invalid");
      fail(signedThreshold === positiveInteger(signedMandate?.expires_at_ms)
        && effectiveThreshold === signedThreshold, "mandate_expiry_threshold_mismatch");
      fail(observed !== null && observed >= effectiveThreshold, "mandate_expiry_observation_invalid");
    } else {
      const limits = {
        contract_data_skew: ["contract_data_skew_ms", mandate.max_contract_data_skew_ms],
        index_basis: ["index_price_divergence_bps", mandate.max_index_price_divergence_bps],
        mark_basis: ["mark_price_divergence_bps", mandate.max_mark_price_divergence_bps],
      };
      const expected = limits[kind];
      fail(Array.isArray(expected) && metric === expected?.[0], "risk_exit_trigger_invalid");
      fail(signedThreshold === expected?.[1] && effectiveThreshold !== null
        && effectiveThreshold <= signedThreshold, "risk_exit_threshold_mismatch");
      fail(observed !== null && observed > effectiveThreshold, "risk_exit_observation_invalid");
    }
    fail(consecutiveObservations === null && venueId === null && status === null,
      "risk_exit_scope_invalid");
  }
}

function verifyLegs({ legs, pair, longVenue, reduceOnly, failures, phase }) {
  const values = array(legs);
  if (!sameVenueSet(values, pair)) failures.push(`${phase}_venues_mismatch`);
  for (const leg of values) {
    const venue = String(leg?.venue_id || "");
    const expectedSide = phase === "entry"
      ? venue === longVenue ? "buy" : "sell"
      : venue === longVenue ? "sell" : "buy";
    if (leg?.side !== expectedSide) failures.push(`${phase}_side_invalid:${venue}`);
    if (leg?.reduce_only !== reduceOnly) failures.push(`${phase}_reduce_only_invalid:${venue}`);
    if (leg?.submit_count !== 1) failures.push(`${phase}_single_submit_required:${venue}`);
    if (leg?.ambiguity_retry_count !== 0) failures.push(`${phase}_ambiguity_retry_forbidden:${venue}`);
    if (leg?.live_order_broadcast !== true) failures.push(`${phase}_live_broadcast_unproven:${venue}`);
    if (leg?.target_client_order_matched !== true) failures.push(`${phase}_target_order_unproven:${venue}`);
    if (leg?.final_venue_execution_proven !== true) failures.push(`${phase}_terminal_execution_unproven:${venue}`);
    if (!positiveDecimal(leg?.filled_base_size)) failures.push(`${phase}_fill_missing:${venue}`);
    if (!commitment(leg?.account_commitment)) failures.push(`${phase}_account_commitment_invalid:${venue}`);
    if (!commitment(leg?.client_order_commitment)) failures.push(`${phase}_client_order_commitment_invalid:${venue}`);
    if (!commitment(leg?.receipt_commitment)) failures.push(`${phase}_receipt_commitment_missing:${venue}`);
    if (signedInteger(leg?.funding_micro_usdc) === null) failures.push(`${phase}_funding_invalid:${venue}`);
    if (nonNegativeInteger(leg?.fee_micro_usdc) === null) failures.push(`${phase}_fee_invalid:${venue}`);
    if (nonNegativeInteger(leg?.slippage_micro_usdc) === null) failures.push(`${phase}_slippage_invalid:${venue}`);
  }
  return values;
}

function verifyValueLedger({ ledger, entryLegs, exitLegs, failures }) {
  const modeled = ledger?.modeled || {};
  const realized = ledger?.realized || {};
  const gross = nonNegativeInteger(modeled.gross_funding_micro_usdc);
  const modeledCosts = nonNegativeInteger(modeled.total_cost_micro_usdc);
  const expectedNet = signedInteger(modeled.expected_net_micro_usdc);
  if (gross === null || modeledCosts === null || expectedNet === null || expectedNet <= 0 || gross - modeledCosts !== expectedNet) {
    failures.push("modeled_value_invalid");
  }
  const pnl = signedInteger(realized.contract_pnl_micro_usdc);
  const funding = signedInteger(realized.funding_micro_usdc);
  const fees = nonNegativeInteger(realized.fees_micro_usdc);
  const slippage = nonNegativeInteger(realized.slippage_micro_usdc);
  const gas = nonNegativeInteger(realized.gas_micro_usdc);
  const capital = nonNegativeInteger(realized.capital_cost_micro_usdc);
  const transfers = nonNegativeInteger(realized.transfer_fees_micro_usdc);
  const rebates = nonNegativeInteger(realized.rebates_micro_usdc);
  const net = signedInteger(realized.net_value_micro_usdc);
  if ([pnl, funding, fees, slippage, gas, capital, transfers, rebates, net].some((value) => value === null)) {
    failures.push("realized_value_invalid");
  } else if (pnl + funding + rebates - fees - slippage - gas - capital - transfers !== net) {
    failures.push("realized_net_value_mismatch");
  }
  const legFees = [...entryLegs, ...exitLegs].reduce((sum, leg) => sum + (nonNegativeInteger(leg?.fee_micro_usdc) ?? 0), 0);
  const legSlippage = [...entryLegs, ...exitLegs].reduce((sum, leg) => sum + (nonNegativeInteger(leg?.slippage_micro_usdc) ?? 0), 0);
  const legFunding = [...entryLegs, ...exitLegs].reduce((sum, leg) => sum + (signedInteger(leg?.funding_micro_usdc) ?? 0), 0);
  if (funding !== legFunding) failures.push("realized_funding_evidence_mismatch");
  if (fees !== legFees) failures.push("realized_fee_evidence_mismatch");
  if (slippage !== legSlippage) failures.push("realized_slippage_evidence_mismatch");
  if (ledger?.finalized !== true || ledger?.complete_costs !== true || !commitment(ledger?.evidence_commitment)) {
    failures.push("value_ledger_incomplete");
  }
}

function sameVenueSet(rows, pair) {
  const venues = array(rows).map((row) => String(row?.venue_id || ""));
  return venues.length === pair.length && new Set(venues).size === pair.length && pair.every((venue) => venues.includes(venue));
}

function sameStrings(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function sameRecord(left, right) {
  if (!left || typeof left !== "object" || Array.isArray(left)) return false;
  const entries = Object.entries(right || {});
  return Object.keys(left).length === entries.length
    && entries.every(([key, value]) => left[key] === value);
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(",")}}`;
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function timestamp(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function signedInteger(value) {
  return Number.isSafeInteger(value) ? value : null;
}

function positiveDecimal(value) {
  return /^\d+(?:\.\d+)?$/.test(String(value || "")) && Number(value) > 0;
}

function equalPositiveDecimal(left, right) {
  const a = scaledDecimal(left, 18);
  const b = scaledDecimal(right, 18);
  return a !== null && a > 0n && a === b;
}

function scaledDecimal(value, scale) {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(String(value || ""));
  if (!match || (match[2]?.length || 0) > scale) return null;
  return BigInt(match[1]) * (10n ** BigInt(scale)) + BigInt((match[2] || "").padEnd(scale, "0") || "0");
}

function identifier(value) {
  return /^[A-Za-z0-9:_-]{8,180}$/.test(String(value || ""));
}

function commitment(value) {
  return identifier(value);
}

async function main() {
  const evidencePath = resolve(process.env.GHOLA_CARRY_RELEASE_EVIDENCE_PATH || DEFAULT_CARRY_EVIDENCE_PATH);
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
  const verified = await verifyCarryReleaseEvidence(evidence);
  console.log(`[carry-release-evidence] verified ${verified.evidence_commitment}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
