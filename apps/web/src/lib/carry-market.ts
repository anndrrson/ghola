import {
  adverseExecutionSlippageE6Bps,
  estimatePerpDepthExecution,
} from "@ghola/execution-core";

export type CarryShadowStatus = "ready" | "degraded" | "quarantined";

export interface CarryDepthLevel {
  price_e8: number;
  size_e8: number;
}

export interface CarryShadowSnapshot {
  venue_id: string;
  contract_id: string;
  asset: string;
  collateral_asset?: string | null;
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

export interface CarryShadowResponse {
  version: 1;
  mode: "shadow_read_only";
  executable: false;
  observed_at: string;
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
  expectedNetUsd: number | null;
  grossDailyUsd: number;
  expectedNetDailyUsd: number | null;
  breakEvenHours: number | null;
  exactCosts: boolean;
  tradingFeeUsd: number | null;
  slippageUsd: number | null;
  depthStatus: "sufficient" | "insufficient" | "unavailable";
  minimumDisplayedDepthUsd: number | null;
}

export interface PricedCarryCandidate {
  candidate: CarryCandidate;
  quote: CarryQuoteModel;
  daily_value_bps: number;
  economics_quality: "positive_net" | "exact_nonpositive" | "gross_only";
}

export const CARRY_LIVE_PATCH_MAX_AGE_MS = 5_000;
export const CARRY_DEPTH_MAX_AGE_MS = 30_000;
const depthExecutionCache = new WeakMap<CarryShadowSnapshot, Map<string, ReturnType<typeof estimatePerpDepthExecution>>>();

export const CARRY_VENUE_LABELS: Record<string, string> = {
  hyperliquid: "Hyperliquid",
  lighter: "Lighter",
  aster: "Aster",
  edgex: "edgeX",
  dydx: "dYdX",
};

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
        if (long.snapshot.venue_id === short.snapshot.venue_id || short.annualBps <= long.annualBps) continue;
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
    snapshots[snapshotIndex] = applyCarryLivePatch(snapshots[snapshotIndex], patch);
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
      return applyCarryLivePatch(snapshot, patch);
    });
    return changed ? { ...venue, ok: true, snapshots } : venue;
  });
}

function applyCarryLivePatch(snapshot: CarryShadowSnapshot, patch: CarryLiveMarketPatch): CarryShadowSnapshot {
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
    stale: false,
    status: criticalMissing ? "quarantined" : missingFields.length > 0 ? "degraded" : "ready",
    missing_fields: missingFields,
  };
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
  const exactCosts = feeBps != null && depth.status === "sufficient" && depth.slippage_bps != null;
  const roundTripCostBps = exactCosts ? feeBps + depth.slippage_bps! : null;
  const roundTripCostUsd = roundTripCostBps == null ? null : safeNotional * roundTripCostBps / 10_000;
  const tradingFeeUsd = feeBps == null ? null : safeNotional * feeBps / 10_000;
  const slippageUsd = depth.slippage_bps == null ? null : safeNotional * depth.slippage_bps / 10_000;
  const expectedNetUsd = roundTripCostUsd == null ? null : grossFundingUsd - roundTripCostUsd;
  const grossHourlyUsd = grossDailyUsd / 24;
  const breakEvenHours = roundTripCostUsd == null || grossHourlyUsd <= 0 ? null : roundTripCostUsd / grossHourlyUsd;
  return {
    notionalUsd: safeNotional,
    horizonHours: safeHours,
    grossFundingUsd,
    roundTripCostUsd,
    expectedNetUsd,
    grossDailyUsd,
    expectedNetDailyUsd: expectedNetUsd == null ? null : expectedNetUsd * 24 / safeHours,
    breakEvenHours,
    exactCosts,
    tradingFeeUsd,
    slippageUsd,
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

export function builderModel(candidate: CarryCandidate, notionalText: string, daysText: string) {
  const notionalUsd = Math.max(0, Number(notionalText) || 0);
  const holdingDays = Math.max(1, Number(daysText) || 1);
  const quote = quoteCarryCandidate(candidate, notionalUsd, holdingDays * 24);
  const grossFundingUsd = quote.grossFundingUsd;
  const legs = [candidate.long, candidate.short];
  const costUsd = quote.roundTripCostUsd;
  const netUsd = costUsd == null ? null : grossFundingUsd - costUsd;
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
    publicInputsComplete: candidate.exact && marginReady && quote.exactCosts && netUsd != null && netUsd > 0,
    creatable: false,
  };
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
