import { describe, expect, it } from "vitest";
import { floorTerminalNotionalUsd, sizeTerminalPositionForRisk } from "./terminal-position-sizing";

describe("terminal position sizing", () => {
  it("sizes a long from stop distance plus slippage", () => {
    const result = sizeTerminalPositionForRisk({
      side: "buy",
      riskBudgetUsd: 25,
      entryPrice: 100,
      stopPrice: 98,
      slippageBps: 50,
      maxNotionalUsd: 2_000,
    });

    expect(result.status).toBe("ready");
    expect(result.totalRiskBps).toBe(250);
    expect(result.notionalUsd).toBe(1_000);
    expect(result.baseSize).toBe(10);
    expect(result.projectedLossUsd).toBe(25);
    expect(result.capped).toBe(false);
  });

  it("caps quote size without pretending the whole risk budget is used", () => {
    const result = sizeTerminalPositionForRisk({
      side: "sell",
      riskBudgetUsd: 25,
      entryPrice: 100,
      stopPrice: 101,
      slippageBps: 0,
      maxNotionalUsd: 100,
    });

    expect(result.notionalUsd).toBe(100);
    expect(result.projectedLossUsd).toBe(1);
    expect(result.capped).toBe(true);
  });

  it("includes explicit round-trip costs in the safe size", () => {
    const result = sizeTerminalPositionForRisk({
      side: "buy", riskBudgetUsd: 5, entryPrice: 100, stopPrice: 95,
      slippageBps: 0, roundTripCostBps: 30, maxNotionalUsd: 100,
    });
    expect(result).toMatchObject({ status: "ready", totalRiskBps: 530, notionalUsd: 94.33 });
    expect(sizeTerminalPositionForRisk({
      side: "buy", riskBudgetUsd: 5, entryPrice: 100, stopPrice: 95,
      slippageBps: 0, roundTripCostBps: Number.NaN, maxNotionalUsd: 100,
    }).status).toBe("invalid_cost_assumption");
  });

  it("does not lose a cent to machine-scale percentage noise", () => {
    const entryPrice = 63_749;
    const result = sizeTerminalPositionForRisk({
      side: "buy",
      riskBudgetUsd: 0.05,
      entryPrice,
      stopPrice: entryPrice * (1 - 0.0075),
      slippageBps: 50,
      maxNotionalUsd: 100,
    });

    expect(result.notionalUsd).toBe(4);
    expect(result.projectedLossUsd).toBeCloseTo(0.05);
  });

  it("normalizes actionable notionals without ever rounding risk upward", () => {
    expect(floorTerminalNotionalUsd(40.509)).toBe(40.5);
    expect(floorTerminalNotionalUsd(40.50000000000001)).toBe(40.5);
    expect(floorTerminalNotionalUsd(-1)).toBeNull();
    expect(floorTerminalNotionalUsd(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("fails closed for invalid budgets, entries, and stop sides", () => {
    const base = {
      side: "buy" as const,
      riskBudgetUsd: 10,
      entryPrice: 100,
      stopPrice: 99,
      slippageBps: 25,
      maxNotionalUsd: 100,
    };
    expect(sizeTerminalPositionForRisk({ ...base, riskBudgetUsd: 0 }).status).toBe("invalid_budget");
    expect(sizeTerminalPositionForRisk({ ...base, entryPrice: null }).status).toBe("invalid_entry");
    expect(sizeTerminalPositionForRisk({ ...base, stopPrice: 101 }).status).toBe("invalid_stop");
  });
});
