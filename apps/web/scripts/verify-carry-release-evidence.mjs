#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { carryRiskMandateMessage } from "@ghola/execution-core";
import { hashMessage, recoverMessageAddress } from "viem";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CARRY_EVIDENCE_PATH = resolve(
  HERE,
  "../../../deploy/evidence/carry-mainnet-proof.json",
);

const ADAPTERS = Object.freeze({
  hyperliquid: "hyperliquid_v1",
  lighter: "lighter_v1",
  aster: "aster_v1",
});

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
  fail(shadowQualification.proven === true, "shadow_qualification_unproven");
  fail(String(shadowQualification.image_digest || "").toLowerCase() === imageDigest,
    "shadow_qualification_image_mismatch");
  fail(shadowQualification.venues === 5, "shadow_qualification_venue_coverage_invalid");
  fail(shadowQualification.assets === 3, "shadow_qualification_asset_coverage_invalid");
  fail(sameStrings(shadowQualification.requested_assets, ["BTC", "ETH", "SOL"]),
    "shadow_qualification_assets_invalid");
  fail(shadowRequiredSamples >= 3, "shadow_qualification_sample_floor_invalid");
  fail(shadowCompletedSamples >= shadowRequiredSamples, "shadow_qualification_samples_incomplete");
  fail(nonNegativeInteger(shadowQualification.duration_ms) !== null,
    "shadow_qualification_duration_invalid");
  fail(shadowQualification.expected_snapshots_per_sample === 15,
    "shadow_qualification_snapshot_coverage_invalid");
  fail(shadowSampleCommitments.length === shadowCompletedSamples
    && new Set(shadowSampleCommitments).size === shadowSampleCommitments.length
    && shadowSampleCommitments.every((value) => /^carry:shadow:sample:[0-9a-f]{64}$/.test(String(value || ""))),
  "shadow_qualification_commitments_invalid");
  fail(shadowQualification.transaction_broadcast === false, "shadow_qualification_broadcast_detected");
  fail(/^carry:shadow:qualification:[0-9a-f]{64}$/.test(String(shadowQualification.evidence_commitment || "")),
    "shadow_qualification_commitment_invalid");

  const position = evidence?.position || {};
  const notional = positiveInteger(position.target_notional_micro_usdc);
  const pair = [String(position.long_venue_id || ""), String(position.short_venue_id || "")];
  fail(identifier(position.position_id), "position_id_invalid");
  fail(/^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(String(position.asset || "")), "asset_invalid");
  fail(notional > 0 && notional <= 25_000_000, "proof_notional_cap_exceeded");
  fail(pair[0] !== pair[1] && pair.every((venue) => venue in ADAPTERS), "venue_pair_invalid");
  fail(pair.includes("hyperliquid") && pair.some((venue) => venue === "lighter" || venue === "aster"), "qualification_pair_required");

  const createdAt = timestamp(position.created_at);
  fail(createdAt > 0, "position_timestamp_invalid");
  fail(shadowCheckedAt > 0 && shadowCheckedAt <= createdAt, "shadow_qualification_timestamp_invalid");
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
    fail(qualification?.adapter_id === ADAPTERS[venue], `qualification_adapter_mismatch:${venue}`);
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
  fail(["manual", "funding_flip", "margin_runway", "risk_mandate"].includes(exit.reason), "exit_reason_invalid");
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
  fail(commitment(finalState.owner_commitment), "final_owner_commitment_invalid");
  fail(finalState.owner_commitment === signedMandate?.owner_commitment, "final_owner_binding_mismatch");
  fail(finalState.carry_position_id === position.position_id, "final_position_binding_mismatch");
  fail(timestamp(finalState.checked_at) >= exitReconciledAt, "final_state_timestamp_invalid");
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
