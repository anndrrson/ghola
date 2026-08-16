import type {
  TerminalRouteCandidate,
  TerminalRouteNetwork,
  TerminalRouteProductClass,
} from "./terminal-route-decision";
import type { TerminalMarketVenue } from "./terminal-market-identity";

export type TerminalRouteStageBlocker =
  | "route_stage_candidate_changed"
  | "route_stage_already_selected"
  | "route_stage_no_visible_fill"
  | "route_stage_context_mismatch"
  | "route_stage_market_unsupported"
  | "route_stage_clock_invalid"
  | "route_stage_frame_future"
  | "route_stage_frame_expired"
  | "route_stage_book_clock_invalid"
  | "route_stage_book_future"
  | "route_stage_book_expired";

export type TerminalRouteStageResult =
  | {
      allowed: true;
      blocker: null;
      venue: TerminalMarketVenue;
      market: string;
      network: TerminalRouteNetwork;
    }
  | { allowed: false; blocker: TerminalRouteStageBlocker };

export function terminalRouteStageTarget(input: {
  candidate: TerminalRouteCandidate;
  currentCandidates: readonly TerminalRouteCandidate[];
  currentVenue: TerminalMarketVenue;
  currentMarket: string;
  requiredProductClass: TerminalRouteProductClass;
  requiredNetwork: TerminalRouteNetwork;
  supportedMarketsByVenue: Readonly<Record<TerminalMarketVenue, readonly string[]>>;
  nowMs: number;
  maxAgeMs: number;
}): TerminalRouteStageResult {
  const certified = input.currentCandidates.find((item) =>
    item.venue === input.candidate.venue &&
    item.product === input.candidate.product &&
    item.network === input.candidate.network &&
    item.bookObservedAt === input.candidate.bookObservedAt &&
    item.fetchedAt === input.candidate.fetchedAt
  );
  if (!certified) return blocked("route_stage_candidate_changed");
  if (certified.venue === input.currentVenue) return blocked("route_stage_already_selected");
  if (certified.status === "none" || !Number.isFinite(certified.fillPct) || certified.fillPct <= 0) {
    return blocked("route_stage_no_visible_fill");
  }
  const market = routeProductMarket(certified.product);
  if (
    certified.productClass !== input.requiredProductClass ||
    certified.network !== input.requiredNetwork ||
    market !== input.currentMarket.trim().toUpperCase()
  ) return blocked("route_stage_context_mismatch");
  if (!input.supportedMarketsByVenue[certified.venue].includes(market)) {
    return blocked("route_stage_market_unsupported");
  }
  if (!Number.isFinite(input.nowMs) || !Number.isFinite(input.maxAgeMs) || input.maxAgeMs <= 0) {
    return blocked("route_stage_clock_invalid");
  }
  const fetchedAtMs = Date.parse(certified.fetchedAt);
  if (!Number.isFinite(fetchedAtMs)) return blocked("route_stage_clock_invalid");
  if (fetchedAtMs > input.nowMs + 5_000) return blocked("route_stage_frame_future");
  if (input.nowMs - fetchedAtMs > input.maxAgeMs) return blocked("route_stage_frame_expired");
  const bookObservedAtMs = Date.parse(certified.bookObservedAt);
  if (!Number.isFinite(bookObservedAtMs) || new Date(bookObservedAtMs).toISOString() !== certified.bookObservedAt) {
    return blocked("route_stage_book_clock_invalid");
  }
  if (bookObservedAtMs > input.nowMs + 5_000) return blocked("route_stage_book_future");
  if (input.nowMs - bookObservedAtMs > input.maxAgeMs) return blocked("route_stage_book_expired");
  return {
    allowed: true,
    blocker: null,
    venue: certified.venue,
    market,
    network: certified.network,
  };
}

function routeProductMarket(product: string) {
  return product.trim().toUpperCase().replace(/-(USD|PERP)$/u, "");
}

function blocked(blocker: TerminalRouteStageBlocker): TerminalRouteStageResult {
  return { allowed: false, blocker };
}
