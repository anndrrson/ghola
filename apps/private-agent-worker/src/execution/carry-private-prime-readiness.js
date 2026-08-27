import { createHash } from "node:crypto";

export function buildCarryPrivatePrimeReadiness({
  readiness,
  diagnostic,
  shadow_qualification: shadowQualification,
  carry_supervision: carrySupervision,
  route_observation_configured: routeObservationConfigured,
  now_ms: nowMs = Date.now(),
}) {
  const reasons = [];
  if (readiness?.ready !== true) reasons.push("three_venue_no_submit_unproven");
  if (readiness?.ready === true && readiness?.capital_ready !== true) reasons.push("opening_capital_shortfall");
  if (shadowQualification?.ready !== true || shadowQualification?.venues < 5) {
    reasons.push("five_venue_shadow_unproven");
  }
  if (carrySupervision?.ready !== true) reasons.push("carry_supervision_unready");
  if (routeObservationConfigured !== true) reasons.push("collateral_route_observation_unavailable");
  const material = {
    version: 1,
    kind: "ghola_private_prime_no_submit_readiness",
    ready: reasons.length === 0,
    proof_level: "pre_broadcast_readiness",
    owner_commitment: readiness?.owner_commitment || null,
    network: readiness?.network || "mainnet",
    asset: readiness?.asset || null,
    checked_at_ms: nowMs,
    expires_at_ms: minimumExpiry(readiness?.expires_at_ms, shadowQualification?.checked_at_ms),
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
    collateral_route_observation: {
      configured: routeObservationConfigured === true,
      read_only: true,
      owner_approval_required: true,
      automatic_transfer_permitted: false,
    },
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

function minimumExpiry(readinessExpiry, shadowCheckedAt) {
  const values = [readinessExpiry, Number.isSafeInteger(shadowCheckedAt) ? shadowCheckedAt + 60_000 : null]
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
