import { describe, expect, it } from "vitest";
import type { TerminalRouteCandidate } from "./terminal-route-decision";
import { terminalRouteStageTarget } from "./terminal-route-staging";

const NOW = Date.parse("2026-08-12T12:00:01.000Z");

describe("terminal route staging", () => {
  it("stages one current compatible peer without executing anything", () => {
    expect(stage()).toEqual({
      allowed: true,
      blocker: null,
      venue: "phoenix",
      market: "SOL",
      network: "mainnet",
    });
  });

  it("fails closed when the rendered candidate changed or is already selected", () => {
    expect(stage({ currentCandidates: [] })).toEqual({ allowed: false, blocker: "route_stage_candidate_changed" });
    expect(stage({ currentVenue: "phoenix" })).toEqual({ allowed: false, blocker: "route_stage_already_selected" });
  });

  it("rejects no-fill, product, network, and venue-market mismatches", () => {
    expect(stage({ candidate: candidate({ status: "none", fillPct: 0 }) })).toEqual({ allowed: false, blocker: "route_stage_no_visible_fill" });
    expect(stage({ candidate: candidate({ product: "BTC-PERP" }), currentMarket: "SOL" })).toEqual({ allowed: false, blocker: "route_stage_context_mismatch" });
    expect(stage({ candidate: candidate({ network: "testnet" }), requiredNetwork: "mainnet" })).toEqual({ allowed: false, blocker: "route_stage_context_mismatch" });
    expect(stage({ supportedMarketsByVenue: { hyperliquid: ["SOL"], phoenix: [], coinbase: ["SOL"] } })).toEqual({ allowed: false, blocker: "route_stage_market_unsupported" });
  });

  it("rechecks frame and book freshness at click time", () => {
    expect(stage({ nowMs: Number.NaN })).toEqual({ allowed: false, blocker: "route_stage_clock_invalid" });
    expect(stage({ candidate: candidate({ fetchedAt: "2026-08-12T12:00:07.000Z" }) })).toEqual({ allowed: false, blocker: "route_stage_frame_future" });
    expect(stage({ nowMs: NOW + 30_001 })).toEqual({ allowed: false, blocker: "route_stage_frame_expired" });
    expect(stage({ candidate: candidate({ bookObservedAt: "bad-clock" }) })).toEqual({ allowed: false, blocker: "route_stage_book_clock_invalid" });
    expect(stage({ candidate: candidate({ bookObservedAt: iso(NOW + 5_001) }) })).toEqual({ allowed: false, blocker: "route_stage_book_future" });
    expect(stage({ candidate: candidate({ bookObservedAt: iso(NOW - 30_001) }) })).toEqual({ allowed: false, blocker: "route_stage_book_expired" });
  });

  it("ages the exact book clock once instead of double-counting frame age", () => {
    const freshAtDecision = candidate({
      fetchedAt: iso(NOW - 1_000),
      bookAgeMs: 29_500,
      bookObservedAt: iso(NOW - 29_500),
    });
    expect(stage({ candidate: freshAtDecision })).toMatchObject({ allowed: true });
    expect(stage({ candidate: freshAtDecision, nowMs: NOW + 501 })).toEqual({ allowed: false, blocker: "route_stage_book_expired" });
  });
});

function stage(overrides: Partial<Parameters<typeof terminalRouteStageTarget>[0]> = {}) {
  const selectedCandidate = overrides.candidate ?? candidate();
  return terminalRouteStageTarget({
    candidate: selectedCandidate,
    currentCandidates: [selectedCandidate],
    currentVenue: "hyperliquid",
    currentMarket: "SOL",
    requiredProductClass: "perpetual",
    requiredNetwork: "mainnet",
    supportedMarketsByVenue: {
      hyperliquid: ["BTC", "ETH", "SOL", "HYPE"],
      phoenix: ["SOL"],
      coinbase: ["BTC", "ETH", "SOL"],
    },
    nowMs: NOW,
    maxAgeMs: 30_000,
    ...overrides,
  });
}

function candidate(overrides: Partial<TerminalRouteCandidate> = {}): TerminalRouteCandidate {
  return {
    rank: 1,
    venue: "phoenix",
    product: "SOL-PERP",
    productClass: "perpetual",
    network: "mainnet",
    status: "full",
    fillPct: 100,
    vwap: 100,
    impactBps: 2,
    filledNotionalUsd: 100,
    unfilledNotionalUsd: 0,
    worstPrice: 100,
    levelsConsumed: 1,
    bookAgeMs: 100,
    bookObservedAt: iso(NOW - 100),
    fetchedAt: "2026-08-12T12:00:00.000Z",
    ...overrides,
  };
}

function iso(value: number) {
  return new Date(value).toISOString();
}
