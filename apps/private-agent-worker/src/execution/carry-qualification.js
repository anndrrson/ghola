import { createHash } from "node:crypto";
import { venueAdapterCapability } from "@ghola/execution-core";
import { hasExactCarryFlatReconciliation } from "./carry-reconciliation.js";

const DEFAULT_MAX_AGE_MS = 90 * 86_400_000;

export async function readCarryVenueQualification({ state, venue_id: venueId, now_ms: nowMs = Date.now(), env = process.env }) {
  const adapters = qualificationAdapters(venueId);
  if (!adapters) return result(false, venueId, ["qualification_adapters_unavailable"]);
  if (adapters.status === "proven") {
    return result(true, venueId, [], {
      source: "registry_baseline",
      adapter_id: adapters.adapter_id,
      image_digest: runtimeImageDigest(env),
    });
  }
  const imageDigest = runtimeImageDigest(env);
  if (!imageDigest) return result(false, venueId, ["runtime_image_digest_missing"]);
  if (typeof state?.getIdempotency !== "function") return result(false, venueId, ["qualification_evidence_missing"]);
  const stored = await state.getIdempotency(qualificationKey(venueId, adapters.adapter_id, imageDigest));
  return assessCarryVenueQualification({
    venue_id: venueId,
    evidence: stored?.receipt,
    image_digest: imageDigest,
    now_ms: nowMs,
    max_age_ms: qualificationMaxAge(env),
  });
}

export async function storeCarryVenueQualification({ state, evidence, now_ms: nowMs = Date.now(), env = process.env }) {
  const venueId = String(evidence?.venue_id || "");
  const imageDigest = runtimeImageDigest(env);
  const assessed = assessCarryVenueQualification({
    venue_id: venueId,
    evidence,
    image_digest: imageDigest,
    now_ms: nowMs,
    max_age_ms: qualificationMaxAge(env),
  });
  if (!assessed.proven) return { ok: false, error: assessed.reasons[0] || "qualification_evidence_invalid", qualification: assessed };
  if (typeof state?.putIdempotency !== "function") return { ok: false, error: "qualification_state_unavailable", qualification: assessed };
  await state.putIdempotency(qualificationKey(venueId, assessed.adapter_id, imageDigest), structuredClone(evidence));
  return { ok: true, qualification: assessed };
}

export async function recordCompletedCarryVenueQualifications({ state, position_id: positionId, now_ms: nowMs = Date.now(), env = process.env }) {
  const record = await state?.getCarryPositionRecord?.(String(positionId || ""));
  const flat = record?.final_reconciliation_evidence;
  const pair = [record?.position?.long_venue_id, record?.position?.short_venue_id];
  const reconciliationBinding = qualificationReconciliationBinding(record);
  if (record?.position?.status !== "reconciled" || !hasExactCarryFlatReconciliation(flat, pair, reconciliationBinding)) {
    return { ok: false, error: "qualification_completed_flat_lifecycle_required", qualifications: [] };
  }
  const [entrySaga, exitSaga] = await Promise.all([
    state.getMultiLegSaga?.(record.entry_saga_id),
    state.getMultiLegSaga?.(record.exit_saga_id),
  ]);
  if (entrySaga?.status !== "reconciled" || exitSaga?.status !== "reconciled") {
    return { ok: false, error: "qualification_reconciled_sagas_required", qualifications: [] };
  }
  const imageDigest = runtimeImageDigest(env);
  if (!imageDigest) return { ok: false, error: "runtime_image_digest_missing", qualifications: [] };
  const qualifications = [];
  for (const venueId of [record.position.long_venue_id, record.position.short_venue_id]) {
    const adapters = qualificationAdapters(venueId);
    if (!adapters || adapters.status === "proven") continue;
    const noSubmit = record.qualification_context?.venues?.[venueId];
    const entry = await sagaReceipt({ state, saga: entrySaga, venueId });
    const exit = await sagaReceipt({ state, saga: exitSaga, venueId });
    const expectedAccountCommitment = reconciliationBinding.account_commitments[venueId];
    const flatAccountCommitment = flat.venues.find((item) => item?.venue_id === venueId)?.account_commitment;
    const accountBindings = [
      noSubmit?.account_commitment,
      entry.receipt?.account_commitment,
      exit.receipt?.account_commitment,
      flatAccountCommitment,
    ];
    if (!commitment(expectedAccountCommitment) || accountBindings.some((value) => value !== expectedAccountCommitment)) {
      qualifications.push({ venue_id: venueId, ok: false, error: "qualification_account_binding_mismatch" });
      continue;
    }
    const entryProof = entry.receipt?.final_proof || {};
    const exitProof = exit.receipt?.final_proof || {};
    const exactBase = equalPositiveDecimal(entryProof.filled_base_size, exitProof.filled_base_size);
    const authorityAcceptable = acceptableAuthorityBoundary(noSubmit?.authority_boundary);
    const submissionAttempts = {
      entry: qualificationSubmissionAttempt("entry", entry),
      exit: qualificationSubmissionAttempt("exit", exit),
    };
    const ambiguityRetryCount = totalAmbiguityRetryCount(submissionAttempts);
    const evidence = {
      version: 1,
      venue_id: venueId,
      owner_commitment: record.owner_commitment,
      carry_position_id: record.position.position_id,
      account_commitment: expectedAccountCommitment,
      adapter_id: adapters.adapter_id,
      image_digest: imageDigest,
      network: "mainnet",
      verified_at_ms: nowMs,
      no_submit: {
        account_commitment: expectedAccountCommitment,
        transaction_broadcast: noSubmit?.transaction_broadcast,
        account_state_checked: noSubmit?.account_state_checked,
        order_request_checked: noSubmit?.order_request_checked,
        evidence_commitment: noSubmit?.evidence_commitment,
      },
      entry_reconciliation: {
        account_commitment: expectedAccountCommitment,
        live_order_broadcast: entryProof.broadcast_performed === true,
        target_client_order_matched: entryProof.target_client_order_matched === true,
        final_venue_execution_proven: entryProof.final_venue_execution_proven === true,
        target_fill_set_complete: entryProof.target_fill_set_complete === true,
        filled_base_size: String(entryProof.filled_base_size || ""),
        evidence_commitment: receiptCommitment("entry", entry.receipt),
      },
      exit_recovery: {
        account_commitment: expectedAccountCommitment,
        live_order_broadcast: exitProof.broadcast_performed === true,
        reduce_only: exit.context?.instruction?.order?.reduce_only === true,
        exact_base_quantity: exactBase,
        final_venue_execution_proven: exitProof.final_venue_execution_proven === true,
        target_fill_set_complete: exitProof.target_fill_set_complete === true,
        account_state_checked: true,
        gross_exposure_micro_usdc: 0,
        open_order_count: 0,
        evidence_commitment: receiptCommitment("exit", exit.receipt),
      },
      submission_attempts: submissionAttempts,
      ambiguous_submission_retry_count: ambiguityRetryCount,
      authority_boundary_acceptable: authorityAcceptable,
      authority_evidence_commitment: noSubmit?.evidence_commitment || "",
    };
    const stored = await storeCarryVenueQualification({ state, evidence, now_ms: nowMs, env });
    qualifications.push({ venue_id: venueId, ...stored });
  }
  return {
    ok: qualifications.length > 0 && qualifications.every((item) => item.ok),
    error: qualifications.find((item) => !item.ok)?.error || null,
    qualifications,
  };
}

export function assessCarryVenueQualification({ venue_id: venueId, evidence, image_digest: imageDigest, now_ms: nowMs = Date.now(), max_age_ms: maxAgeMs = DEFAULT_MAX_AGE_MS }) {
  const adapters = qualificationAdapters(venueId);
  const reasons = [];
  if (!adapters) reasons.push("qualification_adapters_unavailable");
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    reasons.push("qualification_evidence_missing");
    return result(false, venueId, reasons);
  }
  if (evidence.version !== 1) reasons.push("qualification_version_invalid");
  if (evidence.venue_id !== venueId) reasons.push("qualification_venue_mismatch");
  if (!commitment(evidence.owner_commitment)) reasons.push("qualification_owner_binding_invalid");
  if (!commitment(evidence.carry_position_id)) reasons.push("qualification_position_binding_invalid");
  if (!commitment(evidence.account_commitment)) reasons.push("qualification_account_binding_invalid");
  if (evidence.adapter_id !== adapters?.adapter_id) reasons.push("qualification_adapter_mismatch");
  if (!imageDigest || evidence.image_digest !== imageDigest) reasons.push("qualification_image_mismatch");
  if (evidence.network !== "mainnet") reasons.push("qualification_not_mainnet");
  const verifiedAt = positiveInteger(evidence.verified_at_ms);
  if (!verifiedAt || verifiedAt > nowMs || nowMs - verifiedAt > maxAgeMs) reasons.push("qualification_stale");
  const noSubmit = evidence.no_submit || {};
  if (noSubmit.account_commitment !== evidence.account_commitment) reasons.push("no_submit_account_binding_mismatch");
  if (noSubmit.transaction_broadcast !== false || noSubmit.account_state_checked !== true || noSubmit.order_request_checked !== true || !commitment(noSubmit.evidence_commitment)) {
    reasons.push("no_submit_proof_incomplete");
  }
  const entry = evidence.entry_reconciliation || {};
  if (entry.account_commitment !== evidence.account_commitment) reasons.push("entry_account_binding_mismatch");
  if (entry.live_order_broadcast !== true || entry.target_client_order_matched !== true || entry.final_venue_execution_proven !== true || entry.target_fill_set_complete !== true || !positiveDecimal(entry.filled_base_size) || !commitment(entry.evidence_commitment)) {
    reasons.push("entry_reconciliation_proof_incomplete");
  }
  const exit = evidence.exit_recovery || {};
  if (exit.account_commitment !== evidence.account_commitment) reasons.push("exit_account_binding_mismatch");
  if (exit.live_order_broadcast !== true || exit.reduce_only !== true || exit.exact_base_quantity !== true || exit.final_venue_execution_proven !== true || exit.target_fill_set_complete !== true || exit.account_state_checked !== true || exit.gross_exposure_micro_usdc !== 0 || exit.open_order_count !== 0 || !commitment(exit.evidence_commitment)) {
    reasons.push("exit_recovery_proof_incomplete");
  }
  const attempts = evidence.submission_attempts || {};
  for (const phase of ["entry", "exit"]) {
    const attempt = attempts[phase] || {};
    if (attempt.account_commitment !== evidence.account_commitment
      || !commitment(attempt.work_order_commitment)
      || attempt.submit_count !== 1
      || attempt.ambiguity_retry_count !== 0
      || !commitment(attempt.evidence_commitment)) {
      reasons.push(`${phase}_submission_attempt_proof_incomplete`);
    }
  }
  if (attempts.entry?.work_order_commitment === attempts.exit?.work_order_commitment) {
    reasons.push("submission_attempt_lineage_reused");
  }
  const derivedRetryCount = totalAmbiguityRetryCount(attempts);
  if (derivedRetryCount !== 0 || evidence.ambiguous_submission_retry_count !== derivedRetryCount) {
    reasons.push("ambiguity_retry_invariant_failed");
  }
  if (evidence.authority_boundary_acceptable !== true || !commitment(evidence.authority_evidence_commitment)) reasons.push("authority_boundary_unproven");
  return result(reasons.length === 0, venueId, reasons, {
    source: "deployment_bound_lifecycle",
    adapter_id: evidence.adapter_id,
    image_digest: imageDigest,
    verified_at_ms: verifiedAt || null,
    evidence_commitment: commitment(evidence.evidence_commitment) ? evidence.evidence_commitment : evidenceDigest(evidence),
  });
}

function qualificationAdapters(venueId) {
  const execution = venueAdapterCapability(venueId, "carry_execution");
  const noSubmit = venueAdapterCapability(venueId, "no_submit_reconciliation");
  const recovery = venueAdapterCapability(venueId, "exact_quantity_recovery");
  if (!execution || !noSubmit || !recovery) return null;
  if (new Set([execution.adapter_id, noSubmit.adapter_id, recovery.adapter_id]).size !== 1) return null;
  if (new Set([execution.status, noSubmit.status, recovery.status]).size !== 1) return null;
  if (!["proven", "implemented_unproven"].includes(execution.status)) return null;
  return Object.freeze({ adapter_id: execution.adapter_id, status: execution.status });
}

function qualificationReconciliationBinding(record) {
  const venueIds = [record?.position?.long_venue_id, record?.position?.short_venue_id].filter(Boolean);
  return {
    owner_commitment: record?.owner_commitment,
    carry_position_id: record?.position?.position_id,
    account_commitments: Object.fromEntries(venueIds.map((venueId) => [
      venueId,
      record?.monitoring_context?.venue_access?.[venueId]?.account_commitment,
    ])),
  };
}

export function qualificationKey(venueId, adapterId, imageDigest) {
  return `carry:qualification:${venueId}:${createHash("sha256").update(`${adapterId}\0${imageDigest}`).digest("hex").slice(0, 40)}`;
}

function result(proven, venueId, reasons, extra = {}) {
  return Object.freeze({
    version: 1,
    venue_id: venueId,
    proven,
    reasons: Object.freeze([...new Set(reasons)]),
    ...extra,
  });
}

export function runtimeCarryQualificationImageDigest(env = process.env) {
  return runtimeImageDigest(env);
}

function runtimeImageDigest(env) {
  const value = String(env.PHALA_CVM_IMAGE_DIGEST || env.PRIVATE_AGENT_IMAGE_DIGEST || "").trim();
  return /^sha256:[0-9a-f]{6,128}$/i.test(value) ? value.toLowerCase() : "";
}

function qualificationMaxAge(env) {
  const parsed = Number.parseInt(String(env.PRIVATE_AGENT_CARRY_QUALIFICATION_MAX_AGE_MS || ""), 10);
  return Number.isInteger(parsed) ? Math.max(86_400_000, Math.min(365 * 86_400_000, parsed)) : DEFAULT_MAX_AGE_MS;
}

function commitment(value) {
  return typeof value === "string" && /^[A-Za-z0-9:_-]{8,180}$/.test(value);
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function positiveDecimal(value) {
  return /^\d+(?:\.\d+)?$/.test(String(value || "")) && Number(value) > 0;
}

function evidenceDigest(value) {
  return `carry:qualification:evidence:${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 40)}`;
}

async function sagaReceipt({ state, saga, venueId }) {
  const leg = saga?.legs?.find((item) => item.venue_id === venueId);
  const context = saga?.execution_context?.legs?.find((item) => item.leg_id === leg?.leg_id);
  if (!context) return { context: null, receipt: null, attempt: null };
  const [cached, attempt] = await Promise.all([
    state.getIdempotency?.(context.work_order_commitment),
    state.getExecutionAttempt?.(context.work_order_commitment),
  ]);
  return { context, receipt: cached?.receipt || attempt || null, attempt: attempt || null };
}

function qualificationSubmissionAttempt(phase, execution) {
  const attempt = execution?.attempt;
  const workOrderCommitment = String(execution?.context?.work_order_commitment || "");
  return {
    work_order_commitment: workOrderCommitment,
    account_commitment: attempt?.account_commitment || null,
    submit_count: nonnegativeIntegerOrNull(attempt?.submit_count),
    ambiguity_retry_count: nonnegativeIntegerOrNull(attempt?.ambiguity_retry_count),
    evidence_commitment: attempt
      ? `carry:qualification:${phase}:attempt:${createHash("sha256").update(JSON.stringify({
        work_order_commitment: workOrderCommitment,
        account_commitment: attempt.account_commitment || null,
        submit_count: attempt.submit_count,
        ambiguity_retry_count: attempt.ambiguity_retry_count,
        status: attempt.status || null,
        provider_ref_seed: attempt.provider_ref_seed || null,
        result_seed: attempt.result_seed || null,
        final_proof: attempt.final_proof || null,
      })).digest("hex").slice(0, 40)}`
      : "",
  };
}

function totalAmbiguityRetryCount(attempts) {
  const counts = [attempts?.entry?.ambiguity_retry_count, attempts?.exit?.ambiguity_retry_count];
  return counts.every((value) => Number.isSafeInteger(value) && value >= 0)
    ? counts.reduce((total, value) => total + value, 0)
    : null;
}

function nonnegativeIntegerOrNull(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function acceptableAuthorityBoundary(boundary) {
  if (!boundary || typeof boundary !== "object") return false;
  if (boundary.venue_native_trade_only === true) {
    return boundary.withdrawal_request_permitted !== true && boundary.non_owner_fund_movement_possible !== true;
  }
  return boundary.venue_native_trade_only === false
    && boundary.withdrawal_request_permitted === false
    && boundary.secure_withdrawal_destination === "owner_l1_only"
    && boundary.owner_wallet_key_present === false
    && boundary.non_owner_fund_movement_possible === false;
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

function receiptCommitment(phase, receipt) {
  return `carry:qualification:${phase}:${createHash("sha256").update(JSON.stringify({
    provider_ref_commitment: receipt?.provider_ref_commitment || null,
    result_commitment: receipt?.result_commitment || null,
    final_proof: receipt?.final_proof || null,
  })).digest("hex").slice(0, 40)}`;
}
