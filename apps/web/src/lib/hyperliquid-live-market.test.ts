import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHyperliquidLiveMarketStream,
  emptyHyperliquidLiveMarketSnapshot,
  hyperliquidLiveMarketSubscriptions,
  hyperliquidLiveMarketWebSocketUrl,
  mergeHyperliquidFallbackSnapshot,
  mergeHyperliquidLiveMarketMessage,
  type HyperliquidWebSocketConstructor,
} from "./hyperliquid-live-market";
import type { HyperliquidMarketSnapshot } from "./private-account-client";
import { marketComponentClocks } from "./market-component-clock";

describe("Hyperliquid live market stream", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    FakeWebSocket.instances = [];
  });

  it("normalizes websocket updates without leaking trade identifiers", () => {
    let snapshot = emptyHyperliquidLiveMarketSnapshot({
      network: "mainnet",
      coin: "BTC",
      interval: "5m",
      now: new Date("2026-05-29T00:00:00Z"),
    });

    snapshot = mergeHyperliquidLiveMarketMessage(snapshot, {
      channel: "allMids",
      data: { time: 1_710_000_000_500, mids: { BTC: "68100.5", ETH: "2010.2" } },
    }, new Date("2026-05-29T00:00:01Z"));

    snapshot = mergeHyperliquidLiveMarketMessage(snapshot, {
      channel: "l2Book",
      data: {
        coin: "BTC",
        time: 1710000000000,
        levels: [
          Array.from({ length: 22 }, (_, index) => ({
            px: String(68099 - index),
            sz: String(0.1 + index),
            n: index + 1,
          })),
          Array.from({ length: 22 }, (_, index) => ({
            px: String(68101 + index),
            sz: String(0.2 + index),
            n: index + 2,
          })),
        ],
      },
    }, new Date("2026-05-29T00:00:02Z"));

    snapshot = mergeHyperliquidLiveMarketMessage(snapshot, {
      channel: "trades",
      data: [
        {
          coin: "BTC",
          side: "B",
          px: "68100",
          sz: "0.01",
          time: 1710000001000,
          hash: "0xdeadbeef",
          tid: 123,
          users: ["0xabc", "0xdef"],
        },
      ],
    }, new Date("2026-05-29T00:00:03Z"));

    snapshot = mergeHyperliquidLiveMarketMessage(snapshot, {
      channel: "activeAssetCtx",
      data: {
        coin: "BTC",
        time: 1_710_000_002_000,
        ctx: {
          markPx: 68101,
          oraclePx: "68102",
          prevDayPx: "67000",
          dayNtlVlm: "1000000",
          openInterest: "12.5",
          funding: "-0.00001",
          premium: "0.00002",
        },
      },
    }, new Date("2026-05-29T00:00:04Z"));

    snapshot = mergeHyperliquidLiveMarketMessage(snapshot, {
      channel: "candle",
      data: {
        s: "BTC",
        i: "5m",
        t: 1710000000000,
        T: 1710000299999,
        o: 68000,
        h: 68200,
        l: 67950,
        c: 68100,
        v: 12.5,
        n: 40,
      },
    }, new Date("2026-05-29T00:00:05Z"));

    expect(snapshot.mid).toBe("68100.5");
    expect(snapshot.bids).toHaveLength(20);
    expect(snapshot.asks).toHaveLength(20);
    expect(snapshot.best_bid).toBe("68099");
    expect(snapshot.best_ask).toBe("68101");
    expect(snapshot.spread_bps).toBeGreaterThan(0);
    expect(snapshot.recent_trades).toEqual([
      { side: "buy", px: "68100", sz: "0.01", time: 1710000001000 },
    ]);
    expect(snapshot.mark_price).toBe("68101");
    expect(snapshot.oracle_price).toBe("68102");
    expect(snapshot.funding_rate).toBe("-0.00001");
    expect(snapshot).toMatchObject({
      funding_rate_unit: "decimal_fraction",
      funding_rate_source: "hyperliquid_ws_active_asset_context_received",
      funding_time_basis: "received_at",
      funding_updated_at: "2026-05-29T00:00:04.000Z",
    });
    expect(snapshot.candles[0]).toMatchObject({
      t: 1710000000000,
      T: 1710000299999,
      c: "68100",
      n: 40,
    });
    expect(JSON.stringify(snapshot)).not.toContain("0xabc");
    expect(JSON.stringify(snapshot)).not.toContain("0xdeadbeef");
    expect(JSON.stringify(snapshot)).not.toContain("tid");
    expect(JSON.stringify(snapshot)).not.toContain("users");
  });

  it("uses receipt time for untimestamped active-asset funding and never refreshes it indirectly", () => {
    const receivedAt = new Date("2026-05-29T00:00:04.000Z");
    const funding = mergeHyperliquidLiveMarketMessage(
      emptyHyperliquidLiveMarketSnapshot({ network: "mainnet", coin: "BTC", interval: "5m" }),
      { channel: "activeAssetCtx", data: { coin: "BTC", ctx: { funding: "-0.0001" } } },
      receivedAt,
    );
    const book = mergeHyperliquidLiveMarketMessage(funding, {
      channel: "l2Book",
      data: { coin: "BTC", time: receivedAt.getTime() + 1_000, levels: [[{ px: "100", sz: "1" }], [{ px: "101", sz: "1" }]] },
    }, new Date(receivedAt.getTime() + 1_000));
    const candle = mergeHyperliquidLiveMarketMessage(book, {
      channel: "candle",
      data: { s: "BTC", i: "5m", t: receivedAt.getTime() + 2_000, o: 100, h: 102, l: 99, c: 101, v: 1 },
    }, new Date(receivedAt.getTime() + 2_000));

    expect(candle).toMatchObject({
      funding_rate: "-0.0001",
      funding_updated_at: receivedAt.toISOString(),
    });
  });

  it("keeps BBO quote-only and treats empty L2 sides as authoritative", () => {
    let snapshot = emptyHyperliquidLiveMarketSnapshot({
      network: "mainnet",
      coin: "BTC",
      interval: "5m",
    });
    snapshot = mergeHyperliquidLiveMarketMessage(snapshot, {
      channel: "l2Book",
      data: {
        coin: "BTC",
        time: 1_710_000_000_000,
        levels: [[{ px: "100", sz: "1", n: 1 }], [{ px: "101", sz: "1", n: 1 }]],
      },
    });
    const acceptedClock = marketComponentClocks(snapshot).book;
    const acceptedBids = snapshot.bids;
    const acceptedAsks = snapshot.asks;

    const validBbo = mergeHyperliquidLiveMarketMessage(snapshot, {
      channel: "bbo",
      data: {
        coin: "BTC",
        time: 1_710_000_000_500,
        bbo: [{ px: "98", sz: "1", n: 1 }, { px: "103", sz: "1", n: 1 }],
      },
    });

    const oneSidedBook = mergeHyperliquidLiveMarketMessage(validBbo, {
      channel: "l2Book",
      data: {
        coin: "BTC",
        time: 1_710_000_001_000,
        levels: [[{ px: "102", sz: "1", n: 1 }], []],
      },
    });
    const emptyBook = mergeHyperliquidLiveMarketMessage(oneSidedBook, {
      channel: "l2Book",
      data: {
        coin: "BTC",
        time: 1_710_000_001_500,
        levels: [[], []],
      },
    });
    const malformedBook = mergeHyperliquidLiveMarketMessage(oneSidedBook, {
      channel: "l2Book",
      data: {
        coin: "BTC",
        time: 1_710_000_002_000,
        levels: [[{ px: "102", sz: "1", n: 1 }], null],
      },
    });
    const malformedLevels = mergeHyperliquidLiveMarketMessage(oneSidedBook, {
      channel: "l2Book",
      data: {
        coin: "BTC",
        time: 1_710_000_002_000,
        levels: { bids: [], asks: [] },
      },
    });
    const malformedBbo = mergeHyperliquidLiveMarketMessage(oneSidedBook, {
      channel: "bbo",
      data: {
        coin: "BTC",
        time: 1_710_000_002_000,
        bbo: [{ px: "102", sz: "1", n: 1 }, null],
      },
    });

    expect(oneSidedBook).not.toBe(validBbo);
    expect(oneSidedBook.bids).toEqual([{ px: "102", sz: "1", n: 1 }]);
    expect(oneSidedBook.asks).toEqual([]);
    expect(oneSidedBook.best_bid).toBe("102");
    expect(oneSidedBook.best_ask).toBeNull();
    expect(oneSidedBook.mid).toBeNull();
    expect(oneSidedBook.spread_bps).toBeNull();
    expect(marketComponentClocks(oneSidedBook)).toMatchObject({
      book: 1_710_000_001_000,
      quote: 1_710_000_001_000,
      market: 1_710_000_001_000,
    });
    expect(emptyBook.bids).toEqual([]);
    expect(emptyBook.asks).toEqual([]);
    expect(emptyBook.best_bid).toBeNull();
    expect(emptyBook.best_ask).toBeNull();
    expect(emptyBook.mid).toBeNull();
    expect(emptyBook.spread_bps).toBeNull();
    expect(marketComponentClocks(emptyBook).book).toBe(1_710_000_001_500);
    expect(malformedBook).toBe(oneSidedBook);
    expect(malformedLevels).toBe(oneSidedBook);
    expect(malformedBbo).toBe(oneSidedBook);
    expect(marketComponentClocks(snapshot).book).toBe(acceptedClock);
    expect(validBbo.bids).toBe(acceptedBids);
    expect(validBbo.asks).toBe(acceptedAsks);
    expect(validBbo.best_bid).toBe("98");
    expect(validBbo.best_ask).toBe("103");
    expect(marketComponentClocks(validBbo)).toMatchObject({
      book: acceptedClock,
      quote: 1_710_000_000_500,
      market: acceptedClock,
    });
    expect(snapshot.best_bid).toBe("100");
    expect(snapshot.best_ask).toBe("101");
  });

  it("rejects data-bearing quote, book, and market updates without source time", () => {
    const snapshot = emptyHyperliquidLiveMarketSnapshot({
      network: "mainnet",
      coin: "BTC",
      interval: "5m",
      now: new Date("2026-05-29T00:00:00Z"),
    });

    const messages = [
      { channel: "allMids", data: { mids: { BTC: "101" } } },
      {
        channel: "bbo",
        data: { coin: "BTC", bbo: [{ px: "100", sz: "1" }, { px: "102", sz: "1" }] },
      },
      {
        channel: "l2Book",
        data: { coin: "BTC", levels: [[{ px: "100", sz: "1" }], [{ px: "102", sz: "1" }]] },
      },
      { channel: "activeAssetCtx", data: { coin: "BTC", ctx: { markPx: "101" } } },
    ];

    for (const message of messages) {
      expect(mergeHyperliquidLiveMarketMessage(snapshot, message)).toBe(snapshot);
    }
    expect(marketComponentClocks(snapshot)).toEqual({});
  });

  it("protects newer independent quote and market writers from older L2 snapshots", () => {
    let snapshot = emptyHyperliquidLiveMarketSnapshot({
      network: "mainnet",
      coin: "BTC",
      interval: "5m",
    });
    snapshot = mergeHyperliquidLiveMarketMessage(snapshot, {
      channel: "l2Book",
      data: {
        coin: "BTC",
        time: 1_710_000_001_000,
        levels: [[{ px: "100", sz: "1" }], [{ px: "102", sz: "1" }]],
      },
    });
    snapshot = mergeHyperliquidLiveMarketMessage(snapshot, {
      channel: "bbo",
      data: {
        coin: "BTC",
        time: 1_710_000_003_000,
        bbo: [{ px: "99", sz: "1" }, { px: "104", sz: "1" }],
      },
    });
    snapshot = mergeHyperliquidLiveMarketMessage(snapshot, {
      channel: "allMids",
      data: { time: 1_710_000_004_000, mids: { BTC: "201" } },
    });

    const next = mergeHyperliquidLiveMarketMessage(snapshot, {
      channel: "l2Book",
      data: {
        coin: "BTC",
        time: 1_710_000_002_000,
        levels: [[{ px: "98", sz: "2" }], [{ px: "105", sz: "3" }]],
      },
    });

    expect(next.bids[0]?.px).toBe("98");
    expect(next.asks[0]?.px).toBe("105");
    expect(next.best_bid).toBe("99");
    expect(next.best_ask).toBe("104");
    expect(next.mid).toBe("201");
    expect(marketComponentClocks(next)).toMatchObject({
      book: 1_710_000_002_000,
      quote: 1_710_000_003_000,
      market: 1_710_000_004_000,
    });

    const olderBbo = mergeHyperliquidLiveMarketMessage(next, {
      channel: "bbo",
      data: {
        coin: "BTC",
        time: 1_710_000_002_500,
        bbo: [{ px: "1", sz: "1" }, { px: "2", sz: "1" }],
      },
    });
    const olderMarket = mergeHyperliquidLiveMarketMessage(next, {
      channel: "activeAssetCtx",
      data: { coin: "BTC", time: 1_710_000_003_500, ctx: { midPx: "1", markPx: "1" } },
    });
    expect(olderBbo).toBe(next);
    expect(olderMarket).not.toBe(next);
    expect(olderMarket.mid).toBe("201");
    expect(olderMarket.mark_price).toBe("1");
    expect(marketComponentClocks(olderMarket)).toMatchObject({
      market: 1_710_000_004_000,
      mark: 1_710_000_003_500,
    });
  });

  it("recovers newer fallback depth without overwriting a newer websocket BBO", () => {
    let live = emptyHyperliquidLiveMarketSnapshot({
      network: "mainnet",
      coin: "BTC",
      interval: "5m",
    });
    live = mergeHyperliquidLiveMarketMessage(live, {
      channel: "l2Book",
      data: {
        coin: "BTC",
        time: 1_710_000_001_000,
        levels: [[{ px: "100", sz: "1" }], [{ px: "104", sz: "1" }]],
      },
    });
    live = mergeHyperliquidLiveMarketMessage(live, {
      channel: "bbo",
      data: {
        coin: "BTC",
        time: 1_710_000_003_000,
        bbo: [{ px: "101", sz: "1" }, { px: "103", sz: "1" }],
      },
    });
    const fallback = {
      ...emptyHyperliquidLiveMarketSnapshot({ network: "mainnet", coin: "BTC", interval: "5m" }),
      source_timestamp: 1_710_000_002_000,
      stale: false,
      mid: "102",
      best_bid: "100.5",
      best_ask: "103.5",
      bids: [{ px: "100.5", sz: "2", n: null }],
      asks: [{ px: "103.5", sz: "3", n: null }],
    } satisfies HyperliquidMarketSnapshot;

    const merged = mergeHyperliquidFallbackSnapshot(live, fallback);

    expect(merged).toMatchObject({
      bids: fallback.bids,
      asks: fallback.asks,
      best_bid: "101",
      best_ask: "103",
    });
    expect(marketComponentClocks(merged)).toMatchObject({
      book: 1_710_000_002_000,
      quote: 1_710_000_003_000,
    });
  });

  it("merges fallback funding provenance atomically by its own clock", () => {
    const receivedAt = new Date("2026-05-29T00:00:04.000Z");
    const preferred = mergeHyperliquidLiveMarketMessage(
      emptyHyperliquidLiveMarketSnapshot({ network: "mainnet", coin: "BTC", interval: "5m" }),
      { channel: "activeAssetCtx", data: { coin: "BTC", ctx: { funding: "-0.0001" } } },
      receivedAt,
    );
    const fallback = {
      ...emptyHyperliquidLiveMarketSnapshot({ network: "mainnet", coin: "BTC", interval: "5m" }),
      funding_rate: "0.0002",
      funding_rate_unit: "decimal_fraction" as const,
      funding_rate_source: "hyperliquid_rest_asset_context_received" as const,
      funding_time_basis: "received_at" as const,
      funding_updated_at: new Date(receivedAt.getTime() - 1_000).toISOString(),
    };

    expect(mergeHyperliquidFallbackSnapshot(preferred, fallback)).toMatchObject({
      funding_rate: "-0.0001",
      funding_rate_source: "hyperliquid_ws_active_asset_context_received",
      funding_time_basis: "received_at",
      funding_updated_at: receivedAt.toISOString(),
    });
  });

  it("keeps active-asset mid and mark clocks independent", () => {
    const start = emptyHyperliquidLiveMarketSnapshot({
      network: "mainnet",
      coin: "BTC",
      interval: "5m",
    });
    const first = mergeHyperliquidLiveMarketMessage(start, {
      channel: "activeAssetCtx",
      data: {
        coin: "BTC",
        time: 1_710_000_000_000,
        ctx: { midPx: "100", markPx: "100.5", oraclePx: "100.4" },
      },
    });
    const newestMark = mergeHyperliquidLiveMarketMessage(first, {
      channel: "activeAssetCtx",
      data: {
        coin: "BTC",
        time: 1_710_000_002_000,
        ctx: { markPx: "102" },
      },
    });
    const newerMarket = mergeHyperliquidLiveMarketMessage(newestMark, {
      channel: "activeAssetCtx",
      data: {
        coin: "BTC",
        time: 1_710_000_001_000,
        ctx: { midPx: "101", markPx: "101.5", oraclePx: "101.4" },
      },
    });

    expect(newerMarket).toMatchObject({
      mid: "101",
      mark_price: "102",
      oracle_price: "101.4",
    });
    expect(marketComponentClocks(newerMarket)).toMatchObject({
      market: 1_710_000_001_000,
      mark: 1_710_000_002_000,
    });
  });

  it("caps candle and trade windows while merging candle replacements", () => {
    let snapshot = emptyHyperliquidLiveMarketSnapshot({
      network: "mainnet",
      coin: "BTC",
      interval: "5m",
    });

    snapshot = mergeHyperliquidLiveMarketMessage(snapshot, {
      channel: "candle",
      data: Array.from({ length: 260 }, (_, index) => ({
        s: "BTC",
        i: "5m",
        t: 1710000000000 + index * 300_000,
        T: 1710000299999 + index * 300_000,
        o: String(100 + index),
        h: String(110 + index),
        l: String(90 + index),
        c: String(105 + index),
        v: "1",
        n: index,
      })),
    });

    expect(snapshot.candles).toHaveLength(240);
    expect(snapshot.candles[0]?.t).toBe(1710000000000 + 20 * 300_000);

    const replacementTime = snapshot.candles.at(-1)?.t ?? 0;
    snapshot = mergeHyperliquidLiveMarketMessage(snapshot, {
      channel: "candle",
      data: {
        s: "BTC",
        i: "5m",
        t: replacementTime,
        T: replacementTime + 299_999,
        o: "1",
        h: "2",
        l: "1",
        c: "2",
        v: "3",
        n: 4,
      },
    });

    expect(snapshot.candles).toHaveLength(240);
    expect(snapshot.candles.at(-1)?.c).toBe("2");

    snapshot = mergeHyperliquidLiveMarketMessage(snapshot, {
      channel: "trades",
      data: Array.from({ length: 25 }, (_, index) => ({
        coin: "BTC",
        side: index % 2 === 0 ? "B" : "A",
        px: String(100 + index),
        sz: "0.01",
        time: 1710000000000 + index,
      })),
    });

    expect(snapshot.recent_trades).toHaveLength(20);
    expect(snapshot.recent_trades[0]).toMatchObject({ px: "124", time: 1710000000024 });
    expect(snapshot.recent_trades.at(-1)).toMatchObject({ px: "105", time: 1710000000005 });
    expect(marketComponentClocks(snapshot).trades).toBe(snapshot.recent_trades[0]?.time);
  });

  it("derives trade and candle clocks only from accepted payload rows", () => {
    let snapshot = emptyHyperliquidLiveMarketSnapshot({
      network: "mainnet",
      coin: "BTC",
      interval: "5m",
    });
    snapshot = mergeHyperliquidLiveMarketMessage(snapshot, {
      channel: "trades",
      data: [
        { coin: "BTC", side: "B", px: "100", sz: "1", time: 1710000001000 },
        { coin: "BTC", side: "bad", px: "101", sz: "1", time: 1710000002000 },
      ],
    });
    expect(marketComponentClocks(snapshot).trades).toBe(1710000001000);
    expect(snapshot.recent_trades).toEqual([
      { side: "buy", px: "100", sz: "1", time: 1710000001000 },
    ]);

    snapshot = mergeHyperliquidLiveMarketMessage(snapshot, {
      channel: "candle",
      data: [
        { s: "BTC", i: "5m", t: 1710000000000, o: "100", h: "102", l: "99", c: "101", v: "1" },
        { s: "BTC", i: "5m", t: 1710000300000, o: "100", h: "bad", l: "99", c: "101", v: "1" },
      ],
    });
    expect(marketComponentClocks(snapshot).candles).toBe(1710000000000);
    expect(snapshot.candles).toHaveLength(1);
  });

  it("opens the public websocket, subscribes, heartbeats, falls back, and reconnects", async () => {
    vi.useFakeTimers();
    const statuses: string[] = [];
    const snapshots: HyperliquidMarketSnapshot[] = [];
    const fallbackSnapshot = emptyHyperliquidLiveMarketSnapshot({
      network: "mainnet",
      coin: "BTC",
      interval: "5m",
      now: new Date("2026-05-29T00:00:00Z"),
    });
    const getFallbackSnapshot = vi.fn(async () => ({ ...fallbackSnapshot, mid: "68000", stale: false }));

    const stream = createHyperliquidLiveMarketStream({
      network: "mainnet",
      coin: "BTC",
      interval: "5m",
      webSocketCtor: FakeWebSocket as unknown as HyperliquidWebSocketConstructor,
      getFallbackSnapshot,
      onStatus: (status) => statuses.push(status),
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      now: () => Date.now(),
    });

    stream.start();
    expect(FakeWebSocket.instances[0]?.url).toBe(hyperliquidLiveMarketWebSocketUrl("mainnet"));

    const first = FakeWebSocket.instances[0];
    first.open();
    expect(statuses).not.toContain("live");
    expect(first.sent.map((item) => JSON.parse(item))).toEqual(
      hyperliquidLiveMarketSubscriptions("BTC", "5m").map((subscription) => ({
        method: "subscribe",
        subscription,
      })),
    );

    first.message("not-json");
    expect(statuses).not.toContain("live");
    first.message(JSON.stringify({
      channel: "allMids",
      data: { time: Date.now(), mids: { BTC: "68001" } },
    }));
    expect(statuses).toContain("live");
    expect(snapshots.at(-1)?.mid).toBe("68001");

    await vi.advanceTimersByTimeAsync(30_000);
    expect(first.sent.map((item) => JSON.parse(item))).toContainEqual({ method: "ping" });

    first.closeFromServer();
    expect(statuses).toContain("reconnecting");
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    expect(getFallbackSnapshot).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    expect(FakeWebSocket.instances).toHaveLength(2);
    stream.stop();
  });

  it("marks a failed fallback stale without forging a fresh fetch timestamp", async () => {
    vi.useFakeTimers();
    const snapshots: HyperliquidMarketSnapshot[] = [];
    const original = emptyHyperliquidLiveMarketSnapshot({
      network: "mainnet", coin: "BTC", interval: "5m", now: new Date("2026-05-29T00:00:00Z"),
    });
    const stream = createHyperliquidLiveMarketStream({
      network: "mainnet",
      coin: "BTC",
      interval: "5m",
      initialSnapshot: { ...original, stale: false },
      webSocketCtor: null,
      getFallbackSnapshot: async () => { throw new Error("offline"); },
      onStatus: () => {},
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      now: () => Date.parse("2026-05-29T00:10:00Z"),
    });
    stream.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshots.at(-1)?.stale).toBe(true);
    expect(snapshots.at(-1)?.fetched_at).toBe(original.fetched_at);
    stream.stop();
  });

  it("stays on fallback until the consumer accepts a fresh websocket snapshot", async () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-05-29T00:00:10Z");
    const statuses: string[] = [];
    const commits: Array<{
      snapshot: HyperliquidMarketSnapshot;
      provenance?: "websocket" | "fallback";
    }> = [];
    let acceptWebsocket = false;
    let resolveFallback: ((snapshot: HyperliquidMarketSnapshot) => void) | undefined;
    const fallbackSnapshot = {
      ...emptyHyperliquidLiveMarketSnapshot({
        network: "mainnet",
        coin: "BTC",
        interval: "5m",
        now: new Date(now - 5_000),
      }),
      source_timestamp: now - 5_000,
      stale: false,
      mid: "66001",
      best_bid: "66000",
      best_ask: "66002",
      bids: [{ px: "66000", sz: "1", n: null }],
      asks: [{ px: "66002", sz: "1", n: null }],
    } satisfies HyperliquidMarketSnapshot;
    const stream = createHyperliquidLiveMarketStream({
      network: "mainnet",
      coin: "BTC",
      interval: "5m",
      webSocketCtor: FakeWebSocket as unknown as HyperliquidWebSocketConstructor,
      getFallbackSnapshot: () => new Promise((resolve) => { resolveFallback = resolve; }),
      onStatus: (status) => statuses.push(status),
      onSnapshot: (snapshot, provenance) => {
        if (provenance === "websocket" && !acceptWebsocket) return false;
        commits.push({ snapshot, provenance });
        return true;
      },
      now: () => now,
    });

    stream.start();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.message(JSON.stringify({
      channel: "l2Book",
      data: {
        coin: "BTC",
        time: now,
        levels: [[{ px: "67000", sz: "1" }], [{ px: "67002", sz: "1" }]],
      },
    }));
    expect(statuses).not.toContain("live");
    expect(commits).toEqual([]);

    resolveFallback?.(fallbackSnapshot);
    await Promise.resolve();
    await Promise.resolve();
    expect(commits.at(-1)?.provenance).toBe("fallback");

    acceptWebsocket = true;
    socket.message(JSON.stringify({
      channel: "bbo",
      data: {
        coin: "BTC",
        time: now + 1_000,
        bbo: [{ px: "68000", sz: "1" }, { px: "68002", sz: "1" }],
      },
    }));
    expect(statuses).toContain("live");
    expect(commits.at(-1)).toMatchObject({
      provenance: "websocket",
      snapshot: { mid: "66001", best_bid: "68000", best_ask: "68002" },
    });
    stream.stop();
  });

  it("publishes tape updates without using them as executable-price liveness", async () => {
    vi.useFakeTimers();
    let now = Date.parse("2026-05-29T00:00:00Z");
    const statuses: string[] = [];
    const snapshots: HyperliquidMarketSnapshot[] = [];
    const stream = createHyperliquidLiveMarketStream({
      network: "mainnet",
      coin: "BTC",
      interval: "5m",
      webSocketCtor: FakeWebSocket as unknown as HyperliquidWebSocketConstructor,
      onStatus: (status) => statuses.push(status),
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      now: () => now,
    });

    stream.start();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.message(JSON.stringify({
      channel: "bbo",
      data: {
        coin: "BTC",
        time: now,
        bbo: [{ px: "68000", sz: "1" }, { px: "68002", sz: "1" }],
      },
    }));
    expect(statuses.at(-1)).toBe("live");

    now += 9_000;
    await vi.advanceTimersByTimeAsync(9_000);
    socket.message(JSON.stringify({
      channel: "trades",
      data: [{ coin: "BTC", side: "B", px: "68001", sz: "0.1", time: now }],
    }));
    expect(snapshots.at(-1)?.recent_trades).toHaveLength(1);

    now += 3_000;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(statuses.at(-1)).toBe("stale");
    stream.stop();
  });

  it("keeps a fresh BBO live while frozen L2 depth independently restarts fallback", async () => {
    vi.useFakeTimers();
    let now = Date.parse("2026-05-29T00:00:00Z");
    const statuses: string[] = [];
    const fallback = {
      ...emptyHyperliquidLiveMarketSnapshot({ network: "mainnet", coin: "BTC", interval: "5m" }),
      fetched_at: new Date(now).toISOString(),
      source_timestamp: now,
      stale: false,
      mid: "68001",
      best_bid: "68000",
      best_ask: "68002",
      bids: [{ px: "68000", sz: "1", n: null }],
      asks: [{ px: "68002", sz: "1", n: null }],
    } satisfies HyperliquidMarketSnapshot;
    const getFallbackSnapshot = vi.fn(async () => fallback);
    const stream = createHyperliquidLiveMarketStream({
      network: "mainnet",
      coin: "BTC",
      interval: "5m",
      webSocketCtor: FakeWebSocket as unknown as HyperliquidWebSocketConstructor,
      getFallbackSnapshot,
      onStatus: (status) => statuses.push(status),
      onSnapshot: () => true,
      now: () => now,
    });

    stream.start();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.message(JSON.stringify({
      channel: "l2Book",
      data: {
        coin: "BTC",
        time: now,
        levels: [[{ px: "68000", sz: "1" }], [{ px: "68002", sz: "1" }]],
      },
    }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(getFallbackSnapshot).toHaveBeenCalledTimes(1);

    now += 12_000;
    socket.message(JSON.stringify({
      channel: "bbo",
      data: {
        coin: "BTC",
        time: now,
        bbo: [{ px: "68001", sz: "1" }, { px: "68003", sz: "1" }],
      },
    }));
    await vi.advanceTimersByTimeAsync(0);

    expect(statuses.at(-1)).toBe("live");
    expect(getFallbackSnapshot).toHaveBeenCalledTimes(2);
    stream.stop();
  });

  it("does not commit a consumer-rejected channel update into later snapshots", () => {
    const accepted: HyperliquidMarketSnapshot[] = [];
    const now = Date.parse("2026-05-29T00:00:10Z");
    const stream = createHyperliquidLiveMarketStream({
      network: "mainnet",
      coin: "BTC",
      interval: "5m",
      webSocketCtor: FakeWebSocket as unknown as HyperliquidWebSocketConstructor,
      onStatus: () => {},
      onSnapshot: (snapshot) => {
        if (snapshot.best_bid === "67000") return false;
        accepted.push(snapshot);
        return true;
      },
      now: () => now,
    });
    stream.start();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.message(JSON.stringify({
      channel: "l2Book",
      data: {
        coin: "BTC",
        time: now,
        levels: [[{ px: "68000", sz: "1" }], [{ px: "68002", sz: "1" }]],
      },
    }));
    socket.message(JSON.stringify({
      channel: "l2Book",
      data: {
        coin: "BTC",
        time: now + 1_000,
        levels: [[{ px: "67000", sz: "1" }], [{ px: "67002", sz: "1" }]],
      },
    }));
    socket.message(JSON.stringify({
      channel: "allMids",
      data: { time: now + 2_000, mids: { BTC: "68001" } },
    }));

    expect(accepted.at(-1)).toMatchObject({
      mid: "68001",
      best_bid: "68000",
      best_ask: "68002",
    });
    stream.stop();
  });
});

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  readyState = 0;
  sent: string[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
  }

  open() {
    this.readyState = 1;
    this.onopen?.({} as Event);
  }

  message(data: string) {
    this.onmessage?.({ data } as MessageEvent);
  }

  closeFromServer() {
    this.readyState = 3;
    this.onclose?.({} as CloseEvent);
  }
}
