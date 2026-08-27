export type CarryShadowStatus = "ready" | "degraded" | "quarantined";

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
}

export interface PricedCarryCandidate {
  candidate: CarryCandidate;
  quote: CarryQuoteModel;
  daily_value_bps: number;
  economics_quality: "positive_net" | "exact_nonpositive" | "gross_only";
}

export const CARRY_LIVE_PATCH_MAX_AGE_MS = 5_000;

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
): PricedCarryCandidate[] {
  return candidates.map((candidate) => {
    const quote = quoteCarryCandidate(candidate, notionalUsd, horizonHours);
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
    return venues.map((venue) => {
      if (venue.venue_id !== patch.venue_id) return venue;
      let changed = false;
      const snapshots = venue.snapshots.map((snapshot) => {
        if (snapshot.asset !== patch.asset) return snapshot;
        changed = true;
        return applyCarryLivePatch(snapshot, patch);
      });
      return changed ? { ...venue, ok: true, snapshots } : venue;
    });
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
  const next = {
    ...snapshot,
    mark_price_e8: patchedNumber(patch.mark_price_e8, snapshot.mark_price_e8),
    index_price_e8: patchedNumber(patch.index_price_e8, snapshot.index_price_e8),
    best_bid_e8: patchedNumber(patch.best_bid_e8, snapshot.best_bid_e8),
    best_ask_e8: patchedNumber(patch.best_ask_e8, snapshot.best_ask_e8),
    funding_rate_e12_per_interval: patchedNumber(
      patch.funding_rate_e12_per_interval,
      snapshot.funding_rate_e12_per_interval,
    ),
    funding_interval_ms: patchedNumber(patch.funding_interval_ms, snapshot.funding_interval_ms),
    as_of_ms: patch.source_at_ms ?? patch.received_at_ms,
    observed_at_ms: patch.received_at_ms,
  };
  const missingFields = snapshot.missing_fields.filter((field) => next[field as keyof typeof next] == null);
  const criticalMissing = next.mark_price_e8 == null
    || next.index_price_e8 == null
    || next.funding_rate_e12_per_interval == null
    || next.funding_interval_ms == null;
  return {
    ...next,
    stale: false,
    status: criticalMissing ? "quarantined" : missingFields.length > 0 ? "degraded" : "ready",
    missing_fields: missingFields,
  };
}

export function quoteCarryCandidate(
  candidate: CarryCandidate,
  notionalUsd = 10_000,
  horizonHours = 24,
): CarryQuoteModel {
  const safeNotional = Number.isFinite(notionalUsd) ? Math.max(0, notionalUsd) : 0;
  const safeHours = Number.isFinite(horizonHours) ? Math.max(1 / 60, horizonHours) : 24;
  const grossDailyUsd = safeNotional * (candidate.grossAnnualBps / 10_000) / 365;
  const grossFundingUsd = grossDailyUsd * safeHours / 24;
  const longSpreadBps = spreadBps(candidate.long);
  const shortSpreadBps = spreadBps(candidate.short);
  const exactCosts = candidate.long.taker_fee_bps != null && longSpreadBps != null
    && candidate.short.taker_fee_bps != null && shortSpreadBps != null;
  const roundTripCostBps = exactCosts
    ? 2 * candidate.long.taker_fee_bps! + longSpreadBps!
      + 2 * candidate.short.taker_fee_bps! + shortSpreadBps!
    : null;
  const roundTripCostUsd = roundTripCostBps == null ? null : safeNotional * roundTripCostBps / 10_000;
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
  const grossFundingUsd = notionalUsd * (candidate.grossAnnualBps / 10_000) * holdingDays / 365;
  const legs = [candidate.long, candidate.short];
  const feesKnown = legs.every((leg) => leg.taker_fee_bps != null && spreadBps(leg) != null);
  const roundTripCostBps = feesKnown
    ? legs.reduce((sum, leg) => sum + 2 * leg.taker_fee_bps! + spreadBps(leg)!, 0)
    : null;
  const costUsd = roundTripCostBps == null ? null : notionalUsd * roundTripCostBps / 10_000;
  const netUsd = costUsd == null ? null : grossFundingUsd - costUsd;
  const dailyGross = grossFundingUsd / holdingDays;
  const breakEvenDays = costUsd == null || dailyGross <= 0 ? null : costUsd / dailyGross;
  const minimumCollateralUsd = legs.reduce((sum, leg) => sum + notionalUsd * (leg.initial_margin_bps || 10_000) / 10_000, 0);
  const marginReady = legs.every((leg) => leg.initial_margin_bps != null && leg.maintenance_margin_bps != null);
  return {
    grossFundingUsd,
    costUsd,
    netUsd,
    breakEvenDays,
    minimumCollateralUsd,
    publicInputsComplete: candidate.exact && marginReady && costUsd != null && netUsd != null && netUsd > 0,
    creatable: false,
  };
}

export function annualFundingBps(snapshot: CarryShadowSnapshot) {
  return (snapshot.funding_rate_e12_per_interval! / 1_000_000_000_000)
    * (365 * 86_400_000 / snapshot.funding_interval_ms!)
    * 10_000;
}

function spreadBps(snapshot: CarryShadowSnapshot) {
  if (!snapshot.best_bid_e8 || !snapshot.best_ask_e8 || snapshot.best_ask_e8 <= snapshot.best_bid_e8) return null;
  const mid = (snapshot.best_bid_e8 + snapshot.best_ask_e8) / 2;
  return (snapshot.best_ask_e8 - snapshot.best_bid_e8) / mid * 10_000;
}

function patchedNumber(patch: number | null | undefined, fallback: number | null | undefined) {
  return patch == null ? fallback ?? null : patch;
}
