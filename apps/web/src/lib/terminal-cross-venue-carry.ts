import type { GholaMarketFrame } from "./ghola-market-chart";
import { inspectCanonicalFundingRate, type MarketFundingRateSource } from "./market-funding-rate";
import { terminalFrameMatchesSelection, type TerminalMarketVenue } from "./terminal-market-identity";
import type { TerminalRouteNetwork, TerminalRouteProductClass } from "./terminal-route-decision";

export type TerminalCrossVenueFundingBlocker =
  | "spot_market"
  | "funding_unavailable"
  | "notional_invalid";

export interface TerminalCrossVenueCarryRow {
  venue: TerminalMarketVenue;
  network: TerminalRouteNetwork;
  product: string;
  selected: boolean;
  mid: number;
  basisBps: number;
  quoteAgeMs: number;
  fundingRateBps: number | null;
  signedCarryUsd: number | null;
  fundingAgeMs: number | null;
  fundingSource: MarketFundingRateSource | null;
  fundingBlocker: TerminalCrossVenueFundingBlocker | null;
}

export interface TerminalCrossVenueCarryMatrix {
  status: "unavailable" | "single" | "live";
  side: "buy" | "sell";
  notionalUsd: number | null;
  rows: TerminalCrossVenueCarryRow[];
}

export interface TerminalCrossVenueCarryInput {
  frames: readonly GholaMarketFrame[];
  selectedVenue: TerminalMarketVenue;
  market: string;
  interval: string;
  requiredProductClass: TerminalRouteProductClass;
  requiredNetwork: TerminalRouteNetwork;
  side: "buy" | "sell";
  notionalUsd: unknown;
  nowMs: number;
  maxQuoteAgeMs: number;
}

const VENUE_ORDER: TerminalMarketVenue[] = ["hyperliquid", "phoenix", "coinbase"];
const MAX_QUOTE_FUTURE_SKEW_MS = 5_000;

/** Certified quote basis plus independently certified funding snapshots. */
export function deriveTerminalCrossVenueCarryMatrix(
  input: TerminalCrossVenueCarryInput,
): TerminalCrossVenueCarryMatrix {
  const notionalUsd = positive(input.notionalUsd);
  if (!Number.isFinite(input.nowMs) || !Number.isFinite(input.maxQuoteAgeMs) || input.maxQuoteAgeMs <= 0) {
    return unavailable(input.side, notionalUsd);
  }

  const byVenue = new Map<TerminalMarketVenue, QuoteCandidate>();
  for (const frame of input.frames) {
    const venue = supportedVenue(frame.venue);
    const network = canonicalNetwork(frame.network);
    const quoteAt = frame.componentTimestamps?.quote;
    const bid = positive(frame.bestBid);
    const ask = positive(frame.bestAsk);
    if (
      !venue
      || !network
      || network !== input.requiredNetwork
      || frame.stale
      || frameProductClass(frame) !== input.requiredProductClass
      || !terminalFrameMatchesSelection(frame, { venue, market: input.market, interval: input.interval })
      || bid == null
      || ask == null
      || bid >= ask
      || !Number.isFinite(quoteAt)
      || quoteAt == null
      || quoteAt <= 0
      || quoteAt > input.nowMs + MAX_QUOTE_FUTURE_SKEW_MS
      || input.nowMs - quoteAt > input.maxQuoteAgeMs
    ) continue;
    const candidate = { frame, venue, network, quoteAt, mid: (bid + ask) / 2 };
    const existing = byVenue.get(venue);
    if (!existing || candidate.quoteAt > existing.quoteAt) byVenue.set(venue, candidate);
  }

  const selected = byVenue.get(input.selectedVenue);
  if (!selected) return unavailable(input.side, notionalUsd);
  const rows = [...byVenue.values()]
    .map((candidate) => rowFromCandidate(candidate, selected.mid, input, notionalUsd))
    .sort((left, right) => Number(right.selected) - Number(left.selected)
      || left.basisBps - right.basisBps
      || VENUE_ORDER.indexOf(left.venue) - VENUE_ORDER.indexOf(right.venue));
  return {
    status: rows.length > 1 ? "live" : "single",
    side: input.side,
    notionalUsd,
    rows,
  };
}

interface QuoteCandidate {
  frame: GholaMarketFrame;
  venue: TerminalMarketVenue;
  network: TerminalRouteNetwork;
  quoteAt: number;
  mid: number;
}

function rowFromCandidate(
  candidate: QuoteCandidate,
  selectedMid: number,
  input: TerminalCrossVenueCarryInput,
  notionalUsd: number | null,
): TerminalCrossVenueCarryRow {
  const base = {
    venue: candidate.venue,
    network: candidate.network,
    product: candidate.frame.product,
    selected: candidate.venue === input.selectedVenue,
    mid: candidate.mid,
    basisBps: ((candidate.mid - selectedMid) / selectedMid) * 10_000,
    quoteAgeMs: Math.max(0, input.nowMs - candidate.quoteAt),
  };
  if (input.requiredProductClass === "spot" || candidate.venue === "coinbase") {
    return { ...base, fundingRateBps: null, signedCarryUsd: null, fundingAgeMs: null, fundingSource: null, fundingBlocker: "spot_market" };
  }
  if (notionalUsd == null) {
    return { ...base, fundingRateBps: null, signedCarryUsd: null, fundingAgeMs: null, fundingSource: null, fundingBlocker: "notional_invalid" };
  }
  if (candidate.venue !== "hyperliquid" && candidate.venue !== "phoenix") {
    return { ...base, fundingRateBps: null, signedCarryUsd: null, fundingAgeMs: null, fundingSource: null, fundingBlocker: "funding_unavailable" };
  }
  const funding = inspectCanonicalFundingRate({
    rate: candidate.frame.fundingRate,
    unit: candidate.frame.fundingRateUnit,
    source: candidate.frame.fundingRateSource,
    timeBasis: candidate.frame.fundingRateTimeBasis,
    updatedAt: candidate.frame.fundingRateUpdatedAt,
    venue: candidate.venue,
  }, input.nowMs);
  if (!funding) {
    return { ...base, fundingRateBps: null, signedCarryUsd: null, fundingAgeMs: null, fundingSource: null, fundingBlocker: "funding_unavailable" };
  }
  const signedCarryUsd = notionalUsd * funding.rateFraction * (input.side === "buy" ? -1 : 1);
  return {
    ...base,
    fundingRateBps: funding.rateFraction * 10_000,
    signedCarryUsd: Object.is(signedCarryUsd, -0) ? 0 : signedCarryUsd,
    fundingAgeMs: Math.max(0, input.nowMs - funding.updatedAtMs),
    fundingSource: funding.source,
    fundingBlocker: null,
  };
}

function unavailable(side: "buy" | "sell", notionalUsd: number | null): TerminalCrossVenueCarryMatrix {
  return { status: "unavailable", side, notionalUsd, rows: [] };
}

function supportedVenue(value: GholaMarketFrame["venue"]): TerminalMarketVenue | null {
  return value === "hyperliquid" || value === "phoenix" || value === "coinbase" ? value : null;
}

function canonicalNetwork(value: unknown): TerminalRouteNetwork | null {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized === "mainnet" || normalized === "testnet" ? normalized : null;
}

function frameProductClass(frame: GholaMarketFrame): TerminalRouteProductClass | null {
  const product = frame.product.trim().toUpperCase();
  if (product.endsWith("-PERP")) return "perpetual";
  if (product.endsWith("-USD")) return "spot";
  if (frame.venue === "hyperliquid" && /^(BTC|ETH|SOL|HYPE)$/u.test(product)) return "perpetual";
  return null;
}

function positive(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
