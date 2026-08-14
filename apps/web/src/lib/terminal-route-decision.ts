import type { GholaMarketFrame } from "./ghola-market-chart";
import { simulateTerminalExecution } from "./terminal-execution-quality";
import {
  terminalFrameMatchesSelection,
  type TerminalMarketVenue,
} from "./terminal-market-identity";

export type TerminalRouteExclusionCode =
  | "route_frame_venue_unsupported"
  | "route_frame_identity_mismatch"
  | "route_product_class_mismatch"
  | "route_network_mismatch"
  | "route_frame_stale"
  | "route_frame_timestamp_invalid"
  | "route_frame_timestamp_future"
  | "route_frame_expired"
  | "route_reference_price_invalid"
  | "route_visible_book_unavailable"
  | "route_visible_book_malformed"
  | "route_visible_book_crossed"
  | "route_visible_book_quote_mismatch"
  | "route_visible_book_timestamp_invalid"
  | "route_visible_book_timestamp_future"
  | "route_visible_book_expired";

export type TerminalRouteBlocker =
  | "route_notional_invalid"
  | "route_limit_invalid"
  | "route_clock_invalid"
  | "route_freshness_window_invalid"
  | "route_context_invalid"
  | null;

export type TerminalRouteProductClass = "spot" | "perpetual";
export type TerminalRouteNetwork = "mainnet" | "testnet";

export interface TerminalRouteCandidate {
  rank: number;
  venue: TerminalMarketVenue;
  product: string;
  productClass: TerminalRouteProductClass;
  network: TerminalRouteNetwork;
  status: "none" | "partial" | "full";
  fillPct: number;
  vwap: number | null;
  impactBps: number | null;
  filledNotionalUsd: number;
  unfilledNotionalUsd: number;
  worstPrice: number | null;
  levelsConsumed: number;
  bookAgeMs: number;
  bookObservedAt: string;
  fetchedAt: string;
}

export interface TerminalRouteExclusion {
  venue: string;
  product: string;
  code: TerminalRouteExclusionCode;
}

export interface TerminalRouteDecision {
  status: "unavailable" | "partial_only" | "full_available";
  blocker: TerminalRouteBlocker;
  side: "buy" | "sell";
  requestedNotionalUsd: number;
  limitPrice: number;
  candidates: TerminalRouteCandidate[];
  exclusions: TerminalRouteExclusion[];
  best: TerminalRouteCandidate | null;
}

export interface TerminalRouteDecisionInput {
  frames: readonly GholaMarketFrame[];
  market: string;
  interval: string;
  side: "buy" | "sell";
  orderNotionalUsd: number;
  limitPrice: number | null;
  requiredProductClass: TerminalRouteProductClass;
  requiredNetwork: TerminalRouteNetwork;
  nowMs?: number;
  maxAgeMs?: number;
}

const SUPPORTED_VENUES = new Set<TerminalMarketVenue>(["hyperliquid", "phoenix", "coinbase"]);
const VENUE_ORDER: TerminalMarketVenue[] = ["hyperliquid", "phoenix", "coinbase"];
const FUTURE_TOLERANCE_MS = 5_000;
const INACTIVE_ROUTE_FRAMES = Object.freeze([]) as readonly GholaMarketFrame[];

/** Keeps hidden route analytics referentially stable across primary-feed ticks. */
export function terminalRouteAnalysisFrames(input: {
  active: boolean;
  primary: GholaMarketFrame | null;
  peers: readonly GholaMarketFrame[];
}): readonly GholaMarketFrame[] {
  if (!input.active) return INACTIVE_ROUTE_FRAMES;
  if (!input.primary) return input.peers;
  return [input.primary, ...input.peers];
}

export function terminalRouteFreshnessMs(interval: string) {
  const intervalMs = interval === "1m"
    ? 60_000
    : interval === "5m"
      ? 300_000
      : interval === "15m"
        ? 900_000
        : interval === "1h"
          ? 3_600_000
          : 0;
  return intervalMs > 0 ? Math.min(120_000, Math.max(30_000, intervalMs / 10)) : 0;
}

export function deriveTerminalRouteDecision(input: TerminalRouteDecisionInput): TerminalRouteDecision {
  const nowMs = input.nowMs ?? Date.now();
  const maxAgeMs = input.maxAgeMs ?? terminalRouteFreshnessMs(input.interval);
  const notional = positive(input.orderNotionalUsd);
  const limitPrice = positive(input.limitPrice);
  if (notional == null) return blockedDecision(input, "route_notional_invalid");
  if (limitPrice == null) return blockedDecision(input, "route_limit_invalid");
  if (!Number.isFinite(nowMs)) return blockedDecision(input, "route_clock_invalid");
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
    return blockedDecision(input, "route_freshness_window_invalid");
  }
  if (
    (input.requiredProductClass !== "spot" && input.requiredProductClass !== "perpetual")
    || (input.requiredNetwork !== "mainnet" && input.requiredNetwork !== "testnet")
  ) {
    return blockedDecision(input, "route_context_invalid");
  }

  const exclusions: TerminalRouteExclusion[] = [];
  const candidates: Omit<TerminalRouteCandidate, "rank">[] = [];
  for (const frame of input.frames) {
    const venue = supportedVenue(frame.venue);
    const excluded = validateFrame(frame, venue, input.market, input.interval, nowMs, maxAgeMs);
    if (excluded) {
      exclusions.push({ venue: frame.venue, product: frame.product, code: excluded });
      continue;
    }
    const productClass = frameProductClass(frame);
    if (productClass !== input.requiredProductClass) {
      exclusions.push({ venue: frame.venue, product: frame.product, code: "route_product_class_mismatch" });
      continue;
    }
    const network = frameNetwork(frame);
    if (network !== input.requiredNetwork) {
      exclusions.push({ venue: frame.venue, product: frame.product, code: "route_network_mismatch" });
      continue;
    }

    const visibleBook = inspectVisibleBook(frame);
    if (!visibleBook.allowed) {
      exclusions.push({ venue: frame.venue, product: frame.product, code: visibleBook.code });
      continue;
    }
    const referencePrice = (visibleBook.bestBid + visibleBook.bestAsk) / 2;
    if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
      exclusions.push({ venue: frame.venue, product: frame.product, code: "route_reference_price_invalid" });
      continue;
    }
    const bookFreshness = routeBookFreshness(
      frame,
      nowMs,
      maxAgeMs,
    );
    if (!bookFreshness.allowed) {
      exclusions.push({ venue: frame.venue, product: frame.product, code: bookFreshness.code });
      continue;
    }
    const bookAgeMs = bookFreshness.ageMs;
    const bookObservedAt = new Date(bookFreshness.observedAtMs).toISOString();
    const levels = input.side === "buy" ? frame.asks : frame.bids;
    if (!levels.some((level) => positive(level.px) != null && positive(level.sz) != null)) {
      exclusions.push({ venue: frame.venue, product: frame.product, code: "route_visible_book_unavailable" });
      continue;
    }

    const quality = simulateTerminalExecution({
      side: input.side,
      orderNotionalUsd: notional,
      referencePrice,
      targetBaseSize: notional / limitPrice,
      limitPrice,
      levels,
    });
    const fetchedAt = frame.fetchedAt as string;
    candidates.push({
      venue: venue as TerminalMarketVenue,
      product: frame.product,
      productClass,
      network,
      status: quality.status === "no_market" ? "none" : quality.status,
      fillPct: quality.fillPct,
      vwap: quality.vwap,
      impactBps: quality.impactBps,
      filledNotionalUsd: quality.filledNotionalUsd,
      unfilledNotionalUsd: quality.unfilledNotionalUsd ?? notional,
      worstPrice: quality.worstPrice,
      levelsConsumed: quality.levelsConsumed,
      bookAgeMs,
      bookObservedAt,
      fetchedAt,
    });
  }

  candidates.sort(routeComparator(input.side));
  const ranked = candidates.map((candidate, index) => ({ ...candidate, rank: index + 1 }));
  const best = ranked[0] ?? null;
  return {
    status: best?.status === "full"
      ? "full_available"
      : best && best.fillPct > 0
        ? "partial_only"
        : "unavailable",
    blocker: null,
    side: input.side,
    requestedNotionalUsd: notional,
    limitPrice,
    candidates: ranked,
    exclusions,
    best,
  };
}

function blockedDecision(
  input: TerminalRouteDecisionInput,
  blocker: Exclude<TerminalRouteBlocker, null>,
): TerminalRouteDecision {
  return {
    status: "unavailable",
    blocker,
    side: input.side,
    requestedNotionalUsd: input.orderNotionalUsd,
    limitPrice: input.limitPrice ?? Number.NaN,
    candidates: [],
    exclusions: [],
    best: null,
  };
}

function validateFrame(
  frame: GholaMarketFrame,
  venue: TerminalMarketVenue | null,
  market: string,
  interval: string,
  nowMs: number,
  maxAgeMs: number,
): TerminalRouteExclusionCode | null {
  if (!venue) return "route_frame_venue_unsupported";
  if (!venueSupportsMarket(venue, market)) return "route_frame_identity_mismatch";
  if (!terminalFrameMatchesSelection(frame, { venue, market, interval })) return "route_frame_identity_mismatch";
  if (frame.stale) return "route_frame_stale";
  const fetchedAtMs = frame.fetchedAt ? Date.parse(frame.fetchedAt) : Number.NaN;
  if (!Number.isFinite(fetchedAtMs) || new Date(fetchedAtMs).toISOString() !== frame.fetchedAt) {
    return "route_frame_timestamp_invalid";
  }
  if (fetchedAtMs > nowMs + FUTURE_TOLERANCE_MS) return "route_frame_timestamp_future";
  if (nowMs - fetchedAtMs > maxAgeMs) return "route_frame_expired";
  return null;
}

function routeComparator(side: "buy" | "sell") {
  return (
    left: Omit<TerminalRouteCandidate, "rank">,
    right: Omit<TerminalRouteCandidate, "rank">,
  ) => {
    const fill = right.fillPct - left.fillPct;
    if (Math.abs(fill) > Number.EPSILON) return fill;
    const leftVwap = left.vwap ?? (side === "buy" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY);
    const rightVwap = right.vwap ?? (side === "buy" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY);
    const vwap = side === "buy" ? leftVwap - rightVwap : rightVwap - leftVwap;
    if (Math.abs(vwap) > Number.EPSILON) return vwap;
    const impact = (left.impactBps ?? Number.POSITIVE_INFINITY) - (right.impactBps ?? Number.POSITIVE_INFINITY);
    if (Math.abs(impact) > Number.EPSILON) return impact;
    if (left.bookAgeMs !== right.bookAgeMs) return left.bookAgeMs - right.bookAgeMs;
    return VENUE_ORDER.indexOf(left.venue) - VENUE_ORDER.indexOf(right.venue);
  };
}

function inspectVisibleBook(frame: GholaMarketFrame):
  | { allowed: true; bestBid: number; bestAsk: number }
  | { allowed: false; code: Extract<TerminalRouteExclusionCode,
      | "route_visible_book_unavailable"
      | "route_visible_book_malformed"
      | "route_visible_book_crossed"
      | "route_visible_book_quote_mismatch"> } {
  if (!frame.bids.length || !frame.asks.length) {
    return { allowed: false, code: "route_visible_book_unavailable" };
  }
  const bids = inspectBookSide(frame.bids, "bid");
  const asks = inspectBookSide(frame.asks, "ask");
  if (!bids || !asks) return { allowed: false, code: "route_visible_book_malformed" };
  const bestBid = bids[0]!;
  const bestAsk = asks[0]!;
  if (bestBid >= bestAsk) return { allowed: false, code: "route_visible_book_crossed" };
  const displayedBid = frame.bestBid == null ? bestBid : positive(frame.bestBid);
  const displayedAsk = frame.bestAsk == null ? bestAsk : positive(frame.bestAsk);
  if (displayedBid !== bestBid || displayedAsk !== bestAsk) {
    return { allowed: false, code: "route_visible_book_quote_mismatch" };
  }
  return { allowed: true, bestBid, bestAsk };
}

function inspectBookSide(levels: GholaMarketFrame["bids"], side: "bid" | "ask") {
  const prices: number[] = [];
  for (const level of levels) {
    const price = positive(level.px);
    const size = positive(level.sz);
    if (price == null || size == null) return null;
    const previous = prices.at(-1);
    if (previous != null && (side === "bid" ? price >= previous : price <= previous)) return null;
    prices.push(price);
  }
  return prices;
}

function routeBookFreshness(
  frame: GholaMarketFrame,
  nowMs: number,
  maxAgeMs: number,
): { allowed: true; ageMs: number; observedAtMs: number } | {
  allowed: false;
  code: Extract<TerminalRouteExclusionCode,
    | "route_visible_book_timestamp_invalid"
    | "route_visible_book_timestamp_future"
    | "route_visible_book_expired">;
} {
  const exactBookClock = frame.componentTimestamps?.book;
  if (!Number.isFinite(exactBookClock) || exactBookClock == null || exactBookClock <= 0) {
    return { allowed: false, code: "route_visible_book_timestamp_invalid" };
  }
  if (exactBookClock > nowMs + FUTURE_TOLERANCE_MS) {
    return { allowed: false, code: "route_visible_book_timestamp_future" };
  }
  const ageMs = Math.max(0, nowMs - exactBookClock);
  return ageMs > maxAgeMs
    ? { allowed: false, code: "route_visible_book_expired" }
    : { allowed: true, ageMs, observedAtMs: exactBookClock };
}

function supportedVenue(value: GholaMarketFrame["venue"]): TerminalMarketVenue | null {
  return SUPPORTED_VENUES.has(value as TerminalMarketVenue) ? value as TerminalMarketVenue : null;
}

function frameProductClass(frame: GholaMarketFrame): TerminalRouteProductClass | null {
  const normalized = frame.product.trim().toUpperCase();
  if (normalized.endsWith("-PERP")) return "perpetual";
  if (normalized.endsWith("-USD")) return "spot";
  if (frame.venue === "hyperliquid" && /^(BTC|ETH|SOL|HYPE)$/u.test(normalized)) return "perpetual";
  return null;
}

function frameNetwork(frame: GholaMarketFrame): TerminalRouteNetwork | null {
  const normalized = frame.network?.trim().toLowerCase();
  return normalized === "mainnet" || normalized === "testnet" ? normalized : null;
}

function venueSupportsMarket(venue: TerminalMarketVenue, market: string) {
  const instrument = market.trim().toUpperCase().replace(/-(USD|PERP)$/u, "");
  if (venue === "phoenix") return instrument === "SOL";
  if (venue === "coinbase") return instrument === "BTC" || instrument === "ETH" || instrument === "SOL";
  return instrument === "BTC" || instrument === "ETH" || instrument === "SOL" || instrument === "HYPE";
}

function positive(value: string | number | null | undefined) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
