import { CARRY_EXECUTION_VENUES, CORE_PERP_VENUES } from "./carry-venues";

type Tone = "good" | "warn" | "bad";

export type CarryPrivatePrimeSummary = {
  status: "ready" | "blocked" | "pending" | "invalid";
  value: string;
  detail: string;
  tone?: Tone;
};

export function carryPrivatePrimeSummary(input: unknown, nowMs = Date.now()): CarryPrivatePrimeSummary {
  const value = record(input);
  if (!Object.keys(value).length) {
    return { status: "pending", value: "PROOF PENDING", detail: "RUN NO-SUBMIT CHECK" };
  }
  const shadow = record(value.five_venue_shadow);
  const execution = record(value.three_venue_execution);
  const route = record(value.collateral_route_observation);
  const supervision = record(value.supervision);
  const pairedLifecycle = record(value.paired_lifecycle);
  const reasons = strings(value.reasons);
  const venues = strings(execution.venue_ids);
  const checkedAt = integer(value.checked_at_ms);
  const expiresAt = integer(value.expires_at_ms);
  const shadowCount = integer(shadow.venue_count) || 0;
  const shadowReady = shadow.ready === true && shadowCount === CORE_PERP_VENUES.length;
  const executionReady = execution.ready === true
    && venues.length === CARRY_EXECUTION_VENUES.length
    && CARRY_EXECUTION_VENUES.every((venueId, index) => venues[index] === venueId);
  const capitalReady = execution.capital_ready === true;
  const routeCheckedAt = integer(route.checked_at_ms);
  const routeExpiresAt = integer(route.expires_at_ms);
  const routesReady = route.configured === true
    && route.verified === true
    && Number(route.route_count) > 0
    && Number(route.available_route_count) > 0
    && routeCheckedAt !== null
    && routeCheckedAt <= nowMs
    && routeExpiresAt !== null
    && routeExpiresAt > nowMs
    && typeof route.evidence_commitment === "string"
    && route.evidence_commitment.startsWith("carry:transfer-routes:evidence:")
    && route.read_only === true
    && route.owner_approval_required === true
    && route.fund_movement_authorized === false
    && route.transaction_broadcast === false
    && route.automatic_transfer_permitted === false;
  const supervisionReady = supervision.ready === true && supervision.status === "healthy";
  const lifecycleVenues = strings(pairedLifecycle.venue_ids);
  const lifecycleVerifiedAt = integer(pairedLifecycle.verified_at_ms);
  const lifecycleExpiresAt = integer(pairedLifecycle.expires_at_ms);
  const lifecycleReady = pairedLifecycle.verified === true
    && pairedLifecycle.asset === value.asset
    && lifecycleVenues.length === 2
    && new Set(lifecycleVenues).size === 2
    && lifecycleVenues.every((venueId) => CARRY_EXECUTION_VENUES.includes(venueId as typeof CARRY_EXECUTION_VENUES[number]))
    && lifecycleVerifiedAt !== null
    && lifecycleVerifiedAt <= nowMs
    && lifecycleExpiresAt !== null
    && lifecycleExpiresAt > nowMs
    && pairedLifecycle.account_bindings_verified === true
    && pairedLifecycle.live_entry_exit_proven === true
    && pairedLifecycle.supervised_monitoring_proven === true
    && pairedLifecycle.final_flat_zero_orders === true
    && pairedLifecycle.value_ledger_finalized === true
    && pairedLifecycle.ambiguity_retry_count === 0
    && pairedLifecycle.owner_only_funding === true
    && pairedLifecycle.owner_only_transfers === true
    && pairedLifecycle.owner_only_withdrawals === true
    && pairedLifecycle.transaction_broadcast === false
    && /^carry:release:material:[0-9a-f]{64}$/.test(String(pairedLifecycle.worker_material_commitment || ""))
    && /^carry:lifecycle-proof:evidence:[0-9a-f]{64}$/.test(String(pairedLifecycle.evidence_commitment || ""));
  const proofBoundaryValid = (value.proof_level === "pre_broadcast_readiness"
      && value.live_paired_lifecycle_proven === false
      && pairedLifecycle.verified !== true)
    || (value.proof_level === "live_paired_lifecycle"
      && value.live_paired_lifecycle_proven === true
      && lifecycleReady);
  const expectedReady = shadowReady && executionReady && capitalReady && routesReady && supervisionReady && reasons.length === 0;
  const valid = value.version === 1
    && value.kind === "ghola_private_prime_no_submit_readiness"
    && proofBoundaryValid
    && value.owner_only_funding === true
    && value.owner_only_transfers === true
    && value.owner_only_withdrawals === true
    && value.transaction_broadcast === false
    && checkedAt !== null && expiresAt !== null && checkedAt <= nowMs && expiresAt > nowMs
    && typeof value.evidence_commitment === "string"
    && value.evidence_commitment.startsWith("carry:private-prime:")
    && value.ready === expectedReady;
  if (!valid) return { status: "invalid", value: "UNVERIFIED", detail: "WORKER PROOF INVALID", tone: "bad" };

  const statusValue = `${shadowReady ? shadowCount : 0}/${CORE_PERP_VENUES.length} DATA · ${executionReady ? venues.length : 0}/${CARRY_EXECUTION_VENUES.length} EXEC · ${routesReady ? "ROUTES" : "NO ROUTES"}`;
  if (expectedReady) {
    return {
      status: "ready",
      value: statusValue,
      detail: lifecycleReady
        ? "LIVE PAIRED PROOF · FLAT VERIFIED · OWNER CONTROLLED"
        : "PRE-BROADCAST · CAPITAL READY · OWNER CONTROLLED",
      tone: "good",
    };
  }
  const labels = reasons.map(reasonLabel);
  return {
    status: "blocked",
    value: statusValue,
    detail: labels.length ? labels.join(" · ") : "READINESS BLOCKED",
    tone: reasons.includes("opening_capital_shortfall") ? "warn" : "bad",
  };
}

function reasonLabel(reason: string) {
  if (reason === "three_venue_no_submit_unproven") return "CONNECT EXECUTION";
  if (reason === "opening_capital_shortfall") return "OWNER CAPITAL REQUIRED";
  if (reason === "five_venue_shadow_unproven") return "DATA SOAK REQUIRED";
  if (reason === "carry_supervision_unready") return "RISK ENGINE UNREADY";
  if (reason === "collateral_route_observation_unavailable") return "ROUTES UNAVAILABLE";
  if (reason === "collateral_route_evidence_unverified") return "ROUTES UNVERIFIED";
  if (reason === "collateral_route_unavailable") return "NO SAFE ROUTE";
  return "CHECK REQUIRED";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function integer(value: unknown): number | null {
  return Number.isSafeInteger(value) ? Number(value) : null;
}
