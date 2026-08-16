import { describe, expect, it } from "vitest";
import type { GholaMarketFrame } from "./ghola-market-chart";
import {
  deriveTerminalEntryOutcomeMatrix,
  terminalEntryOutcomeMatrixEqual,
  terminalEntrySizeRecommendation,
} from "./terminal-entry-outcome-matrix";

describe("terminal entry outcome matrix", () => {
  it("compares resting, selected, and marketable buy outcomes", () => {
    const result = derive({ currentPrice: 101 });

    expect(result.status).toBe("ready");
    expect(result.outcomes[0]).toMatchObject({ mode: "join", price: 99, intent: "resting", quality: { status: "none", fillPct: 0 } });
    expect(result.outcomes[1]).toMatchObject({ mode: "current", price: 101, intent: "marketable", quality: { status: "partial", fillPct: 50.5 } });
    expect(result.outcomes[2]).toMatchObject({ mode: "cross", price: 101, intent: "marketable", quality: { status: "partial", fillPct: 50.5 } });
    expect(result.outcomes[2]?.quality.impactBps).toBeCloseTo(100);
    expect(result.outcomes[0]?.risk).toMatchObject({ stopValid: true, budgetAllowed: true });
    expect(result.outcomes[1]?.risk).toMatchObject({ stopValid: true, budgetAllowed: false });
    expect(result.outcomes[0]?.risk.modeledLossUsd).toBeCloseTo(45.404);
    expect(result.outcomes[1]?.risk.modeledLossUsd).toBeCloseTo(64.406);
    expect(result.outcomes[1]?.risk.safeNotionalUsd).toBe(100);
    expect(result.outcomes[1]?.risk).toMatchObject({
      visibleFullFillNotionalUsd: 505,
      recommendedNotionalUsd: 100,
      recommendationConstraint: "risk_budget",
      canApplyRecommendedNotional: true,
    });
  });

  it("uses bids symmetrically for sells", () => {
    const result = derive({ side: "sell", joinPrice: 101, currentPrice: 99, crossPrice: 99, stopPrice: 105 });

    expect(result.outcomes[0]).toMatchObject({ intent: "resting", quality: { status: "none" } });
    expect(result.outcomes[1]).toMatchObject({ intent: "marketable", quality: { status: "full", vwap: 99 } });
    expect(result.outcomes[1]?.quality.impactBps).toBeCloseTo(100);
    expect(result.outcomes[0]?.risk.budgetAllowed).toBe(true);
    expect(result.outcomes[1]?.risk.budgetAllowed).toBe(false);
  });

  it("adds round-trip costs to every entry outcome and reduces its safe cap", () => {
    const result = derive({ roundTripCostBps: 50, riskBudgetUsd: 5, maxNotionalUsd: 1_000 });
    expect(result.outcomes[0]?.risk.modeledLossUsd).toBeCloseTo(50.404);
    expect(result.outcomes[1]?.risk.modeledLossUsd).toBeCloseTo(69.406);
    expect(result.outcomes[1]?.risk.safeNotionalUsd).toBe(72.03);
  });

  it("sizes each candidate from its own price and reports unfilled order value", () => {
    const result = derive({ notionalUsd: 1_100, currentPrice: 110, crossPrice: 110 });
    const current = result.outcomes[1];

    expect(current?.quality.targetBaseSize).toBe(10);
    expect(current?.quality.fillPct).toBe(50);
    expect(current?.quality.unfilledNotionalUsd).toBe(550);
  });

  it("marks only outcomes whose invalidation is on the wrong side", () => {
    const result = derive({ stopPrice: 100, stopPinned: true });

    expect(result.outcomes[0]?.risk).toMatchObject({ stopValid: false, modeledLossUsd: null, budgetAllowed: null });
    expect(result.outcomes[1]?.risk.stopValid).toBe(true);
    expect(result.outcomes[2]?.risk.stopValid).toBe(true);
  });

  it("recomputes automatic invalidation for every staged entry", () => {
    const result = derive({ stopPrice: 95, stopPinned: false });

    expect(result.outcomes.every((outcome) => outcome.risk.stopValid)).toBe(true);
    expect(result.outcomes.map((outcome) => outcome.risk.invalidationPrice)).toEqual([
      expect.closeTo(98.2575, 6),
      expect.closeTo(100.2425, 6),
      expect.closeTo(100.2425, 6),
    ]);
    expect(result.outcomes.map((outcome) => outcome.risk.modeledLossUsd)).toEqual([
      expect.closeTo(12.5, 6),
      expect.closeTo(12.5, 6),
      expect.closeTo(12.5, 6),
    ]);
    expect(result.outcomes.map((outcome) => outcome.risk.safeNotionalUsd)).toEqual([100, 100, 100]);
    expect(result.outcomes.every((outcome) => outcome.risk.canApplyRecommendedNotional)).toBe(true);
  });

  it("passes a budget boundary despite machine-scale loss noise", () => {
    const result = derive({
      notionalUsd: 4,
      riskBudgetUsd: 0.05,
      stopPinned: false,
    });

    expect(result.outcomes.every((outcome) => outcome.risk.budgetAllowed)).toBe(true);
    expect(result.outcomes.every((outcome) => !outcome.risk.canApplyRecommendedNotional)).toBe(true);
  });

  it("caps a marketable recommendation to fully fillable displayed depth", () => {
    const result = derive({
      notionalUsd: 1_000,
      riskBudgetUsd: 10_000,
      maxNotionalUsd: 10_000,
    });

    expect(result.outcomes[0]?.risk).toMatchObject({
      visibleFullFillNotionalUsd: null,
      recommendedNotionalUsd: 10_000,
      recommendationConstraint: "risk_budget",
    });
    expect(result.outcomes[2]?.risk).toMatchObject({
      visibleFullFillNotionalUsd: 505,
      recommendedNotionalUsd: 505,
      recommendationConstraint: "visible_liquidity",
      canApplyRecommendedNotional: true,
    });
    expect(terminalEntrySizeRecommendation(result.outcomes[2])).toEqual({
      notionalUsd: 505,
      constraint: "visible_liquidity",
      canApply: true,
      riskCapNotionalUsd: 10_000,
      visibleFullFillNotionalUsd: 505,
    });
  });

  it("never presents a modeled cap as an exposure-increasing safe action", () => {
    const result = derive({ notionalUsd: 10, riskBudgetUsd: 50, maxNotionalUsd: 100 });
    expect(result.outcomes[1]?.risk).toMatchObject({
      recommendedNotionalUsd: 100,
      canApplyRecommendedNotional: false,
    });
    expect(terminalEntrySizeRecommendation(result.outcomes[1])).toMatchObject({
      notionalUsd: 100,
      canApply: false,
    });
  });

  it("floors depth capacity to cents and never offers a subminimum action", () => {
    const floored = derive({
      notionalUsd: 10,
      riskBudgetUsd: 10_000,
      maxNotionalUsd: 10_000,
      frame: frame({ asks: [{ px: "101.003", sz: "0.401", n: 1 }], bestAsk: "101.003" }),
      currentPrice: 101.003,
      crossPrice: 101.003,
    });
    expect(floored.outcomes[2]?.risk).toMatchObject({
      visibleFullFillNotionalUsd: expect.closeTo(40.502203, 6),
      recommendedNotionalUsd: 40.5,
    });

    const belowMinimum = derive({
      notionalUsd: 10,
      riskBudgetUsd: 10_000,
      maxNotionalUsd: 10_000,
      minNotionalUsd: 1,
      frame: frame({ asks: [{ px: "101", sz: "0.005", n: 1 }] }),
    });
    expect(belowMinimum.outcomes[2]?.risk).toMatchObject({
      recommendedNotionalUsd: 0.5,
      canApplyRecommendedNotional: false,
    });
  });

  it("compares outcome matrices semantically for memoized rendering", () => {
    const left = derive({});
    const right = derive({});
    expect(terminalEntryOutcomeMatrixEqual(left, right)).toBe(true);
    if (right.status === "ready") right.outcomes[0]!.risk.recommendedNotionalUsd = 99;
    expect(terminalEntryOutcomeMatrixEqual(left, right)).toBe(false);
  });

  it.each([
    ["missing book", { frame: null }, "book_unavailable"],
    ["crossed book", { frame: frame({ bestBid: "102" }) }, "book_invalid"],
    ["invalid level", { frame: frame({ asks: [{ px: "101", sz: "0", n: 1 }] }) }, "book_invalid"],
    ["BBO-depth mismatch", { frame: frame({ bestAsk: "100.5" }) }, "book_invalid"],
    ["unsorted depth", { frame: frame({ asks: [{ px: "102", sz: "1", n: 1 }, { px: "101", sz: "1", n: 1 }] }) }, "book_invalid"],
    ["invalid notional", { notionalUsd: 0 }, "notional_invalid"],
    ["missing stage", { joinPrice: null }, "price_invalid"],
    ["missing invalidation", { stopPrice: null }, "risk_input_invalid"],
    ["invalid slippage", { slippageBps: -1 }, "risk_input_invalid"],
    ["invalid round-trip costs", { roundTripCostBps: Number.NaN }, "risk_input_invalid"],
    ["invalid budget", { riskBudgetUsd: 0 }, "risk_input_invalid"],
    ["invalid max notional", { maxNotionalUsd: 0 }, "risk_input_invalid"],
    ["invalid min notional", { minNotionalUsd: 0 }, "risk_input_invalid"],
    ["minimum above maximum", { minNotionalUsd: 101, maxNotionalUsd: 100 }, "risk_input_invalid"],
    ["invalid auto invalidation", { autoStopDistancePct: 1 }, "risk_input_invalid"],
  ] as const)("fails closed for %s", (_label, overrides, blocker) => {
    expect(derive(overrides)).toEqual({ status: "unavailable", blocker, outcomes: [] });
  });
});

function derive(overrides: Partial<Parameters<typeof deriveTerminalEntryOutcomeMatrix>[0]>) {
  return deriveTerminalEntryOutcomeMatrix({
    frame: frame(),
    side: "buy",
    notionalUsd: 1_000,
    joinPrice: 99,
    currentPrice: 101,
    crossPrice: 101,
    stopPrice: 95,
    stopPinned: true,
    autoStopDistancePct: 0.0075,
    slippageBps: 50,
    riskBudgetUsd: 50,
    minNotionalUsd: 1,
    maxNotionalUsd: 100,
    ...overrides,
  });
}

function frame(overrides: Partial<GholaMarketFrame> = {}): GholaMarketFrame {
  return {
    version: 1,
    venue: "hyperliquid",
    network: "mainnet",
    product: "BTC",
    interval: "5m",
    fetchedAt: "2026-08-13T12:00:00.000Z",
    stale: false,
    mid: "100",
    bestBid: "99",
    bestAsk: "101",
    spreadBps: 200,
    markPrice: null,
    oraclePrice: null,
    fundingRate: null,
    openInterest: null,
    dayVolume: null,
    candles: [],
    bids: [{ px: "99", sz: "20", n: 1 }],
    asks: [{ px: "101", sz: "5", n: 1 }],
    trades: [],
    routeQuotes: [],
    componentTimestamps: { quote: 1, book: 1 },
    ...overrides,
  };
}
