import { describe, expect, it } from "vitest";
import type { GholaMarketFrame } from "./ghola-market-chart";
import { deriveTerminalPriceAuthority } from "./terminal-price-authority";

describe("terminal price authority", () => {
  it("quarantines a tempting synthetic chart price from display and staging", () => {
    expect(deriveTerminalPriceAuthority({
      chartFrame: frame("99999"),
      liveMarketContext: blockedContext(),
    })).toEqual({
      chartMid: 99_999,
      certifiedMid: null,
      displayMid: null,
      automaticEntryPrice: null,
      source: "chart_only",
    });
  });

  it("uses certified BBO instead of a conflicting chart midpoint", () => {
    expect(deriveTerminalPriceAuthority({
      chartFrame: frame("99999"),
      liveMarketContext: {
        allowed: true,
        blocker: null,
        quoteAgeMs: 10,
        quoteFetchedAt: "2026-08-13T12:00:00.000Z",
        referencePrice: 100,
        spreadBps: 200,
        bestBid: 99,
        bestAsk: 101,
      },
    })).toMatchObject({ chartMid: 99_999, certifiedMid: 100, displayMid: 100, automaticEntryPrice: 100, source: "certified_bbo" });
  });
});

function blockedContext() {
  return {
    allowed: false as const,
    blocker: "quote_expired" as const,
    quoteAgeMs: 31_000,
    quoteFetchedAt: null,
    referencePrice: null,
    spreadBps: null,
    bestBid: null,
    bestAsk: null,
  };
}

function frame(mid: string): GholaMarketFrame {
  return {
    version: 1,
    venue: "hyperliquid",
    network: "mainnet",
    product: "BTC",
    interval: "1m",
    fetchedAt: "2026-08-13T12:00:00.000Z",
    stale: true,
    mid,
    bestBid: "99",
    bestAsk: "101",
    spreadBps: 200,
    markPrice: mid,
    oraclePrice: mid,
    fundingRate: null,
    openInterest: null,
    dayVolume: null,
    candles: [],
    bids: [],
    asks: [],
    trades: [],
    routeQuotes: [],
  };
}
