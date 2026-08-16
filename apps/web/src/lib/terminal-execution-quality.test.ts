import { describe, expect, it } from "vitest";
import { simulateTerminalExecution, terminalExecutionQualityEqual } from "./terminal-execution-quality";

describe("terminal execution quality", () => {
  it("sweeps asks in price order and reports all-in arrival cost", () => {
    const result = simulateTerminalExecution({
      side: "buy",
      orderNotionalUsd: 1_000,
      referencePrice: 100,
      takerFeeBps: 5,
      levels: [{ px: "101", sz: "6" }, { px: "100.5", sz: "5" }, { px: "100.5", sz: "1" }],
    });

    expect(result.status).toBe("full");
    expect(result.filledBaseSize).toBe(10);
    expect(result.vwap).toBeCloseTo(100.7);
    expect(result.impactBps).toBeCloseTo(70);
    expect(result.allInImpactBps).toBeCloseTo(75);
    expect(result.levelsConsumed).toBe(2);
  });

  it("reports partial liquidity when a limit excludes deeper asks", () => {
    const result = simulateTerminalExecution({
      side: "buy",
      orderNotionalUsd: 1_000,
      referencePrice: 100,
      limitPrice: 100.5,
      levels: [{ px: "100.5", sz: "4" }, { px: "101", sz: "20" }],
    });

    expect(result.status).toBe("partial");
    expect(result.fillPct).toBeCloseTo(40);
    expect(result.unfilledNotionalUsd).toBeCloseTo(600);
    expect(result.worstPrice).toBe(100.5);
  });

  it("sizes an aggressive buy at its order quantity while benchmarking impact to market", () => {
    const result = simulateTerminalExecution({
      side: "buy",
      orderNotionalUsd: 1_100,
      targetBaseSize: 10,
      referencePrice: 100,
      limitPrice: 110,
      levels: [{ px: "101", sz: "20" }],
    });

    expect(result).toMatchObject({ status: "full", targetBaseSize: 10, filledBaseSize: 10, vwap: 101 });
    expect(result.impactBps).toBeCloseTo(100);
  });

  it("sizes an aggressive sell at its order quantity while benchmarking impact to market", () => {
    const result = simulateTerminalExecution({
      side: "sell",
      orderNotionalUsd: 900,
      targetBaseSize: 10,
      referencePrice: 100,
      limitPrice: 90,
      levels: [{ px: "99", sz: "20" }],
    });

    expect(result).toMatchObject({ status: "full", targetBaseSize: 10, filledBaseSize: 10, vwap: 99 });
    expect(result.impactBps).toBeCloseTo(100);
  });

  it("reports partial unfilled value as the same fraction of requested order notional", () => {
    const result = simulateTerminalExecution({
      side: "buy",
      orderNotionalUsd: 1_100,
      targetBaseSize: 10,
      referencePrice: 100,
      limitPrice: 110,
      levels: [{ px: "101", sz: "4" }],
    });

    expect(result.status).toBe("partial");
    expect(result.fillPct).toBeCloseTo(40);
    expect(result.unfilledNotionalUsd).toBeCloseTo(660);
  });

  it("sorts bids, ignores invalid levels, and measures sell impact", () => {
    const result = simulateTerminalExecution({
      side: "sell",
      orderNotionalUsd: 500,
      referencePrice: 100,
      levels: [{ px: "98", sz: "10" }, { px: "99.5", sz: "3" }, { px: "100", sz: "0" }, { px: "bad", sz: "2" }],
    });

    expect(result.status).toBe("full");
    expect(result.vwap).toBeCloseTo(98.9);
    expect(result.impactBps).toBeCloseTo(110);
    expect(result.levelsConsumed).toBe(2);
  });

  it("fails closed without a valid benchmark", () => {
    expect(simulateTerminalExecution({
      side: "buy",
      orderNotionalUsd: 10,
      targetBaseSize: 1,
      referencePrice: null,
      levels: [],
    }).status)
      .toBe("no_market");
  });

  it("compares derived quality semantically", () => {
    const result = simulateTerminalExecution({
      side: "buy",
      orderNotionalUsd: 100,
      referencePrice: 100,
      levels: [{ px: 101, sz: 1 }],
    });
    expect(terminalExecutionQualityEqual(result, { ...result })).toBe(true);
    expect(terminalExecutionQualityEqual(result, { ...result, impactBps: 101 })).toBe(false);
  });
});
