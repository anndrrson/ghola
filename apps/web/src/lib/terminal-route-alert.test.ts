import { describe, expect, it } from "vitest";
import type { TerminalRouteCandidate, TerminalRouteDecision } from "./terminal-route-decision";
import { deriveTerminalRouteImprovement } from "./terminal-route-alert";

describe("terminal route improvement alert metric", () => {
  it("measures side-correct full-fill peer improvement", () => {
    expect(deriveTerminalRouteImprovement(decision("buy", [candidate("hyperliquid", 101), candidate("phoenix", 100)]), "hyperliquid")).toMatchObject({
      improvementBps: expect.closeTo(99.0099, 3),
      improvementUsd: expect.closeTo(0.90909, 5),
      selectedVwap: 101,
      peerVenue: "phoenix",
      peerVwap: 100,
    });
    expect(deriveTerminalRouteImprovement(decision("sell", [candidate("hyperliquid", 99), candidate("phoenix", 100)]), "hyperliquid")).toMatchObject({
      improvementBps: expect.closeTo(101.0101, 3),
      improvementUsd: expect.closeTo(0.90909, 5),
      peerVenue: "phoenix",
    });
  });

  it("returns zero when a certified full peer is not better", () => {
    expect(deriveTerminalRouteImprovement(decision("buy", [candidate("hyperliquid", 100), candidate("phoenix", 101)]), "hyperliquid")).toMatchObject({
      improvementBps: 0,
      improvementUsd: 0,
    });
  });

  it("fails closed when the requested quantity cannot be derived", () => {
    const invalid = { ...decision("buy", [candidate("hyperliquid", 101), candidate("phoenix", 100)]), limitPrice: 0 };
    expect(deriveTerminalRouteImprovement(invalid, "hyperliquid")).toBeNull();
  });

  it.each([
    ["missing selected", decision("buy", [candidate("phoenix", 100)]), "hyperliquid"],
    ["missing peer", decision("buy", [candidate("hyperliquid", 100)]), "hyperliquid"],
    ["partial peer", decision("buy", [candidate("hyperliquid", 100), candidate("phoenix", 99, { status: "partial", fillPct: 50 })]), "hyperliquid"],
    ["blocked decision", { ...decision("buy", [candidate("hyperliquid", 100), candidate("phoenix", 99)]), blocker: "route_limit_invalid" as const }, "hyperliquid"],
  ])("fails closed for %s", (_label, value, selectedVenue) => {
    expect(deriveTerminalRouteImprovement(value, selectedVenue)).toBeNull();
  });

  it("does not mutate ranked candidates", () => {
    const value = decision("buy", [candidate("hyperliquid", 101), candidate("coinbase", 100.5), candidate("phoenix", 100)]);
    const before = JSON.stringify(value);
    deriveTerminalRouteImprovement(value, "hyperliquid");
    expect(JSON.stringify(value)).toBe(before);
  });
});

function decision(side: "buy" | "sell", candidates: TerminalRouteCandidate[]): TerminalRouteDecision {
  return {
    status: "full_available",
    blocker: null,
    side,
    requestedNotionalUsd: 100,
    limitPrice: 110,
    candidates,
    exclusions: [],
    best: candidates[0] ?? null,
  };
}

function candidate(venue: TerminalRouteCandidate["venue"], vwap: number, overrides: Partial<TerminalRouteCandidate> = {}): TerminalRouteCandidate {
  return {
    rank: 1,
    venue,
    product: "BTC-PERP",
    productClass: "perpetual",
    network: "mainnet",
    status: "full",
    fillPct: 100,
    vwap,
    impactBps: 0,
    filledNotionalUsd: 100,
    unfilledNotionalUsd: 0,
    worstPrice: vwap,
    levelsConsumed: 1,
    bookAgeMs: 10,
    bookObservedAt: "2026-08-12T12:00:00.000Z",
    fetchedAt: "2026-08-12T12:00:00.000Z",
    ...overrides,
  };
}
