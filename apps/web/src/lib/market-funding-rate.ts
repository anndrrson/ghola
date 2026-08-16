export const CANONICAL_FUNDING_RATE_UNIT = "decimal_fraction" as const;

export type MarketFundingRateUnit = typeof CANONICAL_FUNDING_RATE_UNIT;

export type MarketFundingRateSource =
  | "hyperliquid_rest_asset_context_received"
  | "hyperliquid_ws_active_asset_context_received"
  | "phoenix_rest_funding_history"
  | "phoenix_ws_market_stats";

export type MarketFundingTimeBasis = "venue_event_time" | "received_at";

export interface MarketFundingRateFields {
  /** Signed rate normalized at ingress to a decimal fraction (0.0001 = 0.01%). */
  funding_rate: string | null;
  funding_rate_unit: MarketFundingRateUnit | null;
  funding_rate_source: MarketFundingRateSource | null;
  funding_time_basis: MarketFundingTimeBasis | null;
  /** Timestamp expressed by funding_time_basis; null without a trustworthy clock. */
  funding_updated_at: string | null;
}

export interface CanonicalFundingRateInput {
  rate: unknown;
  unit: unknown;
  source: unknown;
  timeBasis: unknown;
  updatedAt: unknown;
  venue: "hyperliquid" | "phoenix";
}

export interface CanonicalFundingRate {
  rateFraction: number;
  source: MarketFundingRateSource;
  timeBasis: MarketFundingTimeBasis;
  updatedAt: string;
  updatedAtMs: number;
}

const MAX_FUTURE_SKEW_MS = 30_000;

export function inspectCanonicalFundingRate(
  input: CanonicalFundingRateInput,
  nowMs?: number,
): CanonicalFundingRate | null {
  if (input.unit !== CANONICAL_FUNDING_RATE_UNIT) return null;
  if (!isMarketFundingRateSource(input.source)) return null;
  if (!fundingSourceMatchesVenue(input.source, input.venue)) return null;
  const expectedBasis = input.source.endsWith("_received") ? "received_at" : "venue_event_time";
  if (input.timeBasis !== expectedBasis) return null;
  if (typeof input.updatedAt !== "string" || input.updatedAt.trim() === "") return null;
  const updatedAtMs = Date.parse(input.updatedAt);
  if (!Number.isFinite(updatedAtMs) || updatedAtMs <= 0) return null;
  if (typeof input.rate !== "string" || !/^-?\d+(?:\.\d+)?$/u.test(input.rate.trim())) return null;
  const rateFraction = Number(input.rate);
  if (!Number.isFinite(rateFraction)) return null;
  if (nowMs != null) {
    if (!Number.isFinite(nowMs)) return null;
    const ageMs = nowMs - updatedAtMs;
    if (ageMs < -MAX_FUTURE_SKEW_MS || ageMs > fundingMaxAgeMs(input.source)) return null;
  }
  return {
    rateFraction,
    source: input.source,
    timeBasis: expectedBasis,
    updatedAt: input.updatedAt,
    updatedAtMs,
  };
}

export function fundingMaxAgeMs(source: MarketFundingRateSource): number {
  if (source === "hyperliquid_ws_active_asset_context_received" || source === "phoenix_ws_market_stats") {
    return 10_000;
  }
  if (source === "hyperliquid_rest_asset_context_received") return 2 * 60_000;
  return 2 * 60 * 60_000;
}

export function fundingSourceMatchesVenue(
  source: MarketFundingRateSource,
  venue: "hyperliquid" | "phoenix",
): boolean {
  return venue === "hyperliquid"
    ? source === "hyperliquid_rest_asset_context_received" ||
        source === "hyperliquid_ws_active_asset_context_received"
    : source === "phoenix_rest_funding_history" || source === "phoenix_ws_market_stats";
}

function isMarketFundingRateSource(value: unknown): value is MarketFundingRateSource {
  return value === "hyperliquid_rest_asset_context_received" ||
    value === "hyperliquid_ws_active_asset_context_received" ||
    value === "phoenix_rest_funding_history" ||
    value === "phoenix_ws_market_stats";
}
