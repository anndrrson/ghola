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
  const routesReady = route.configured === true
    && route.read_only === true
    && route.owner_approval_required === true
    && route.automatic_transfer_permitted === false;
  const supervisionReady = supervision.ready === true && supervision.status === "healthy";
  const expectedReady = shadowReady && executionReady && capitalReady && routesReady && supervisionReady && reasons.length === 0;
  const valid = value.version === 1
    && value.kind === "ghola_private_prime_no_submit_readiness"
    && value.proof_level === "pre_broadcast_readiness"
    && value.live_paired_lifecycle_proven === false
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
    return { status: "ready", value: statusValue, detail: "PRE-BROADCAST · CAPITAL READY · OWNER CONTROLLED", tone: "good" };
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
