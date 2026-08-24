#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

export function verifyCarryReleaseEvidence(evidence) {
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
  fail(evidence?.mandate?.ai_execution_authority === false, "ai_must_be_proposal_only");
  fail(evidence?.mandate?.funding_owner_only === true, "funding_owner_only_required");
  fail(evidence?.mandate?.transfers_owner_only === true, "transfers_owner_only_required");
  fail(evidence?.mandate?.withdrawals_owner_only === true, "withdrawals_owner_only_required");
  fail(commitment(evidence?.mandate?.policy_commitment), "policy_commitment_missing");

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
  fail(positiveInteger(monitoring.observation_count) > 0, "monitoring_observation_missing");
  fail(positiveInteger(monitoring.funding_flip_checks) > 0, "funding_flip_check_missing");
  fail(sameVenueSet(monitoring.margin_runways, pair), "margin_runway_venues_mismatch");
  for (const runway of array(monitoring.margin_runways)) {
    fail(positiveInteger(runway?.runway_ms) > 0, `margin_runway_missing:${String(runway?.venue_id || "")}`);
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
  fail(timestamp(finalState.checked_at) >= exitReconciledAt, "final_state_timestamp_invalid");
  fail(finalState.gross_exposure_micro_usdc === 0, "final_exposure_not_flat");
  fail(finalState.open_order_count === 0, "final_open_orders_not_zero");
  fail(sameVenueSet(finalState.venues, pair), "final_state_venues_mismatch");
  for (const venueState of array(finalState.venues)) {
    const venue = String(venueState?.venue_id || "");
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
    if (!commitment(leg?.client_order_commitment)) failures.push(`${phase}_client_order_commitment_invalid:${venue}`);
    if (!commitment(leg?.receipt_commitment)) failures.push(`${phase}_receipt_commitment_missing:${venue}`);
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

function main() {
  const evidencePath = resolve(process.env.GHOLA_CARRY_RELEASE_EVIDENCE_PATH || DEFAULT_CARRY_EVIDENCE_PATH);
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
  const verified = verifyCarryReleaseEvidence(evidence);
  console.log(`[carry-release-evidence] verified ${verified.evidence_commitment}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
