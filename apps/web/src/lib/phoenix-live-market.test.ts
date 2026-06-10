import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPhoenixLiveMarketStream,
  mergePhoenixBook,
  mergePhoenixCandle,
  mergePhoenixMarket,
  mergePhoenixMarkPrice,
  mergePhoenixTrades,
  type PhoenixLiveMarketStatus,
} from "./phoenix-live-market";
import {
  emptyPhoenixMarketSnapshot,
  type PhoenixMarketSnapshot,
  type PhoenixRecentTrade,
} from "./phoenix-market-data";

const NOW = new Date("2026-05-29T00:00:01Z");

function base(): PhoenixMarketSnapshot {
  return emptyPhoenixMarketSnapshot({ symbol: "SOL", interval: "1m", now: new Date("2026-05-29T00:00:00Z") });
}

describe("Phoenix live market merge reducers", () => {
  it("merges an l2Book update into book + best bid/ask + spread", () => {
    const next = mergePhoenixBook(
      base(),
      { market: "SOL", ts: 111, slot: BigInt(7), bids: [[150.1, 4], [150.0, 2]], asks: [[150.2, 3], [150.3, 1]] },
      NOW,
    );
    expect(next.best_bid).toBe("150.1");
    expect(next.best_ask).toBe("150.2");
    expect(next.bids).toHaveLength(2);
    expect(next.spread_bps).toBeGreaterThan(0);
    expect(next.slot).toBe(7);
    expect(next.source).toBe("websocket");
    expect(next.stale).toBe(false);
    expect(next.book_updated_at).toBe(NOW.toISOString());
  });

  it("ignores an empty book update", () => {
    const start = base();
    expect(mergePhoenixBook(start, { bids: [], asks: [] }, NOW)).toBe(start);
  });

  it("merges a market update into mid/mark/funding/OI", () => {
    const next = mergePhoenixMarket(
      base(),
      { symbol: "SOL", midPx: 150.15, markPx: 150.16, oraclePx: 150.17, funding: -0.0001, openInterest: 1000, dayNtlVlm: 42, prevDayPx: 148 },
      NOW,
    );
    expect(next.mid).toBe("150.15");
    expect(next.mark_price).toBe("150.16");
    expect(next.oracle_price).toBe("150.17");
    expect(next.funding_rate).toBe("-0.0001");
    expect(next.open_interest).toBe("1000");
    expect(next.prev_day_price).toBe("148");
    expect(next.market_updated_at).toBe(NOW.toISOString());
  });

  it("uses markPx as mid when midPx absent", () => {
    const next = mergePhoenixMarket(base(), { symbol: "SOL", markPx: 151.5 }, NOW);
    expect(next.mid).toBe("151.5");
  });

  it("merges a markPrice update and backfills mid", () => {
    const next = mergePhoenixMarkPrice(base(), { symbol: "SOL", slot: BigInt(9), markPrice: 152.25 }, NOW);
    expect(next.mark_price).toBe("152.25");
    expect(next.mid).toBe("152.25");
    expect(next.slot).toBe(9);
    expect(next.market_updated_at).toBe(NOW.toISOString());
  });

  it("upserts candles by open time and keeps order", () => {
    let snap = mergePhoenixCandle(base(), { timeframe: "1m", candle: { time: 100, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, tradeCount: 3 } }, "1m", NOW);
    snap = mergePhoenixCandle(snap, { timeframe: "1m", candle: { time: 160, open: 1.5, high: 3, low: 1.4, close: 2.8, volume: 12, tradeCount: 4 } }, "1m", NOW);
    // Re-send time=100 updated -> upsert, not duplicate.
    snap = mergePhoenixCandle(snap, { timeframe: "1m", candle: { time: 100, open: 1, high: 2.2, low: 0.5, close: 1.9, volume: 11, tradeCount: 5 } }, "1m", NOW);
    expect(snap.candles).toHaveLength(2);
    expect(snap.candles[0].t).toBe(100);
    expect(snap.candles[0].c).toBe("1.9");
    expect(snap.candles[1].t).toBe(160);
    expect(snap.candles_updated_at).toBe(NOW.toISOString());
  });

  it("drops candle updates for a different timeframe", () => {
    const start = base();
    expect(mergePhoenixCandle(start, { timeframe: "5m", candle: { time: 1, open: 1, high: 1, low: 1, close: 1, volume: 0, tradeCount: 0 } }, "1m", NOW)).toBe(start);
  });

  it("dedupes and windows recent trades newest-first", () => {
    const trades: PhoenixRecentTrade[] = [
      { side: "buy", px: "150.1", sz: "1", time: 2000, slot: null },
      { side: "sell", px: "150.0", sz: "2", time: 1000, slot: null },
    ];
    let snap = mergePhoenixTrades(base(), trades, NOW);
    expect(snap.recent_trades).toHaveLength(2);
    expect(snap.recent_trades[0].time).toBe(2000);
    // Re-merge same trades -> no duplicates.
    snap = mergePhoenixTrades(snap, trades, NOW);
    expect(snap.recent_trades).toHaveLength(2);
    expect(snap.trades_updated_at).toBe(NOW.toISOString());
  });
});

// Long-lived async iterable: yields the given items then stays open until aborted.
async function* live<T>(items: T[], signal: AbortSignal): AsyncGenerator<T> {
  for (const item of items) yield item;
  await new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

async function* empty<T>(signal: AbortSignal): AsyncGenerator<T> {
  void signal;
  // yields nothing, returns immediately
}

function fakeClient() {
  return {
    exchange: { ready: async () => ({}) },
    api: { trades: () => ({ getMarketFills: async () => ({ data: [] }) }) },
    streams: {
      l2Book: (_sym: string, signal: AbortSignal) => live([{ market: "SOL", slot: BigInt(5), ts: 1, bids: [[150.1, 4]], asks: [[150.2, 3]] }], signal),
      market: (_sym: string, signal: AbortSignal) => live([{ symbol: "SOL", midPx: 150.15, markPx: 150.16 }], signal),
      markPrice: (_sym: string, signal: AbortSignal) => empty(signal),
      candles: (_sym: string, _tf: string, signal: AbortSignal) => empty(signal),
    },
    dispose() {},
  };
}

describe("Phoenix live market stream lifecycle", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("goes live and emits merged snapshots from injected streams", async () => {
    if (typeof WebSocket === "undefined") vi.stubGlobal("WebSocket", class {});
    const snapshots: PhoenixMarketSnapshot[] = [];
    const statuses: PhoenixLiveMarketStatus[] = [];
    const stream = createPhoenixLiveMarketStream({
      symbol: "SOL",
      interval: "1m",
      createClient: (() => fakeClient()) as never,
      getFallbackSnapshot: async () => emptyPhoenixMarketSnapshot({ symbol: "SOL", interval: "1m" }),
      onSnapshot: (s) => snapshots.push(s),
      onStatus: (s) => statuses.push(s),
    });

    stream.start();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // "connecting" is the initial state, so only the change to "live" is emitted.
    expect(statuses).toContain("live");
    const latest = snapshots[snapshots.length - 1];
    expect(latest.best_bid).toBe("150.1");
    expect(latest.mid).toBe("150.15");

    stream.stop();
  });
});
