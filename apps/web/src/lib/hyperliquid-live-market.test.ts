import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHyperliquidLiveMarketStream,
  emptyHyperliquidLiveMarketSnapshot,
  hyperliquidLiveMarketSubscriptions,
  hyperliquidLiveMarketWebSocketUrl,
  mergeHyperliquidLiveMarketMessage,
  type HyperliquidWebSocketConstructor,
} from "./hyperliquid-live-market";
import type { HyperliquidMarketSnapshot } from "./private-account-client";

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
      data: { mids: { BTC: "68100.5", ETH: "2010.2" } },
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
    expect(snapshot.recent_trades[0]?.px).toBe("100");
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
    expect(statuses).toContain("live");
    expect(first.sent.map((item) => JSON.parse(item))).toEqual(
      hyperliquidLiveMarketSubscriptions("BTC", "5m").map((subscription) => ({
        method: "subscribe",
        subscription,
      })),
    );

    first.message(JSON.stringify({ channel: "allMids", data: { mids: { BTC: "68001" } } }));
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
