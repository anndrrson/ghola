import { describe, expect, it } from "vitest";
import { deriveTerminalMarketMetrics, deriveTerminalTradeRisk } from "./trading-terminal-metrics";
import type { GholaChartCandle, GholaMarketFrame } from "./ghola-market-chart";

describe("trading terminal metrics", () => {
  it("derives direction, volatility, liquidity, flow, and freshness", () => {
    const metrics = deriveTerminalMarketMetrics(frame(), {
      depthLevels: 2,
      nowMs: Date.parse("2026-08-12T12:00:03.000Z"),
    });

    expect(metrics.sessionChangePct).toBeCloseTo(2);
    expect(metrics.sessionHigh).toBe(104);
    expect(metrics.sessionLow).toBe(98);
    expect(metrics.atr).toBeCloseTo(4);
    expect(metrics.bidDepthUsd).toBe(99 * 3 + 98 * 2);
    expect(metrics.askDepthUsd).toBe(101 * 1 + 102 * 2);
    expect(metrics.bookImbalancePct).toBeCloseTo(25);
    expect(metrics.microprice).toBeCloseTo(100.25);
    expect(metrics.micropriceEdgeBps).toBeCloseTo(25);
    expect(metrics.tradeVwap).toBeCloseTo(100);
    expect(metrics.buyFlowPct).toBeCloseTo((101 * 2) / (101 * 2 + 99 * 2) * 100);
    expect(metrics.marketAgeMs).toBe(3_000);
  });

  it("calculates explicit execution and stop risk for both sides", () => {
    const long = deriveTerminalTradeRisk({
      side: "buy",
      notionalUsd: 1_000,
      entryPrice: 100,
      stopPrice: 98,
      slippageBps: 25,
      spreadBps: 10,
    });
    const short = deriveTerminalTradeRisk({
      side: "sell",
      notionalUsd: 1_000,
      entryPrice: 100,
      stopPrice: 103,
      slippageBps: 50,
    });

    expect(long).toMatchObject({
      baseSize: 10,
      stopDistanceBps: 200,
      maxLossUsd: 22.5,
      crossingCostUsd: 1,
      worstFillPrice: 100.25,
      twoRTargetPrice: 104,
      stopValid: true,
    });
    expect(short.worstFillPrice).toBe(99.5);
    expect(short.twoRTargetPrice).toBe(94);
    expect(short.stopValid).toBe(true);
  });

  it("flags a stop placed on the loss-increasing side of the entry", () => {
    expect(deriveTerminalTradeRisk({
      side: "buy",
      notionalUsd: 100,
      entryPrice: 100,
      stopPrice: 101,
      slippageBps: 0,
    }).stopValid).toBe(false);
  });

  it("stays finite for missing or malformed market data", () => {
    const malformed = { ...frame(), mid: "NaN", candles: [], bids: [], asks: [], trades: [] };
    const metrics = deriveTerminalMarketMetrics(malformed);

    expect(metrics.sessionChangePct).toBeNull();
    expect(metrics.bookImbalancePct).toBeNull();
    expect(metrics.microprice).toBeNull();
    expect(metrics.tradeVwap).toBeNull();
  });
});

function frame(): GholaMarketFrame {
  return {
    version: 1,
    venue: "hyperliquid",
    product: "BTC",
    interval: "5m",
    fetchedAt: "2026-08-12T12:00:00.000Z",
    stale: false,
    mid: "100",
    bestBid: "99",
    bestAsk: "101",
    spreadBps: 10,
    markPrice: "100",
    oraclePrice: "100",
    fundingRate: "0.0001",
    openInterest: "1000000",
    dayVolume: "10000000",
    candles: [
      candle(0, 100, 102, 98, 101),
      candle(1, 101, 103, 99, 102),
      candle(2, 102, 104, 100, 102),
    ],
    bids: [{ px: "99", sz: "3", n: 2 }, { px: "98", sz: "2", n: 1 }],
    asks: [{ px: "101", sz: "1", n: 1 }, { px: "102", sz: "2", n: 1 }],
    trades: [
      { side: "buy", px: "101", sz: "2", time: 1 },
      { side: "sell", px: "99", sz: "2", time: 2 },
    ],
    routeQuotes: [],
  };
}

function candle(index: number, open: number, high: number, low: number, close: number): GholaChartCandle {
  return {
    t: index * 300_000,
    T: index * 300_000 + 299_999,
    o: String(open),
    h: String(high),
    l: String(low),
    c: String(close),
    v: "10",
    n: 1,
  };
}
