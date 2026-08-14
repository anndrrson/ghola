import { describe, expect, it } from "vitest";
import type { GholaMarketFrame } from "./ghola-market-chart";
import { deriveTerminalEntryPriceStages } from "./terminal-entry-price-staging";

const NOW = Date.parse("2026-08-12T12:00:00.000Z");

describe("terminal entry price staging", () => {
  it.each([
    ["buy", 99, 101, "bid", "ask"],
    ["sell", 101, 99, "ask", "bid"],
  ] as const)("maps %s join and cross to the correct certified quote side", (side, join, cross, joinSide, crossSide) => {
    const stages = deriveTerminalEntryPriceStages({
      frame: frame(),
      venue: "hyperliquid",
      market: "BTC",
      interval: "5m",
      network: "mainnet",
      side,
      controllerStale: false,
      nowMs: NOW + 250,
      maxAgeMs: 30_000,
    });

    expect(stages).toMatchObject({ status: "ready", quoteAgeMs: 250, bestBid: 99, bestAsk: 101 });
    expect(stages.join).toMatchObject({ price: join, sourceSide: joinSide, marketable: false });
    expect(stages.cross).toMatchObject({ price: cross, sourceSide: crossSide, marketable: true });
  });

  it.each([
    ["wrong network", { network: "testnet" }, {}, "identity_mismatch"],
    ["stale controller", {}, { controllerStale: true }, "controller_stale"],
    ["missing clock", { componentTimestamps: {} }, {}, "quote_clock_invalid"],
    ["future clock", { componentTimestamps: { quote: NOW + 31_000 } }, {}, "quote_clock_future"],
    ["expired clock", { componentTimestamps: { quote: NOW - 30_001 } }, {}, "quote_expired"],
    ["one sided", { bestAsk: null }, {}, "quote_invalid"],
    ["crossed", { bestBid: "102", bestAsk: "101" }, {}, "quote_invalid"],
  ])("fails closed for %s", (_label, frameOverrides, inputOverrides, blocker) => {
    expect(deriveTerminalEntryPriceStages({
      frame: frame(frameOverrides),
      venue: "hyperliquid",
      market: "BTC",
      interval: "5m",
      network: "mainnet",
      side: "buy",
      controllerStale: false,
      nowMs: NOW,
      maxAgeMs: 30_000,
      ...inputOverrides,
    })).toMatchObject({ status: "unavailable", blocker, join: null, cross: null });
  });
});

function frame(overrides: Partial<GholaMarketFrame> = {}): GholaMarketFrame {
  return {
    version: 1,
    venue: "hyperliquid",
    network: "mainnet",
    product: "BTC",
    interval: "5m",
    fetchedAt: new Date(NOW).toISOString(),
    stale: false,
    mid: "100",
    bestBid: "99",
    bestAsk: "101",
    spreadBps: 200,
    markPrice: "100",
    oraclePrice: "100",
    fundingRate: null,
    openInterest: null,
    dayVolume: null,
    candles: [],
    bids: [{ px: "99", sz: "10", n: 1 }],
    asks: [{ px: "101", sz: "10", n: 1 }],
    trades: [],
    routeQuotes: [],
    componentTimestamps: { quote: NOW },
    ...overrides,
  };
}
