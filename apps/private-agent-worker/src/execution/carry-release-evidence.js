import { createHash } from "node:crypto";
import {
  CARRY_EXECUTION_VENUES,
  CARRY_RECOVERY_POLICY,
  normalizeCarryLifecycleValueAttribution,
} from "@ghola/execution-core";
import { readCarryVenueQualification, runtimeCarryQualificationImageDigest } from "./carry-qualification.js";
import { verifyCarryRiskMandateAuthorization } from "./carry-mandate.js";
import {
  carryPositionLegId,
  validateCarryCreationInputEvidence,
  verifyStoredCarryOpportunityBinding,
} from "./carry-positions.js";
import { assessCarryFlatReconciliation } from "./carry-reconciliation.js";
import {
  carryAccountStateCommitment,
  readCarryExecutionReadiness,
  verifyCarryExecutionReadinessResult,
} from "./carry-readiness.js";
import { readCarryShadowQualification } from "./carry-shadow-qualification.js";
import { loadCarryTransferRouteEvidence } from "./carry-transfer-routes.js";
import { liquidationDistanceSourceForVenue } from "../venues/liquidation-distance.js";

const DEFAULT_LIFECYCLE_PROOF_MAX_AGE_MS = 90 * 86_400_000;
const MAX_LIFECYCLE_PROOFS_PER_ASSET = 64;

export async function recordCompletedCarryLifecycleProof({
  state,
  owner_commitment: ownerCommitment,
  position_id: positionId,
  env = process.env,
  now_ms: nowMs = Date.now(),
}) {
  if (typeof state?.putIdempotency !== "function" || typeof state?.getIdempotency !== "function") {
    return denied("carry_lifecycle_proof_state_unavailable");
  }
  const imageDigest = runtimeCarryQualificationImageDigest(env);
  if (!imageDigest) return denied("carry_lifecycle_proof_image_missing");
  const completed = await buildCompletedCarryReleaseMaterial({
    state,
    owner_commitment: ownerCommitment,
    position_id: positionId,
    env,
    now_ms: nowMs,
  });
  if (!completed.ok) return completed;
  const material = completed.material;
  const venueIds = [material.position.long_venue_id, material.position.short_venue_id];
  const proof = {
    version: 1,
    kind: "ghola_carry_live_paired_lifecycle_proof",
    network: "mainnet",
    owner_commitment: ownerCommitment,
    worker_image_digest: imageDigest,
    position_id: material.position.position_id,
    asset: material.position.asset,
    venue_ids: venueIds,
    account_commitments: Object.fromEntries(material.final_state.venues.map((venue) => [
      venue.venue_id,
      venue.account_commitment,
    ])),
    verified_at_ms: nowMs,
    expires_at_ms: nowMs + lifecycleProofMaxAge(env),
    live_entry_exit_proven: true,
    supervised_monitoring_proven: true,
    final_flat_zero_orders: true,
    value_ledger_finalized: true,
    collateral_route_coverage_proven: true,
    collateral_route_evidence_commitment: material.collateral_route_readiness.evidence_commitment,
    creation_input_evidence_commitment: material.creation_input_evidence.evidence_commitment,
    ambiguity_retry_count: 0,
    owner_only_funding: true,
    owner_only_transfers: true,
    owner_only_withdrawals: true,
    recording_transaction_broadcast: false,
    realized_net_value_micro_usdc: material.value_ledger.realized.net_value_micro_usdc,
    value_attribution: lifecycleValueAttribution(material.value_ledger),
    worker_material_commitment: material.worker_material_commitment,
  };
  proof.evidence_commitment = lifecycleProofCommitment(proof);
  const assessed = assessCompletedCarryLifecycleProof({
    proof,
    owner_commitment: ownerCommitment,
    image_digest: imageDigest,
    asset: material.position.asset,
    position_id: material.position.position_id,
    now_ms: nowMs,
  });
  if (!assessed.ok) return assessed;
  if (typeof state?.claimIdempotency !== "function") {
    return denied("carry_lifecycle_proof_reference_claim_unavailable");
  }
  const proofKey = carryLifecycleProofKey(
    ownerCommitment,
    imageDigest,
    material.position.asset,
    material.position.position_id,
    venueIds,
  );
  const proofClaim = await state.claimIdempotency(proofKey, structuredClone(proof));
  const persistedProof = proofClaim?.ok ? proofClaim.receipt : proofClaim?.existing;
  const persistedAssessment = assessCompletedCarryLifecycleProof({
    proof: persistedProof,
    owner_commitment: ownerCommitment,
    image_digest: imageDigest,
    asset: material.position.asset,
    position_id: material.position.position_id,
    now_ms: nowMs,
  });
  if (!persistedAssessment.ok || !sameLifecycleProofSemantics(persistedProof, proof)) {
    return denied("carry_lifecycle_proof_conflict");
  }
  const referenceKey = carryLifecycleProofReferenceKey(
    ownerCommitment,
    imageDigest,
    material.position.asset,
    material.position.position_id,
  );
  const reference = lifecycleProofReference({
    proof: persistedProof,
    ownerCommitment,
    imageDigest,
    asset: material.position.asset,
  });
  const claim = await state.claimIdempotency(referenceKey, structuredClone(reference));
  const persistedReference = claim?.ok ? claim.receipt : claim?.existing;
  if (!validLifecycleProofReference(persistedReference, {
    ownerCommitment,
    imageDigest,
    asset: material.position.asset,
    positionId: material.position.position_id,
  }) || stableJson(persistedReference) !== stableJson(reference)) {
    return denied("carry_lifecycle_proof_reference_conflict");
  }
  await state.putIdempotency(
    legacyCarryLifecycleProofKey(ownerCommitment, imageDigest, material.position.asset),
    structuredClone(persistedProof),
  );
  return { ok: true, proof: persistedAssessment.proof };
}

export async function readCompletedCarryLifecycleProof({
  state,
  owner_commitment: ownerCommitment,
  asset,
  position_id: positionId,
  env = process.env,
  now_ms: nowMs = Date.now(),
}) {
  const imageDigest = runtimeCarryQualificationImageDigest(env);
  if (!imageDigest) return denied("carry_lifecycle_proof_image_missing");
  const normalizedAsset = String(asset || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{1,20}$/.test(normalizedAsset)) return denied("carry_lifecycle_proof_asset_invalid");
  if (positionId != null && !commitment(positionId)) return denied("carry_lifecycle_proof_position_invalid");
  if (typeof state?.getIdempotency !== "function") return denied("carry_lifecycle_proof_state_unavailable");
  let storedReference = positionId
    ? (await state.getIdempotency(carryLifecycleProofReferenceKey(
        ownerCommitment,
        imageDigest,
        normalizedAsset,
        positionId,
      )))?.receipt
    : null;
  let referenceFormat = storedReference
    ? lifecycleProofReferenceFormat(storedReference, {
        ownerCommitment,
        imageDigest,
        asset: normalizedAsset,
        positionId,
      })
    : "";
  if (storedReference && !referenceFormat) {
    return denied("carry_lifecycle_proof_reference_invalid");
  }
  let stored;
  let migratableLegacyEntry = null;
  if (storedReference) {
    stored = await state.getIdempotency(storedReference.proof_key);
  } else {
    const legacyIndex = (await state.getIdempotency(
      carryLifecycleProofIndexKey(ownerCommitment, imageDigest, normalizedAsset),
    ))?.receipt;
    const legacyIndexValid = legacyIndex && validLifecycleProofIndex(legacyIndex, {
      ownerCommitment,
      imageDigest,
      asset: normalizedAsset,
    });
    if (legacyIndex && !legacyIndexValid) {
      return denied("carry_lifecycle_proof_legacy_index_invalid");
    }
    const legacyEntry = legacyIndexValid
      ? legacyIndex.entries.find((entry) => !positionId || entry.position_id === positionId)
      : null;
    if (legacyIndexValid && positionId && !legacyEntry) {
      return denied("carry_lifecycle_proof_missing");
    }
    migratableLegacyEntry = legacyEntry || null;
    stored = legacyEntry
      ? await state.getIdempotency(legacyEntry.proof_key)
      : await state.getIdempotency(legacyCarryLifecycleProofKey(ownerCommitment, imageDigest, normalizedAsset));
    if (legacyEntry && !legacyEntryMatchesProof(legacyEntry, stored?.receipt)) {
      return denied("carry_lifecycle_proof_legacy_index_mismatch");
    }
    if (positionId && stored?.receipt?.position_id !== positionId) {
      return denied("carry_lifecycle_proof_missing");
    }
  }
  let assessed = assessCompletedCarryLifecycleProof({
    proof: stored?.receipt,
    owner_commitment: ownerCommitment,
    image_digest: imageDigest,
    asset: normalizedAsset,
    position_id: storedReference?.position_id || positionId,
    now_ms: nowMs,
  });
  if (!assessed.ok) return assessed;
  if (!storedReference) {
    const derivedReferenceKey = carryLifecycleProofReferenceKey(
      ownerCommitment,
      imageDigest,
      normalizedAsset,
      assessed.proof.position_id,
    );
    const derivedReference = (await state.getIdempotency(derivedReferenceKey))?.receipt;
    if (derivedReference) {
      referenceFormat = lifecycleProofReferenceFormat(derivedReference, {
        ownerCommitment,
        imageDigest,
        asset: normalizedAsset,
        positionId: assessed.proof.position_id,
      });
      if (!referenceFormat) return denied("carry_lifecycle_proof_reference_invalid");
      const referencedStored = await state.getIdempotency(derivedReference.proof_key);
      const referencedAssessment = assessCompletedCarryLifecycleProof({
        proof: referencedStored?.receipt,
        owner_commitment: ownerCommitment,
        image_digest: imageDigest,
        asset: normalizedAsset,
        position_id: assessed.proof.position_id,
        now_ms: nowMs,
      });
      if (!referencedAssessment.ok
        || stableJson(referencedAssessment.proof) !== stableJson(assessed.proof)
        || !lifecycleReferenceMatchesProof(derivedReference, referencedAssessment.proof, referenceFormat)) {
        return denied("carry_lifecycle_proof_reference_mismatch");
      }
      storedReference = derivedReference;
      assessed = referencedAssessment;
    } else if (migratableLegacyEntry) {
      if (typeof state?.claimIdempotency !== "function") {
        return denied("carry_lifecycle_proof_reference_claim_unavailable");
      }
      const reference = lifecycleProofReference({
        proof: assessed.proof,
        ownerCommitment,
        imageDigest,
        asset: normalizedAsset,
      });
      const claim = await state.claimIdempotency(
        derivedReferenceKey,
        structuredClone(reference),
      );
      const persisted = claim?.ok ? claim.receipt : claim?.existing;
      if (!validLifecycleProofReference(persisted, {
        ownerCommitment,
        imageDigest,
        asset: normalizedAsset,
        positionId: assessed.proof.position_id,
      }) || stableJson(persisted) !== stableJson(reference)
        || !lifecycleProofReferenceMatchesProof(persisted, assessed.proof)) {
        return denied("carry_lifecycle_proof_reference_conflict");
      }
      storedReference = persisted;
      referenceFormat = "current";
    } else {
      if (!positionId) {
        if (typeof state?.hasIdempotencyReceipt !== "function") {
          return denied("carry_lifecycle_proof_reference_lookup_unavailable");
        }
        const anyReference = await state.hasIdempotencyReceipt({
          kind: "ghola_carry_lifecycle_proof_reference",
          owner_commitment: ownerCommitment,
          worker_image_digest: imageDigest,
          asset: normalizedAsset,
        });
        if (anyReference) return denied("carry_lifecycle_proof_reference_mismatch");
      }
      const [currentPairProof, legacyJsonPairProof] = await Promise.all([
        state.getIdempotency(carryLifecycleProofKey(
          ownerCommitment,
          imageDigest,
          normalizedAsset,
          assessed.proof.position_id,
          assessed.proof.venue_ids,
        )),
        state.getIdempotency(legacyJsonPairCarryLifecycleProofKey(
          ownerCommitment,
          imageDigest,
          normalizedAsset,
          assessed.proof.position_id,
          assessed.proof.venue_ids,
        )),
      ]);
      if (currentPairProof?.receipt || legacyJsonPairProof?.receipt) {
        return denied("carry_lifecycle_proof_reference_missing");
      }
      return assessed;
    }
  }
  return lifecycleReferenceMatchesProof(storedReference, assessed.proof, referenceFormat)
    ? assessed
    : denied("carry_lifecycle_proof_reference_mismatch");
}

export function assessCompletedCarryLifecycleProof({
  proof,
  owner_commitment: ownerCommitment,
  image_digest: imageDigest,
  asset,
  position_id: positionId,
  now_ms: nowMs = Date.now(),
}) {
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) return denied("carry_lifecycle_proof_missing");
  const venueIds = Array.isArray(proof.venue_ids) ? proof.venue_ids : [];
  const accountCommitments = proof.account_commitments && typeof proof.account_commitments === "object"
    ? proof.account_commitments
    : {};
  const valueAttribution = safeLifecycleValueAttribution(proof.value_attribution);
  const valid = proof.version === 1
    && proof.kind === "ghola_carry_live_paired_lifecycle_proof"
    && proof.network === "mainnet"
    && proof.owner_commitment === ownerCommitment
    && proof.worker_image_digest === imageDigest
    && (!asset || proof.asset === String(asset).trim().toUpperCase())
    && (!positionId || proof.position_id === positionId)
    && commitment(proof.position_id)
    && /^[A-Z0-9]{1,20}$/.test(String(proof.asset || ""))
    && venueIds.length === 2
    && new Set(venueIds).size === 2
    && venueIds.every((venueId) => commitment(venueId) && commitment(accountCommitments[venueId]))
    && positiveInteger(proof.verified_at_ms)
    && proof.verified_at_ms <= nowMs + 5_000
    && positiveInteger(proof.expires_at_ms)
    && proof.expires_at_ms > nowMs
    && proof.expires_at_ms > proof.verified_at_ms
    && proof.expires_at_ms - proof.verified_at_ms <= 365 * 86_400_000
    && proof.live_entry_exit_proven === true
    && proof.supervised_monitoring_proven === true
    && proof.final_flat_zero_orders === true
    && proof.value_ledger_finalized === true
    && proof.collateral_route_coverage_proven === true
    && /^carry:transfer-routes:evidence:[0-9a-f]{40}$/.test(String(proof.collateral_route_evidence_commitment || ""))
    && /^carry:creation-inputs:[0-9a-f]{64}$/.test(String(proof.creation_input_evidence_commitment || ""))
    && proof.ambiguity_retry_count === 0
    && proof.owner_only_funding === true
    && proof.owner_only_transfers === true
    && proof.owner_only_withdrawals === true
    && proof.recording_transaction_broadcast === false
    && Number.isSafeInteger(proof.realized_net_value_micro_usdc)
    && valueAttribution?.realized.net_value_micro_usdc === proof.realized_net_value_micro_usdc
    && valueAttribution?.realized_total_cost_micro_usdc === proof.value_attribution?.realized_total_cost_micro_usdc
    && /^carry:release:material:[0-9a-f]{64}$/.test(String(proof.worker_material_commitment || ""))
    && proof.evidence_commitment === lifecycleProofCommitment(proof);
  if (!valid) return denied("carry_lifecycle_proof_invalid");
  return { ok: true, proof: Object.freeze(structuredClone(proof)) };
}

export function carryLifecycleProofKey(ownerCommitment, imageDigest, asset, positionId, venueIds) {
  if (arguments.length === 3) return legacyCarryLifecycleProofKey(ownerCommitment, imageDigest, asset);
  const pair = normalizedVenuePair(venueIds);
  return `carry:lifecycle-proof:${digest([
    ownerCommitment,
    imageDigest,
    String(asset || "").toUpperCase(),
    String(positionId || ""),
    pair,
  ].join("\0")).slice(0, 40)}`;
}

export function carryLifecycleProofReferenceKey(ownerCommitment, imageDigest, asset, positionId) {
  return `carry:lifecycle-proof-reference:${digest([
    ownerCommitment,
    imageDigest,
    String(asset || "").toUpperCase(),
    String(positionId || ""),
  ].join("\0")).slice(0, 40)}`;
}

export function carryLifecycleProofIndexKey(ownerCommitment, imageDigest, asset) {
  return `carry:lifecycle-proof-index:${digest(`${ownerCommitment}\0${imageDigest}\0${String(asset || "").toUpperCase()}`).slice(0, 40)}`;
}

export async function buildCompletedCarryReleaseMaterial({
  state,
  owner_commitment: ownerCommitment,
  position_id: positionId,
  env = process.env,
  now_ms: nowMs = Date.now(),
}) {
  const record = await state?.getCarryPositionRecord?.(String(positionId || ""));
  if (!record) return denied("carry_position_not_found");
  if (record.owner_commitment !== ownerCommitment) return denied("carry_position_owner_mismatch");
  const storedOpportunity = verifyStoredCarryOpportunityBinding({ record });
  if (!storedOpportunity.ok) return denied("carry_release_opportunity_provenance_unproven");
  const mandate = await verifyCarryRiskMandateAuthorization({
    owner_commitment: ownerCommitment,
    position_input: record.position,
    now_ms: record.position?.created_at_ms,
  });
  if (!mandate.ok) return denied("carry_release_signed_mandate_unproven");
  if (record.position?.status !== "reconciled") return denied("carry_release_position_not_reconciled");
  if (record.value_ledger?.status !== "finalized" || record.value_evidence?.costs_complete !== true) {
    return denied("carry_release_value_ledger_incomplete");
  }
  const contractEquivalence = releaseContractEquivalence(record.opportunity);
  if (!contractEquivalence.ok) return contractEquivalence;
  const creationInputEvidence = releaseCreationInputEvidence(record.position, record.opportunity?.input_evidence);
  if (!creationInputEvidence.ok) return creationInputEvidence;
  const shadowQualification = await readCarryShadowQualification({
    state,
    now_ms: nowMs,
    env,
  });
  if (!shadowQualification.ready || !shadowQualification.release_bound) {
    return denied("carry_release_shadow_qualification_unproven");
  }
  const executionReadiness = await readCarryExecutionReadiness({
    state,
    owner_commitment: ownerCommitment,
    venue_access: record.monitoring_context?.venue_access,
    asset: record.position.asset,
    notional_usd: String(record.position.target_notional_micro_usdc / 1_000_000),
    horizon_days: String(Math.max(1, Math.ceil(Number(record.opportunity?.horizon_ms || 86_400_000) / 86_400_000))),
    now_ms: record.position.created_at_ms,
    env,
  });
  const assessedExecutionReadiness = verifyCarryExecutionReadinessResult(executionReadiness, {
    now_ms: record.position.created_at_ms,
  });
  if (!assessedExecutionReadiness.ok
    || executionReadiness.recovery_ready !== true
    || !sameStrings(executionReadiness.recovery_venue_ids, CARRY_EXECUTION_VENUES)
    || !sameRecord(executionReadiness.recovery_policy, CARRY_RECOVERY_POLICY)) {
    return denied("carry_release_three_venue_readiness_unproven");
  }
  const routeEvidence = await loadCarryTransferRouteEvidence({
    state,
    owner_commitment: ownerCommitment,
    now_ms: nowMs,
    max_data_age_ms: 30_000,
    expected_worker_image_digest: runtimeCarryQualificationImageDigest(env),
  });
  const collateralRouteReadiness = releaseCollateralRouteReadiness({
    route_evidence: routeEvidence,
    monitoring_context: record.monitoring_context,
    minimum_checked_at_ms: record.final_reconciliation_evidence?.checked_at_ms,
  });
  if (!collateralRouteReadiness.ok) return collateralRouteReadiness;
  const finalState = record.final_reconciliation_evidence;
  const pair = [record.position.long_venue_id, record.position.short_venue_id];
  const accountCommitments = Object.fromEntries(pair.map((venueId) => [
    venueId,
    record.monitoring_context?.venue_access?.[venueId]?.account_commitment,
  ]));
  const finalAssessment = assessCarryFlatReconciliation({
    evidence: finalState,
    venue_ids: pair,
    owner_commitment: record.owner_commitment,
    carry_position_id: record.position.position_id,
    account_commitments: accountCommitments,
  });
  if (!finalAssessment.flat) return denied("carry_release_final_state_unproven");
  const [entrySaga, exitSaga] = await Promise.all([
    state.getMultiLegSaga?.(record.entry_saga_id),
    state.getMultiLegSaga?.(record.exit_saga_id),
  ]);
  if (entrySaga?.status !== "reconciled" || exitSaga?.status !== "reconciled") {
    return denied("carry_release_sagas_not_reconciled");
  }
  const entryReconciledAt = entrySaga.updated_at_ms;
  const events = Array.isArray(record.lifecycle_events) ? record.lifecycle_events : [];
  if (events.some((event) => ["submission_ambiguous", "recovery_failed"].includes(event?.type))) {
    return denied("carry_release_ambiguous_or_recovered_lifecycle");
  }
  const exitRequest = [...events].reverse().find((event) => event?.type === "manual_exit_requested");
  const exitRequestedAt = exitRequest?.recorded_at_ms || exitSaga.created_at_ms;
  const monitoringFailures = events.filter((event) => ["observation_unavailable", "mandate_invalid"].includes(event?.type)
    && positiveInteger(event.recorded_at_ms)
    && event.recorded_at_ms >= entryReconciledAt
    && event.recorded_at_ms <= exitRequestedAt);
  if (monitoringFailures.length > 0) return denied("carry_release_monitoring_failure_detected");
  const observations = events.filter((event) => event?.type === "observation" && positiveInteger(event.recorded_at_ms));
  if (observations.length === 0) return denied("carry_release_monitoring_evidence_missing");
  const supervisedObservations = observations.filter((event) => event?.observation_source === "supervised_loop");
  if (supervisedObservations.length === 0) return denied("carry_release_supervised_monitoring_missing");
  if (supervisedObservations.length < 2) return denied("carry_release_supervised_monitoring_insufficient");
  supervisedObservations.sort((left, right) => left.recorded_at_ms - right.recorded_at_ms);
  const latestObservation = supervisedObservations.at(-1);
  const observationTimes = supervisedObservations.map((event) => event.recorded_at_ms);
  const observationGaps = [
    observationTimes[0] - entryReconciledAt,
    ...observationTimes.slice(1).map((value, index) => value - observationTimes[index]),
    exitRequestedAt - observationTimes.at(-1),
  ];
  const maxAllowedObservationGapMs = record.position.risk_mandate.max_data_age_ms;
  const maxObservationGapMs = Math.max(...observationGaps);
  if (observationGaps.some((value) => value < 0)
    || !positiveInteger(maxAllowedObservationGapMs)
    || maxObservationGapMs > maxAllowedObservationGapMs) {
    return denied("carry_release_monitoring_cadence_exceeded");
  }
  const fundingObservations = releaseFundingObservations({
    observations: supervisedObservations,
    venue_ids: pair,
    max_age_ms: maxAllowedObservationGapMs,
  });
  if (!fundingObservations.ok) return fundingObservations;
  const monitoredRunways = supervisedObservations.map((observation) => releaseMarginRunways({
    observation,
    venue_ids: pair,
    position: record.position,
    monitoring_context: record.monitoring_context,
  }));
  const invalidRunways = monitoredRunways.find((result) => !result.ok);
  if (invalidRunways) return invalidRunways;
  const marginRunways = monitoredRunways.at(-1).runways;
  const exitTrigger = releaseExitTrigger({
    exit_request: exitRequest,
    exit_requested_at_ms: exitRequestedAt,
    observations: supervisedObservations,
    position: record.position,
  });
  if (!exitTrigger.ok) return exitTrigger;
  const qualifications = await Promise.all(pair.map((venueId) => readCarryVenueQualification({
    state,
    venue_id: venueId,
    now_ms: nowMs,
    env,
  })));
  if (!qualifications.every((qualification) => qualification.proven === true)) {
    return denied("carry_release_qualification_unproven");
  }
  const [entryLegs, exitLegs] = await Promise.all([
    materialLegs({ state, saga: entrySaga, record, phase: "entry" }),
    materialLegs({ state, saga: exitSaga, record, phase: "exit" }),
  ]);
  if (!entryLegs.ok) return entryLegs;
  if (!exitLegs.ok) return exitLegs;
  const monitoringEndedAt = latestObservation.recorded_at_ms;
  if (monitoringEndedAt <= entryReconciledAt) return denied("carry_release_monitoring_period_missing");
  if (!positiveInteger(exitRequestedAt) || exitRequestedAt < monitoringEndedAt) {
    return denied("carry_release_exit_timestamp_invalid");
  }

  const material = {
    version: 1,
    kind: "ghola_cross_venue_carry_mainnet_lifecycle_proof",
    network: "mainnet",
    request: { ambiguity_retry_performed: false },
    position: {
      position_id: record.position.position_id,
      asset: record.position.asset,
      target_notional_micro_usdc: record.position.target_notional_micro_usdc,
      long_venue_id: record.position.long_venue_id,
      short_venue_id: record.position.short_venue_id,
      created_at: iso(record.position.created_at_ms),
    },
    contract_equivalence: contractEquivalence.evidence,
    creation_input_evidence: creationInputEvidence.evidence,
    shadow_qualification: {
      proven: true,
      image_digest: shadowQualification.image_digest,
      checked_at: iso(shadowQualification.checked_at_ms),
      venues: shadowQualification.venues,
      assets: shadowQualification.assets,
      requested_assets: shadowQualification.requested_assets,
      required_samples: shadowQualification.required_samples,
      completed_samples: shadowQualification.completed_samples,
      minimum_span_ms: shadowQualification.minimum_span_ms,
      duration_ms: shadowQualification.duration_ms,
      expected_snapshots_per_sample: shadowQualification.expected_snapshots_per_sample,
      sample_commitments: shadowQualification.sample_commitments,
      source_observation_commitments: shadowQualification.source_observation_commitments,
      transaction_broadcast: false,
      evidence_commitment: shadowQualification.evidence_commitment,
    },
    execution_readiness: releaseExecutionReadiness({
      readiness: assessedExecutionReadiness.readiness,
      monitoring_context: record.monitoring_context,
    }),
    collateral_route_readiness: collateralRouteReadiness.evidence,
    mandate: {
      policy_commitment: mandate.authorization.mandate_commitment,
      signed_mandate: mandate.authorization.signed_mandate,
      owner_signature: mandate.authorization.signature,
      ai_execution_authority: false,
      funding_owner_only: true,
      transfers_owner_only: true,
      withdrawals_owner_only: true,
    },
    qualification: {
      venues: qualifications.map((qualification) => ({
        venue_id: qualification.venue_id,
        proven: true,
        adapter_id: qualification.adapter_id,
        image_digest: qualification.image_digest,
        source: qualification.source,
        no_submit_ready: true,
        transaction_broadcast: false,
        evidence_commitment: qualification.evidence_commitment || `qualification:${qualification.venue_id}:registry`,
      })),
    },
    entry: {
      started_at: iso(entrySaga.created_at_ms),
      reconciled_at: iso(entrySaga.updated_at_ms),
      legs: entryLegs.legs,
    },
    monitoring: {
      started_at: iso(entryReconciledAt),
      ended_at: iso(monitoringEndedAt),
      observation_count: supervisedObservations.length,
      funding_flip_checks: supervisedObservations.length,
      funding_observations: fundingObservations.observations,
      supervision: {
        mode: "attested_worker_loop",
        automatic_observation_count: supervisedObservations.length,
        first_automatic_observed_at: iso(supervisedObservations[0].recorded_at_ms),
        last_automatic_observed_at: iso(monitoringEndedAt),
        max_observation_gap_ms: maxObservationGapMs,
        max_allowed_gap_ms: maxAllowedObservationGapMs,
        failure_count: 0,
        transaction_broadcast: false,
      },
      margin_runways: marginRunways,
    },
    exit: {
      reason: exitTrigger.reason,
      trigger: exitTrigger.evidence,
      requested_at: iso(exitRequestedAt),
      reconciled_at: iso(exitSaga.updated_at_ms),
      legs: exitLegs.legs,
    },
    final_state: {
      owner_commitment: record.owner_commitment,
      carry_position_id: record.position.position_id,
      checked_at: iso(finalState.checked_at_ms),
      gross_exposure_micro_usdc: 0,
      open_order_count: 0,
      venues: finalAssessment.venues.map((item) => ({
        venue_id: item.venue_id,
        account_commitment: item.account_commitment,
        authorized: true,
        flat_zero_orders: true,
        nonzero_position_count: item.position_count,
        open_order_count: item.open_order_count,
        account_state_checked: true,
      })),
    },
    value_ledger: releaseValueLedger(record),
  };
  material.worker_material_commitment = workerMaterialCommitment(material);
  return { ok: true, material };
}

function releaseCollateralRouteReadiness({
  route_evidence: routeEvidence,
  monitoring_context: monitoringContext,
  minimum_checked_at_ms: minimumCheckedAtMs,
}) {
  if (routeEvidence?.ok !== true || !Array.isArray(routeEvidence.routes)) {
    return denied("carry_release_collateral_routes_unproven");
  }
  const routes = routeEvidence.routes;
  const requiredPairs = CARRY_EXECUTION_VENUES.flatMap((fromVenueId) => CARRY_EXECUTION_VENUES
    .filter((toVenueId) => toVenueId !== fromVenueId)
    .map((toVenueId) => `${fromVenueId}:${toVenueId}`));
  const routePairs = routes.map((route) => `${route.from_venue_id}:${route.to_venue_id}`);
  const accountByVenue = new Map();
  for (const route of routes) {
    for (const [venueId, accountCommitment] of [
      [route.from_venue_id, route.from_account_commitment],
      [route.to_venue_id, route.to_account_commitment],
    ]) {
      const existing = accountByVenue.get(venueId);
      if (existing && existing !== accountCommitment) {
        return denied("carry_release_collateral_route_account_ambiguous");
      }
      accountByVenue.set(venueId, accountCommitment);
    }
  }
  const monitoringAccounts = new Map(Object.entries(monitoringContext?.venue_access || {})
    .map(([venueId, access]) => [venueId, access?.account_commitment]));
  const valid = routes.length === requiredPairs.length
    && positiveInteger(minimumCheckedAtMs)
    && routeEvidence.evidence.checked_at_ms >= minimumCheckedAtMs
    && routeEvidence.evidence.checked_at_ms - minimumCheckedAtMs <= 30_000
    && new Set(routePairs).size === requiredPairs.length
    && requiredPairs.every((pair) => routePairs.includes(pair))
    && routes.every((route) => route.status === "available"
      && route.quote_verified === true
      && route.all_in_fee_verified === true
      && route.valuation_basis_verified === true
      && Number.isSafeInteger(route.maximum_transfer_micro_usdc)
      && route.maximum_transfer_micro_usdc > 0
      && Number.isSafeInteger(route.estimated_latency_ms)
      && route.owner_approval_required === true
      && route.fund_movement_authorized === false
      && route.transaction_broadcast === false
      && route.automatic_transfer_permitted === false)
    && CARRY_EXECUTION_VENUES.every((venueId) => accountByVenue.get(venueId)
      && accountByVenue.get(venueId) === monitoringAccounts.get(venueId));
  if (!valid) return denied("carry_release_collateral_route_coverage_incomplete");
  const evidence = routeEvidence.evidence;
  return {
    ok: true,
    evidence: Object.freeze({
      proven: true,
      checked_at: iso(evidence.checked_at_ms),
      expires_at: iso(evidence.expires_at_ms),
      required_route_count: requiredPairs.length,
      available_route_count: routes.length,
      complete_directed_coverage: true,
      route_pairs: Object.freeze([...requiredPairs].sort()),
      venues: Object.freeze(CARRY_EXECUTION_VENUES.map((venueId) => Object.freeze({
        venue_id: venueId,
        account_commitment: accountByVenue.get(venueId),
      }))),
      minimum_route_capacity_micro_usdc: Math.min(...routes.map((route) => route.maximum_transfer_micro_usdc)),
      maximum_route_latency_ms: Math.max(...routes.map((route) => route.estimated_latency_ms)),
      owner_approval_required: true,
      fund_movement_authorized: false,
      transaction_broadcast: false,
      automatic_transfer_permitted: false,
      evidence_commitment: evidence.evidence_commitment,
    }),
  };
}

function releaseFundingObservations({ observations, venue_ids: venueIds, max_age_ms: maxAgeMs }) {
  const normalized = [];
  for (const event of observations) {
    const commitmentValue = String(event?.funding_observation_commitment || "");
    const sources = event?.funding_source_observed_at_ms_by_venue;
    if (!/^carry:funding:current:[0-9a-f]{64}$/.test(commitmentValue)
      || !sources
      || typeof sources !== "object"
      || Array.isArray(sources)
      || Object.keys(sources).length !== venueIds.length
      || !venueIds.every((venueId) => positiveInteger(sources[venueId])
        && sources[venueId] <= event.recorded_at_ms
        && event.recorded_at_ms - sources[venueId] <= maxAgeMs)) {
      return denied("carry_release_funding_observation_evidence_missing");
    }
    const prior = normalized.at(-1);
    if (prior) {
      const regressed = venueIds.some((venueId) =>
        sources[venueId] < prior.source_observed_at_ms_by_venue[venueId]);
      if (regressed) return denied("carry_release_funding_observation_time_regressed");
      const advanced = venueIds.some((venueId) =>
        sources[venueId] > prior.source_observed_at_ms_by_venue[venueId]);
      if (!advanced || commitmentValue === prior.evidence_commitment) {
        return denied("carry_release_funding_observation_reused");
      }
    }
    normalized.push(Object.freeze({
      observed_at: iso(event.recorded_at_ms),
      evidence_commitment: commitmentValue,
      source_observed_at_ms_by_venue: Object.freeze(Object.fromEntries(
        venueIds.map((venueId) => [venueId, sources[venueId]]),
      )),
    }));
  }
  return { ok: true, observations: Object.freeze(normalized) };
}

function releaseMarginRunways({ observation, venue_ids: venueIds, position, monitoring_context: monitoringContext }) {
  const statuses = observation?.margin_runway_status_by_venue;
  const values = observation?.margin_runway_ms_by_venue;
  const states = observation?.account_state_evidence;
  const plan = observation?.capital_action_plan;
  const observedAt = observation?.recorded_at_ms;
  const validStatuses = new Set(["healthy", "warning", "critical", "breached"]);
  if (!positiveInteger(observedAt)
    || !statuses
    || typeof statuses !== "object"
    || Array.isArray(statuses)
    || !values
    || typeof values !== "object"
    || Array.isArray(values)
    || !Array.isArray(states)
    || states.length !== venueIds.length
    || Object.keys(statuses).length !== venueIds.length
    || Object.keys(values).length !== venueIds.length
    || !venueIds.every((venueId) => Object.hasOwn(statuses, venueId)
      && Object.hasOwn(values, venueId)
      && validStatuses.has(statuses[venueId])
      && (values[venueId] === null || nonNegativeInteger(values[venueId])))) {
    return denied("carry_release_margin_runway_evidence_missing");
  }
  if (plan?.version !== 1
    || plan.kind !== "ghola_carry_capital_action_plan"
    || plan.position_id !== position?.position_id
    || plan.asset !== position?.asset
    || plan.checked_at_ms !== observedAt
    || plan.proposal_only !== true
    || plan.transaction_broadcast !== false
    || plan.automatic_transfer_permitted !== false
    || !Array.isArray(plan.legs)
    || plan.legs.length !== venueIds.length) {
    return denied("carry_release_margin_runway_plan_detached");
  }
  const statesByVenue = new Map(states.map((state) => [state?.venue_id, state]));
  const legsByVenue = new Map(plan.legs.map((leg) => [leg?.venue_id, leg]));
  if (statesByVenue.size !== venueIds.length
    || legsByVenue.size !== venueIds.length
    || !venueIds.every((venueId) => statesByVenue.has(venueId) && legsByVenue.has(venueId))) {
    return denied("carry_release_margin_runway_plan_detached");
  }
  const runways = [];
  for (const venueId of venueIds) {
    const state = statesByVenue.get(venueId);
    const leg = legsByVenue.get(venueId);
    const accountCommitment = monitoringContext?.venue_access?.[venueId]?.account_commitment;
    const source = liquidationDistanceSourceForVenue(venueId);
    if (!commitment(accountCommitment)
      || state?.account_commitment !== accountCommitment
      || leg?.account_commitment !== accountCommitment) {
      return denied("carry_release_margin_runway_account_binding_invalid");
    }
    if (state?.checked_at_ms !== observedAt
      || !commitment(state?.verification_commitment)
      || !Number.isSafeInteger(state?.position_count)
      || state.position_count <= 0
      || !Number.isSafeInteger(state?.open_order_count)
      || state.open_order_count < 0
      || state.flat_zero_orders !== false
      || !/^carry:account-state:[0-9a-f]{40}$/.test(String(state?.account_state_commitment || ""))
      || state.account_state_commitment !== carryAccountStateCommitment(state)
      || leg?.account_state_commitment !== state.account_state_commitment) {
      return denied("carry_release_margin_runway_account_state_invalid");
    }
    if (typeof source !== "string"
      || state.liquidation_distance_source !== source
      || state.liquidation_distance_verified !== true
      || !boundedInteger(state.liquidation_distance_bps, 0, 100_000)
      || leg.position_open !== true
      || leg.liquidation_distance_bps !== state.liquidation_distance_bps
      || leg.liquidation_distance_verified !== true
      || leg.liquidation_distance_source !== source
      || !boundedInteger(leg.minimum_liquidation_distance_bps, 0, 100_000)) {
      return denied("carry_release_margin_runway_liquidation_binding_invalid");
    }
    if (leg.status !== statuses[venueId]
      || leg.runway_ms !== values[venueId]
      || (state.liquidation_distance_bps < leg.minimum_liquidation_distance_bps
        && leg.status !== "breached")) {
      return denied("carry_release_margin_runway_plan_detached");
    }
    runways.push(Object.freeze({
      venue_id: venueId,
      status: leg.status,
      runway_ms: leg.runway_ms,
      stale: false,
      checked_at: iso(observedAt),
      account_state_checked_at_ms: state.checked_at_ms,
      account_commitment: state.account_commitment,
      verification_commitment: state.verification_commitment,
      account_state_commitment: state.account_state_commitment,
      position_count: state.position_count,
      open_order_count: state.open_order_count,
      flat_zero_orders: state.flat_zero_orders,
      position_open: leg.position_open,
      liquidation_distance_bps: state.liquidation_distance_bps,
      minimum_liquidation_distance_bps: leg.minimum_liquidation_distance_bps,
      liquidation_distance_verified: state.liquidation_distance_verified,
      liquidation_distance_source: state.liquidation_distance_source,
    }));
  }
  return { ok: true, runways: Object.freeze(runways) };
}

function releaseExecutionReadiness({ readiness, monitoring_context: monitoringContext }) {
  const capitalByVenue = new Map((Array.isArray(readiness?.capital_plan) ? readiness.capital_plan : [])
    .map((item) => [item?.venue_id, item]));
  return {
    ready: true,
    owner_commitment: readiness.owner_commitment,
    asset: readiness.asset,
    notional_usd: readiness.notional_usd,
    horizon_days: readiness.horizon_days,
    image_digest: readiness.image_digest,
    checked_at: iso(readiness.checked_at_ms),
    expires_at: iso(readiness.expires_at_ms),
    registry_venue_ids: [...readiness.registry_venue_ids],
    recovery_ready: true,
    recovery_venue_ids: [...readiness.recovery_venue_ids],
    recovery_policy: { ...readiness.recovery_policy },
    transaction_broadcast: false,
    evidence_commitment: readiness.evidence_commitment,
    readiness_commitment: readiness.readiness_commitment,
    venues: CARRY_EXECUTION_VENUES.map((venueId) => ({
      venue_id: venueId,
      account_commitment: monitoringContext?.venue_access?.[venueId]?.account_commitment || null,
      account_state_commitment: capitalByVenue.get(venueId)?.account_state_commitment || null,
      position_count: capitalByVenue.get(venueId)?.position_count ?? null,
      liquidation_distance_bps: capitalByVenue.get(venueId)?.liquidation_distance_bps ?? null,
      liquidation_distance_verified: capitalByVenue.get(venueId)?.liquidation_distance_verified === true,
      liquidation_distance_source: capitalByVenue.get(venueId)?.liquidation_distance_source ?? null,
      account_state_checked: true,
      transaction_broadcast: false,
    })),
  };
}

function releaseExitTrigger({ exit_request: exitRequest, exit_requested_at_ms: exitRequestedAt, observations, position }) {
  if (exitRequest) {
    return releaseTrigger("manual", {
      kind: "owner_request",
      observed_at: iso(exitRequest.recorded_at_ms),
      metric: "owner_request",
    });
  }
  const eligible = observations.filter((event) => event.recorded_at_ms <= exitRequestedAt);
  const latest = eligible.at(-1);
  if (!latest) return denied("carry_release_exit_trigger_unproven");
  const mandate = position.risk_mandate || {};
  const mandateExpiresAt = position.mandate_authorization?.signed_mandate?.expires_at_ms;
  if (positiveInteger(mandateExpiresAt) && latest.recorded_at_ms >= mandateExpiresAt) {
    return releaseTrigger("risk_mandate", {
      kind: "mandate_expired",
      observed_at: iso(latest.recorded_at_ms),
      metric: "expires_at_ms",
      observed_value: latest.recorded_at_ms,
      signed_threshold_value: mandateExpiresAt,
      effective_threshold_value: mandateExpiresAt,
    });
  }

  const contractSkewTrigger = thresholdTrigger({
    observation: latest,
    observedKey: "contract_data_skew_ms",
    observedLimitKey: "max_contract_data_skew_ms",
    signedLimit: mandate.max_contract_data_skew_ms,
    kind: "contract_data_skew",
  });
  if (contractSkewTrigger) return releaseTrigger("risk_mandate", contractSkewTrigger);
  for (const [kind, observedKey, observedLimitKey, signedLimit] of [
    ["index_basis", "index_price_divergence_bps", "max_index_price_divergence_bps", mandate.max_index_price_divergence_bps],
    ["mark_basis", "mark_price_divergence_bps", "max_mark_price_divergence_bps", mandate.max_mark_price_divergence_bps],
  ]) {
    const trigger = thresholdTrigger({ observation: latest, observedKey, observedLimitKey, signedLimit, kind });
    if (trigger) return releaseTrigger("risk_mandate", trigger);
  }

  const runwayValues = latest.margin_runway_ms_by_venue || {};
  const runwayStatuses = latest.margin_runway_status_by_venue || {};
  for (const venueId of [position.long_venue_id, position.short_venue_id]) {
    const runway = runwayValues[venueId];
    const status = runwayStatuses[venueId];
    const unverifiable = !Object.hasOwn(runwayValues, venueId) || (runway === null && status !== "healthy");
    const unsafe = ["critical", "breached"].includes(status)
      || (Number.isSafeInteger(runway) && runway < mandate.min_margin_runway_ms);
    if (unverifiable || unsafe) {
      return releaseTrigger("margin_runway", {
        kind: unverifiable ? "margin_runway_unverifiable" : "margin_runway_below_threshold",
        observed_at: iso(latest.recorded_at_ms),
        metric: "margin_runway_ms",
        observed_value: Number.isSafeInteger(runway) ? runway : null,
        signed_threshold_value: mandate.min_margin_runway_ms,
        effective_threshold_value: mandate.min_margin_runway_ms,
        venue_id: venueId,
        status: typeof status === "string" ? status : null,
      });
    }
  }

  const exitThreshold = mandate.exit_net_value_bps;
  const requiredObservations = mandate.exit_after_consecutive_observations;
  let consecutiveObservations = 0;
  for (let index = eligible.length - 1; index >= 0; index -= 1) {
    if (!Number.isSafeInteger(eligible[index].expected_net_value_bps)
      || eligible[index].expected_net_value_bps > exitThreshold) break;
    consecutiveObservations += 1;
  }
  if (positiveInteger(requiredObservations) && consecutiveObservations >= requiredObservations) {
    return releaseTrigger("funding_flip", {
      kind: "net_carry_below_threshold",
      observed_at: iso(latest.recorded_at_ms),
      metric: "expected_net_value_bps",
      observed_value: latest.expected_net_value_bps,
      signed_threshold_value: exitThreshold,
      effective_threshold_value: exitThreshold,
      consecutive_observation_count: consecutiveObservations,
    });
  }
  return denied("carry_release_exit_trigger_unproven");
}

function thresholdTrigger({ observation, observedKey, observedLimitKey, signedLimit, kind }) {
  const observed = observation[observedKey];
  const observedLimit = observation[observedLimitKey];
  if (![observed, observedLimit, signedLimit].every((value) => Number.isSafeInteger(value) && value >= 0)) return null;
  const effectiveLimit = Math.min(observedLimit, signedLimit);
  if (observed <= effectiveLimit) return null;
  return {
    kind,
    observed_at: iso(observation.recorded_at_ms),
    metric: observedKey,
    observed_value: observed,
    signed_threshold_value: signedLimit,
    effective_threshold_value: effectiveLimit,
  };
}

function releaseTrigger(reason, values) {
  return {
    ok: true,
    reason,
    evidence: {
      kind: values.kind,
      observed_at: values.observed_at,
      metric: values.metric,
      observed_value: values.observed_value ?? null,
      signed_threshold_value: values.signed_threshold_value ?? null,
      effective_threshold_value: values.effective_threshold_value ?? null,
      consecutive_observation_count: values.consecutive_observation_count ?? null,
      venue_id: values.venue_id ?? null,
      status: values.status ?? null,
      transaction_broadcast: false,
    },
  };
}

async function materialLegs({ state, saga, record, phase }) {
  const legs = [];
  for (const sagaLeg of saga.legs || []) {
    const context = saga.execution_context?.legs?.find((item) => item.leg_id === sagaLeg.leg_id);
    if (!context) return denied(`carry_release_${phase}_context_missing:${sagaLeg.venue_id}`);
    const [cached, attempt] = await Promise.all([
      state.getIdempotency?.(context.work_order_commitment),
      state.getExecutionAttempt?.(context.work_order_commitment),
    ]);
    const receipt = cached?.receipt || attempt || null;
    const expectedAccountCommitment = record.monitoring_context?.venue_access?.[sagaLeg.venue_id]?.account_commitment;
    if (!expectedAccountCommitment || receipt?.account_commitment !== expectedAccountCommitment) {
      return denied(`carry_release_${phase}_account_binding_mismatch:${sagaLeg.venue_id}`);
    }
    const proof = receipt?.final_proof || attempt?.final_proof || null;
    if (attempt?.submit_count !== 1 || attempt?.ambiguity_retry_count !== 0) {
      return denied(`carry_release_${phase}_submission_count_unproven:${sagaLeg.venue_id}`);
    }
    if (proof?.broadcast_performed !== true
      || proof?.target_client_order_matched !== true
      || proof?.final_venue_execution_proven !== true
      || !positiveDecimal(proof?.filled_base_size)) {
      return denied(`carry_release_${phase}_terminal_proof_missing:${sagaLeg.venue_id}`);
    }
    const ledgerEntries = record.value_ledger.entries || [];
    const executionLedgerEntries = ledgerEntries.filter((entry) => entry.leg_id === sagaLeg.leg_id);
    const fundingLegId = carryPositionLegId(record.position, sagaLeg.venue_id);
    const fundingLedgerEntries = phase === "entry"
      ? ledgerEntries.filter((entry) => entry.entry_type === "funding"
        && entry.venue_id === sagaLeg.venue_id
        && entry.leg_id === fundingLegId)
      : [];
    legs.push({
      venue_id: sagaLeg.venue_id,
      account_commitment: expectedAccountCommitment,
      side: context.instruction?.order?.side,
      reduce_only: context.instruction?.order?.reduce_only === true,
      client_order_commitment: receipt?.provider_ref_commitment || providerCommitment(attempt?.provider_ref_seed),
      submit_count: attempt.submit_count,
      ambiguity_retry_count: attempt.ambiguity_retry_count,
      live_order_broadcast: true,
      target_client_order_matched: true,
      final_venue_execution_proven: true,
      filled_base_size: String(proof.filled_base_size),
      funding_micro_usdc: sumSignedEntries(fundingLedgerEntries, "funding"),
      fee_micro_usdc: sumEntries(executionLedgerEntries, "trading_fee"),
      slippage_micro_usdc: sumEntries(executionLedgerEntries, "slippage"),
      receipt_commitment: receipt?.result_commitment || `receipt:${digest(JSON.stringify(proof))}`,
    });
  }
  return legs.length === 2 ? { ok: true, legs } : denied(`carry_release_${phase}_legs_missing`);
}

function releaseValueLedger(record) {
  const ledger = record.value_ledger;
  const modeled = ledger.modeled;
  const realized = ledger.realized;
  const contractPnl = Number(record.value_evidence?.realized_economics?.contract_pnl_micro_usdc || 0);
  return {
    finalized: ledger.status === "finalized",
    complete_costs: record.value_evidence?.costs_complete === true,
    modeled: {
      gross_funding_micro_usdc: modeled.gross_funding_micro_usdc,
      total_cost_micro_usdc: modeled.trading_cost_micro_usdc + modeled.capital_cost_micro_usdc + modeled.risk_buffer_micro_usdc,
      expected_net_micro_usdc: modeled.net_value_micro_usdc,
    },
    realized: {
      contract_pnl_micro_usdc: contractPnl,
      funding_micro_usdc: realized.funding_credit_micro_usdc - realized.funding_debit_micro_usdc,
      fees_micro_usdc: realized.trading_fee_micro_usdc,
      slippage_micro_usdc: realized.slippage_micro_usdc,
      gas_micro_usdc: realized.gas_micro_usdc,
      capital_cost_micro_usdc: realized.capital_cost_micro_usdc,
      transfer_fees_micro_usdc: realized.transfer_fee_micro_usdc,
      rebates_micro_usdc: realized.rebate_micro_usdc,
      net_value_micro_usdc: realized.net_value_micro_usdc,
    },
    evidence_commitment: record.final_reconciliation_evidence.reconciliation_commitment,
  };
}

function releaseContractEquivalence(opportunity) {
  const values = [
    opportunity?.contract_data_skew_ms,
    opportunity?.max_contract_data_skew_ms,
    opportunity?.index_price_divergence_bps,
    opportunity?.mark_price_divergence_bps,
    opportunity?.max_index_price_divergence_bps,
    opportunity?.max_mark_price_divergence_bps,
  ];
  if (!values.every((value) => Number.isSafeInteger(value) && value >= 0)
    || !positiveInteger(opportunity?.checked_at_ms)
    || !/^[A-Za-z0-9:_-]{8,180}$/.test(String(opportunity?.economic_equivalence_id || ""))
    || opportunity?.contract_type !== "linear_perp"
    || !["USD", "USDC", "USDT"].includes(opportunity?.long_quote_asset)
    || !["USD", "USDC", "USDT"].includes(opportunity?.short_quote_asset)) {
    return denied("carry_release_contract_equivalence_evidence_missing");
  }
  if (opportunity.contract_data_skew_ms > opportunity.max_contract_data_skew_ms
    || opportunity.index_price_divergence_bps > opportunity.max_index_price_divergence_bps
    || opportunity.mark_price_divergence_bps > opportunity.max_mark_price_divergence_bps) {
    return denied("carry_release_contract_equivalence_exceeded");
  }
  return {
    ok: true,
    evidence: {
      verified: true,
      checked_at: iso(opportunity.checked_at_ms),
      economic_equivalence_id: opportunity.economic_equivalence_id,
      contract_type: opportunity.contract_type,
      long_quote_asset: opportunity.long_quote_asset,
      short_quote_asset: opportunity.short_quote_asset,
      contract_data_skew_ms: opportunity.contract_data_skew_ms,
      max_contract_data_skew_ms: opportunity.max_contract_data_skew_ms,
      index_price_divergence_bps: opportunity.index_price_divergence_bps,
      mark_price_divergence_bps: opportunity.mark_price_divergence_bps,
      max_index_price_divergence_bps: opportunity.max_index_price_divergence_bps,
      max_mark_price_divergence_bps: opportunity.max_mark_price_divergence_bps,
    },
  };
}

function releaseCreationInputEvidence(position, inputEvidence) {
  if (validateCarryCreationInputEvidence(position, inputEvidence)) {
    return denied("carry_release_creation_input_evidence_unproven");
  }
  const evidence = {
    verified: true,
    opportunity_evidence_commitment: position.opportunity_evidence_commitment,
    legs: structuredClone(inputEvidence.legs),
  };
  evidence.evidence_commitment = `carry:creation-inputs:${digest(stableJson(evidence))}`;
  return { ok: true, evidence };
}

function workerMaterialCommitment(material) {
  const payload = { ...material };
  delete payload.worker_material_commitment;
  return `carry:release:material:${digest(stableJson(payload))}`;
}

function lifecycleProofCommitment(proof) {
  const payload = { ...proof };
  delete payload.evidence_commitment;
  return `carry:lifecycle-proof:evidence:${digest(stableJson(payload))}`;
}

function sameLifecycleProofSemantics(left, right) {
  return stableJson(lifecycleProofSemanticBody(left)) === stableJson(lifecycleProofSemanticBody(right));
}

function lifecycleProofSemanticBody(proof) {
  const body = { ...(proof || {}) };
  delete body.evidence_commitment;
  delete body.verified_at_ms;
  delete body.expires_at_ms;
  return body;
}

function lifecycleProofIndexCommitment(index) {
  const payload = { ...index };
  delete payload.evidence_commitment;
  return `carry:lifecycle-proof-index:evidence:${digest(stableJson(payload))}`;
}

function validLifecycleProofIndex(index, { ownerCommitment, imageDigest, asset }) {
  if (!index || typeof index !== "object" || Array.isArray(index)) return false;
  const entries = Array.isArray(index.entries) ? index.entries : [];
  return index.version === 1
    && index.kind === "ghola_carry_lifecycle_proof_index"
    && index.owner_commitment === ownerCommitment
    && index.worker_image_digest === imageDigest
    && index.asset === String(asset || "").toUpperCase()
    && entries.length > 0
    && entries.length <= MAX_LIFECYCLE_PROOFS_PER_ASSET
    && new Set(entries.map((entry) => entry.position_id)).size === entries.length
    && entries.every((entry) => commitment(entry?.position_id)
      && normalizedVenuePair(entry?.venue_ids)
      && positiveInteger(entry?.verified_at_ms)
      && entry?.proof_key === carryLifecycleProofKey(
        ownerCommitment,
        imageDigest,
        asset,
        entry.position_id,
        entry.venue_ids,
      ))
    && index.evidence_commitment === lifecycleProofIndexCommitment(index);
}

function legacyEntryMatchesProof(entry, proof) {
  return Boolean(entry && proof)
    && entry.position_id === proof.position_id
    && sameStrings(entry.venue_ids, proof.venue_ids)
    && entry.verified_at_ms === proof.verified_at_ms;
}

function lifecycleProofReferenceCommitment(reference) {
  const payload = { ...reference };
  delete payload.evidence_commitment;
  return `carry:lifecycle-proof-reference:evidence:${digest(stableJson(payload))}`;
}

function lifecycleProofReference({ proof, ownerCommitment, imageDigest, asset }) {
  const reference = {
    version: 1,
    kind: "ghola_carry_lifecycle_proof_reference",
    owner_commitment: ownerCommitment,
    worker_image_digest: imageDigest,
    asset: String(asset || "").toUpperCase(),
    position_id: proof.position_id,
    venue_ids: [...proof.venue_ids],
    proof_key: carryLifecycleProofKey(
      ownerCommitment,
      imageDigest,
      asset,
      proof.position_id,
      proof.venue_ids,
    ),
    proof_evidence_commitment: proof.evidence_commitment,
    worker_material_commitment: proof.worker_material_commitment,
    verified_at_ms: proof.verified_at_ms,
    expires_at_ms: proof.expires_at_ms,
  };
  reference.evidence_commitment = lifecycleProofReferenceCommitment(reference);
  return reference;
}

function validLifecycleProofReference(reference, { ownerCommitment, imageDigest, asset, positionId }) {
  if (!reference || typeof reference !== "object" || Array.isArray(reference)) return false;
  return reference.version === 1
    && reference.kind === "ghola_carry_lifecycle_proof_reference"
    && reference.owner_commitment === ownerCommitment
    && reference.worker_image_digest === imageDigest
    && reference.asset === String(asset || "").toUpperCase()
    && reference.position_id === positionId
    && commitment(reference.position_id)
    && normalizedVenuePair(reference.venue_ids)
    && reference.proof_key === carryLifecycleProofKey(
      ownerCommitment,
      imageDigest,
      asset,
      reference.position_id,
      reference.venue_ids,
    )
    && /^carry:lifecycle-proof:evidence:[0-9a-f]{64}$/.test(String(reference.proof_evidence_commitment || ""))
    && /^carry:release:material:[0-9a-f]{64}$/.test(String(reference.worker_material_commitment || ""))
    && positiveInteger(reference.verified_at_ms)
    && positiveInteger(reference.expires_at_ms)
    && reference.expires_at_ms > reference.verified_at_ms
    && reference.evidence_commitment === lifecycleProofReferenceCommitment(reference);
}

function validLegacyJsonLifecycleProofReference(reference, {
  ownerCommitment,
  imageDigest,
  asset,
  positionId,
}) {
  if (!reference || typeof reference !== "object" || Array.isArray(reference)) return false;
  const exactKeys = [
    "version",
    "kind",
    "owner_commitment",
    "worker_image_digest",
    "asset",
    "position_id",
    "venue_ids",
    "proof_key",
    "evidence_commitment",
  ];
  return Object.keys(reference).length === exactKeys.length
    && exactKeys.every((key) => Object.hasOwn(reference, key))
    && reference.version === 1
    && reference.kind === "ghola_carry_lifecycle_proof_reference"
    && reference.owner_commitment === ownerCommitment
    && reference.worker_image_digest === imageDigest
    && reference.asset === String(asset || "").toUpperCase()
    && reference.position_id === positionId
    && commitment(reference.position_id)
    && normalizedVenuePair(reference.venue_ids)
    && reference.proof_key === legacyJsonPairCarryLifecycleProofKey(
      ownerCommitment,
      imageDigest,
      asset,
      reference.position_id,
      reference.venue_ids,
    )
    && reference.evidence_commitment === lifecycleProofReferenceCommitment(reference);
}

function lifecycleProofReferenceFormat(reference, expected) {
  if (validLifecycleProofReference(reference, expected)) return "current";
  if (validLegacyJsonLifecycleProofReference(reference, expected)) return "legacy_json";
  return "";
}

function lifecycleReferenceMatchesProof(reference, proof, format) {
  return format === "legacy_json"
    ? legacyJsonLifecycleProofReferenceMatchesProof(reference, proof)
    : format === "current" && lifecycleProofReferenceMatchesProof(reference, proof);
}

function lifecycleProofReferenceMatchesProof(reference, proof) {
  return sameStrings(proof.venue_ids, reference.venue_ids)
    && proof.position_id === reference.position_id
    && proof.evidence_commitment === reference.proof_evidence_commitment
    && proof.worker_material_commitment === reference.worker_material_commitment
    && proof.verified_at_ms === reference.verified_at_ms
    && proof.expires_at_ms === reference.expires_at_ms
    && reference.proof_key === carryLifecycleProofKey(
      reference.owner_commitment,
      reference.worker_image_digest,
      reference.asset,
      proof.position_id,
      proof.venue_ids,
    );
}

function legacyJsonLifecycleProofReferenceMatchesProof(reference, proof) {
  return sameStrings(proof.venue_ids, reference.venue_ids)
    && proof.position_id === reference.position_id
    && reference.proof_key === legacyJsonPairCarryLifecycleProofKey(
      reference.owner_commitment,
      reference.worker_image_digest,
      reference.asset,
      proof.position_id,
      proof.venue_ids,
    );
}

function legacyJsonPairCarryLifecycleProofKey(ownerCommitment, imageDigest, asset, positionId, venueIds) {
  const venues = Array.isArray(venueIds) ? venueIds.map((venueId) => String(venueId || "")) : [];
  const pair = venues.length === 2
    && venues[0] !== venues[1]
    && venues.every((venueId) => CARRY_EXECUTION_VENUES.includes(venueId))
    ? stableJson(venues)
    : "";
  return `carry:lifecycle-proof:${digest([
    ownerCommitment,
    imageDigest,
    String(asset || "").toUpperCase(),
    String(positionId || ""),
    pair,
  ].join("\0")).slice(0, 40)}`;
}

function normalizedVenuePair(venueIds) {
  const venues = Array.isArray(venueIds) ? venueIds.map((venueId) => String(venueId || "")) : [];
  return venues.length === 2
    && venues[0] !== venues[1]
    && venues.every((venueId) => CARRY_EXECUTION_VENUES.includes(venueId))
    ? venues.join(":")
    : "";
}

function legacyCarryLifecycleProofKey(ownerCommitment, imageDigest, asset) {
  return `carry:lifecycle-proof:${digest(`${ownerCommitment}\0${imageDigest}\0${String(asset || "").toUpperCase()}`).slice(0, 40)}`;
}

function lifecycleProofMaxAge(env) {
  const parsed = Number.parseInt(String(env.PRIVATE_AGENT_CARRY_LIFECYCLE_PROOF_MAX_AGE_MS || ""), 10);
  return Number.isInteger(parsed)
    ? Math.max(86_400_000, Math.min(365 * 86_400_000, parsed))
    : DEFAULT_LIFECYCLE_PROOF_MAX_AGE_MS;
}

function lifecycleValueAttribution(valueLedger) {
  const modeled = valueLedger.modeled;
  const realized = valueLedger.realized;
  return normalizeCarryLifecycleValueAttribution({
    modeled: {
      gross_funding_micro_usdc: modeled.gross_funding_micro_usdc,
      total_cost_micro_usdc: modeled.total_cost_micro_usdc,
      expected_net_micro_usdc: modeled.expected_net_micro_usdc,
    },
    realized: {
      contract_pnl_micro_usdc: realized.contract_pnl_micro_usdc,
      funding_micro_usdc: realized.funding_micro_usdc,
      fees_micro_usdc: realized.fees_micro_usdc,
      slippage_micro_usdc: realized.slippage_micro_usdc,
      gas_micro_usdc: realized.gas_micro_usdc,
      capital_cost_micro_usdc: realized.capital_cost_micro_usdc,
      transfer_fees_micro_usdc: realized.transfer_fees_micro_usdc,
      rebates_micro_usdc: realized.rebates_micro_usdc,
      net_value_micro_usdc: realized.net_value_micro_usdc,
    },
    variance_from_modeled_micro_usdc: realized.net_value_micro_usdc - modeled.expected_net_micro_usdc,
  });
}

function safeLifecycleValueAttribution(value) {
  try {
    return normalizeCarryLifecycleValueAttribution(value);
  } catch {
    return null;
  }
}

function commitment(value) {
  return typeof value === "string" && /^[A-Za-z0-9:_-]{3,180}$/.test(value);
}

function providerCommitment(value) {
  return `provider:${digest(JSON.stringify(value || null))}`;
}

function sumEntries(entries, type) {
  return entries.filter((entry) => entry.entry_type === type && entry.direction === "debit")
    .reduce((sum, entry) => sum + Number(entry.amount_micro_usdc || 0), 0);
}

function sumSignedEntries(entries, type) {
  return entries.filter((entry) => entry.entry_type === type)
    .reduce((sum, entry) => sum + (entry.direction === "credit" ? 1 : -1) * Number(entry.amount_micro_usdc || 0), 0);
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

function iso(value) {
  return new Date(value).toISOString();
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function boundedInteger(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function positiveDecimal(value) {
  return /^\d+(?:\.\d+)?$/.test(String(value || "")) && Number(value) > 0;
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

function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function denied(error) {
  return { ok: false, error };
}
