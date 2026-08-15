import { describe, expect, it } from "vitest";
import type { GholaMarketFrame } from "./ghola-market-chart";
import { deriveTerminalLiveMarketContext } from "./terminal-live-market-context";

const NOW = Date.parse("2026-08-12T12:00:00.000Z");

describe("terminal live market context", () => {
  it("binds the exact quote clock and canonical BBO midpoint", () => {
    expect(derive({})).toEqual({
      allowed: true,
      blocker: null,
      quoteAgeMs: 250,
      quoteFetchedAt: new Date(NOW - 250).toISOString(),
      referencePrice: 100,
      spreadBps: 200,
      bestBid: 99,
      bestAsk: 101,
    });
  });

  it("rejects an expired quote even when an unrelated receipt made the aggregate frame fresh", () => {
    const result = derive({
      frame: frame({
        fetchedAt: new Date(NOW).toISOString(),
        componentTimestamps: { quote: NOW - 30_001, trades: NOW },
      }),
      nowMs: NOW,
    });
    expect(result).toMatchObject({ allowed: false, blocker: "quote_expired", quoteAgeMs: 30_001 });
  });

  it("accepts a fresh quote independently of an old aggregate receipt", () => {
    const result = derive({
      frame: frame({
        fetchedAt: new Date(NOW - 300_000).toISOString(),
        componentTimestamps: { quote: NOW - 100 },
      }),
      nowMs: NOW,
    });
    expect(result).toMatchObject({ allowed: true, quoteAgeMs: 100, referencePrice: 100 });
  });

  it("makes polling view-only when an executable WebSocket quote is required", () => {
    expect(derive({
      status: "fallback_polling",
      transport: "polling",
      requireWebSocket: true,
    })).toMatchObject({ allowed: false, blocker: "websocket_required" });
    expect(derive({
      transport: "websocket",
      requireWebSocket: true,
      maxAgeMs: 2_000,
    })).toMatchObject({ allowed: true, quoteAgeMs: 250 });
  });

  it.each([
    ["future tolerance", NOW + 5_000, 0],
    ["freshness boundary", NOW - 30_000, 30_000],
  ] as const)("accepts the exact %s boundary", (_label, quoteClock, expectedAge) => {
    expect(derive({ frame: frame({ componentTimestamps: { quote: quoteClock } }) })).toMatchObject({
      allowed: true,
      quoteAgeMs: expectedAge,
    });
  });

  it.each([
    ["transport", {}, { status: "blocked" }, "transport_unavailable"],
    ["network", { network: "testnet" }, {}, "identity_mismatch"],
    ["market", { product: "ETH" }, {}, "identity_mismatch"],
    ["controller", {}, { controllerStale: true }, "controller_stale"],
    ["missing clock", { componentTimestamps: {} }, {}, "quote_clock_missing"],
    ["future clock", { componentTimestamps: { quote: NOW + 5_001 } }, {}, "quote_clock_future"],
    ["one-sided", { bestAsk: null }, {}, "quote_invalid"],
    ["crossed", { bestBid: "102", bestAsk: "101" }, {}, "quote_invalid"],
  ] as const)("fails closed for %s context", (_label, frameOverrides, inputOverrides, blocker) => {
    expect(derive({ frame: frame(frameOverrides), ...inputOverrides })).toMatchObject({
      allowed: false,
      blocker,
      quoteFetchedAt: null,
      referencePrice: null,
      spreadBps: null,
    });
  });
});

function derive(overrides: Partial<Parameters<typeof deriveTerminalLiveMarketContext>[0]>) {
  return deriveTerminalLiveMarketContext({
    frame: frame(),
    venue: "hyperliquid",
    network: "mainnet",
    market: "BTC",
    interval: "5m",
    status: "live",
    controllerStale: false,
    maxAgeMs: 30_000,
    nowMs: NOW,
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
    fetchedAt: new Date(NOW).toISOString(),
    stale: false,
    mid: "10000",
    bestBid: "99",
    bestAsk: "101",
    spreadBps: 200,
    markPrice: "10000",
    oraclePrice: "10000",
    fundingRate: null,
    openInterest: null,
    dayVolume: null,
    candles: [],
    bids: [{ px: "99", sz: "10", n: 1 }],
    asks: [{ px: "101", sz: "10", n: 1 }],
    trades: [],
    routeQuotes: [],
    componentTimestamps: { quote: NOW - 250 },
    ...overrides,
  };
}
