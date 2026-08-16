import { describe, expect, it } from "vitest";
import { deriveTerminalRewardLadder, terminalRewardTargetPrice } from "./terminal-reward-ladder";
import type { GholaChartCandle } from "./ghola-market-chart";

describe("terminal reward ladder", () => {
  it("compares long targets using slippage-adjusted payoff and resolved paths", () => {
    const result = deriveTerminalRewardLadder({
      candles: repeatedEpisodes("buy"),
      side: "buy",
      entryPrice: 100,
      stopPrice: 98,
      notionalUsd: 1_000,
      slippageBps: 10,
    });

    expect(result.status).toBe("ready");
    expect(result.stopLossUsd).toBe(21);
    expect(result.rows.map((row) => [row.rewardMultiple, row.targetPrice, row.targetProfitUsd]))
      .toEqual([[1, 102, 19], [1.5, 103, 29], [2, 104, 39], [3, 106, 59]]);
    expect(result.rows.every((row) => row.requiredWinRatePct != null)).toBe(true);
    expect(result.rows[0]?.requiredWinRatePct).toBeCloseTo(52.5);
  });

  it("mirrors exact target prices for shorts", () => {
    const result = deriveTerminalRewardLadder({
      candles: repeatedEpisodes("sell"),
      side: "sell",
      entryPrice: 100,
      stopPrice: 102,
      notionalUsd: 1_000,
      slippageBps: 0,
    });
    expect(result.rows.map((row) => row.targetPrice)).toEqual([98, 97, 96, 94]);
  });

  it("derives only supported targets from a valid directional plan", () => {
    expect(terminalRewardTargetPrice({ side: "buy", entryPrice: 100, stopPrice: 98, rewardMultiple: 1.5 })).toBe(103);
    expect(terminalRewardTargetPrice({ side: "sell", entryPrice: 100, stopPrice: 102, rewardMultiple: 3 })).toBe(94);
    expect(terminalRewardTargetPrice({ side: "buy", entryPrice: 100, stopPrice: 101, rewardMultiple: 2 })).toBeNull();
  });

  it("fails closed for invalid plan, ticket, or history", () => {
    expect(deriveTerminalRewardLadder({ ...base(), stopPrice: 101 }).blocker).toBe("plan_invalid");
    expect(deriveTerminalRewardLadder({ ...base(), notionalUsd: 0 }).blocker).toBe("notional_invalid");
    expect(deriveTerminalRewardLadder({ ...base(), slippageBps: -1 }).blocker).toBe("slippage_invalid");
    expect(deriveTerminalRewardLadder({ ...base(), candles: [] }).blocker).toBe("history_unavailable");
  });

  it("keeps malformed candle history unavailable for every target", () => {
    const candles = repeatedEpisodes("buy");
    candles[1] = { ...candles[1]!, l: "200" };
    const result = deriveTerminalRewardLadder({ ...base(), candles });
    expect(result.status).toBe("unavailable");
    expect(result.rows.every((row) => row.status === "unavailable")).toBe(true);
  });
});

function base() {
  return {
    candles: repeatedEpisodes("buy"),
    side: "buy" as const,
    entryPrice: 100,
    stopPrice: 98,
    notionalUsd: 1_000,
    slippageBps: 10,
  };
}

function repeatedEpisodes(side: "buy" | "sell"): GholaChartCandle[] {
  const candles: GholaChartCandle[] = [];
  for (let index = 0; index < 80; index += 1) {
    const phase = index % 4;
    const values: [number, number, number, number] = side === "buy"
      ? phase === 0 ? [101, 101.5, 100.5, 101] : phase === 1 ? [100.5, 101, 99.5, 100] : phase === 2 ? [100, 106.5, 99, 105] : [105, 105.5, 104.5, 105]
      : phase === 0 ? [99, 99.5, 98.5, 99] : phase === 1 ? [99.5, 100.5, 99, 100] : phase === 2 ? [100, 101, 93.5, 95] : [95, 95.5, 94.5, 95];
    candles.push(candle(index, ...values));
  }
  return candles;
}

function candle(index: number, o: number, h: number, l: number, c: number): GholaChartCandle {
  return { t: index * 60_000 + 1, T: index * 60_000 + 59_999, o: String(o), h: String(h), l: String(l), c: String(c), v: "1", n: 1 };
}
