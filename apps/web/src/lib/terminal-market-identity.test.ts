import { describe, expect, it } from "vitest";
import type { GholaMarketFrame } from "./ghola-market-chart";
import { terminalFrameMatchesSelection } from "./terminal-market-identity";

describe("terminal market identity", () => {
  it("requires venue, normalized instrument, and interval to match", () => {
    const value = frame();
    expect(terminalFrameMatchesSelection(value, {
      venue: "hyperliquid",
      market: "BTC",
      interval: "5m",
    })).toBe(true);
    expect(terminalFrameMatchesSelection(value, {
      venue: "coinbase",
      market: "BTC",
      interval: "5m",
    })).toBe(false);
    expect(terminalFrameMatchesSelection(value, {
      venue: "hyperliquid",
      market: "ETH",
      interval: "5m",
    })).toBe(false);
    expect(terminalFrameMatchesSelection(value, {
      venue: "hyperliquid",
      market: "BTC",
      interval: "1m",
    })).toBe(false);
  });
});

function frame(): GholaMarketFrame {
  return {
    version: 1,
    venue: "hyperliquid",
    product: "BTC-PERP",
    interval: "5m",
    fetchedAt: "2026-08-12T17:00:00.000Z",
    stale: false,
    mid: "68000",
    bestBid: "67999",
    bestAsk: "68001",
    spreadBps: 0.3,
    markPrice: "68000",
    oraclePrice: null,
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
