import { describe, expect, it } from "vitest";
import type { GholaMarketFrame } from "./ghola-market-chart";
import { deriveTerminalMarketFieldAuthority } from "./terminal-market-field-authority";

const NOW = Date.parse("2026-08-13T12:00:00.000Z");

describe("terminal market field authority", () => {
  it("admits independently fresh market fields", () => {
    expect(derive({})).toEqual({
      ready: true,
      ageMs: 100,
      markPrice: 100,
      oraclePrice: 100.5,
      openInterest: 50,
      dayVolume: 1_000,
    });
  });

  it.each([
    ["missing", {}],
    ["expired", { market: NOW - 30_001 }],
    ["future", { market: NOW + 5_001 }],
  ] as const)("does not let a fresh quote bless %s market fields", (_label, componentTimestamps) => {
    expect(derive({ frame: frame({ componentTimestamps: { quote: NOW, ...componentTimestamps } }) })).toMatchObject({
      ready: false,
      markPrice: null,
      oraclePrice: null,
      openInterest: null,
      dayVolume: null,
    });
  });
});

function derive(overrides: Partial<Parameters<typeof deriveTerminalMarketFieldAuthority>[0]>) {
  return deriveTerminalMarketFieldAuthority({ frame: frame(), liveMarketContext: liveContext(), maxAgeMs: 30_000, nowMs: NOW, ...overrides });
}

function liveContext() {
  return { allowed: true as const, blocker: null, quoteAgeMs: 10, quoteFetchedAt: new Date(NOW - 10).toISOString(), referencePrice: 100, spreadBps: 200, bestBid: 99, bestAsk: 101 };
}

function frame(overrides: Partial<GholaMarketFrame> = {}): GholaMarketFrame {
  return {
    version: 1, venue: "hyperliquid", network: "mainnet", product: "BTC", interval: "1m",
    fetchedAt: new Date(NOW).toISOString(), stale: false, mid: "100", bestBid: "99", bestAsk: "101", spreadBps: 200,
    markPrice: "100", oraclePrice: "100.5", fundingRate: null, openInterest: "50", dayVolume: "1000",
    candles: [], bids: [], asks: [], trades: [], routeQuotes: [], componentTimestamps: { quote: NOW - 10, market: NOW - 100 },
    ...overrides,
  };
}
