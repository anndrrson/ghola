import {
  SUPPORTED_EXECUTION_VENUES,
  executionVenueSpec,
  requiredVenueCapabilities,
} from "@ghola/execution-core";

const TARGET_VENUES = new Set(SUPPORTED_EXECUTION_VENUES);
const DRIFT_RUNTIME_AVAILABLE = false;

const CAPABILITIES = Object.freeze(Object.fromEntries(
  SUPPORTED_EXECUTION_VENUES.map((venueId) => {
    const spec = executionVenueSpec(venueId);
    const route = requiredVenueCapabilities({ venue_id: venueId, product_type: spec.primary_product });
    const capabilities = [...route];
    if (spec.primary_product === "perp") capabilities.push("cancel", "reduce_only");
    if (venueId === "coinbase_advanced") capabilities.push("cancel");
    return [venueId, Object.freeze(Object.fromEntries([...new Set(capabilities)].map((item) => [item, true])))];
  }),
));

export function venueStateForRouting({
  venue_id,
  access = {},
  market_observed_at_ms,
  market_latency_ms = 0,
  now_ms = Date.now(),
  env = process.env,
}) {
  if (!TARGET_VENUES.has(venue_id)) throw new Error("unsupported_execution_venue");
  const venueSpec = executionVenueSpec(venue_id);
  const reasons = [];
  const simulatedNoCustody = env.PRIVATE_AGENT_VENUE_DRY_RUN === "true";
  if (!simulatedNoCustody && (access.execution_mode === "ghola_pooled" || access.custody_type === "pooled_platform_account")) {
    reasons.push("pooled_custody_forbidden");
  }
  const forced = envList(env.PRIVATE_AGENT_QUARANTINED_VENUES);
  if (forced.includes(venue_id)) reasons.push("operator_quarantine");
  if (access.status !== "ready") reasons.push(`access_${safeStatus(access.status)}`);
  const routableWorkerStatus = venueSpec.worker_routing_status === "enabled"
    || venueSpec.worker_routing_status === "isolated";
  if (!routableWorkerStatus && venue_id !== "drift") {
    reasons.push(`worker_route_${venueSpec.worker_routing_status}`);
  }
  if (venue_id === "drift") reasons.push(...driftReadinessReasons({ access, now_ms, env }));

  const capabilities = Object.fromEntries(
    Object.keys(CAPABILITIES[venue_id]).map((capability) => [
      capability,
      routableWorkerStatus ? true : access.capabilities?.[capability] === true,
    ]),
  );
  if (access.capabilities && typeof access.capabilities === "object") {
    for (const capability of Object.keys(capabilities)) {
      if (access.capabilities[capability] === false) capabilities[capability] = false;
    }
  }
  if (venue_id === "drift" && reasons.length > 0) {
    for (const capability of Object.keys(capabilities)) capabilities[capability] = false;
  }
  return Object.freeze({
    version: 1,
    venue_id,
    status: reasons.length === 0 ? "ready" : "quarantined",
    as_of_ms: timestamp(access.readiness_checked_at_ms ?? access.verified_at_ms) || market_observed_at_ms,
    latency_ms: nonNegativeInteger(access.latency_ms, market_latency_ms),
    capabilities: Object.freeze(capabilities),
    quarantine_reasons: Object.freeze([...new Set(reasons)]),
  });
}

function driftReadinessReasons({ access, now_ms, env }) {
  const reasons = [];
  if (!DRIFT_RUNTIME_AVAILABLE) reasons.push("drift_runtime_quarantined");
  if (env.PRIVATE_AGENT_DRIFT_ADAPTER_ENABLED !== "true") reasons.push("drift_adapter_disabled");
  if (access.adapter_id !== "drift_turnkey_v1") reasons.push("drift_turnkey_adapter_required");
  const proof = access.no_submit_proof;
  if (!proof || typeof proof !== "object") return [...reasons, "drift_no_submit_proof_required"];
  if (proof.status !== "verified_no_funds") reasons.push("drift_no_submit_unverified");
  if (proof.transaction_broadcast !== false) reasons.push("drift_no_submit_broadcast_unsafe");
  if (proof.turnkey_policy_checked !== true) reasons.push("drift_turnkey_policy_unverified");
  if (proof.account_state_checked !== true) reasons.push("drift_account_state_unverified");
  if (proof.order_request_checked !== true) reasons.push("drift_order_request_unverified");
  if (proof.dependency_audit !== "pass") reasons.push("drift_dependency_audit_failed");
  const verifiedAt = timestamp(proof.verified_at_ms ?? proof.verified_at);
  const maxAge = boundedInteger(env.PRIVATE_AGENT_DRIFT_PROOF_MAX_AGE_MS, 300_000, 1_000, 86_400_000);
  if (!verifiedAt || verifiedAt > now_ms || now_ms - verifiedAt > maxAge) reasons.push("drift_no_submit_proof_stale");
  for (const capability of Object.keys(CAPABILITIES.drift)) {
    if (proof.capabilities?.[capability] !== true) reasons.push(`drift_capability_unverified:${capability}`);
  }
  return reasons;
}

function safeStatus(value) {
  return typeof value === "string" && /^[a-z0-9_-]{2,40}$/.test(value) ? value : "not_ready";
}

function timestamp(value) {
  if (Number.isSafeInteger(value) && value > 0) return value;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function nonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : Math.max(0, Number(fallback) || 0);
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function envList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}
