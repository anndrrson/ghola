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
    expect(snapshot.candles.find((candle) => candle.t === 1780106400000)).toMatchObject({ t: 1780106400000, c: "68150" });
    expect(JSON.stringify(snapshot)).not.toContain("ignored-eth-trade");
  });

  it("does not combine a partial ticker side with an older order book", () => {
    const coherent = {
      ...base(),
      best_bid: "73.08",
      best_ask: "73.09",
      book_mid: "73.085",
      mid: "73.085",
      spread_bps: 1.37,
    };
    const next = mergeCoinbaseLiveMarketMessage(coherent, {
      channel: "ticker",
      timestamp: "2026-05-30T00:00:01Z",
      events: [{ tickers: [{ product_id: "BTC-USD", price: "73.08", best_bid: "73.05" }] }],
    }, "5m", NOW);

    expect(next).toMatchObject({
      best_bid: "73.08",
      best_ask: "73.09",
      book_mid: "73.085",
      spread_bps: 1.37,
    });
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

  it("preserves both sides when Coinbase sends split level2 snapshots", () => {
    let snapshot = base();
    snapshot = mergeCoinbaseLiveMarketMessage(snapshot, {
      channel: "level2",
      events: [{
        type: "snapshot",
        product_id: "BTC-USD",
        updates: [{ side: "bid", price_level: "68100", new_quantity: "0.2" }],
      }],
    }, "5m", NOW);
    snapshot = mergeCoinbaseLiveMarketMessage(snapshot, {
      channel: "level2",
      events: [{
        type: "snapshot",
        product_id: "BTC-USD",
        updates: [{ side: "ask", price_level: "68101", new_quantity: "0.3" }],
      }],
    }, "5m", NOW);

    expect(snapshot.best_bid).toBe("68100");
    expect(snapshot.best_ask).toBe("68101");
    expect(snapshot.bids).toHaveLength(1);
    expect(snapshot.asks).toHaveLength(1);
  });

  it("does not poll HTTP while a non-native interval socket is healthy", async () => {
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
    FakeWebSocket.instances[0]?.message({
      channel: "ticker",
      timestamp: new Date(Date.now()).toISOString(),
      events: [{ tickers: [{ product_id: "BTC-USD", price: "68100", best_bid: "68099", best_ask: "68101" }] }],
    });
    expect(FakeWebSocket.instances[0]?.sent.map((item) => JSON.parse(item))).toEqual(
      coinbaseLiveMarketSubscriptions("BTC-USD"),
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(getFallbackSnapshot).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4_000);
    await Promise.resolve();
    expect(getFallbackSnapshot).toHaveBeenCalledTimes(1);
    expect(snapshots.at(-1)?.candles).toHaveLength(1);

    stream.stop();
  });

  it("builds a one-minute candle from live trades after bootstrap", () => {
    const snapshot = mergeCoinbaseLiveMarketMessage(base("1m"), {
      channel: "market_trades",
      events: [{ trades: [
        { product_id: "BTC-USD", trade_id: "1", side: "BUY", price: "100", size: "2", time: "2026-05-30T00:00:03.000Z" },
        { product_id: "BTC-USD", trade_id: "2", side: "SELL", price: "102", size: "1", time: "2026-05-30T00:00:20.000Z" },
      ] }],
    }, "1m", NOW);

    expect(snapshot.candles).toEqual([{ t: 1780099200000, T: 1780099260000, o: "100", h: "102", l: "100", c: "102", v: "3", n: 2 }]);
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
    FakeWebSocket.instances[0]?.message({
      channel: "ticker",
      timestamp: new Date(Date.now()).toISOString(),
      events: [{ tickers: [{ product_id: "BTC-USD", price: "68100", best_bid: "68099", best_ask: "68101" }] }],
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(getFallbackSnapshot).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4_000);
    expect(getFallbackSnapshot).toHaveBeenCalledTimes(1);

    stream.stop();
  });

  it("does not treat a heartbeat as fresh market data", () => {
    const snapshot = { ...base(), stale: true, fetched_at: "2026-05-30T00:00:00.000Z" };
    const next = mergeCoinbaseLiveMarketMessage(snapshot, {
      channel: "heartbeats",
      timestamp: "2026-05-30T00:00:10.000Z",
      events: [{ current_time: "2026-05-30T00:00:10.000Z" }],
    }, "5m", new Date("2026-05-30T00:00:10.000Z"));

    expect(next.last_heartbeat_at).toBe(Date.parse("2026-05-30T00:00:10.000Z"));
    expect(next.fetched_at).toBe(snapshot.fetched_at);
    expect(next.stale).toBe(true);
    expect(next.source).toBe(snapshot.source);
  });

  it("keeps last trade and book midpoint as distinct values", () => {
    const withBook = mergeCoinbaseLiveMarketMessage(base(), {
      channel: "level2",
      timestamp: "2026-05-30T00:00:01.000Z",
      events: [{
        type: "snapshot",
        product_id: "BTC-USD",
        updates: [
          { side: "bid", price_level: "100", new_quantity: "1" },
          { side: "ask", price_level: "102", new_quantity: "1" },
        ],
      }],
    }, "5m", NOW);
    const next = mergeCoinbaseLiveMarketMessage(withBook, {
      channel: "ticker",
      timestamp: "2026-05-30T00:00:02.000Z",
      events: [{ tickers: [{ product_id: "BTC-USD", price: "100.5", best_bid: "100", best_ask: "102" }] }],
    }, "5m", NOW);

    expect(next.last_trade_price).toBe("100.5");
    expect(next.book_mid).toBe("101");
    expect(next.mid).toBe("101");
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

  message(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }
}
