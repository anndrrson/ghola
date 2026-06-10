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

  it("stops HTTP polling once a 5m websocket is healthy", async () => {
    vi.useFakeTimers();
    const getFallbackSnapshot = vi.fn(async () => ({ ...base("5m"), source: "http" as const, stale: false }));
    const stream = createCoinbaseLiveMarketStream({
      productId: "BTC-USD",
      interval: "5m",
      webSocketCtor: FakeWebSocket as unknown as CoinbaseWebSocketConstructor,
      getFallbackSnapshot,
      onStatus: () => {},
      onSnapshot: () => {},
      now: () => Date.now(),
    });

    stream.start();
    FakeWebSocket.instances[0]?.open();
    await Promise.resolve();
    await Promise.resolve();
    expect(getFallbackSnapshot).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4_000);
    expect(getFallbackSnapshot).toHaveBeenCalledTimes(1);

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
}
