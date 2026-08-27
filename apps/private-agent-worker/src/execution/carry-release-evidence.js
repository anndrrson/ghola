import { createHash } from "node:crypto";
import { readCarryVenueQualification, runtimeCarryQualificationImageDigest } from "./carry-qualification.js";
import { verifyCarryRiskMandateAuthorization } from "./carry-mandate.js";
import { carryPositionLegId } from "./carry-positions.js";
import { assessCarryFlatReconciliation } from "./carry-reconciliation.js";
import { readCarryShadowQualification } from "./carry-shadow-qualification.js";

const DEFAULT_LIFECYCLE_PROOF_MAX_AGE_MS = 90 * 86_400_000;

export async function recordCompletedCarryLifecycleProof({
  state,
  owner_commitment: ownerCommitment,
  position_id: positionId,
  env = process.env,
  now_ms: nowMs = Date.now(),
}) {
  if (typeof state?.putIdempotency !== "function") return denied("carry_lifecycle_proof_state_unavailable");
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
    ambiguity_retry_count: 0,
    owner_only_funding: true,
    owner_only_transfers: true,
    owner_only_withdrawals: true,
    recording_transaction_broadcast: false,
    realized_net_value_micro_usdc: material.value_ledger.realized.net_value_micro_usdc,
    worker_material_commitment: material.worker_material_commitment,
  };
  proof.evidence_commitment = lifecycleProofCommitment(proof);
  const assessed = assessCompletedCarryLifecycleProof({
    proof,
    owner_commitment: ownerCommitment,
    image_digest: imageDigest,
    now_ms: nowMs,
  });
  if (!assessed.ok) return assessed;
  await state.putIdempotency(carryLifecycleProofKey(ownerCommitment, imageDigest), structuredClone(proof));
  return { ok: true, proof: assessed.proof };
}

export async function readCompletedCarryLifecycleProof({
  state,
  owner_commitment: ownerCommitment,
  env = process.env,
  now_ms: nowMs = Date.now(),
}) {
  const imageDigest = runtimeCarryQualificationImageDigest(env);
  if (!imageDigest) return denied("carry_lifecycle_proof_image_missing");
  if (typeof state?.getIdempotency !== "function") return denied("carry_lifecycle_proof_state_unavailable");
  const stored = await state.getIdempotency(carryLifecycleProofKey(ownerCommitment, imageDigest));
  return assessCompletedCarryLifecycleProof({
    proof: stored?.receipt,
    owner_commitment: ownerCommitment,
    image_digest: imageDigest,
    now_ms: nowMs,
  });
}

export function assessCompletedCarryLifecycleProof({
  proof,
  owner_commitment: ownerCommitment,
  image_digest: imageDigest,
  now_ms: nowMs = Date.now(),
}) {
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) return denied("carry_lifecycle_proof_missing");
  const venueIds = Array.isArray(proof.venue_ids) ? proof.venue_ids : [];
  const accountCommitments = proof.account_commitments && typeof proof.account_commitments === "object"
    ? proof.account_commitments
    : {};
  const valid = proof.version === 1
    && proof.kind === "ghola_carry_live_paired_lifecycle_proof"
    && proof.network === "mainnet"
    && proof.owner_commitment === ownerCommitment
    && proof.worker_image_digest === imageDigest
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
    && proof.ambiguity_retry_count === 0
    && proof.owner_only_funding === true
    && proof.owner_only_transfers === true
    && proof.owner_only_withdrawals === true
    && proof.recording_transaction_broadcast === false
    && Number.isSafeInteger(proof.realized_net_value_micro_usdc)
    && /^carry:release:material:[0-9a-f]{64}$/.test(String(proof.worker_material_commitment || ""))
    && proof.evidence_commitment === lifecycleProofCommitment(proof);
  if (!valid) return denied("carry_lifecycle_proof_invalid");
  return { ok: true, proof: Object.freeze(structuredClone(proof)) };
}

export function carryLifecycleProofKey(ownerCommitment, imageDigest) {
  return `carry:lifecycle-proof:${digest(`${ownerCommitment}\0${imageDigest}`).slice(0, 40)}`;
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
  const shadowQualification = await readCarryShadowQualification({
    state,
    now_ms: nowMs,
    env,
  });
  if (!shadowQualification.ready || !shadowQualification.release_bound) {
    return denied("carry_release_shadow_qualification_unproven");
  }
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
  const exitTrigger = releaseExitTrigger({
    exit_request: exitRequest,
    exit_requested_at_ms: exitRequestedAt,
    observations: supervisedObservations,
    position: record.position,
  });
  if (!exitTrigger.ok) return exitTrigger;
  const runwayStatuses = latestObservation.margin_runway_status_by_venue || {};
  const runwayValues = latestObservation.margin_runway_ms_by_venue || {};
  const validRunwayStatuses = new Set(["healthy", "warning", "critical", "breached"]);
  if (pair.some((venueId) => !Object.hasOwn(runwayValues, venueId) || !validRunwayStatuses.has(runwayStatuses[venueId]))) {
    return denied("carry_release_margin_runway_evidence_missing");
  }
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
    shadow_qualification: {
      proven: true,
      image_digest: shadowQualification.image_digest,
      checked_at: iso(shadowQualification.checked_at_ms),
      venues: shadowQualification.venues,
      assets: shadowQualification.assets,
      requested_assets: shadowQualification.requested_assets,
      required_samples: shadowQualification.required_samples,
      completed_samples: shadowQualification.completed_samples,
      duration_ms: shadowQualification.duration_ms,
      expected_snapshots_per_sample: shadowQualification.expected_snapshots_per_sample,
      sample_commitments: shadowQualification.sample_commitments,
      transaction_broadcast: false,
      evidence_commitment: shadowQualification.evidence_commitment,
    },
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
      margin_runways: pair.map((venueId) => ({
        venue_id: venueId,
        status: runwayStatuses[venueId],
        runway_ms: runwayValues[venueId],
        stale: false,
      })),
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

function lifecycleProofMaxAge(env) {
  const parsed = Number.parseInt(String(env.PRIVATE_AGENT_CARRY_LIFECYCLE_PROOF_MAX_AGE_MS || ""), 10);
  return Number.isInteger(parsed)
    ? Math.max(86_400_000, Math.min(365 * 86_400_000, parsed))
    : DEFAULT_LIFECYCLE_PROOF_MAX_AGE_MS;
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

function positiveDecimal(value) {
  return /^\d+(?:\.\d+)?$/.test(String(value || "")) && Number(value) > 0;
}

function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function denied(error) {
  return { ok: false, error };
}
