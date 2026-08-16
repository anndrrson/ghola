import { describe, expect, it } from "vitest";
import type { GholaMarketFrame } from "./ghola-market-chart";
import { stabilizeUnifiedMarketFrameCollections } from "./unified-live-market";

describe("unified market collection stability", () => {
  it("retains unchanged component arrays across quote-only updates", () => {
    const previous = frame();
    const next = frame({ fetchedAt: "2026-08-13T12:00:01.000Z", mid: "101" });
    const stable = stabilizeUnifiedMarketFrameCollections(previous, next);
    expect(stable).not.toBe(next);
    expect(stable.candles).toBe(previous.candles);
    expect(stable.bids).toBe(previous.bids);
    expect(stable.asks).toBe(previous.asks);
    expect(stable.trades).toBe(previous.trades);
    expect(stable.routeQuotes).toBe(previous.routeQuotes);
    expect(stable.mid).toBe("101");
  });

  it("does not scan cold collections for an authoritative quote-only update", () => {
    const previous = frame();
    const unreadableCandle = Object.defineProperty({}, "t", {
      get() { throw new Error("cold candle collection was scanned"); },
    }) as GholaMarketFrame["candles"][number];
    const next = frame({
      fetchedAt: "2026-08-13T12:00:01.000Z",
      mid: "101",
      candles: [unreadableCandle],
    });
    const stable = stabilizeUnifiedMarketFrameCollections(previous, next, new Set(["quote"]));
    expect(stable.candles).toBe(previous.candles);
    expect(stable.bids).toBe(previous.bids);
    expect(stable.asks).toBe(previous.asks);
    expect(stable.trades).toBe(previous.trades);
    expect(stable.mid).toBe("101");
  });

  it("changes only the collection whose exact values changed", () => {
    const previous = frame();
    const next = frame({ trades: [{ id: "trade-2", side: "sell", px: "100", sz: "0.2", time: 2 }] });
    const stable = stabilizeUnifiedMarketFrameCollections(previous, next);
    expect(stable.candles).toBe(previous.candles);
    expect(stable.bids).toBe(previous.bids);
    expect(stable.trades).toBe(next.trades);
  });

  it("never shares collections across market identities", () => {
    const previous = frame();
    const next = frame({ product: "ETH" });
    expect(stabilizeUnifiedMarketFrameCollections(previous, next)).toBe(next);
    expect(next.candles).not.toBe(previous.candles);
  });

  it("detects exact candle and depth changes", () => {
    const previous = frame();
    const next = frame({
      candles: [{ ...previous.candles[0], c: "101" }],
      bids: [{ ...previous.bids[0], sz: "2" }],
    });
    const stable = stabilizeUnifiedMarketFrameCollections(previous, next);
    expect(stable.candles).toBe(next.candles);
    expect(stable.bids).toBe(next.bids);
    expect(stable.asks).toBe(previous.asks);
  });
});

function frame(overrides: Partial<GholaMarketFrame> = {}): GholaMarketFrame {
  return {
    version: 1,
    venue: "hyperliquid",
    network: "mainnet",
    product: "BTC",
    interval: "5m",
    fetchedAt: "2026-08-13T12:00:00.000Z",
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
    candles: [{ t: 1, T: 2, o: "99", h: "102", l: "98", c: "100", v: "1", n: 1 }],
    bids: [{ px: "99", sz: "1", n: 1 }],
    asks: [{ px: "101", sz: "1", n: 1 }],
    trades: [{ id: "trade-1", side: "buy", px: "100", sz: "0.1", time: 1 }],
    routeQuotes: [],
    ...overrides,
  };
}
