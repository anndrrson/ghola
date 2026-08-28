import {
  CARRY_EXECUTION_VENUES,
  CARRY_SHADOW_ASSETS,
  CORE_PERP_VENUES,
  adverseExecutionSlippageE6Bps,
  estimatePerpDepthExecution,
  evaluatePerpContractPairBasis,
  executionVenueLabel,
} from "@ghola/execution-core";

export type CarryShadowStatus = "ready" | "degraded" | "quarantined";

export interface CarryDepthLevel {
  price_e8: number;
  size_e8: number;
}

export interface CarryShadowSnapshot {
  venue_id: string;
  contract_id: string;
  economic_equivalence_id: string;
  asset: string;
  market: string;
  quote_asset: string;
  collateral_asset?: string | null;
  contract_type: "linear_perp" | "inverse_perp";
  status: CarryShadowStatus;
  stale: boolean;
  funding_rate_e12_per_interval: number | null;
  funding_interval_ms: number | null;
  maker_fee_bps: number | null;
  taker_fee_bps: number | null;
  minimum_notional_micro_usdc: number | null;
  quantity_step_e8?: number | null;
  initial_margin_bps: number | null;
  maintenance_margin_bps: number | null;
  margin_model?: string | null;
  liquidation_fee_bps?: number | null;
  liquidation_model?: string | null;
  mark_price_e8?: number | null;
  index_price_e8?: number | null;
  best_bid_e8: number | null;
  best_ask_e8: number | null;
  depth_bids?: CarryDepthLevel[];
  depth_asks?: CarryDepthLevel[];
  depth_observed_at_ms?: number | null;
  source_observed_at_ms?: {
    market?: number | null;
    funding?: number | null;
    orderbook?: number | null;
  };
  source_max_age_ms?: {
    market?: number | null;
    funding?: number | null;
    orderbook?: number | null;
  };
  stale_sources?: string[];
  as_of_ms?: number | null;
  observed_at_ms?: number | null;
  missing_fields: string[];
}

export interface CarryVenueShadow {
  venue_id: string;
  ok: boolean;
  error?: string;
  snapshots: CarryShadowSnapshot[];
}

export interface CarryFundingPersistenceRoute {
  asset: string;
  long_venue_id: string;
  short_venue_id: string;
  ready: boolean;
  reasons: string[];
  sample_count: number;
  minimum_samples: number;
  observed_span_ms: number;
  minimum_span_ms: number;
  conservative_hourly_spread_e12: number | null;
  conservative_funding_rate_e12_by_venue?: Record<string, number>;
  evidence_commitment: string | null;
}

export interface CarryFundingPersistenceSummary {
  version: 1;
  transaction_broadcast: false;
  observed_route_count: number;
  ready_route_count: number;
  routes: CarryFundingPersistenceRoute[];
}

export interface CarryFundingEvidence {
  status: "indicative" | "observing" | "durable" | "rejected";
  value: string;
  detail: string;
}

export interface CarryShadowQualificationSummary {
  version: 1;
  kind?: "carry_shadow_qualification";
  ready: boolean;
  release_bound: boolean;
  transaction_broadcast: false;
  image_digest: string;
  checked_at_ms: number | null;
  required_samples: number;
  completed_samples: number;
  venues: number;
  assets: number;
  requested_assets: string[];
  minimum_span_ms?: number;
  duration_ms?: number | null;
  expected_snapshots_per_sample?: number;
  sample_commitments?: string[];
  source_observation_commitments?: string[];
  evidence_commitment?: string | null;
  failures: string[];
}

export interface CarryMarketQualificationEvidence {
  status: "observing" | "ready" | "rejected";
  value: string;
  detail: string;
}

export interface CarryShadowResponse {
  version: 1;
  mode: "shadow_read_only";
  executable: false;
  observed_at: string;
  funding_persistence?: CarryFundingPersistenceSummary;
  shadow_qualification?: CarryShadowQualificationSummary;
  routing_advantage?: CarryRoutingAdvantageSummary;
  venues: CarryVenueShadow[];
  error?: string;
}

export interface CarryCandidate {
  asset: string;
  long: CarryShadowSnapshot;
  short: CarryShadowSnapshot;
  grossAnnualBps: number;
  exact: boolean;
}

export interface CarryLiveMarketPatch {
  venue_id: string;
  asset: string;
  received_at_ms: number;
  source_at_ms?: number | null;
  mark_price_e8?: number | null;
  index_price_e8?: number | null;
  best_bid_e8?: number | null;
  best_ask_e8?: number | null;
  funding_rate_e12_per_interval?: number | null;
  funding_interval_ms?: number | null;
  depth_bids?: CarryDepthLevel[];
  depth_asks?: CarryDepthLevel[];
  depth_complete?: boolean;
}

export interface CarryQuoteModel {
  notionalUsd: number;
  horizonHours: number;
  grossFundingUsd: number;
  roundTripCostUsd: number | null;
  modeledTotalCostUsd: number | null;
  expectedNetUsd: number | null;
  grossDailyUsd: number;
  expectedNetDailyUsd: number | null;
  breakEvenHours: number | null;
  exactCosts: boolean;
  tradingFeeUsd: number | null;
  slippageUsd: number | null;
  latencyBufferUsd: number | null;
  capitalCostUsd: number | null;
  riskBufferUsd: number | null;
  collateralBasisRiskUsd: number | null;
  depthStatus: "sufficient" | "insufficient" | "unavailable";
  minimumDisplayedDepthUsd: number | null;
}

export interface PricedCarryCandidate {
  candidate: CarryCandidate;
  quote: CarryQuoteModel;
  daily_value_bps: number;
  economics_quality: "positive_net" | "exact_nonpositive" | "gross_only";
}

export interface CarryRoutingAdvantage {
  status: "advantaged" | "equal" | "disadvantaged" | "unavailable";
  indicative: true;
  benchmarkKind: "next_best_executable_route";
  selectedRoute: string | null;
  baselineRoute: string | null;
  dailyNetAdvantageUsd: number | null;
  dailyNetAdvantageBps: number | null;
  reason: string | null;
}

export interface CarryRoutingAdvantageRouteEvidence {
  asset: string;
  status: CarryRoutingAdvantage["status"];
  selected_route: { long_venue_id: string; short_venue_id: string } | null;
  baseline_route: { long_venue_id: string; short_venue_id: string } | null;
  daily_net_advantage_micro_usdc: number | null;
  daily_net_advantage_e6_bps: number | null;
  sample_count: number;
  minimum_samples: number;
  observed_span_ms: number;
  minimum_span_ms: number;
  funding_evidence_commitments: string[];
  ready: boolean;
  reasons: string[];
}

export interface CarryRoutingAdvantageSummary {
  version: 2;
  kind: "carry_routing_advantage";
  ready: boolean;
  failures: string[];
  benchmark_kind: "next_best_executable_route";
  execution_venue_ids: string[];
  requested_assets: string[];
  notional_micro_usdc: number;
  horizon_ms: number;
  modeled: true;
  realized: false;
  account_fee_tier_included: false;
  execution_ready: false;
  transaction_broadcast: false;
  shadow_qualification_commitment: string | null;
  observer_image_digest: string | null;
  observed_at_ms: number;
  routes: CarryRoutingAdvantageRouteEvidence[];
  evidence_commitment: string;
}

export interface CarryRoutingAdvantageEvidence {
  status: "committed" | "indicative" | "rejected";
  label: "EDGE✓" | "EDGE*" | "EDGE!";
  advantage: CarryRoutingAdvantage;
  detail: string;
}

export const CARRY_LIVE_PATCH_MAX_AGE_MS = 5_000;
export const CARRY_DEPTH_MAX_AGE_MS = 30_000;
export const CARRY_MAX_CONTRACT_DATA_SKEW_MS = 2_000;
export const CARRY_MAX_INDEX_PRICE_DIVERGENCE_BPS = 25;
export const CARRY_MAX_MARK_PRICE_DIVERGENCE_BPS = 50;
export const CARRY_CAPITAL_COST_BPS_PER_DAY = 1;
export const CARRY_BASE_RISK_BUFFER_BPS = 10;
export const CARRY_LATENCY_BUFFER_BPS_PER_LEG = 1;
export const CARRY_STABLE_COLLATERAL_BASIS_RISK_BPS = 50;
const CARRY_FUNDING_COMMITMENT = /^carry:funding:[a-f0-9]{64}$/;
const CARRY_SHADOW_SAMPLE_COMMITMENT = /^carry:shadow:sample:[a-f0-9]{64}$/;
const CARRY_SHADOW_SOURCE_COMMITMENT = /^carry:shadow:sources:[a-f0-9]{64}$/;
const CARRY_SHADOW_QUALIFICATION_COMMITMENT = /^carry:shadow:qualification:[a-f0-9]{64}$/;
const CARRY_ROUTING_ADVANTAGE_COMMITMENT = /^carry:routing:advantage:[a-f0-9]{64}$/;
const CARRY_IMAGE_DIGEST = /^sha256:[a-f0-9]{12,128}$/;
const depthExecutionCache = new WeakMap<CarryShadowSnapshot, Map<string, ReturnType<typeof estimatePerpDepthExecution>>>();
const pairCompatibilityCache = new WeakMap<CarryShadowSnapshot, WeakMap<CarryShadowSnapshot, boolean>>();

export const CARRY_VENUE_LABELS: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(
  CORE_PERP_VENUES.map((venueId) => [venueId, executionVenueLabel(venueId)]),
));

export function carryMarketQualificationEvidence(
  response: CarryShadowResponse | null,
): CarryMarketQualificationEvidence {
  const qualification = response?.shadow_qualification;
  if (!qualification) {
    return { status: "observing", value: "—", detail: "Five-venue market qualification has not started." };
  }
  const required = safeNonnegativeInteger(qualification.required_samples);
  const completed = safeNonnegativeInteger(qualification.completed_samples);
  const samples = Array.isArray(qualification.sample_commitments) ? qualification.sample_commitments : [];
  const sourceObservations = Array.isArray(qualification.source_observation_commitments)
    ? qualification.source_observation_commitments
    : [];
  const failures = Array.isArray(qualification.failures) ? qualification.failures : [];
  const bound = qualification.release_bound === true
    && CARRY_IMAGE_DIGEST.test(qualification.image_digest)
    && CARRY_SHADOW_QUALIFICATION_COMMITMENT.test(String(qualification.evidence_commitment || ""));
  const coverage = qualification.venues === CORE_PERP_VENUES.length
    && qualification.assets === CARRY_SHADOW_ASSETS.length
    && qualification.expected_snapshots_per_sample === CORE_PERP_VENUES.length * CARRY_SHADOW_ASSETS.length
    && sameStrings(qualification.requested_assets, CARRY_SHADOW_ASSETS);
  const durableSpan = safeNonnegativeInteger(qualification.minimum_span_ms) >= 120_000
    && safeNonnegativeInteger(qualification.duration_ms) >= safeNonnegativeInteger(qualification.minimum_span_ms);
  const distinctSamples = samples.length === completed
    && new Set(samples).size === samples.length
    && samples.every((value) => CARRY_SHADOW_SAMPLE_COMMITMENT.test(value));
  const distinctSourceObservations = sourceObservations.length === completed
    && new Set(sourceObservations).size === sourceObservations.length
    && sourceObservations.every((value) => CARRY_SHADOW_SOURCE_COMMITMENT.test(value));
  const ready = qualification.ready === true
    && qualification.transaction_broadcast === false
    && failures.length === 0
    && required >= 3
    && completed >= required
    && bound
    && coverage
    && durableSpan
    && distinctSamples
    && distinctSourceObservations;
  if (ready) {
    return {
      status: "ready",
      value: `${CORE_PERP_VENUES.length}V ${completed}/${required}`,
      detail: `${CORE_PERP_VENUES.length} venues and ${CARRY_SHADOW_ASSETS.join("/")} passed consecutive, worker-bound market checks.`,
    };
  }
  if (qualification.ready === true || failures.some((reason) => [
    "shadow_qualification_evidence_invalid",
    "shadow_qualification_image_mismatch",
    "shadow_qualification_sample_policy_mismatch",
    "shadow_qualification_asset_mismatch",
    "shadow_qualification_stale",
  ].includes(reason))) {
    return { status: "rejected", value: "FAIL", detail: "Five-venue market qualification failed closed." };
  }
  return {
    status: "observing",
    value: required > 0 ? `${CORE_PERP_VENUES.length}V ${completed}/${required}` : "—",
    detail: `Collecting consecutive ${CORE_PERP_VENUES.length}-venue market evidence; no order is submitted.`,
  };
}

export function carryFundingEvidenceForCandidate(
  response: CarryShadowResponse | null,
  candidate: CarryCandidate | null,
): CarryFundingEvidence {
  if (!candidate) return { status: "indicative", value: "—", detail: "No fresh route evidence." };
  const route = response?.funding_persistence?.routes.find((item) =>
    item.asset === candidate.asset &&
    item.long_venue_id === candidate.long.venue_id &&
    item.short_venue_id === candidate.short.venue_id
  );
  if (!route) return { status: "indicative", value: "—", detail: "Point-in-time quote; durable funding history unavailable." };

  const sampleCount = safeNonnegativeInteger(route.sample_count);
  const minimumSamples = safeNonnegativeInteger(route.minimum_samples);
  const observedSpanMs = safeNonnegativeInteger(route.observed_span_ms);
  const minimumSpanMs = safeNonnegativeInteger(route.minimum_span_ms);
  const reasons = Array.isArray(route.reasons) ? route.reasons : [];
  const committed = typeof route.evidence_commitment === "string" &&
    CARRY_FUNDING_COMMITMENT.test(route.evidence_commitment);
  const durable = route.ready === true && committed && reasons.length === 0 &&
    minimumSamples > 0 && sampleCount >= minimumSamples && observedSpanMs >= minimumSpanMs &&
    typeof route.conservative_hourly_spread_e12 === "number" && route.conservative_hourly_spread_e12 > 0;
  if (durable) {
    return {
      status: "durable",
      value: `${sampleCount}/${minimumSamples}`,
      detail: `Committed funding edge across ${formatEvidenceDuration(observedSpanMs)}.`,
    };
  }
  const rejected = route.ready === true || reasons.some((reason) => [
    "funding_not_persistent",
    "funding_persistence_evidence_invalid",
    "funding_persistence_state_unavailable",
    "funding_persistence_observation_failed",
  ].includes(reason));
  if (rejected) {
    return { status: "rejected", value: "FAIL", detail: "Durable funding evidence failed closed." };
  }
  if (minimumSamples > 0) {
    return {
      status: "observing",
      value: `${sampleCount}/${minimumSamples}`,
      detail: `Observing ${formatEvidenceDuration(observedSpanMs)} of ${formatEvidenceDuration(minimumSpanMs)}; durability check required.`,
    };
  }
  return { status: "indicative", value: "—", detail: "Point-in-time quote; durable funding history unavailable." };
}

export function buildCandidates(venues: CarryVenueShadow[], allowedVenueIds?: readonly string[]): CarryCandidate[] {
  const bestByAsset = new Map<string, CarryCandidate>();
  for (const candidate of buildPairCandidates(venues, allowedVenueIds)) {
    if (!bestByAsset.has(candidate.asset)) bestByAsset.set(candidate.asset, candidate);
  }
  return [...bestByAsset.values()].sort((left, right) => right.grossAnnualBps - left.grossAnnualBps);
}

export function buildPairCandidates(venues: CarryVenueShadow[], allowedVenueIds?: readonly string[]): CarryCandidate[] {
  const allowed = allowedVenueIds ? new Set(allowedVenueIds) : null;
  const byAsset = new Map<string, CarryShadowSnapshot[]>();
  for (const venue of venues) {
    if (allowed && !allowed.has(venue.venue_id)) continue;
    for (const snapshot of venue.snapshots || []) {
      if (!venue.ok || snapshot.stale || snapshot.status === "quarantined" || snapshot.funding_rate_e12_per_interval == null || !snapshot.funding_interval_ms) continue;
      const snapshots = byAsset.get(snapshot.asset);
      if (snapshots) snapshots.push(snapshot);
      else byAsset.set(snapshot.asset, [snapshot]);
    }
  }
  const result: CarryCandidate[] = [];
  for (const [asset, snapshots] of byAsset) {
    if (snapshots.length < 2) continue;
    const ranked = snapshots
      .map((snapshot) => ({ snapshot, annualBps: annualFundingBps(snapshot) }))
      .sort((left, right) => left.annualBps - right.annualBps);
    for (let longIndex = 0; longIndex < ranked.length - 1; longIndex += 1) {
      for (let shortIndex = longIndex + 1; shortIndex < ranked.length; shortIndex += 1) {
        const long = ranked[longIndex];
        const short = ranked[shortIndex];
        if (long.snapshot.venue_id === short.snapshot.venue_id || short.annualBps <= long.annualBps ||
            !carryContractsAreComparable(long.snapshot, short.snapshot)) continue;
        result.push({
          asset,
          long: long.snapshot,
          short: short.snapshot,
          grossAnnualBps: short.annualBps - long.annualBps,
          exact: long.snapshot.status === "ready" && short.snapshot.status === "ready",
        });
      }
    }
  }
  return result.sort((left, right) => right.grossAnnualBps - left.grossAnnualBps);
}

export function carryContractsAreComparable(
  long: CarryShadowSnapshot,
  short: CarryShadowSnapshot,
) {
  const cached = pairCompatibilityCache.get(long)?.get(short);
  if (cached !== undefined) return cached;
  let comparable = false;
  const longAsOf = long.as_of_ms;
  const shortAsOf = short.as_of_ms;
  if (Number.isSafeInteger(longAsOf) && Number.isSafeInteger(shortAsOf) &&
      Math.abs(Number(longAsOf) - Number(shortAsOf)) <= CARRY_MAX_CONTRACT_DATA_SKEW_MS) {
    try {
      comparable = evaluatePerpContractPairBasis({
        version: 1,
        long_contract: long,
        short_contract: short,
        max_index_price_divergence_bps: CARRY_MAX_INDEX_PRICE_DIVERGENCE_BPS,
        max_mark_price_divergence_bps: CARRY_MAX_MARK_PRICE_DIVERGENCE_BPS,
      }).eligible === true;
    } catch {
      comparable = false;
    }
  }
  let byShort = pairCompatibilityCache.get(long);
  if (!byShort) {
    byShort = new WeakMap<CarryShadowSnapshot, boolean>();
    pairCompatibilityCache.set(long, byShort);
  }
  byShort.set(short, comparable);
  return comparable;
}

export function rankCarryCandidatesByNet(
  candidates: CarryCandidate[],
  notionalUsd = 10_000,
  horizonHours = 24,
  nowMs = Date.now(),
): PricedCarryCandidate[] {
  return candidates.map((candidate) => {
    const quote = quoteCarryCandidate(candidate, notionalUsd, horizonHours, nowMs);
    const dailyValueBps = quote.exactCosts && quote.expectedNetDailyUsd != null && quote.notionalUsd > 0
      ? quote.expectedNetDailyUsd / quote.notionalUsd * 10_000
      : candidate.grossAnnualBps / 365;
    const economicsQuality: PricedCarryCandidate["economics_quality"] = quote.exactCosts
      ? quote.expectedNetDailyUsd != null && quote.expectedNetDailyUsd > 0
        ? "positive_net"
        : "exact_nonpositive"
      : "gross_only";
    return {
      candidate,
      quote,
      daily_value_bps: dailyValueBps,
      economics_quality: economicsQuality,
    };
  }).sort((left, right) =>
    economicsQualityRank(right.economics_quality) - economicsQualityRank(left.economics_quality) ||
    right.daily_value_bps - left.daily_value_bps ||
    right.candidate.grossAnnualBps - left.candidate.grossAnnualBps
  );
}

export function carryRoutingAdvantage(
  selected: PricedCarryCandidate | null,
  candidates: PricedCarryCandidate[],
): CarryRoutingAdvantage {
  if (!exactComparableQuote(selected)) {
    return unavailableRoutingAdvantage("selected_route_unpriced");
  }
  const selectedAsset = selected.candidate.asset;
  const selectedNotional = selected.quote.notionalUsd;
  const selectedHorizon = selected.quote.horizonHours;
  const comparable = candidates.filter((item) =>
    exactComparableQuote(item)
    && item.candidate.asset === selectedAsset
    && item.quote.notionalUsd === selectedNotional
    && item.quote.horizonHours === selectedHorizon
  );
  const alternatives = comparable.filter(({ candidate }) =>
    carryRouteId(candidate) !== carryRouteId(selected.candidate)
  );
  if (alternatives.length === 0) {
    return unavailableRoutingAdvantage("comparison_route_unavailable", carryRouteId(selected.candidate));
  }
  const baseline = alternatives.reduce((best, item) =>
    item.quote.expectedNetDailyUsd! > best.quote.expectedNetDailyUsd! ? item : best
  );
  const dailyNetAdvantageUsd = selected.quote.expectedNetDailyUsd! - baseline.quote.expectedNetDailyUsd!;
  const dailyNetAdvantageBps = dailyNetAdvantageUsd / selectedNotional * 10_000;
  const epsilon = 1e-9;
  return {
    status: dailyNetAdvantageUsd > epsilon
      ? "advantaged"
      : dailyNetAdvantageUsd < -epsilon
        ? "disadvantaged"
        : "equal",
    indicative: true,
    benchmarkKind: "next_best_executable_route",
    selectedRoute: carryRouteId(selected.candidate),
    baselineRoute: carryRouteId(baseline.candidate),
    dailyNetAdvantageUsd,
    dailyNetAdvantageBps,
    reason: null,
  };
}

export function carryRoutingAdvantageEvidence(
  response: CarryShadowResponse | null,
  selected: PricedCarryCandidate | null,
  pointInTime: CarryRoutingAdvantage,
): CarryRoutingAdvantageEvidence {
  const summary = response?.routing_advantage;
  if (!summary) return indicativeAdvantage(pointInTime);
  const summaryValid = summary.version === 2
    && summary.kind === "carry_routing_advantage"
    && summary.ready === true
    && summary.modeled === true
    && summary.realized === false
    && summary.account_fee_tier_included === false
    && summary.execution_ready === false
    && summary.transaction_broadcast === false
    && summary.benchmark_kind === "next_best_executable_route"
    && Array.isArray(summary.routes)
    && Array.isArray(summary.execution_venue_ids)
    && summary.notional_micro_usdc === 10_000_000_000
    && summary.horizon_ms === 86_400_000
    && Number.isSafeInteger(summary.observed_at_ms)
    && summary.observed_at_ms === Date.parse(response!.observed_at)
    && Array.isArray(summary.failures) && summary.failures.length === 0
    && CARRY_ROUTING_ADVANTAGE_COMMITMENT.test(String(summary.evidence_commitment || ""))
    && CARRY_SHADOW_QUALIFICATION_COMMITMENT.test(String(summary.shadow_qualification_commitment || ""))
    && summary.shadow_qualification_commitment === response?.shadow_qualification?.evidence_commitment
    && CARRY_IMAGE_DIGEST.test(String(summary.observer_image_digest || ""))
    && summary.observer_image_digest === response?.shadow_qualification?.image_digest;
  if (!summaryValid) {
    return summary.ready === true
      ? rejectedAdvantage()
      : indicativeAdvantage(pointInTime);
  }
  if (!selected) return rejectedAdvantage();
  const route = summary.routes.find((item) => item.asset === selected.candidate.asset);
  const selectedRoute = route?.selected_route;
  const baselineRoute = route?.baseline_route;
  const selectedMatches = selectedRoute?.long_venue_id === selected.candidate.long.venue_id
    && selectedRoute?.short_venue_id === selected.candidate.short.venue_id
    && Math.round(selected.quote.notionalUsd * 1_000_000) === summary.notional_micro_usdc
    && Math.round(selected.quote.horizonHours * 3_600_000) === summary.horizon_ms;
  const baselineDistinct = Boolean(baselineRoute
    && selectedRoute
    && CARRY_EXECUTION_VENUES.includes(baselineRoute.long_venue_id as typeof CARRY_EXECUTION_VENUES[number])
    && CARRY_EXECUTION_VENUES.includes(baselineRoute.short_venue_id as typeof CARRY_EXECUTION_VENUES[number])
    && (baselineRoute.long_venue_id !== selectedRoute.long_venue_id
      || baselineRoute.short_venue_id !== selectedRoute.short_venue_id));
  const commitments = Array.isArray(route?.funding_evidence_commitments)
    ? route.funding_evidence_commitments
    : [];
  const knownFundingCommitments = new Set((response?.funding_persistence?.routes || [])
    .map((item) => item.evidence_commitment)
    .filter((value): value is string => typeof value === "string"));
  const routeValid = route?.ready === true
    && Array.isArray(route.reasons) && route.reasons.length === 0
    && ["advantaged", "equal", "disadvantaged"].includes(route.status)
    && selectedMatches
    && baselineDistinct
    && Number.isSafeInteger(route.sample_count) && route.sample_count >= route.minimum_samples
    && Number.isSafeInteger(route.observed_span_ms) && route.observed_span_ms >= route.minimum_span_ms
    && Number.isSafeInteger(route.daily_net_advantage_micro_usdc)
    && Number.isSafeInteger(route.daily_net_advantage_e6_bps)
    && commitments.length > 0
    && commitments.every((value) => CARRY_FUNDING_COMMITMENT.test(value) && knownFundingCommitments.has(value));
  if (!routeValid) return rejectedAdvantage();
  const dailyNetAdvantageUsd = route.daily_net_advantage_micro_usdc! / 1_000_000;
  const dailyNetAdvantageBps = route.daily_net_advantage_e6_bps! / 1_000_000;
  const advantage: CarryRoutingAdvantage = {
    status: route.status,
    indicative: true,
    benchmarkKind: summary.benchmark_kind,
    selectedRoute: `${route.asset}:${selectedRoute!.long_venue_id}:${selectedRoute!.short_venue_id}`,
    baselineRoute: `${route.asset}:${baselineRoute!.long_venue_id}:${baselineRoute!.short_venue_id}`,
    dailyNetAdvantageUsd,
    dailyNetAdvantageBps,
    reason: null,
  };
  return {
    status: "committed",
    label: "EDGE✓",
    advantage,
    detail: `${dailyNetAdvantageUsd >= 0 ? "+" : ""}$${dailyNetAdvantageUsd.toFixed(2)}/day worker-committed modeled net versus the next-best executable route across ${route.sample_count} funding samples; excludes the account fee tier and is not realized P&L.`,
  };
}

function indicativeAdvantage(advantage: CarryRoutingAdvantage): CarryRoutingAdvantageEvidence {
  return {
    status: "indicative",
    label: "EDGE*",
    advantage,
    detail: advantage.reason
      ? "Indicative route edge unavailable until exact costs exist for another executable route."
      : `${advantage.dailyNetAdvantageUsd! >= 0 ? "+" : ""}$${advantage.dailyNetAdvantageUsd!.toFixed(2)}/day point-in-time modeled net versus the next-best executable route; not realized P&L.`,
  };
}

function rejectedAdvantage(): CarryRoutingAdvantageEvidence {
  return {
    status: "rejected",
    label: "EDGE!",
    advantage: unavailableRoutingAdvantage("routing_advantage_evidence_invalid"),
    detail: "Worker routing-advantage evidence failed closed; no economic benefit is claimed.",
  };
}

export function applyCarryLivePatches(
  venues: CarryVenueShadow[],
  patches: CarryLiveMarketPatch[],
  nowMs = Date.now(),
): CarryVenueShadow[] {
  if (patches.length === 0) return venues;
  if (patches.length === 1) {
    const patch = patches[0];
    if (nowMs - patch.received_at_ms > CARRY_LIVE_PATCH_MAX_AGE_MS) return venues;
    const venueIndex = venues.findIndex((venue) => venue.venue_id === patch.venue_id);
    if (venueIndex < 0) return venues;
    const venue = venues[venueIndex];
    const snapshotIndex = venue.snapshots.findIndex((snapshot) => snapshot.asset === patch.asset);
    if (snapshotIndex < 0) return venues;
    const snapshots = venue.snapshots.slice();
    snapshots[snapshotIndex] = applyCarryLivePatch(snapshots[snapshotIndex], patch, nowMs);
    const next = venues.slice();
    next[venueIndex] = { ...venue, ok: true, snapshots };
    return next;
  }
  const byMarket = new Map<string, CarryLiveMarketPatch>();
  for (const patch of patches) {
    if (nowMs - patch.received_at_ms <= CARRY_LIVE_PATCH_MAX_AGE_MS) {
      byMarket.set(`${patch.venue_id}:${patch.asset}`, patch);
    }
  }
  if (byMarket.size === 0) return venues;
  return venues.map((venue) => {
    let changed = false;
    const snapshots = venue.snapshots.map((snapshot) => {
      const patch = byMarket.get(`${snapshot.venue_id}:${snapshot.asset}`);
      if (!patch) return snapshot;
      changed = true;
      return applyCarryLivePatch(snapshot, patch, nowMs);
    });
    return changed ? { ...venue, ok: true, snapshots } : venue;
  });
}

function applyCarryLivePatch(
  snapshot: CarryShadowSnapshot,
  patch: CarryLiveMarketPatch,
  nowMs: number,
): CarryShadowSnapshot {
  const markPrice = patchedNumber(patch.mark_price_e8, snapshot.mark_price_e8);
  const indexPrice = patchedNumber(patch.index_price_e8, snapshot.index_price_e8);
  const bestBid = patchedNumber(patch.best_bid_e8, snapshot.best_bid_e8);
  const bestAsk = patchedNumber(patch.best_ask_e8, snapshot.best_ask_e8);
  const fundingRate = patchedNumber(patch.funding_rate_e12_per_interval, snapshot.funding_rate_e12_per_interval);
  const fundingInterval = patchedNumber(patch.funding_interval_ms, snapshot.funding_interval_ms);
  const depthBids = patch.depth_bids === undefined
    ? snapshot.depth_bids
    : patch.depth_complete === true
      ? patch.depth_bids
      : mergePartialDepth(snapshot.depth_bids, patch.depth_bids, "bid", bestBid);
  const depthAsks = patch.depth_asks === undefined
    ? snapshot.depth_asks
    : patch.depth_complete === true
      ? patch.depth_asks
      : mergePartialDepth(snapshot.depth_asks, patch.depth_asks, "ask", bestAsk);
  const depthUpdated = patch.depth_bids !== undefined || patch.depth_asks !== undefined;
  const sourceAt = patch.source_at_ms ?? patch.received_at_ms;
  const sourceObservedAt = {
    ...snapshot.source_observed_at_ms,
    ...(patch.mark_price_e8 !== undefined || patch.index_price_e8 !== undefined ? { market: sourceAt } : {}),
    ...(patch.funding_rate_e12_per_interval !== undefined || patch.funding_interval_ms !== undefined ? { funding: sourceAt } : {}),
    ...(patch.best_bid_e8 !== undefined || patch.best_ask_e8 !== undefined || depthUpdated ? { orderbook: sourceAt } : {}),
  };
  const values = {
    mark_price_e8: markPrice,
    index_price_e8: indexPrice,
    best_bid_e8: bestBid,
    best_ask_e8: bestAsk,
    funding_rate_e12_per_interval: fundingRate,
    funding_interval_ms: fundingInterval,
  };
  const missingFields = snapshot.missing_fields.length === 0
    ? snapshot.missing_fields
    : snapshot.missing_fields.filter((field) => values[field as keyof typeof values] == null);
  const criticalMissing = markPrice == null || indexPrice == null || fundingRate == null || fundingInterval == null;
  const staleSources = carryStaleSources(snapshot, sourceObservedAt, nowMs);
  return {
    ...snapshot,
    ...values,
    depth_bids: depthBids,
    depth_asks: depthAsks,
    depth_observed_at_ms: depthUpdated && patch.depth_complete === true
      ? sourceAt
      : snapshot.depth_observed_at_ms ?? (depthUpdated ? sourceAt : null),
    source_observed_at_ms: sourceObservedAt,
    as_of_ms: oldestObservedAt(sourceObservedAt, snapshot.as_of_ms, sourceAt),
    observed_at_ms: patch.received_at_ms,
    stale_sources: staleSources,
    stale: staleSources.length > 0,
    status: criticalMissing || staleSources.length > 0
      ? "quarantined"
      : missingFields.length > 0
        ? "degraded"
        : "ready",
    missing_fields: missingFields,
  };
}

function carryStaleSources(
  snapshot: CarryShadowSnapshot,
  observations: CarryShadowSnapshot["source_observed_at_ms"],
  nowMs: number,
) {
  return (["market", "funding", "orderbook"] as const).filter((source) => {
    const observedAt = observations?.[source] ?? snapshot.as_of_ms ?? snapshot.observed_at_ms;
    const declaredMaxAge = snapshot.source_max_age_ms?.[source];
    const maxAge = Number.isSafeInteger(declaredMaxAge) && Number(declaredMaxAge) > 0
      ? Number(declaredMaxAge)
      : CARRY_DEPTH_MAX_AGE_MS;
    return !Number.isSafeInteger(observedAt) || Number(observedAt) <= 0 ||
      Number(observedAt) > nowMs + CARRY_LIVE_PATCH_MAX_AGE_MS || nowMs - Number(observedAt) > maxAge;
  });
}

function mergePartialDepth(
  previous: CarryDepthLevel[] | undefined,
  patch: CarryDepthLevel[],
  side: "bid" | "ask",
  bestPriceE8: number | null,
) {
  const levels = new Map<number, number>();
  for (const level of previous || []) {
    if (!Number.isSafeInteger(level.price_e8) || level.price_e8 <= 0 ||
        !Number.isSafeInteger(level.size_e8) || level.size_e8 <= 0) continue;
    if (bestPriceE8 != null && (side === "bid" ? level.price_e8 > bestPriceE8 : level.price_e8 < bestPriceE8)) continue;
    levels.set(level.price_e8, level.size_e8);
  }
  for (const level of patch) {
    if (!Number.isSafeInteger(level.price_e8) || level.price_e8 <= 0 ||
        !Number.isSafeInteger(level.size_e8) || level.size_e8 <= 0) continue;
    levels.set(level.price_e8, level.size_e8);
  }
  return [...levels.entries()]
    .sort(([left], [right]) => side === "bid" ? right - left : left - right)
    .slice(0, 20)
    .map(([price_e8, size_e8]) => ({ price_e8, size_e8 }));
}

function oldestObservedAt(
  sources: CarryShadowSnapshot["source_observed_at_ms"],
  fallback: number | null | undefined,
  latest: number,
) {
  const observed = [sources?.market, sources?.funding, sources?.orderbook]
    .filter((value): value is number => Number.isSafeInteger(value) && Number(value) > 0);
  return observed.length === 3 ? Math.min(...observed) : fallback ?? latest;
}

export function quoteCarryCandidate(
  candidate: CarryCandidate,
  notionalUsd = 10_000,
  horizonHours = 24,
  nowMs = Date.now(),
): CarryQuoteModel {
  const safeNotional = Number.isFinite(notionalUsd) ? Math.max(0, notionalUsd) : 0;
  const safeHours = Number.isFinite(horizonHours) ? Math.max(1 / 60, horizonHours) : 24;
  const grossDailyUsd = safeNotional * (candidate.grossAnnualBps / 10_000) / 365;
  const grossFundingUsd = grossDailyUsd * safeHours / 24;
  const feeBps = candidate.long.taker_fee_bps != null && candidate.short.taker_fee_bps != null
    ? 2 * candidate.long.taker_fee_bps + 2 * candidate.short.taker_fee_bps
    : null;
  const depth = carryDepthCost(candidate, safeNotional, nowMs);
  const collateralBasisRiskBps = carryCollateralBasisRiskBps(candidate);
  const directCostsExact = feeBps != null && depth.status === "sufficient" && depth.slippage_bps != null;
  const exactCosts = directCostsExact && collateralBasisRiskBps != null;
  const roundTripCostBps = directCostsExact ? feeBps + depth.slippage_bps! : null;
  const roundTripCostUsd = roundTripCostBps == null ? null : safeNotional * roundTripCostBps / 10_000;
  const tradingFeeUsd = feeBps == null ? null : safeNotional * feeBps / 10_000;
  const slippageUsd = depth.slippage_bps == null ? null : safeNotional * depth.slippage_bps / 10_000;
  const latencyBufferUsd = directCostsExact
    ? safeNotional * CARRY_LATENCY_BUFFER_BPS_PER_LEG * 2 / 10_000
    : null;
  const capitalCostUsd = exactCosts
    ? safeNotional * 2 * CARRY_CAPITAL_COST_BPS_PER_DAY / 10_000 * safeHours / 24
    : null;
  const collateralBasisRiskUsd = collateralBasisRiskBps == null
    ? null
    : safeNotional * collateralBasisRiskBps / 10_000;
  const riskBufferUsd = collateralBasisRiskUsd == null
    ? null
    : safeNotional * CARRY_BASE_RISK_BUFFER_BPS / 10_000 + collateralBasisRiskUsd;
  const modeledTotalCostUsd = roundTripCostUsd == null || latencyBufferUsd == null ||
      capitalCostUsd == null || riskBufferUsd == null
    ? null
    : roundTripCostUsd + latencyBufferUsd + capitalCostUsd + riskBufferUsd;
  const expectedNetUsd = modeledTotalCostUsd == null ? null : grossFundingUsd - modeledTotalCostUsd;
  const grossHourlyUsd = grossDailyUsd / 24;
  const capitalCostHourlyUsd = exactCosts
    ? safeNotional * 2 * CARRY_CAPITAL_COST_BPS_PER_DAY / 10_000 / 24
    : null;
  const recurringNetHourlyUsd = capitalCostHourlyUsd == null ? null : grossHourlyUsd - capitalCostHourlyUsd;
  const oneTimeModeledCostUsd = roundTripCostUsd == null || latencyBufferUsd == null || riskBufferUsd == null
    ? null
    : roundTripCostUsd + latencyBufferUsd + riskBufferUsd;
  const breakEvenHours = oneTimeModeledCostUsd == null || recurringNetHourlyUsd == null || recurringNetHourlyUsd <= 0
    ? null
    : oneTimeModeledCostUsd / recurringNetHourlyUsd;
  return {
    notionalUsd: safeNotional,
    horizonHours: safeHours,
    grossFundingUsd,
    roundTripCostUsd,
    modeledTotalCostUsd,
    expectedNetUsd,
    grossDailyUsd,
    expectedNetDailyUsd: expectedNetUsd == null ? null : expectedNetUsd * 24 / safeHours,
    breakEvenHours,
    exactCosts,
    tradingFeeUsd,
    slippageUsd,
    latencyBufferUsd,
    capitalCostUsd,
    riskBufferUsd,
    collateralBasisRiskUsd,
    depthStatus: depth.status,
    minimumDisplayedDepthUsd: depth.minimum_displayed_depth_usd,
  };
}

export function carryCandidateAgeMs(candidate: CarryCandidate, nowMs = Date.now()) {
  return Math.max(...[candidate.long, candidate.short].map((leg) => {
    const observedAt = leg.as_of_ms ?? leg.observed_at_ms;
    return observedAt == null ? Number.POSITIVE_INFINITY : Math.max(0, nowMs - observedAt);
  }));
}

function economicsQualityRank(value: PricedCarryCandidate["economics_quality"]) {
  if (value === "positive_net") return 2;
  if (value === "gross_only") return 1;
  return 0;
}

function exactComparableQuote(value: PricedCarryCandidate | null): value is PricedCarryCandidate {
  return value !== null
    && value.quote.exactCosts === true
    && Number.isFinite(value.quote.expectedNetDailyUsd)
    && Number.isFinite(value.quote.notionalUsd)
    && value.quote.notionalUsd > 0
    && Number.isFinite(value.quote.horizonHours)
    && value.quote.horizonHours > 0;
}

function unavailableRoutingAdvantage(
  reason: string,
  selectedRoute: string | null = null,
): CarryRoutingAdvantage {
  return {
    status: "unavailable",
    indicative: true,
    benchmarkKind: "next_best_executable_route",
    selectedRoute,
    baselineRoute: null,
    dailyNetAdvantageUsd: null,
    dailyNetAdvantageBps: null,
    reason,
  };
}

function carryRouteId(candidate: CarryCandidate) {
  return `${candidate.asset}:${candidate.long.venue_id}:${candidate.short.venue_id}`;
}

export function builderModel(candidate: CarryCandidate, notionalText: string, daysText: string) {
  const notionalUsd = Math.max(0, Number(notionalText) || 0);
  const holdingDays = Math.max(1, Number(daysText) || 1);
  const quote = quoteCarryCandidate(candidate, notionalUsd, holdingDays * 24);
  const contractPair = publicContractPairMetrics(candidate);
  const grossFundingUsd = quote.grossFundingUsd;
  const legs = [candidate.long, candidate.short];
  const costUsd = quote.modeledTotalCostUsd;
  const netUsd = quote.expectedNetUsd;
  const dailyGross = grossFundingUsd / holdingDays;
  const breakEvenDays = costUsd == null || dailyGross <= 0 ? null : costUsd / dailyGross;
  const capitalPlan = legs.map((leg) => ({
    venueId: leg.venue_id,
    collateralAsset: leg.collateral_asset || "USD",
    requiredOpeningCapitalUsd: notionalUsd,
    venueMinimumMarginUsd: notionalUsd * (leg.initial_margin_bps ?? 10_000) / 10_000,
    executionLeverage: 1,
  }));
  const minimumCollateralUsd = capitalPlan.reduce((sum, leg) => sum + leg.venueMinimumMarginUsd, 0);
  const requiredOpeningCapitalUsd = capitalPlan.reduce((sum, leg) => sum + leg.requiredOpeningCapitalUsd, 0);
  const marginReady = legs.every((leg) => leg.initial_margin_bps != null && leg.maintenance_margin_bps != null);
  return {
    grossFundingUsd,
    costUsd,
    netUsd,
    breakEvenDays,
    minimumCollateralUsd,
    requiredOpeningCapitalUsd,
    capitalPlan,
    tradingFeeUsd: quote.tradingFeeUsd,
    slippageUsd: quote.slippageUsd,
    depthStatus: quote.depthStatus,
    minimumDisplayedDepthUsd: quote.minimumDisplayedDepthUsd,
    contractDataSkewMs: contractPair.contractDataSkewMs,
    indexPriceDivergenceBps: contractPair.indexPriceDivergenceBps,
    markPriceDivergenceBps: contractPair.markPriceDivergenceBps,
    contractsComparable: contractPair.comparable,
    publicInputsComplete: candidate.exact && marginReady && quote.exactCosts && netUsd != null && netUsd > 0,
    creatable: false,
  };
}

function publicContractPairMetrics(candidate: CarryCandidate) {
  const longObservedAt = candidate.long.as_of_ms ?? candidate.long.observed_at_ms;
  const shortObservedAt = candidate.short.as_of_ms ?? candidate.short.observed_at_ms;
  const contractDataSkewMs = Number.isSafeInteger(longObservedAt) && Number.isSafeInteger(shortObservedAt)
    ? Math.abs(Number(longObservedAt) - Number(shortObservedAt))
    : null;
  try {
    const basis = evaluatePerpContractPairBasis({
      version: 1,
      long_contract: candidate.long,
      short_contract: candidate.short,
      max_index_price_divergence_bps: CARRY_MAX_INDEX_PRICE_DIVERGENCE_BPS,
      max_mark_price_divergence_bps: CARRY_MAX_MARK_PRICE_DIVERGENCE_BPS,
    });
    return {
      contractDataSkewMs,
      indexPriceDivergenceBps: safeBasisMetric(basis.index_price_divergence_bps),
      markPriceDivergenceBps: safeBasisMetric(basis.mark_price_divergence_bps),
      comparable: basis.eligible === true
        && contractDataSkewMs !== null
        && contractDataSkewMs <= CARRY_MAX_CONTRACT_DATA_SKEW_MS,
    };
  } catch {
    return {
      contractDataSkewMs,
      indexPriceDivergenceBps: null,
      markPriceDivergenceBps: null,
      comparable: false,
    };
  }
}

function safeBasisMetric(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function carryCollateralBasisRiskBps(candidate: CarryCandidate) {
  const longCollateral = candidate.long.collateral_asset;
  const shortCollateral = candidate.short.collateral_asset;
  if (typeof longCollateral !== "string" || typeof shortCollateral !== "string") return null;
  if (longCollateral === shortCollateral) return 0;
  const stablecoins = new Set(["USDC", "USDT"]);
  return stablecoins.has(longCollateral) && stablecoins.has(shortCollateral)
    ? CARRY_STABLE_COLLATERAL_BASIS_RISK_BPS
    : null;
}

export function annualFundingBps(snapshot: CarryShadowSnapshot) {
  return (snapshot.funding_rate_e12_per_interval! / 1_000_000_000_000)
    * (365 * 86_400_000 / snapshot.funding_interval_ms!)
    * 10_000;
}

function carryDepthCost(candidate: CarryCandidate, notionalUsd: number, nowMs: number) {
  const notionalMicro = Math.round(notionalUsd * 1_000_000);
  if (!Number.isSafeInteger(notionalMicro) || notionalMicro <= 0) {
    return { status: "unavailable", slippage_bps: null, minimum_displayed_depth_usd: null } as const;
  }
  const legs = [
    { snapshot: candidate.long, entry: "buy" as const, exit: "sell" as const },
    { snapshot: candidate.short, entry: "sell" as const, exit: "buy" as const },
  ];
  const observations = legs.flatMap(({ snapshot, entry, exit }) => {
    if (depthAgeMs(snapshot, nowMs) > CARRY_DEPTH_MAX_AGE_MS) return [];
    return [entry, exit].map((side, index) => cachedDepthExecution(
      snapshot,
      side,
      notionalMicro,
      index === 0 ? "entry" : "exit",
    ));
  });
  if (observations.length !== 4 || observations.some((item) => item.status === "unavailable")) {
    return { status: "unavailable", slippage_bps: null, minimum_displayed_depth_usd: null } as const;
  }
  const minimumDisplayedDepthUsd = Math.min(...observations.map((item) => item.displayed_notional_micro_usdc / 1_000_000));
  if (observations.some((item) => item.status !== "sufficient")) {
    return { status: "insufficient", slippage_bps: null, minimum_displayed_depth_usd: minimumDisplayedDepthUsd } as const;
  }
  const sides = ["buy", "sell", "sell", "buy"] as const;
  const marks = [candidate.long.mark_price_e8, candidate.long.mark_price_e8, candidate.short.mark_price_e8, candidate.short.mark_price_e8];
  const slippageE6Bps = observations.reduce((sum, item, index) => sum + adverseExecutionSlippageE6Bps({
    side: sides[index],
    mark_price_e8: marks[index],
    execution_price_e8: item.execution_price_e8,
  }), 0);
  return {
    status: "sufficient",
    slippage_bps: slippageE6Bps / 1_000_000,
    minimum_displayed_depth_usd: minimumDisplayedDepthUsd,
  } as const;
}

function cachedDepthExecution(
  snapshot: CarryShadowSnapshot,
  side: "buy" | "sell",
  notionalMicro: number,
  phase: "entry" | "exit",
) {
  let cache = depthExecutionCache.get(snapshot);
  if (!cache) {
    cache = new Map();
    depthExecutionCache.set(snapshot, cache);
  }
  const key = `${side}:${notionalMicro}:${phase}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const result = estimatePerpDepthExecution({
    side,
    depth_levels: side === "buy" ? snapshot.depth_asks : snapshot.depth_bids,
    fallback_price_e8: side === "buy" ? snapshot.best_ask_e8 : snapshot.best_bid_e8,
    target_notional_micro_usdc: notionalMicro,
    phase,
  });
  cache.set(key, result);
  return result;
}

function depthAgeMs(snapshot: CarryShadowSnapshot, nowMs: number) {
  const observedAt = snapshot.depth_observed_at_ms
    ?? snapshot.source_observed_at_ms?.orderbook
    ?? snapshot.as_of_ms
    ?? snapshot.observed_at_ms;
  return observedAt == null ? Number.POSITIVE_INFINITY : Math.max(0, nowMs - observedAt);
}

function patchedNumber(patch: number | null | undefined, fallback: number | null | undefined) {
  return patch == null ? fallback ?? null : patch;
}

function safeNonnegativeInteger(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function sameStrings(left: unknown, right: readonly string[]) {
  return Array.isArray(left)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function formatEvidenceDuration(value: number) {
  if (value < 60_000) return `${Math.floor(value / 1_000)}s`;
  return `${Math.floor(value / 60_000)}m`;
}
