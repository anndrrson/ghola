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
  const recoveryReasons = strings(recovery.reasons);
  const recoveryPolicy = record(recovery.policy);
  const route = record(value.collateral_route_observation);
  const supervision = record(value.supervision);
  const pairedLifecycle = record(value.paired_lifecycle);
  const releaseEquivalent = record(value.release_equivalent_lifecycles);
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
    && Array.isArray(recovery.reasons)
    && recoveryReasons.length === 0
    && recoveryVenues.length === CARRY_EXECUTION_VENUES.length
    && CARRY_EXECUTION_VENUES.every((venueId, index) => recoveryVenues[index] === venueId)
    && Object.entries(CARRY_RECOVERY_POLICY).every(([key, expected]) => recoveryPolicy[key] === expected)
    && Object.keys(recoveryPolicy).length === Object.keys(CARRY_RECOVERY_POLICY).length;
  const capitalReady = execution.capital_ready === true;
  const routeCheckedAt = integer(route.checked_at_ms);
  const routeExpiresAt = integer(route.expires_at_ms);
  const requiredRouteCount = CARRY_EXECUTION_VENUES.length * (CARRY_EXECUTION_VENUES.length - 1);
  const availableRouteCount = integer(route.available_route_count) || 0;
  const routesReady = route.configured === true
    && route.verified === true
    && Number(route.route_count) === requiredRouteCount
    && Number(route.required_route_count) === requiredRouteCount
    && availableRouteCount === requiredRouteCount
    && route.complete_directed_coverage === true
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
  const derivedReasons = [
    ...(!executionReady ? ["three_venue_no_submit_unproven"] : []),
    ...(executionReady && !recoveryReady ? ["three_venue_recovery_unproven"] : []),
    ...(!shadowReady ? ["five_venue_shadow_unproven"] : []),
    ...(!supervisionReady ? ["carry_supervision_unready"] : []),
    ...(route.configured !== true
      ? ["collateral_route_observation_unavailable"]
      : route.verified !== true
        ? ["collateral_route_evidence_unverified"]
        : availableRouteCount < 1
          ? ["collateral_route_unavailable"]
          : route.complete_directed_coverage !== true
            ? ["collateral_route_coverage_incomplete"]
          : []),
    ...(executionReady && !capitalReady ? ["opening_capital_shortfall"] : []),
  ];
  const lifecycleExpiresAt = integer(pairedLifecycle.expires_at_ms);
  const lifecycleAttribution = parseLifecycleValueAttribution(pairedLifecycle.value_attribution);
  const lifecycleReady = verifiedPairedLifecycle(pairedLifecycle, value.asset, nowMs);
  const releaseLifecycles = Array.isArray(releaseEquivalent.lifecycles)
    ? releaseEquivalent.lifecycles.map(record)
    : [];
  const releasePositionIds = releaseLifecycles.map((item) => String(item.position_id || ""));
  const releaseEvidenceCommitments = releaseLifecycles.map((item) => String(item.evidence_commitment || ""));
  const releaseNormalizedPairs = releaseLifecycles.map(normalizedVenuePair);
  const uniqueReleasePositionIds = [...new Set(releasePositionIds)].sort();
  const uniqueReleaseNormalizedPairs = [...new Set(releaseNormalizedPairs)].sort();
  const releaseLifecycleExpiries = releaseLifecycles.map((item) => integer(item.expires_at_ms));
  const releaseLifecyclesValid = releaseLifecycles.every((item) => verifiedPairedLifecycle(item, value.asset, nowMs));
  const expectedReleaseEquivalentReady = releaseLifecyclesValid
    && releasePositionIds.every(Boolean)
    && uniqueReleasePositionIds.length >= 2
    && releaseEvidenceCommitments.every((item) => /^carry:lifecycle-proof:evidence:[0-9a-f]{64}$/.test(item))
    && new Set(releaseEvidenceCommitments).size === releaseLifecycles.length
    && releaseNormalizedPairs.every(Boolean)
    && uniqueReleaseNormalizedPairs.length >= 2;
  const expectedReleaseExpiry = expectedReleaseEquivalentReady
    ? Math.min(...releaseLifecycleExpiries.map((item) => Number(item)))
    : null;
  const releaseEquivalentValid = releaseEquivalent.lifecycle_count === releaseLifecycles.length
    && releaseEquivalent.distinct_position_count === uniqueReleasePositionIds.length
    && releaseEquivalent.distinct_venue_pair_count === uniqueReleaseNormalizedPairs.length
    && sameStrings(
      strings(releaseEquivalent.normalized_venue_pairs),
      uniqueReleaseNormalizedPairs,
    )
    && sameStrings(strings(releaseEquivalent.position_ids), uniqueReleasePositionIds)
    && sameStrings(
      strings(releaseEquivalent.lifecycle_evidence_commitments),
      [...releaseEvidenceCommitments].sort(),
    )
    && releaseEquivalent.verified === expectedReleaseEquivalentReady
    && integer(releaseEquivalent.expires_at_ms) === expectedReleaseExpiry;
  const releaseEquivalentReady = releaseEquivalentValid && expectedReleaseEquivalentReady;
  const proofBoundaryValid = (value.proof_level === "pre_broadcast_readiness"
      && value.live_paired_lifecycle_proven === false
      && pairedLifecycle.verified !== true)
    || (value.proof_level === "live_paired_lifecycle"
      && value.live_paired_lifecycle_proven === true
      && lifecycleReady);
  const technicalReasons = derivedReasons.filter((reason) => reason !== "opening_capital_shortfall");
  const expectedReady = shadowReady && executionReady && recoveryReady && routesReady && supervisionReady && technicalReasons.length === 0;
  const expectedLiveReady = expectedReady && capitalReady && lifecycleReady && releaseEquivalentReady;
  const expectedLiveLaunchBlockers = [
    ...reasons,
    ...(lifecycleReady ? [] : ["live_paired_lifecycle_unproven"]),
    ...(lifecycleReady && !releaseEquivalentReady ? ["live_release_lifecycle_coverage_unproven"] : []),
  ];
  const valid = value.version === 1
    && value.kind === "ghola_private_prime_no_submit_readiness"
    && proofBoundaryValid
    && releaseEquivalentValid
    && value.owner_only_funding === true
    && value.owner_only_transfers === true
    && value.owner_only_withdrawals === true
    && value.transaction_broadcast === false
    && checkedAt !== null && expiresAt !== null && checkedAt <= nowMs && expiresAt > nowMs
    && value.evidence_commitment === carryPrivatePrimeEvidenceCommitment(value)
    && sameStrings(reasons, derivedReasons)
    && (!supervisionReady || (supervisionCheckedAt !== null && expiresAt <= supervisionCheckedAt + 5_000))
    && (!lifecycleReady || (lifecycleExpiresAt !== null && expiresAt <= lifecycleExpiresAt))
    && (!releaseEquivalentReady || (expectedReleaseExpiry !== null && expiresAt <= expectedReleaseExpiry))
    && value.ready === expectedReady
    && value.no_submit_ready === expectedReady
    && value.ready_for_live_users === expectedLiveReady
    && sameStrings(liveLaunchBlockers, expectedLiveLaunchBlockers);
  if (!valid) return { status: "invalid", value: "UNVERIFIED", detail: "WORKER PROOF INVALID", tone: "bad" };

  const statusValue = `${shadowReady ? shadowCount : 0}/${CORE_PERP_VENUES.length} DATA · ${executionReady ? venues.length : 0}/${CARRY_EXECUTION_VENUES.length} EXEC · ${recoveryReady ? recoveryVenues.length : 0}/${CARRY_EXECUTION_VENUES.length} REC · ${Math.min(availableRouteCount, requiredRouteCount)}/${requiredRouteCount} ROUTES`;
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
      detail: capitalReady
        ? lifecycleReady
          ? "QUALIFIED · NO-SUBMIT ONLY · LIVE LIFECYCLE COVERAGE REQUIRED"
          : "QUALIFIED · NO-SUBMIT ONLY · LIVE PAIRED PROOF REQUIRED"
        : "QUALIFIED · NO-SUBMIT · OWNER CAPITAL REQUIRED FOR LIVE ENTRY",
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
  const material = { ...value };
  delete material.evidence_commitment;
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
  if (reason === "collateral_route_coverage_incomplete") return "ROUTE COVERAGE INCOMPLETE";
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

function verifiedPairedLifecycle(value: Record<string, unknown>, expectedAsset: unknown, nowMs: number): boolean {
  const venues = strings(value.venue_ids);
  const verifiedAt = integer(value.verified_at_ms);
  const expiresAt = integer(value.expires_at_ms);
  const realizedNet = integer(value.realized_net_value_micro_usdc);
  const attribution = parseLifecycleValueAttribution(value.value_attribution);
  const firstExposure = integer(value.first_exposure_observed_at_ms);
  const boundaries = record(value.first_exposure_observed_at_ms_by_venue);
  const provenances = record(value.exposure_boundary_provenance_by_venue);
  const boundaryReady = venues.length === 2
    && Object.keys(boundaries).length === 2
    && Object.keys(provenances).length === 2
    && venues.every((venueId) => integer(boundaries[venueId]) !== null
      && Number(boundaries[venueId]) > 0
      && provenances[venueId] === "authoritative_exchange_fill_time")
    && firstExposure !== null
    && firstExposure === Math.min(...venues.map((venueId) => Number(boundaries[venueId])));
  return value.verified === true
    && value.asset === expectedAsset
    && venues.length === 2
    && new Set(venues).size === 2
    && venues.every((venueId) => CARRY_EXECUTION_VENUES.includes(venueId as typeof CARRY_EXECUTION_VENUES[number]))
    && verifiedAt !== null
    && verifiedAt <= nowMs
    && expiresAt !== null
    && expiresAt > nowMs
    && value.account_bindings_verified === true
    && value.live_entry_exit_proven === true
    && value.supervised_monitoring_proven === true
    && value.final_flat_zero_orders === true
    && value.value_ledger_finalized === true
    && value.value_boundary_authoritative === true
    && value.exposure_boundary_provenance === "authoritative_exchange_fill_time"
    && boundaryReady
    && realizedNet !== null
    && attribution?.realized.net_value_micro_usdc === realizedNet
    && value.ambiguity_retry_count === 0
    && value.owner_only_funding === true
    && value.owner_only_transfers === true
    && value.owner_only_withdrawals === true
    && value.transaction_broadcast === false
    && /^carry:creation-inputs:[0-9a-f]{64}$/.test(String(value.creation_input_evidence_commitment || ""))
    && /^carry:release:material:[0-9a-f]{64}$/.test(String(value.worker_material_commitment || ""))
    && /^carry:lifecycle-proof:evidence:[0-9a-f]{64}$/.test(String(value.evidence_commitment || ""));
}

function normalizedVenuePair(value: Record<string, unknown>): string {
  const venues = strings(value.venue_ids);
  return venues.length === 2 && new Set(venues).size === 2
    ? [...venues].sort().join(":")
    : "";
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
