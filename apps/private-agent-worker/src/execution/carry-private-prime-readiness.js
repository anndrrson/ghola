import { createHash } from "node:crypto";

export function buildCarryPrivatePrimeReadiness({
  readiness,
  diagnostic,
  shadow_qualification: shadowQualification,
  carry_supervision: carrySupervision,
  route_observation_configured: routeObservationConfigured,
  route_evidence: routeEvidence,
  now_ms: nowMs = Date.now(),
}) {
  const routeObservation = verifiedRouteObservation({
    readiness,
    routeEvidence,
    routeObservationConfigured,
    nowMs,
  });
  const reasons = [];
  if (readiness?.ready !== true) reasons.push("three_venue_no_submit_unproven");
  if (readiness?.ready === true && readiness?.capital_ready !== true) reasons.push("opening_capital_shortfall");
  if (shadowQualification?.ready !== true || shadowQualification?.venues < 5) {
    reasons.push("five_venue_shadow_unproven");
  }
  if (carrySupervision?.ready !== true) reasons.push("carry_supervision_unready");
  if (routeObservationConfigured !== true) reasons.push("collateral_route_observation_unavailable");
  else if (routeObservation.verified !== true) reasons.push("collateral_route_evidence_unverified");
  else if (routeObservation.available_route_count < 1) reasons.push("collateral_route_unavailable");
  const material = {
    version: 1,
    kind: "ghola_private_prime_no_submit_readiness",
    ready: reasons.length === 0,
    proof_level: "pre_broadcast_readiness",
    owner_commitment: readiness?.owner_commitment || null,
    network: readiness?.network || "mainnet",
    asset: readiness?.asset || null,
    checked_at_ms: nowMs,
    expires_at_ms: minimumExpiry(
      readiness?.expires_at_ms,
      shadowQualification?.checked_at_ms,
      routeObservation.expires_at_ms,
    ),
    five_venue_shadow: {
      ready: shadowQualification?.ready === true && shadowQualification?.venues >= 5,
      venue_count: shadowQualification?.venues || 0,
      evidence_commitment: shadowQualification?.evidence_commitment || null,
    },
    three_venue_execution: {
      ready: readiness?.ready === true,
      venue_ids: Array.isArray(readiness?.registry_venue_ids) ? readiness.registry_venue_ids : [],
      capital_ready: readiness?.capital_ready === true,
      evidence_commitment: readiness?.evidence_commitment || null,
      diagnostic_commitment: diagnostic?.diagnostic_commitment || null,
    },
    collateral_route_observation: routeObservation,
    supervision: {
      ready: carrySupervision?.ready === true,
      status: carrySupervision?.status || "unavailable",
    },
    live_paired_lifecycle_proven: false,
    owner_only_funding: true,
    owner_only_transfers: true,
    owner_only_withdrawals: true,
    transaction_broadcast: false,
    reasons,
  };
  material.evidence_commitment = evidenceCommitment(material);
  return Object.freeze(material);
}

function verifiedRouteObservation({ readiness, routeEvidence, routeObservationConfigured, nowMs }) {
  const evidence = routeEvidence?.evidence;
  const routes = Array.isArray(routeEvidence?.routes) ? routeEvidence.routes : [];
  const checkedAtMs = Number.isSafeInteger(evidence?.checked_at_ms) ? evidence.checked_at_ms : null;
  const expiresAtMs = Number.isSafeInteger(evidence?.expires_at_ms) ? evidence.expires_at_ms : null;
  const effectiveExpiresAtMs = checkedAtMs !== null && expiresAtMs !== null
    ? Math.min(expiresAtMs, checkedAtMs + 30_000)
    : null;
  const evidenceCommitment = typeof evidence?.evidence_commitment === "string"
    ? evidence.evidence_commitment
    : null;
  const verified = routeObservationConfigured === true
    && routeEvidence?.ok === true
    && evidence?.owner_commitment === readiness?.owner_commitment
    && evidence?.worker_image_digest === readiness?.image_digest
    && checkedAtMs !== null
    && checkedAtMs <= nowMs + 5_000
    && nowMs - checkedAtMs <= 30_000
    && effectiveExpiresAtMs !== null
    && effectiveExpiresAtMs > nowMs
    && evidenceCommitment?.startsWith("carry:transfer-routes:evidence:") === true;
  const availableRouteCount = verified
    ? routes.filter((route) => route?.status === "available"
      && route?.quote_verified === true
      && route?.all_in_fee_verified === true
      && route?.valuation_basis_verified === true
      && route?.owner_approval_required === true
      && route?.fund_movement_authorized === false
      && route?.transaction_broadcast === false
      && route?.automatic_transfer_permitted === false).length
    : 0;
  return Object.freeze({
    configured: routeObservationConfigured === true,
    verified,
    route_count: verified ? routes.length : 0,
    available_route_count: availableRouteCount,
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

function minimumExpiry(readinessExpiry, shadowCheckedAt, routeExpiry) {
  const values = [readinessExpiry, Number.isSafeInteger(shadowCheckedAt) ? shadowCheckedAt + 60_000 : null, routeExpiry]
    .filter((value) => Number.isSafeInteger(value) && value > 0);
  return values.length > 0 ? Math.min(...values) : null;
}

function evidenceCommitment(value) {
  const { evidence_commitment: _ignored, ...material } = value;
  return `carry:private-prime:${createHash("sha256").update(stableJson(material)).digest("hex").slice(0, 40)}`;
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
