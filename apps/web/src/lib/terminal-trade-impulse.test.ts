import { describe, expect, it } from "vitest";
import type { GholaChartTrade } from "./ghola-market-chart";
import {
  deriveTerminalTradeImpulse,
  terminalTradeImpulseAgeBucket,
  terminalTradePrintStageDecision,
  TERMINAL_TRADE_IMPULSE_LIMIT,
} from "./terminal-trade-impulse";

describe("terminal trade impulse", () => {
  it("uses one-second temporal buckets for bounded memo refreshes", () => {
    expect(terminalTradeImpulseAgeBucket(null)).toBe(-1);
    expect(terminalTradeImpulseAgeBucket(999)).toBe(0);
    expect(terminalTradeImpulseAgeBucket(1_000)).toBe(1);
    expect(terminalTradeImpulseAgeBucket(35_000)).toBe(30);
  });

  it("stages only an exact current certified market identity", () => {
    expect(terminalTradePrintStageDecision({
      streamCertified: true,
      currentIdentityKey: "coinbase:mainnet:btc:1m",
      expectedIdentityKey: "coinbase:mainnet:btc:1m",
      price: 100.25,
    })).toEqual({ allowed: true, price: 100.25 });
    expect(terminalTradePrintStageDecision({
      streamCertified: false,
      currentIdentityKey: "coinbase:mainnet:btc:1m",
      expectedIdentityKey: "coinbase:mainnet:btc:1m",
      price: 100.25,
    })).toEqual({ allowed: false, blocker: "stream_uncertified" });
    expect(terminalTradePrintStageDecision({
      streamCertified: true,
      currentIdentityKey: "coinbase:mainnet:eth:1m",
      expectedIdentityKey: "coinbase:mainnet:btc:1m",
      price: 100.25,
    })).toEqual({ allowed: false, blocker: "identity_mismatch" });
  });

  it("classifies aggressive buying with rising prints", () => {
    const result = deriveTerminalTradeImpulse({ certified: true, componentAgeMs: 0, trades: [
      trade(0, "buy", 100, 5),
      trade(1_000, "sell", 100.01, 1),
      trade(2_000, "buy", 100.05, 5),
    ] });
    expect(result).toMatchObject({
      status: "ready",
      classification: "buy_impulse",
      sampleCount: 3,
      windowMs: 2_000,
      printsPerSecond: 1,
      largestPrintSide: "buy",
    });
    expect(result.buySharePct).toBeGreaterThan(80);
    expect(result.priceChangeBps).toBeCloseTo(5);
    expect(result.netAggressorNotionalUsd).toBeGreaterThan(0);
  });

  it.each([
    ["buy_absorption_candidate", [trade(0, "buy", 100, 5), trade(1_000, "sell", 100.01, 1), trade(2_000, "buy", 100.01, 5)]],
    ["buy_divergence", [trade(0, "buy", 100, 5), trade(1_000, "sell", 99.99, 1), trade(2_000, "buy", 99.95, 5)]],
    ["sell_impulse", [trade(0, "sell", 100, 5), trade(1_000, "buy", 99.99, 1), trade(2_000, "sell", 99.95, 5)]],
    ["sell_absorption_candidate", [trade(0, "sell", 100, 5), trade(1_000, "buy", 99.99, 1), trade(2_000, "sell", 99.99, 5)]],
    ["sell_divergence", [trade(0, "sell", 100, 5), trade(1_000, "buy", 100.01, 1), trade(2_000, "sell", 100.05, 5)]],
  ])("classifies %s without directional prediction", (classification, trades) => {
    expect(deriveTerminalTradeImpulse({ certified: true, componentAgeMs: 0, trades }).classification).toBe(classification);
  });

  it("uses only the latest 30 seconds and preserves caller order", () => {
    const trades = [
      trade(0, "sell", 90, 100),
      trade(31_000, "buy", 100, 1),
      trade(45_000, "buy", 101, 1),
      trade(61_000, "sell", 102, 1),
    ];
    const before = trades.map((item) => item.id);
    const result = deriveTerminalTradeImpulse({ certified: true, componentAgeMs: 0, trades });
    expect(result).toMatchObject({ sampleCount: 3, windowMs: 30_000 });
    expect(trades.map((item) => item.id)).toEqual(before);
  });

  it("subtracts component age so old prints cannot masquerade as a current 30-second window", () => {
    const trades = [
      trade(0, "buy", 100, 1),
      trade(15_000, "buy", 101, 1),
      trade(30_000, "sell", 102, 1),
    ];
    expect(deriveTerminalTradeImpulse({ certified: true, componentAgeMs: 20_000, trades })).toMatchObject({
      status: "thin_sample",
      sampleCount: 1,
      windowMs: 0,
      classification: null,
    });
  });

  it("deduplicates exact prints and rejects conflicting identities", () => {
    const same = trade(0, "buy", 100, 1, "same");
    expect(deriveTerminalTradeImpulse({ certified: true, componentAgeMs: 0, trades: [same, { ...same }] })).toMatchObject({
      status: "thin_sample",
      sampleCount: 1,
    });
    expect(deriveTerminalTradeImpulse({ certified: true, componentAgeMs: 0, trades: [same, { ...same, px: "101" }] }).blocker)
      .toBe("prints_invalid");
  });

  it.each([
    ["uncertified", { certified: false, componentAgeMs: null, trades: [trade(0, "buy", 100, 1)] }],
    ["component_age_invalid", { certified: true, componentAgeMs: 30_001, trades: [trade(0, "buy", 100, 1)] }],
    ["prints_empty", { certified: true, componentAgeMs: 0, trades: [] }],
    ["prints_oversized", { certified: true, componentAgeMs: 0, trades: Array.from({ length: TERMINAL_TRADE_IMPULSE_LIMIT + 1 }, (_, index) => trade(index, "buy", 100, 1)) }],
    ["prints_invalid", { certified: true, componentAgeMs: 0, trades: [{ ...trade(0, "buy", 100, 1), sz: "0" }] }],
    ["prints_invalid", { certified: true, componentAgeMs: 0, trades: [trade(0, "buy", 1e308, 1e308)] }],
  ])("fails closed for %s input", (blocker, input) => {
    expect(deriveTerminalTradeImpulse(input)).toMatchObject({ status: "unavailable", blocker, sampleCount: 0 });
  });
});

function trade(
  time: number,
  side: "buy" | "sell",
  price: number,
  size: number,
  id = `${time}:${side}`,
): GholaChartTrade {
  return { id, time, side, px: String(price), sz: String(size) };
}
