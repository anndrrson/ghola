import {
  CARRY_RECOVERY_POLICY,
  canonicalCarryCommitmentJson,
  normalizeCarryLifecycleValueAttribution,
  type CarryLifecycleValueAttribution,
} from "@ghola/execution-core";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
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
  const recovery = record(value.failure_recovery);
  const recoveryPolicy = record(recovery.policy);
  const route = record(value.collateral_route_observation);
  const supervision = record(value.supervision);
  const pairedLifecycle = record(value.paired_lifecycle);
  const reasons = strings(value.reasons);
  const liveLaunchBlockers = strings(value.live_launch_blockers);
  const venues = strings(execution.venue_ids);
  const checkedAt = integer(value.checked_at_ms);
  const expiresAt = integer(value.expires_at_ms);
  const shadowCount = integer(shadow.venue_count) || 0;
  const shadowReady = shadow.ready === true && shadowCount === CORE_PERP_VENUES.length;
  const executionReady = execution.ready === true
    && venues.length === CARRY_EXECUTION_VENUES.length
    && CARRY_EXECUTION_VENUES.every((venueId, index) => venues[index] === venueId);
  const recoveryVenues = strings(recovery.venue_ids);
  const recoveryReady = recovery.ready === true
    && recoveryVenues.length === CARRY_EXECUTION_VENUES.length
    && CARRY_EXECUTION_VENUES.every((venueId, index) => recoveryVenues[index] === venueId)
    && Object.entries(CARRY_RECOVERY_POLICY).every(([key, expected]) => recoveryPolicy[key] === expected)
    && Object.keys(recoveryPolicy).length === Object.keys(CARRY_RECOVERY_POLICY).length;
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
  const supervisionCheckedAt = integer(supervision.checked_at_ms);
  const supervisionReady = supervision.ready === true
    && supervision.status === "healthy"
    && supervisionCheckedAt !== null
    && supervisionCheckedAt <= nowMs + 5_000
    && nowMs - supervisionCheckedAt <= 5_000
    && /^carry:supervision:evidence:[0-9a-f]{64}$/.test(String(supervision.evidence_commitment || ""));
  const lifecycleVenues = strings(pairedLifecycle.venue_ids);
  const lifecycleVerifiedAt = integer(pairedLifecycle.verified_at_ms);
  const lifecycleExpiresAt = integer(pairedLifecycle.expires_at_ms);
  const lifecycleRealizedNet = integer(pairedLifecycle.realized_net_value_micro_usdc);
  const lifecycleAttribution = parseLifecycleValueAttribution(pairedLifecycle.value_attribution);
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
    && lifecycleRealizedNet !== null
    && lifecycleAttribution?.realized.net_value_micro_usdc === lifecycleRealizedNet
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
  const expectedReady = shadowReady && executionReady && recoveryReady && capitalReady && routesReady && supervisionReady && reasons.length === 0;
  const expectedLiveReady = expectedReady && lifecycleReady;
  const expectedLiveLaunchBlockers = [
    ...reasons,
    ...(lifecycleReady ? [] : ["live_paired_lifecycle_unproven"]),
  ];
  const valid = value.version === 1
    && value.kind === "ghola_private_prime_no_submit_readiness"
    && proofBoundaryValid
    && value.owner_only_funding === true
    && value.owner_only_transfers === true
    && value.owner_only_withdrawals === true
    && value.transaction_broadcast === false
    && checkedAt !== null && expiresAt !== null && checkedAt <= nowMs && expiresAt > nowMs
    && value.evidence_commitment === carryPrivatePrimeEvidenceCommitment(value)
    && (!supervisionReady || (supervisionCheckedAt !== null && expiresAt <= supervisionCheckedAt + 5_000))
    && (!lifecycleReady || (lifecycleExpiresAt !== null && expiresAt <= lifecycleExpiresAt))
    && value.ready === expectedReady
    && value.no_submit_ready === expectedReady
    && value.ready_for_live_users === expectedLiveReady
    && sameStrings(liveLaunchBlockers, expectedLiveLaunchBlockers);
  if (!valid) return { status: "invalid", value: "UNVERIFIED", detail: "WORKER PROOF INVALID", tone: "bad" };

  const statusValue = `${shadowReady ? shadowCount : 0}/${CORE_PERP_VENUES.length} DATA · ${executionReady ? venues.length : 0}/${CARRY_EXECUTION_VENUES.length} EXEC · ${recoveryReady ? recoveryVenues.length : 0}/${CARRY_EXECUTION_VENUES.length} REC · ${routesReady ? "ROUTES" : "NO ROUTES"}`;
  if (expectedLiveReady && lifecycleAttribution) {
    return {
      status: "ready",
      value: statusValue,
      detail: liveLifecycleDetail(lifecycleAttribution),
      tone: "good",
    };
  }
  if (expectedReady) {
    return {
      status: "pending",
      value: statusValue,
      detail: "QUALIFIED · NO-SUBMIT ONLY · LIVE PAIRED PROOF REQUIRED",
      tone: "warn",
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

export function carryPrivatePrimeEvidenceCommitment(input: unknown): string | null {
  const value = record(input);
  if (!Object.keys(value).length) return null;
  const { evidence_commitment: _ignored, ...material } = value;
  try {
    const digest = sha256(new TextEncoder().encode(canonicalCarryCommitmentJson(material)));
    return `carry:private-prime:${bytesToHex(digest).slice(0, 40)}`;
  } catch {
    return null;
  }
}

function reasonLabel(reason: string) {
  if (reason === "three_venue_no_submit_unproven") return "CONNECT EXECUTION";
  if (reason === "three_venue_recovery_unproven") return "RECOVERY UNPROVEN";
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

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function parseLifecycleValueAttribution(input: unknown): CarryLifecycleValueAttribution | null {
  try {
    return normalizeCarryLifecycleValueAttribution(input);
  } catch {
    return null;
  }
}

function liveLifecycleDetail(value: CarryLifecycleValueAttribution): string {
  return `LIVE · NET ${formatSignedMicroUsd(value.realized.net_value_micro_usdc)} · ΔMODEL ${formatSignedMicroUsd(value.variance_from_modeled_micro_usdc)} · FUND ${formatSignedMicroUsd(value.realized.funding_micro_usdc)} · PNL ${formatSignedMicroUsd(value.realized.contract_pnl_micro_usdc)} · COST ${formatSignedMicroUsd(-value.realized_total_cost_micro_usdc)} · FLAT`;
}

function formatSignedMicroUsd(value: number): string {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  const dollars = Math.abs(value) / 1_000_000;
  const decimals = dollars >= 100 ? 2 : dollars >= 1 ? 4 : 6;
  return `${sign}$${dollars.toFixed(decimals)}`;
}
