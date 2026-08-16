import { describe, expect, it } from "vitest";
import { deriveTerminalPlanMarketState } from "./terminal-plan-market-state";

describe("terminal plan market state", () => {
  it.each([
    ["buy resting", "buy", 99, 95, 100, "resting", -100],
    ["buy marketable", "buy", 101, 95, 100, "marketable", 100],
    ["sell resting", "sell", 101, 105, 100, "resting", -100],
    ["sell marketable", "sell", 99, 105, 100, "marketable", 100],
  ] as const)("classifies %s", (_label, side, entryPrice, stopPrice, executablePrice, mode, distance) => {
    const exact = deriveTerminalPlanMarketState({
      side,
      entryPrice,
      stopPrice,
      bestBid: side === "sell" ? executablePrice : 99.99,
      bestAsk: side === "buy" ? executablePrice : 100.01,
    });
    expect(exact).toMatchObject({ allowed: true, mode, distanceToMarketBps: expect.closeTo(distance, 6) });
  });

  it.each([
    ["buy", 110, 109, 108, 108.1],
    ["sell", 90, 91, 91.1, 91.2],
  ] as const)("blocks a marketable %s after BBO crossed invalidation", (side, entryPrice, stopPrice, bestBid, bestAsk) => {
    expect(deriveTerminalPlanMarketState({ side, entryPrice, stopPrice, bestBid, bestAsk })).toMatchObject({
      allowed: false,
      blocker: "already_invalidated",
      mode: "marketable",
      remainingRiskBps: expect.any(Number),
    });
  });

  it("accepts exact invalidation distance only when strictly positive", () => {
    expect(deriveTerminalPlanMarketState({
      side: "buy", entryPrice: 110, stopPrice: 100, bestBid: 99.9, bestAsk: 100,
    })).toMatchObject({ allowed: false, blocker: "already_invalidated", remainingRiskBps: 0 });
    expect(deriveTerminalPlanMarketState({
      side: "buy", entryPrice: 110, stopPrice: 99.99, bestBid: 99.9, bestAsk: 100,
    })).toMatchObject({ allowed: true, mode: "marketable", remainingRiskBps: expect.closeTo(1, 6) });
  });

  it.each([
    ["missing quote", { bestAsk: null }, "quote_unavailable"],
    ["crossed quote", { bestBid: 101, bestAsk: 100 }, "quote_unavailable"],
    ["wrong-side stop", { stopPrice: 110 }, "plan_invalid"],
  ])("fails closed for %s", (_label, overrides, blocker) => {
    expect(deriveTerminalPlanMarketState({
      side: "buy", entryPrice: 100, stopPrice: 95, bestBid: 99, bestAsk: 101, ...overrides,
    })).toMatchObject({ allowed: false, blocker });
  });
});
