import { afterEach, describe, expect, it, vi } from "vitest";
import {
  coinbaseLiveMarketSubscriptions,
  coinbaseLiveMarketWebSocketUrl,
  createCoinbaseLiveMarketStream,
  mergeCoinbaseFallbackSnapshot,
  mergeCoinbaseLiveMarketMessage,
  type CoinbaseWebSocketConstructor,
} from "./coinbase-live-market";
import {
  emptyCoinbaseMarketSnapshot,
  type CoinbaseMarketSnapshot,
} from "./coinbase-market-data";
import { marketComponentClocks } from "./market-component-clock";

const NOW = new Date("2026-05-30T00:00:01Z");

function base(interval: "1m" | "5m" = "5m"): CoinbaseMarketSnapshot {
  return emptyCoinbaseMarketSnapshot({
    productId: "BTC-USD",
    interval,
    now: new Date("2026-05-30T00:00:00Z"),
  });
}

describe("Coinbase live market stream", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    FakeWebSocket.instances = [];
  });

  it("merges public websocket messages into a stable chart snapshot", () => {
    let snapshot = base();

    snapshot = mergeCoinbaseLiveMarketMessage(snapshot, {
      channel: "ticker",
      timestamp: "2026-05-30T00:00:01Z",
      events: [{
        tickers: [{
          product_id: "BTC-USD",
          price: "68100.5",
          best_bid: "68100",
          best_ask: "68101",
          price_percent_chg_24_h: "1.25",
          volume_24_h: "12.5",
        }],
      }],
    }, "5m", NOW);

    snapshot = mergeCoinbaseLiveMarketMessage(snapshot, {
      channel: "level2",
      timestamp: "2026-05-30T00:00:02Z",
      events: [
        {
          type: "snapshot",
          product_id: "BTC-USD",
          updates: Array.from({ length: 22 }, (_, index) => ({
            side: index % 2 === 0 ? "bid" : "ask",
            price_level: String(index % 2 === 0 ? 68100 - index : 68101 + index),
            new_quantity: String(0.1 + index / 100),
          })),
        },
        {
          type: "snapshot",
          product_id: "ETH-USD",
          updates: [{ side: "bid", price_level: "2000", new_quantity: "9" }],
        },
      ],
    }, "5m", NOW);

    snapshot = mergeCoinbaseLiveMarketMessage(snapshot, {
      channel: "market_trades",
      timestamp: "2026-05-30T00:00:03Z",
      events: [{
        trades: [
          {
            product_id: "BTC-USD",
            trade_id: "btc-public-trade",
            side: "BUY",
            price: "68100.25",
            size: "0.01",
            time: "2026-05-30T00:00:03Z",
          },
          {
            product_id: "ETH-USD",
            trade_id: "ignored-eth-trade",
            side: "SELL",
            price: "2000",
            size: "1",
            time: "2026-05-30T00:00:03Z",
          },
        ],
      }],
    }, "5m", NOW);

    snapshot = mergeCoinbaseLiveMarketMessage(snapshot, {
      channel: "candles",
      timestamp: "2026-05-30T00:00:04Z",
      events: [{
        candles: [{
          product_id: "BTC-USD",
          start: "1780106400",
          low: "68000",
          high: "68200",
          open: "68100",
          close: "68150",
          volume: "3",
        }],
      }],
    }, "5m", NOW);

    expect(snapshot.price).toBe("68100.25");
    expect(snapshot.best_bid).toBe("68100");
    expect(snapshot.best_ask).toBe("68102");
    expect(snapshot.mid).toBe("68101");
    expect(snapshot.spread_bps).toBeGreaterThan(0);
    expect(snapshot.bids).toHaveLength(11);
    expect(snapshot.asks).toHaveLength(11);
    expect(snapshot.recent_trades).toEqual([
      { trade_id: "btc-public-trade", side: "buy", px: "68100.25", sz: "0.01", time: 1780099203000 },
    ]);
    expect(snapshot.candles[0]).toMatchObject({ t: 1780106400000, c: "68150" });
    expect(JSON.stringify(snapshot)).not.toContain("ignored-eth-trade");
  });

  it("keeps fallback candles while preserving fresher websocket book and trades", () => {
    const live = {
      ...base("1m"),
      source: "websocket" as const,
      stale: false,
      price: "68101",
      mid: "68100.5",
      best_bid: "68100",
      best_ask: "68101",
      bids: [{ px: "68100", sz: "0.2", n: null }],
      asks: [{ px: "68101", sz: "0.3", n: null }],
      recent_trades: [{ trade_id: "live", side: "buy" as const, px: "68101", sz: "0.01", time: 1780099203000 }],
    };
    const fallback = {
      ...base("1m"),
      source: "http" as const,
      stale: false,
      price: "68090",
      mid: "68090",
      candles: [
        { t: 1780106340000, T: null, o: "68080", h: "68100", l: "68070", c: "68090", v: "2", n: null },
      ],
    };

    const merged = mergeCoinbaseFallbackSnapshot(live, fallback);

    expect(merged.source).toBe("websocket");
    expect(merged.price).toBe("68101");
    expect(merged.best_bid).toBe("68100");
    expect(merged.candles).toEqual(fallback.candles);
    expect(merged.recent_trades[0]?.trade_id).toBe("live");
  });

  it("recovers frozen websocket depth from fallback without degrading a newer ticker quote", () => {
    let live = mergeCoinbaseLiveMarketMessage(base(), {
      channel: "level2",
      timestamp: "2026-05-30T00:00:01Z",
      events: [{
        type: "snapshot",
        product_id: "BTC-USD",
        updates: [
          { side: "bid", price_level: "68090", new_quantity: "1" },
          { side: "ask", price_level: "68110", new_quantity: "1" },
        ],
      }],
    }, "5m", NOW);
    live = mergeCoinbaseLiveMarketMessage(live, {
      channel: "ticker",
      timestamp: "2026-05-30T00:00:03Z",
      events: [{ tickers: [{
        product_id: "BTC-USD",
        price: "68101",
        best_bid: "68100",
        best_ask: "68102",
      }] }],
    }, "5m", NOW);
    const fallback = {
      ...base(),
      source: "http" as const,
      source_timestamp: Date.parse("2026-05-30T00:00:02Z"),
      stale: false,
      price: "68099",
      mid: "68099",
      best_bid: "68098",
      best_ask: "68100",
      bids: [{ px: "68098", sz: "2", n: null }],
      asks: [{ px: "68100", sz: "3", n: null }],
    };

    const merged = mergeCoinbaseFallbackSnapshot(live, fallback);

    expect(merged).toMatchObject({
      bids: fallback.bids,
      asks: fallback.asks,
      best_bid: "68100",
      best_ask: "68102",
      mid: "68101",
    });
    expect(marketComponentClocks(merged)).toMatchObject({
      book: Date.parse("2026-05-30T00:00:02Z"),
      quote: Date.parse("2026-05-30T00:00:03Z"),
    });
  });

  it("does not freshen executable quote age from a price-only ticker", () => {
    let snapshot = mergeCoinbaseLiveMarketMessage(base(), {
      channel: "level2",
      timestamp: "2026-05-30T00:00:01Z",
      events: [{
        type: "snapshot",
        product_id: "BTC-USD",
        updates: [
          { side: "bid", price_level: "68100", new_quantity: "1" },
          { side: "ask", price_level: "68101", new_quantity: "1" },
        ],
      }],
    }, "5m", NOW);
    snapshot = mergeCoinbaseLiveMarketMessage(snapshot, {
      channel: "ticker",
      timestamp: "2026-05-30T00:00:05Z",
      events: [{ tickers: [{ product_id: "BTC-USD", price: "69000" }] }],
    }, "5m", NOW);

    expect(snapshot.price).toBe("69000");
    expect(snapshot.mid).toBe("68100.5");
    expect(marketComponentClocks(snapshot)).toMatchObject({
      book: Date.parse("2026-05-30T00:00:01Z"),
      quote: Date.parse("2026-05-30T00:00:01Z"),
      market: Date.parse("2026-05-30T00:00:05Z"),
    });
  });

  it("rejects data-bearing ticker and level2 messages without authoritative timestamps", () => {
    const original = base();
    const ticker = mergeCoinbaseLiveMarketMessage(original, {
      channel: "ticker",
      events: [{ tickers: [{ product_id: "BTC-USD", price: "68100" }] }],
    }, "5m", NOW);
    const level2 = mergeCoinbaseLiveMarketMessage(original, {
      channel: "level2",
      events: [{
        type: "snapshot",
        product_id: "BTC-USD",
        updates: [{ side: "bid", price_level: "68100", new_quantity: "1" }],
      }],
    }, "5m", NOW);

    expect(ticker).toBe(original);
    expect(level2).toBe(original);
  });

  it("keeps newer book quotes while accepting an older ticker market price", () => {
    let snapshot = mergeCoinbaseLiveMarketMessage(base(), {
      channel: "level2",
      timestamp: "2026-05-30T00:00:05Z",
      events: [{
        type: "snapshot",
        product_id: "BTC-USD",
        updates: [
          { side: "bid", price_level: "68100", new_quantity: "1" },
          { side: "ask", price_level: "68102", new_quantity: "1" },
        ],
      }],
    }, "5m", NOW);
    snapshot = mergeCoinbaseLiveMarketMessage(snapshot, {
      channel: "ticker",
      timestamp: "2026-05-30T00:00:04Z",
      events: [{ tickers: [{
        product_id: "BTC-USD",
        price: "68090",
        best_bid: "68089",
        best_ask: "68091",
      }] }],
    }, "5m", NOW);

    expect(snapshot).toMatchObject({
      price: "68090",
      best_bid: "68100",
      best_ask: "68102",
      mid: "68101",
    });
    expect(marketComponentClocks(snapshot)).toMatchObject({
      market: Date.parse("2026-05-30T00:00:04Z"),
      book: Date.parse("2026-05-30T00:00:05Z"),
      quote: Date.parse("2026-05-30T00:00:05Z"),
    });
  });

  it("applies an L2 update that is new for depth without overwriting a newer ticker quote", () => {
    let snapshot = mergeCoinbaseLiveMarketMessage(base(), {
      channel: "level2",
      timestamp: "2026-05-30T00:00:01Z",
      events: [{
        type: "snapshot",
        product_id: "BTC-USD",
        updates: [
          { side: "bid", price_level: "68100", new_quantity: "1" },
          { side: "ask", price_level: "68102", new_quantity: "1" },
        ],
      }],
    }, "5m", NOW);
    snapshot = mergeCoinbaseLiveMarketMessage(snapshot, {
      channel: "ticker",
      timestamp: "2026-05-30T00:00:03Z",
      events: [{ tickers: [{
        product_id: "BTC-USD",
        price: "68101",
        best_bid: "68099",
        best_ask: "68103",
      }] }],
    }, "5m", NOW);
    snapshot = mergeCoinbaseLiveMarketMessage(snapshot, {
      channel: "level2",
      timestamp: "2026-05-30T00:00:02Z",
      events: [{
        type: "snapshot",
        product_id: "BTC-USD",
        updates: [
          { side: "bid", price_level: "68098", new_quantity: "2" },
          { side: "ask", price_level: "68104", new_quantity: "3" },
        ],
      }],
    }, "5m", NOW);

    expect(snapshot).toMatchObject({
      bids: [{ px: "68098", sz: "2", n: null }],
      asks: [{ px: "68104", sz: "3", n: null }],
      best_bid: "68099",
      best_ask: "68103",
      mid: "68101",
    });
    expect(marketComponentClocks(snapshot)).toMatchObject({
      book: Date.parse("2026-05-30T00:00:02Z"),
      quote: Date.parse("2026-05-30T00:00:03Z"),
    });
  });

  it("does not let an older trade overwrite a newer ticker-owned market", () => {
    let snapshot = mergeCoinbaseLiveMarketMessage(base(), {
      channel: "ticker",
      timestamp: "2026-05-30T00:00:05Z",
      events: [{ tickers: [{ product_id: "BTC-USD", price: "68100" }] }],
    }, "5m", NOW);
    snapshot = mergeCoinbaseLiveMarketMessage(snapshot, {
      channel: "market_trades",
      timestamp: "2026-05-30T00:00:04Z",
      events: [{ trades: [{
        product_id: "BTC-USD",
        trade_id: "older-trade",
        side: "BUY",
        price: "67000",
        size: "0.1",
        time: "2026-05-30T00:00:04Z",
      }] }],
    }, "5m", NOW);

    expect(snapshot.price).toBe("68100");
    expect(snapshot.recent_trades[0]?.trade_id).toBe("older-trade");
    expect(marketComponentClocks(snapshot)).toMatchObject({
      market: Date.parse("2026-05-30T00:00:05Z"),
      trades: Date.parse("2026-05-30T00:00:04Z"),
    });
  });

  it("treats empty and one-sided full book snapshots as authoritative", () => {
    let snapshot = mergeCoinbaseLiveMarketMessage(base(), {
      channel: "level2",
      timestamp: "2026-05-30T00:00:01Z",
      events: [{
        type: "snapshot",
        product_id: "BTC-USD",
        updates: [
          { side: "bid", price_level: "68100", new_quantity: "1" },
          { side: "ask", price_level: "68102", new_quantity: "1" },
        ],
      }],
    }, "5m", NOW);
    snapshot = mergeCoinbaseLiveMarketMessage(snapshot, {
      channel: "level2",
      timestamp: "2026-05-30T00:00:02Z",
      events: [{ type: "snapshot", product_id: "BTC-USD", updates: [] }],
    }, "5m", NOW);

    expect(snapshot).toMatchObject({
      bids: [], asks: [], best_bid: null, best_ask: null, mid: null, spread_bps: null,
    });
    expect(marketComponentClocks(snapshot)).toMatchObject({
      book: Date.parse("2026-05-30T00:00:02Z"),
      quote: Date.parse("2026-05-30T00:00:02Z"),
    });
    const withFallback = mergeCoinbaseFallbackSnapshot(snapshot, {
      ...base(),
      source: "http",
      stale: false,
      best_bid: "67000",
      best_ask: "67002",
      mid: "67001",
      bids: [{ px: "67000", sz: "1", n: null }],
      asks: [{ px: "67002", sz: "1", n: null }],
    });
    expect(withFallback).toMatchObject({
      bids: [], asks: [], best_bid: null, best_ask: null, mid: null, spread_bps: null,
    });

    snapshot = mergeCoinbaseLiveMarketMessage(snapshot, {
      channel: "level2",
      timestamp: "2026-05-30T00:00:03Z",
      events: [{
        type: "snapshot",
        product_id: "BTC-USD",
        updates: [{ side: "bid", price_level: "68099", new_quantity: "2" }],
      }],
    }, "5m", NOW);
    expect(snapshot).toMatchObject({
      bids: [{ px: "68099", sz: "2", n: null }],
      asks: [],
      best_bid: "68099",
      best_ask: null,
      mid: null,
      spread_bps: null,
    });
  });

  it("rejects level2 events whose updates payload is not an array", () => {
    const original = base();
    const next = mergeCoinbaseLiveMarketMessage(original, {
      channel: "level2",
      timestamp: "2026-05-30T00:00:01Z",
      events: [{ type: "snapshot", product_id: "BTC-USD", updates: {} }],
    }, "5m", NOW);

    expect(next).toBe(original);
  });

  it("continues polling HTTP candles for non-native websocket intervals", async () => {
    vi.useFakeTimers();
    const snapshots: CoinbaseMarketSnapshot[] = [];
    const getFallbackSnapshot = vi.fn(async () => ({
      ...base("1m"),
      source: "http" as const,
      stale: false,
      candles: [{ t: Date.now(), T: null, o: "1", h: "2", l: "1", c: "2", v: "1", n: null }],
    }));
    const stream = createCoinbaseLiveMarketStream({
      productId: "BTC-USD",
      interval: "1m",
      webSocketCtor: FakeWebSocket as unknown as CoinbaseWebSocketConstructor,
      getFallbackSnapshot,
      onStatus: () => {},
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      now: () => Date.now(),
    });

    stream.start();
    expect(FakeWebSocket.instances[0]?.url).toBe(coinbaseLiveMarketWebSocketUrl());
    FakeWebSocket.instances[0]?.open();
    expect(FakeWebSocket.instances[0]?.sent.map((item) => JSON.parse(item))).toEqual(
      coinbaseLiveMarketSubscriptions("BTC-USD"),
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(getFallbackSnapshot).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4_000);
    await Promise.resolve();
    expect(getFallbackSnapshot).toHaveBeenCalledTimes(2);
    expect(snapshots.at(-1)?.candles).toHaveLength(1);

    stream.stop();
  });

  it("stops HTTP polling only after both the ticker quote and L2 depth are healthy", async () => {
    vi.useFakeTimers();
    const statuses: string[] = [];
    const getFallbackSnapshot = vi.fn(async () => ({ ...base("5m"), source: "http" as const, stale: false }));
    const stream = createCoinbaseLiveMarketStream({
      productId: "BTC-USD",
      interval: "5m",
      webSocketCtor: FakeWebSocket as unknown as CoinbaseWebSocketConstructor,
      getFallbackSnapshot,
      onStatus: (status) => statuses.push(status),
      onSnapshot: () => {},
      now: () => Date.now(),
    });

    stream.start();
    const socket = FakeWebSocket.instances[0];
    socket?.open();
    socket?.message(JSON.stringify({ channel: "heartbeats", events: [{ heartbeat_counter: "1" }] }));
    expect(statuses).not.toContain("live");
    socket?.message(JSON.stringify({
      channel: "ticker",
      timestamp: "2026-05-30T00:00:01Z",
      events: [{
        tickers: [{ product_id: "BTC-USD", price: "68100", best_bid: "68099", best_ask: "68101" }],
      }],
    }));
    expect(statuses).toContain("live");
    await Promise.resolve();
    await Promise.resolve();
    expect(getFallbackSnapshot).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4_000);
    expect(getFallbackSnapshot).toHaveBeenCalledTimes(2);

    socket?.message(JSON.stringify({
      channel: "level2",
      timestamp: "2026-05-30T00:00:02Z",
      events: [{
        type: "snapshot",
        product_id: "BTC-USD",
        updates: [
          { side: "bid", price_level: "68098", new_quantity: "1" },
          { side: "ask", price_level: "68102", new_quantity: "1" },
        ],
      }],
    }));
    await vi.advanceTimersByTimeAsync(4_000);
    expect(getFallbackSnapshot).toHaveBeenCalledTimes(2);

    stream.stop();
  });

  it("keeps fallback active when tape moves but an executable quote is frozen", async () => {
    vi.useFakeTimers();
    const statuses: string[] = [];
    const getFallbackSnapshot = vi.fn(async () => ({
      ...base(),
      source: "http" as const,
      stale: false,
      price: "68100",
      mid: "68100",
      best_bid: "68099",
      best_ask: "68101",
      bids: [{ px: "68099", sz: "1", n: null }],
      asks: [{ px: "68101", sz: "1", n: null }],
    }));
    const stream = createCoinbaseLiveMarketStream({
      productId: "BTC-USD",
      interval: "5m",
      webSocketCtor: FakeWebSocket as unknown as CoinbaseWebSocketConstructor,
      getFallbackSnapshot,
      onStatus: (status) => statuses.push(status),
      onSnapshot: () => true,
      now: () => Date.parse("2026-05-30T00:00:10Z"),
    });

    stream.start();
    const socket = FakeWebSocket.instances[0];
    socket?.open();
    await Promise.resolve();
    await Promise.resolve();
    socket?.message(JSON.stringify({
      channel: "market_trades",
      timestamp: "2026-05-30T00:00:10Z",
      events: [{ trades: [{
        product_id: "BTC-USD",
        trade_id: "tape-only",
        side: "BUY",
        price: "68110",
        size: "0.1",
        time: "2026-05-30T00:00:10Z",
      }] }],
    }));

    expect(statuses).not.toContain("live");
    await vi.advanceTimersByTimeAsync(4_000);
    expect(getFallbackSnapshot).toHaveBeenCalledTimes(2);
    stream.stop();
  });

  it("commits live state only after acceptance and preserves fallback provenance", async () => {
    vi.useFakeTimers();
    const accepted: CoinbaseMarketSnapshot[] = [];
    const provenances: Array<string | undefined> = [];
    const statuses: string[] = [];
    const fallback = {
      ...base(),
      source: "http" as const,
      stale: false,
      price: "68000",
      best_bid: "67999",
      best_ask: "68001",
      mid: "68000",
      bids: [{ px: "67999", sz: "1", n: null }],
      asks: [{ px: "68001", sz: "1", n: null }],
    };
    const stream = createCoinbaseLiveMarketStream({
      productId: "BTC-USD",
      interval: "5m",
      webSocketCtor: FakeWebSocket as unknown as CoinbaseWebSocketConstructor,
      getFallbackSnapshot: async () => fallback,
      onStatus: (status) => statuses.push(status),
      onSnapshot: (snapshot, provenance) => {
        provenances.push(provenance);
        if (provenance === "websocket" && snapshot.best_bid === "67000") return false;
        accepted.push(snapshot);
        return true;
      },
      now: () => Date.parse("2026-05-30T00:00:10Z"),
    });

    stream.start();
    const socket = FakeWebSocket.instances[0];
    socket?.open();
    socket?.message(JSON.stringify({
      channel: "level2",
      timestamp: "2026-05-30T00:00:09Z",
      events: [{
        type: "snapshot",
        product_id: "BTC-USD",
        updates: [
          { side: "bid", price_level: "67000", new_quantity: "1" },
          { side: "ask", price_level: "67002", new_quantity: "1" },
        ],
      }],
    }));
    expect(statuses).not.toContain("live");
    await Promise.resolve();
    await Promise.resolve();
    expect(accepted.at(-1)?.best_bid).toBe("67999");

    socket?.message(JSON.stringify({
      channel: "ticker",
      timestamp: "2026-05-30T00:00:10Z",
      events: [{ tickers: [{
        product_id: "BTC-USD",
        price: "68010",
        best_bid: "68009",
        best_ask: "68011",
      }] }],
    }));
    expect(accepted.at(-1)).toMatchObject({ price: "68010", best_bid: "68009" });
    expect(statuses).toContain("live");
    expect(provenances).toEqual(["websocket", "fallback", "websocket"]);
    stream.stop();
  });

  it("keeps fallback polling when the consumer rejects a fallback snapshot", async () => {
    vi.useFakeTimers();
    const getFallbackSnapshot = vi.fn(async () => ({
      ...base(), source: "http" as const, stale: false,
    }));
    const stream = createCoinbaseLiveMarketStream({
      productId: "BTC-USD",
      interval: "5m",
      webSocketCtor: null,
      getFallbackSnapshot,
      onStatus: () => {},
      onSnapshot: () => false,
    });

    stream.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(getFallbackSnapshot).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(getFallbackSnapshot).toHaveBeenCalledTimes(2);
    stream.stop();
  });

  it("preserves source age when fallback polling fails", async () => {
    vi.useFakeTimers();
    const snapshots: CoinbaseMarketSnapshot[] = [];
    const original = { ...base("5m"), fetched_at: "2026-05-29T00:00:00.000Z", stale: false };
    const stream = createCoinbaseLiveMarketStream({
      productId: "BTC-USD",
      interval: "5m",
      initialSnapshot: original,
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
}
