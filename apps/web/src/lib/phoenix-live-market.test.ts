import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPhoenixLiveMarketStream,
  mergePhoenixFallbackFunding,
  mergePhoenixMarketStats,
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
import { marketComponentClocks } from "./market-component-clock";

const NOW = new Date("2026-05-29T00:00:01Z");

function base(): PhoenixMarketSnapshot {
  return emptyPhoenixMarketSnapshot({ symbol: "SOL", interval: "1m", now: new Date("2026-05-29T00:00:00Z") });
}

describe("Phoenix live market merge reducers", () => {
  it("merges an l2Book update into book + best bid/ask + spread", () => {
    const next = mergePhoenixBook(
      base(),
      { market: "SOL", ts: NOW.getTime(), slot: BigInt(7), bids: [[150.1, 4], [150.0, 2]], asks: [[150.2, 3], [150.3, 1]] },
      NOW,
    );
    expect(next.best_bid).toBe("150.1");
    expect(next.best_ask).toBe("150.2");
    expect(next.mid).toBe("150.15");
    expect(next.bids).toHaveLength(2);
    expect(next.spread_bps).toBeGreaterThan(0);
    expect(next.slot).toBe(7);
    expect(next.source).toBe("websocket");
    expect(next.stale).toBe(false);
    expect(next.book_updated_at).toBe(NOW.toISOString());
    expect(marketComponentClocks(next)).toMatchObject({
      book: NOW.getTime(),
      quote: NOW.getTime(),
    });
  });

  it("treats empty and one-sided full books as authoritative clears", () => {
    const initialTime = NOW.getTime() - 2_000;
    const start = mergePhoenixBook(
      base(),
      { ts: initialTime, bids: [[150.1, 4]], asks: [[150.2, 3]] },
      NOW,
    );
    const oneSidedTime = NOW.getTime() - 1_000;
    const oneSided = mergePhoenixBook(
      start,
      { ts: oneSidedTime, bids: [[151, 2]], asks: [] },
      NOW,
    );

    expect(oneSided.bids).toEqual([{ px: "151", sz: "2" }]);
    expect(oneSided.asks).toEqual([]);
    expect(oneSided.best_bid).toBe("151");
    expect(oneSided.best_ask).toBeNull();
    expect(oneSided.mid).toBeNull();
    expect(oneSided.spread_bps).toBeNull();
    expect(marketComponentClocks(oneSided)).toMatchObject({
      book: oneSidedTime,
      quote: oneSidedTime,
    });

    const empty = mergePhoenixBook(
      oneSided,
      { ts: NOW.getTime(), bids: [], asks: [] },
      NOW,
    );
    expect(empty.bids).toEqual([]);
    expect(empty.asks).toEqual([]);
    expect(empty.best_bid).toBeNull();
    expect(empty.best_ask).toBeNull();
    expect(empty.mid).toBeNull();
    expect(empty.spread_bps).toBeNull();
    expect(marketComponentClocks(empty)).toMatchObject({
      book: NOW.getTime(),
      quote: NOW.getTime(),
    });
  });

  it("rejects malformed, untimestamped, and older book updates without mutation", () => {
    const start = mergePhoenixBook(
      base(),
      { ts: NOW.getTime() - 1_000, bids: [[150.1, 4]], asks: [[150.2, 3]] },
      NOW,
    );
    const acceptedClock = marketComponentClocks(start).book;
    expect(mergePhoenixBook(start, { ts: NOW.getTime(), bids: {}, asks: [] }, NOW)).toBe(start);
    expect(mergePhoenixBook(start, { bids: [[151, 2]], asks: [[152, 2]] }, NOW)).toBe(start);
    expect(mergePhoenixBook(
      start,
      { ts: NOW.getTime() - 2_000, bids: [[151, 2]], asks: [[152, 2]] },
      NOW,
    )).toBe(start);
    expect(marketComponentClocks(start).book).toBe(acceptedClock);
    expect(start.best_bid).toBe("150.1");
    expect(start.best_ask).toBe("150.2");
  });

  it("merges market pricing but ignores its timestamp-less funding field", () => {
    const next = mergePhoenixMarket(
      base(),
      { symbol: "SOL", ts: NOW.getTime(), midPx: 150.15, markPx: 150.16, oraclePx: 150.17, funding: -0.0001, openInterest: 1000, dayNtlVlm: 42, prevDayPx: 148 },
      NOW,
    );
    expect(next.mid).toBe("150.15");
    expect(next.mark_price).toBe("150.16");
    expect(next.oracle_price).toBe("150.17");
    expect(next.funding_rate).toBeNull();
    expect(next.open_interest).toBe("1000");
    expect(next.prev_day_price).toBe("148");
    expect(next.market_updated_at).toBe(NOW.toISOString());
    expect(marketComponentClocks(next)).toMatchObject({
      market: NOW.getTime(),
      mark: NOW.getTime(),
    });
  });

  it("accepts timestamped market-stats funding as a decimal fraction", () => {
    const next = mergePhoenixMarketStats(base(), {
      symbol: "SOL",
      stats: { timestamp: BigInt(Math.floor(NOW.getTime() / 1_000)), currentFundingRate: -0.0001 },
    }, NOW);

    expect(next).toMatchObject({
      funding_rate: "-0.0001",
      funding_rate_unit: "decimal_fraction",
      funding_rate_source: "phoenix_ws_market_stats",
      funding_time_basis: "venue_event_time",
      funding_updated_at: NOW.toISOString(),
    });
  });

  it("does not refresh funding on market, book, or candle updates", () => {
    const funding = mergePhoenixMarketStats(base(), {
      symbol: "SOL",
      stats: { timestamp: BigInt(Math.floor(NOW.getTime() / 1_000)), currentFundingRate: -0.0001 },
    }, NOW);
    const updatedAt = funding.funding_updated_at;
    const market = mergePhoenixMarket(funding, {
      symbol: "SOL",
      ts: NOW.getTime() + 1_000,
      midPx: 151,
      funding: 0.7,
    }, new Date(NOW.getTime() + 1_000));
    const book = mergePhoenixBook(market, {
      ts: NOW.getTime() + 2_000,
      bids: [[150, 1]],
      asks: [[152, 1]],
    }, new Date(NOW.getTime() + 2_000));
    const candle = mergePhoenixCandle(book, {
      timeframe: "1m",
      candle: { time: NOW.getTime() + 3_000, open: 150, high: 152, low: 149, close: 151, volume: 1 },
    }, "1m", new Date(NOW.getTime() + 3_000));

    expect(candle).toMatchObject({ funding_rate: "-0.0001", funding_updated_at: updatedAt });
  });

  it("merges fallback funding provenance atomically by its own clock", () => {
    const preferred = mergePhoenixMarketStats(base(), {
      symbol: "SOL",
      stats: { timestamp: BigInt(Math.floor(NOW.getTime() / 1_000)), currentFundingRate: -0.0001 },
    }, NOW);
    const fallback = {
      ...base(),
      funding_rate: "0.0002",
      funding_rate_unit: "decimal_fraction" as const,
      funding_rate_source: "phoenix_rest_funding_history" as const,
      funding_time_basis: "venue_event_time" as const,
      funding_updated_at: new Date(NOW.getTime() - 1_000).toISOString(),
    };

    expect(mergePhoenixFallbackFunding(preferred, fallback)).toMatchObject({
      funding_rate: "-0.0001",
      funding_rate_source: "phoenix_ws_market_stats",
      funding_time_basis: "venue_event_time",
      funding_updated_at: NOW.toISOString(),
    });
  });

  it("uses markPx as mid when midPx absent", () => {
    const next = mergePhoenixMarket(
      base(),
      { symbol: "SOL", ts: NOW.getTime(), markPx: 151.5 },
      NOW,
    );
    expect(next.mid).toBe("151.5");
    expect(marketComponentClocks(next)).toEqual({ mark: NOW.getTime() });
  });

  it("does not let an older mark-only market event overwrite a newer mark-derived mid", () => {
    const newestMarkTime = NOW.getTime();
    const newest = mergePhoenixMarkPrice(
      base(),
      { ts: newestMarkTime, markPrice: 152 },
      NOW,
    );
    const older = mergePhoenixMarket(
      newest,
      { ts: newestMarkTime - 1_000, markPx: 151, oraclePx: 150.5 },
      NOW,
    );

    expect(older).toMatchObject({ mid: "152", mark_price: "152", oracle_price: "150.5" });
    expect(marketComponentClocks(older)).toEqual({ mark: newestMarkTime });
  });

  it("requires source timestamps and keeps market and mark ownership independent", () => {
    const start = base();
    expect(mergePhoenixMarket(start, { midPx: 151, markPx: 151.1 }, NOW)).toBe(start);
    expect(mergePhoenixMarkPrice(start, { markPrice: 151.2 }, NOW)).toBe(start);

    const firstTime = NOW.getTime() - 3_000;
    const first = mergePhoenixMarket(
      start,
      { ts: firstTime, midPx: 150, markPx: 150.1, oraclePx: 150.2 },
      NOW,
    );
    const newestMarkTime = NOW.getTime() - 1_000;
    const newestMark = mergePhoenixMarkPrice(
      first,
      { ts: newestMarkTime, markPrice: 152 },
      NOW,
    );
    const newerMarketTime = NOW.getTime() - 2_000;
    const newerMarket = mergePhoenixMarket(
      newestMark,
      { ts: newerMarketTime, midPx: 151, markPx: 151.1, oraclePx: 151.2 },
      NOW,
    );

    expect(newerMarket.mid).toBe("151");
    expect(newerMarket.oracle_price).toBe("151.2");
    expect(newerMarket.mark_price).toBe("152");
    expect(marketComponentClocks(newerMarket)).toMatchObject({
      market: newerMarketTime,
      mark: newestMarkTime,
    });
    expect(mergePhoenixMarket(
      newerMarket,
      { ts: firstTime, midPx: 99, markPx: 99 },
      NOW,
    )).toBe(newerMarket);
    expect(mergePhoenixMarkPrice(
      newerMarket,
      { ts: newerMarketTime, markPrice: 99 },
      NOW,
    )).toBe(newerMarket);
  });

  it("merges a markPrice update and backfills mid", () => {
    const next = mergePhoenixMarkPrice(base(), { symbol: "SOL", ts: NOW.getTime(), slot: BigInt(9), markPrice: 152.25 }, NOW);
    expect(next.mark_price).toBe("152.25");
    expect(next.mid).toBe("152.25");
    expect(next.slot).toBe(9);
    expect(next.market_updated_at).toBeNull();
    expect(marketComponentClocks(next)).toEqual({ mark: NOW.getTime() });
  });

  it("upserts candles by open time and keeps order", () => {
    const firstTime = NOW.getTime() - 60_000;
    const secondTime = NOW.getTime();
    let snap = mergePhoenixCandle(base(), { timeframe: "1m", candle: { time: firstTime, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, tradeCount: 3 } }, "1m", NOW);
    snap = mergePhoenixCandle(snap, { timeframe: "1m", candle: { time: secondTime, open: 1.5, high: 3, low: 1.4, close: 2.8, volume: 12, tradeCount: 4 } }, "1m", NOW);
    // Re-send the older bucket updated -> upsert, not duplicate.
    snap = mergePhoenixCandle(snap, { timeframe: "1m", candle: { time: firstTime, open: 1, high: 2.2, low: 0.5, close: 1.9, volume: 11, tradeCount: 5 } }, "1m", NOW);
    expect(snap.candles).toHaveLength(2);
    expect(snap.candles[0].t).toBe(firstTime);
    expect(snap.candles[0].c).toBe("1.9");
    expect(snap.candles[1].t).toBe(secondTime);
    expect(snap.candles_updated_at).toBe(NOW.toISOString());
  });

  it("drops candle updates for a different timeframe", () => {
    const start = base();
    expect(mergePhoenixCandle(start, { timeframe: "5m", candle: { time: 1, open: 1, high: 1, low: 1, close: 1, volume: 0, tradeCount: 0 } }, "1m", NOW)).toBe(start);
  });

  it("dedupes and windows recent trades newest-first", () => {
    const trades: PhoenixRecentTrade[] = [
      { side: "buy", px: "150.1", sz: "1", time: NOW.getTime(), slot: null },
      { side: "sell", px: "150.0", sz: "2", time: NOW.getTime() - 1_000, slot: null },
    ];
    let snap = mergePhoenixTrades(base(), trades, NOW);
    expect(snap.recent_trades).toHaveLength(2);
    expect(snap.recent_trades[0].time).toBe(NOW.getTime());
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

async function* delayedLive<T>(
  item: T,
  delayMs: number,
  signal: AbortSignal,
): AsyncGenerator<T> {
  await new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, delayMs);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
  if (signal.aborted) return;
  yield item;
  yield* live([], signal);
}

function fakeClient() {
  return {
    exchange: { ready: async () => ({}) },
    api: { trades: () => ({ getMarketFills: async () => ({ data: [] }) }) },
    streams: {
      l2Book: (_sym: string, signal: AbortSignal) => live([{ market: "SOL", slot: BigInt(5), ts: 1, bids: [[150.1, 4]], asks: [[150.2, 3]] }], signal),
      market: (_sym: string, signal: AbortSignal) => live([{ symbol: "SOL", ts: NOW.getTime(), midPx: 150.15, markPx: 150.16 }], signal),
      markPrice: (_sym: string, signal: AbortSignal) => empty(signal),
      candles: (_sym: string, _tf: string, signal: AbortSignal) => empty(signal),
    },
    dispose() {},
  };
}

describe("Phoenix live market stream lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
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

  it("preserves source age when the fallback fails", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", undefined);
    const snapshots: PhoenixMarketSnapshot[] = [];
    const original = { ...base(), stale: false };
    const stream = createPhoenixLiveMarketStream({
      symbol: "SOL",
      interval: "1m",
      initialSnapshot: original,
      getFallbackSnapshot: async () => { throw new Error("offline"); },
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      onStatus: () => {},
      now: () => Date.parse("2026-05-29T00:10:00Z"),
    });
    stream.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshots.at(-1)?.stale).toBe(true);
    expect(snapshots.at(-1)?.fetched_at).toBe(original.fetched_at);
    stream.stop();
  });

  it("does not mark an empty stream update live", async () => {
    if (typeof WebSocket === "undefined") vi.stubGlobal("WebSocket", class {});
    const statuses: PhoenixLiveMarketStatus[] = [];
    const stream = createPhoenixLiveMarketStream({
      symbol: "SOL",
      interval: "1m",
      createClient: (() => ({
        exchange: { ready: async () => ({}) },
        api: { trades: () => ({ getMarketFills: async () => ({ data: [] }) }) },
        streams: {
          l2Book: (_symbol: string, signal: AbortSignal) => live([{ bids: [], asks: [] }], signal),
          market: (_symbol: string, signal: AbortSignal) => live([{}], signal),
          markPrice: (_symbol: string, signal: AbortSignal) => live([{}], signal),
          candles: (_symbol: string, _interval: string, signal: AbortSignal) => live([{}], signal),
        },
        dispose() {},
      })) as never,
      onSnapshot: () => {},
      onStatus: (status) => statuses.push(status),
    });

    stream.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(statuses).not.toContain("live");
    stream.stop();
  });

  it("publishes candle updates without refreshing executable-book liveness", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    if (typeof WebSocket === "undefined") vi.stubGlobal("WebSocket", class {});
    const statuses: PhoenixLiveMarketStatus[] = [];
    const snapshots: PhoenixMarketSnapshot[] = [];
    const stream = createPhoenixLiveMarketStream({
      symbol: "SOL",
      interval: "1m",
      createClient: (() => ({
        exchange: { ready: async () => ({}) },
        api: { trades: () => ({ getMarketFills: async () => ({ data: [] }) }) },
        streams: {
          l2Book: (_symbol: string, signal: AbortSignal) => live([{
            ts: NOW.getTime(),
            bids: [[150.1, 4]],
            asks: [[150.2, 3]],
          }], signal),
          market: (_symbol: string, signal: AbortSignal) => empty(signal),
          markPrice: (_symbol: string, signal: AbortSignal) => empty(signal),
          candles: (_symbol: string, _interval: string, signal: AbortSignal) => delayedLive({
            timeframe: "1m",
            candle: {
              time: NOW.getTime() + 9_000,
              open: 150,
              high: 151,
              low: 149,
              close: 150.5,
              volume: 10,
              tradeCount: 2,
            },
          }, 9_000, signal),
        },
        dispose() {},
      })) as never,
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      onStatus: (status) => statuses.push(status),
      now: () => Date.now(),
    });

    stream.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses).toContain("live");
    await vi.advanceTimersByTimeAsync(9_000);
    expect(snapshots.at(-1)?.candles).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3_001);
    expect(statuses).toContain("stale");
    stream.stop();
  });

  it("retains the prior snapshot and keeps fallback polling when the consumer rejects live data", async () => {
    vi.useFakeTimers();
    if (typeof WebSocket === "undefined") vi.stubGlobal("WebSocket", class {});
    const statuses: PhoenixLiveMarketStatus[] = [];
    const emissions: Array<{
      snapshot: PhoenixMarketSnapshot;
      provenance?: "websocket" | "fallback";
    }> = [];
    let fallbackCalls = 0;
    const stream = createPhoenixLiveMarketStream({
      symbol: "SOL",
      interval: "1m",
      initialSnapshot: base(),
      createClient: (() => fakeClient()) as never,
      getFallbackSnapshot: async () => {
        fallbackCalls += 1;
        return { ...base(), source: "http", stale: false };
      },
      onSnapshot: (snapshot, provenance) => {
        emissions.push({ snapshot, provenance });
        return false;
      },
      onStatus: (status) => statuses.push(status),
      now: () => NOW.getTime(),
    });

    stream.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses).not.toContain("live");
    expect(emissions.some((emission) => emission.provenance === "websocket")).toBe(true);
    expect(emissions.some((emission) => emission.provenance === "fallback")).toBe(true);
    const marketEmission = emissions.find((emission) => emission.snapshot.mark_price === "150.16");
    expect(marketEmission?.snapshot.best_bid).toBeNull();

    const callsAfterInitialPoll = fallbackCalls;
    await vi.advanceTimersByTimeAsync(4_000);
    expect(fallbackCalls).toBeGreaterThan(callsAfterInitialPoll);
    stream.stop();
  });
});
