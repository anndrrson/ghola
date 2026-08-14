import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoinbaseMarketSnapshot } from "./coinbase-market-data";
import type { HyperliquidMarketSnapshot } from "./hyperliquid-market-data";
import type { PhoenixMarketSnapshot } from "./phoenix-market-data";
import {
  advanceMarketComponent,
  attachMarketComponentClocks,
} from "./market-component-clock";
import {
  createUnifiedLiveMarket,
  inspectUnifiedMarketSnapshot,
  UNIFIED_MARKET_COLLECTION_LIMITS,
  unifiedMarketSnapshotUrl,
  type UnifiedLiveMarketState,
  type UnifiedMarketAdapterContext,
  type UnifiedMarketSelection,
} from "./unified-live-market";

const NOW = Date.parse("2026-08-12T14:00:00.000Z");

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("unified public live market", () => {
  it("builds only same-origin public snapshot GET URLs", () => {
    expect(unifiedMarketSnapshotUrl(selection("hyperliquid", "BTC"))).toBe(
      "/v1/private-account/hyperliquid/market-snapshot?coin=BTC&interval=5m&network=mainnet",
    );
    expect(unifiedMarketSnapshotUrl(selection("phoenix", "SOL"))).toBe(
      "/v1/private-account/phoenix/market-snapshot?symbol=SOL&interval=5m",
    );
    expect(unifiedMarketSnapshotUrl(selection("coinbase", "ETH"))).toBe(
      "/v1/private-account/coinbase/market-snapshot?product_id=ETH-USD&interval=5m",
    );
  });

  it.each([
    [selection("hyperliquid", "BTC"), hyperliquidSnapshot(NOW, "68000")],
    [selection("coinbase", "BTC"), coinbaseSnapshot(NOW, "68001")],
    [selection("phoenix", "SOL"), phoenixSnapshot(NOW, "150")],
  ] as const)("normalizes valid %s websocket updates as live", (selected, snapshot) => {
    vi.useFakeTimers();
    const states: UnifiedLiveMarketState[] = [];
    let context: UnifiedMarketAdapterContext | null = null;
    const controller = createUnifiedLiveMarket({
      ...selected,
      now: () => NOW,
      onState: (state) => states.push(state),
      createStream: (nextContext) => {
        context = nextContext;
        return { start() {}, stop() {} };
      },
    });

    controller.start();
    expect(context).not.toBeNull();
    const activeContext = context as unknown as UnifiedMarketAdapterContext;
    activeContext.onStatus("live");
    activeContext.onSnapshot(snapshot);

    expect(states.at(-1)).toMatchObject({
      status: "live",
      transport: "websocket",
      loading: false,
      stale: false,
      error: null,
    });
    expect(states.at(-1)?.frame?.venue).toBe(selected.venue);
    controller.stop();
  });

  it("retains unchanged collection references at the publication boundary", () => {
    vi.useFakeTimers();
    let context: UnifiedMarketAdapterContext | null = null;
    const controller = createUnifiedLiveMarket({
      ...selection("hyperliquid", "BTC"),
      now: () => NOW,
      onState: () => {},
      createStream: (nextContext) => {
        context = nextContext;
        return { start() {}, stop() {} };
      },
    });
    controller.start();
    const activeContext = context as unknown as UnifiedMarketAdapterContext;
    activeContext.onStatus("live");
    const first = hyperliquidSnapshotAtCollectionLimits(NOW - 1_000, "68000");
    expect(activeContext.onSnapshot(first)).toBe(true);
    const firstFrame = controller.getState().frame;
    expect(firstFrame).not.toBeNull();

    const quoteOnly = {
      ...first,
      fetched_at: new Date(NOW).toISOString(),
      source_timestamp: NOW,
      mid: "68001",
      best_bid: "68000",
      best_ask: "68002",
      mark_price: "68001",
      oracle_price: "68001",
    };
    expect(activeContext.onSnapshot(quoteOnly)).toBe(true);
    const nextFrame = controller.getState().frame;
    expect(nextFrame?.mid).toBe("68001");
    expect(nextFrame?.candles).toBe(firstFrame?.candles);
    expect(nextFrame?.bids).toBe(firstFrame?.bids);
    expect(nextFrame?.asks).toBe(firstFrame?.asks);
    expect(nextFrame?.trades).toBe(firstFrame?.trades);
    controller.stop();
  });

  it("canonicalizes displayed midpoint to BBO and withholds invalid reference prices", () => {
    const input = {
      ...hyperliquidSnapshot(NOW, "99999"),
      best_bid: "99",
      best_ask: "101",
      oracle_price: "0",
    };
    const inspected = inspectUnifiedMarketSnapshot(selection("hyperliquid", "BTC"), input, NOW);

    expect(inspected?.frame).toMatchObject({
      mid: "100",
      bestBid: "99",
      bestAsk: "101",
      spreadBps: 200,
      oraclePrice: null,
    });
  });

  it("promotes an accepted snapshot when the adapter confirms live afterward", () => {
    vi.useFakeTimers();
    const controller = createUnifiedLiveMarket({
      ...selection("hyperliquid", "BTC"),
      now: () => NOW,
      onState: () => {},
      createStream: (context) => ({
        start() {
          if (context.onSnapshot(hyperliquidSnapshot(NOW, "68000"), "websocket")) {
            context.onStatus("live");
          }
        },
        stop() {},
      }),
    });
    controller.start();
    expect(controller.getState()).toMatchObject({
      status: "live",
      transport: "websocket",
      stale: false,
    });
    controller.stop();
  });

  it("uses credential-free polling fallback and rejects an older response after a live update", async () => {
    vi.useFakeTimers();
    const states: UnifiedLiveMarketState[] = [];
    const older = hyperliquidSnapshot(NOW - 5_000, "67900");
    const newer = hyperliquidSnapshot(NOW, "68100");
    const deferred = promiseWithResolvers<unknown>();
    let context: UnifiedMarketAdapterContext | null = null;
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: () => deferred.promise,
      init,
    }));
    const fetchImpl = fetchSpy as unknown as typeof fetch;
    const controller = createUnifiedLiveMarket({
      ...selection("hyperliquid", "BTC"),
      fetchImpl,
      now: () => NOW,
      onState: (state) => states.push(state),
      createStream: (nextContext) => {
        context = nextContext;
        return {
          start() {
            void nextContext.getFallbackSnapshot().then(nextContext.onSnapshot).catch(() => undefined);
          },
          stop() {},
        };
      },
    });

    controller.start();
    await Promise.resolve();
    const activeContext = context as unknown as UnifiedMarketAdapterContext;
    activeContext.onStatus("live");
    activeContext.onSnapshot(newer);
    const liveSequence = controller.getState().sequence;
    deferred.resolve(older);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchSpy).toHaveBeenCalledWith(
      unifiedMarketSnapshotUrl(selection("hyperliquid", "BTC")),
      expect.objectContaining({
        method: "GET",
        cache: "no-store",
        credentials: "omit",
      }),
    );
    expect(fetchSpy.mock.calls[0]?.[1]).not.toHaveProperty("body");
    expect(controller.getState().frame?.mid).toBe("68100");
    expect(controller.getState().sequence).toBe(liveSequence);
    expect(controller.getState().telemetry.sequenceRegressionCount).toBe(1);
    controller.stop();
  });

  it("publishes bounded feed quality telemetry and classifies rejected updates", () => {
    vi.useFakeTimers();
    let now = NOW;
    let context: UnifiedMarketAdapterContext | null = null;
    const controller = createUnifiedLiveMarket({
      ...selection("hyperliquid", "BTC"),
      now: () => now,
      onState: () => {},
      createStream: (nextContext) => {
        context = nextContext;
        return { start() {}, stop() {} };
      },
    });
    controller.start();
    const activeContext = context as unknown as UnifiedMarketAdapterContext;
    activeContext.onStatus("reconnecting");
    activeContext.onStatus("fallback_polling");
    activeContext.onStatus("live");

    const first = hyperliquidSnapshot(now - 100, "68000");
    first.source_timestamp = now - 200;
    activeContext.onSnapshot(first);
    now += 500;
    const second = hyperliquidSnapshot(now - 100, "68010");
    second.source_timestamp = now - 200;
    activeContext.onSnapshot(second);

    const regressed = hyperliquidSnapshot(now, "67900");
    regressed.source_timestamp = NOW;
    activeContext.onSnapshot(regressed);
    activeContext.onSnapshot({
      ...hyperliquidSnapshot(now, "68020"),
      source_timestamp: now,
      candles: [
        candle(now - 25 * 60_000, "68000"),
        candle(now - 5 * 60_000, "68020"),
      ],
    });
    activeContext.onStatus("stale");

    expect(controller.getState().telemetry).toMatchObject({
      acceptedUpdateCount: 2,
      rejectedUpdateCount: 2,
      sourceAgeMs: 200,
      receiptLatencyMs: 200,
      updateRateHz: 2,
      reconnectCount: 1,
      fallbackCount: 1,
      staleCount: 1,
      timestampRegressionCount: 1,
      gapRejectCount: 1,
      rollingSampleCount: 2,
    });
    expect(controller.getState().telemetry.sampleCapacity).toBe(120);
    controller.stop();
  });

  it("keeps an old successful source explicitly stale without forging its timestamp", async () => {
    vi.useFakeTimers();
    const oldSource = hyperliquidSnapshot(NOW, "68000");
    oldSource.source_timestamp = NOW - 90_000;
    const fetchImpl = vi.fn(async () => Response.json(oldSource)) as unknown as typeof fetch;
    const controller = createUnifiedLiveMarket({
      ...selection("hyperliquid", "BTC"),
      fetchImpl,
      now: () => NOW,
      onState: () => {},
      createStream: (context) => ({
        start() {
          context.onStatus("fallback_polling");
          void context.getFallbackSnapshot().then(context.onSnapshot).catch(() => undefined);
        },
        stop() {},
      }),
    });

    controller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(controller.getState()).toMatchObject({
      status: "stale",
      stale: true,
      loading: false,
      error: "market_unavailable",
    });
    expect(controller.getState().frame?.fetchedAt).toBe(oldSource.fetched_at);
    expect(controller.getState().telemetry.sourceAgeMs).toBe(90_000);
    controller.stop();
  });

  it("accepts independent component clocks and rejects only older same-component updates", () => {
    vi.useFakeTimers();
    let context: UnifiedMarketAdapterContext | null = null;
    const controller = createUnifiedLiveMarket({
      ...selection("phoenix", "SOL"),
      now: () => NOW,
      onState: () => {},
      createStream: (nextContext) => {
        context = nextContext;
        return { start() {}, stop() {} };
      },
    });
    controller.start();
    const activeContext = context as unknown as UnifiedMarketAdapterContext;
    activeContext.onStatus("live");

    const book = attachMarketComponentClocks(phoenixSnapshot(NOW, "150"), { book: NOW });
    expect(activeContext.onSnapshot(book)).toBe(true);
    expect(controller.getState().frame?.componentTimestamps?.book).toBe(NOW);
    const afterBook = controller.getState().sequence;

    const independentTrade = attachMarketComponentClocks({
      ...phoenixSnapshot(NOW, "151"),
      recent_trades: [{ side: "buy" as const, px: "151", sz: "1", time: NOW - 1_000, slot: null }],
    }, { book: NOW, trades: NOW - 1_000 });
    expect(activeContext.onSnapshot(independentTrade)).toBe(true);
    expect(controller.getState().sequence).toBe(afterBook + 1);
    expect(controller.getState().telemetry.timestampRegressionCount).toBe(0);
    expect(controller.getState().frame?.componentTimestamps).toMatchObject({
      book: NOW,
      trades: NOW - 1_000,
    });

    const olderSameChannel = attachMarketComponentClocks({
      ...independentTrade,
      recent_trades: [{ side: "sell" as const, px: "149", sz: "1", time: NOW - 2_000, slot: null }],
    }, { book: NOW, trades: NOW - 2_000 });
    const beforeReject = controller.getState().sequence;
    expect(activeContext.onSnapshot(olderSameChannel)).toBe(false);
    expect(controller.getState().sequence).toBe(beforeReject);
    expect(controller.getState().telemetry.timestampRegressionCount).toBe(1);

    const equalSameChannel = attachMarketComponentClocks({
      ...independentTrade,
      recent_trades: [{ side: "sell" as const, px: "152", sz: "1", time: NOW - 1_000, slot: null }],
    }, { book: NOW, trades: NOW - 1_000 });
    expect(activeContext.onSnapshot(equalSameChannel)).toBe(true);
    expect(controller.getState().frame?.trades[0]?.px).toBe("152");
    controller.stop();
  });

  it("checks only the component a websocket message actually updated", () => {
    vi.useFakeTimers();
    let context: UnifiedMarketAdapterContext | null = null;
    const controller = createUnifiedLiveMarket({
      ...selection("phoenix", "SOL"),
      now: () => NOW,
      onState: () => {},
      createStream: (nextContext) => {
        context = nextContext;
        return { start() {}, stop() {} };
      },
    });
    controller.start();
    const activeContext = context as unknown as UnifiedMarketAdapterContext;
    const first = attachMarketComponentClocks(
      phoenixSnapshot(NOW, "150"),
      { book: NOW, quote: NOW, market: NOW - 2_000 },
      true,
    );
    expect(activeContext.onSnapshot(first, "websocket")).toBe(true);

    const olderCarriedBook = attachMarketComponentClocks(
      phoenixSnapshot(NOW, "151"),
      { book: NOW - 5_000, quote: NOW - 5_000, market: NOW - 2_000 },
      true,
    );
    const marketUpdate = advanceMarketComponent(
      olderCarriedBook,
      { ...olderCarriedBook },
      "market",
      NOW,
    );
    expect(activeContext.onSnapshot(marketUpdate, "websocket")).toBe(true);
    expect(controller.getState().frame?.mid).toBe("151");

    const oldBookUpdate = advanceMarketComponent(
      olderCarriedBook,
      { ...olderCarriedBook },
      "book",
      NOW - 5_000,
    );
    expect(activeContext.onSnapshot(oldBookUpdate, "websocket")).toBe(false);
    expect(controller.getState().frame?.mid).toBe("151");
    controller.stop();
  });

  it("does not reject a fresher fallback quote because its ancillary tape is older", () => {
    vi.useFakeTimers();
    let context: UnifiedMarketAdapterContext | null = null;
    const controller = createUnifiedLiveMarket({
      ...selection("phoenix", "SOL"),
      now: () => NOW,
      onState: () => {},
      createStream: (nextContext) => {
        context = nextContext;
        return { start() {}, stop() {} };
      },
    });
    controller.start();
    const activeContext = context as unknown as UnifiedMarketAdapterContext;
    const live = attachMarketComponentClocks({
      ...phoenixSnapshot(NOW - 1_000, "150"),
      recent_trades: [{ side: "buy" as const, px: "150", sz: "1", time: NOW, slot: null }],
    }, { book: NOW - 1_000, quote: NOW - 1_000, trades: NOW }, true);
    expect(activeContext.onSnapshot(live, "websocket")).toBe(true);

    const fallback = attachMarketComponentClocks({
      ...phoenixSnapshot(NOW, "151"),
      source: "rpc" as const,
      recent_trades: [{ side: "sell" as const, px: "149", sz: "1", time: NOW - 2_000, slot: null }],
    }, { book: NOW, quote: NOW, trades: NOW - 2_000 }, true);
    expect(activeContext.onSnapshot(fallback, "fallback")).toBe(true);
    expect(controller.getState()).toMatchObject({
      status: "fallback_polling",
      stale: false,
    });
    expect(controller.getState().frame?.mid).toBe("151");
    controller.stop();
  });

  it("keeps executable-book age authoritative when trades and receipt are fresh", () => {
    vi.useFakeTimers();
    let context: UnifiedMarketAdapterContext | null = null;
    const controller = createUnifiedLiveMarket({
      ...selection("phoenix", "SOL"),
      now: () => NOW,
      onState: () => {},
      createStream: (nextContext) => {
        context = nextContext;
        return { start() {}, stop() {} };
      },
    });
    controller.start();
    const activeContext = context as unknown as UnifiedMarketAdapterContext;
    activeContext.onStatus("live");
    const staleBook = phoenixSnapshot(NOW, "150");
    staleBook.source_timestamp = NOW;
    staleBook.book_updated_at = new Date(NOW - 90_000).toISOString();
    staleBook.market_updated_at = new Date(NOW - 90_000).toISOString();
    staleBook.trades_updated_at = new Date(NOW).toISOString();
    staleBook.recent_trades = [{ side: "buy", px: "150", sz: "1", time: NOW, slot: null }];

    expect(activeContext.onSnapshot(staleBook, "websocket")).toBe(false);
    expect(controller.getState()).toMatchObject({ status: "stale", stale: true });
    expect(controller.getState().telemetry).toMatchObject({
      sourceAgeMs: 90_000,
      componentAgesMs: { book: 90_000, trades: 0 },
    });
    controller.stop();
  });

  it("does not let fresh tape certify a stale displayed market price", () => {
    vi.useFakeTimers();
    let context: UnifiedMarketAdapterContext | null = null;
    const controller = createUnifiedLiveMarket({
      ...selection("coinbase", "BTC"),
      now: () => NOW,
      onState: () => {},
      createStream: (nextContext) => {
        context = nextContext;
        return { start() {}, stop() {} };
      },
    });
    controller.start();
    const activeContext = context as unknown as UnifiedMarketAdapterContext;
    const base = attachMarketComponentClocks({
      ...coinbaseSnapshot(NOW, "68000"),
      best_bid: null,
      best_ask: null,
      bids: [],
      asks: [],
    }, { market: NOW - 90_000 }, true);
    const tape = advanceMarketComponent(base, {
      ...base,
      recent_trades: [{
        trade_id: "1",
        side: "buy" as const,
        px: "68000",
        sz: "1",
        time: NOW,
      }],
    }, "trades", NOW);

    expect(activeContext.onSnapshot(tape, "websocket")).toBe(false);
    expect(controller.getState()).toMatchObject({ status: "stale", stale: true });
    expect(controller.getState().telemetry.componentAgesMs).toMatchObject({
      market: 90_000,
      trades: 0,
    });
    controller.stop();
  });

  it("does not let a fresh market price certify a stale one-sided quote", () => {
    vi.useFakeTimers();
    let context: UnifiedMarketAdapterContext | null = null;
    const controller = createUnifiedLiveMarket({
      ...selection("coinbase", "BTC"),
      now: () => NOW,
      onState: () => {},
      createStream: (nextContext) => {
        context = nextContext;
        return { start() {}, stop() {} };
      },
    });
    controller.start();
    const activeContext = context as unknown as UnifiedMarketAdapterContext;
    const oneSided = attachMarketComponentClocks({
      ...coinbaseSnapshot(NOW, "68000"),
      best_ask: null,
      asks: [],
    }, {
      book: NOW - 90_000,
      quote: NOW - 90_000,
      market: NOW,
    }, true);

    expect(activeContext.onSnapshot(oneSided, "websocket")).toBe(false);
    expect(controller.getState()).toMatchObject({ status: "stale", stale: true });
    expect(controller.getState().telemetry.sourceAgeMs).toBe(90_000);
    controller.stop();
  });

  it("keeps a fresh BBO live while clearing stale depth until the book recovers", () => {
    vi.useFakeTimers();
    let now = NOW;
    let context: UnifiedMarketAdapterContext | null = null;
    const controller = createUnifiedLiveMarket({
      ...selection("hyperliquid", "BTC"),
      now: () => now,
      onState: () => {},
      createStream: (nextContext) => {
        context = nextContext;
        return { start() {}, stop() {} };
      },
    });
    controller.start();
    const activeContext = context as unknown as UnifiedMarketAdapterContext;
    activeContext.onStatus("live");
    const initial = attachMarketComponentClocks({
      ...hyperliquidSnapshot(now, "68001"),
      bids: [{ px: "68000", sz: "1", n: null }],
      asks: [{ px: "68002", sz: "1", n: null }],
    }, { book: now - 29_000, quote: now }, true);

    expect(activeContext.onSnapshot(initial, "websocket")).toBe(true);
    expect(controller.getState()).toMatchObject({ status: "live", stale: false });
    expect(controller.getState().frame).toMatchObject({
      bestBid: "68000",
      bestAsk: "68002",
      bids: initial.bids,
      asks: initial.asks,
    });

    now += 2_000;
    vi.advanceTimersByTime(2_000);
    expect(controller.getState()).toMatchObject({ status: "live", stale: false });
    expect(controller.getState().frame).toMatchObject({
      bestBid: "68000",
      bestAsk: "68002",
      bids: [],
      asks: [],
    });

    const recovered = attachMarketComponentClocks({
      ...hyperliquidSnapshot(now, "68001"),
      bids: [{ px: "67999", sz: "2", n: null }],
      asks: [{ px: "68003", sz: "3", n: null }],
    }, { book: now, quote: NOW }, true);
    expect(activeContext.onSnapshot(recovered, "websocket")).toBe(true);
    expect(controller.getState().frame).toMatchObject({
      bestBid: "68000",
      bestAsk: "68002",
      bids: recovered.bids,
      asks: recovered.asks,
    });
    controller.stop();
  });

  it("uses explicit provenance for the first websocket update", () => {
    vi.useFakeTimers();
    const controller = createUnifiedLiveMarket({
      ...selection("hyperliquid", "BTC"),
      now: () => NOW,
      onState: () => {},
      createStream: (context) => ({
        start() {
          if (context.onSnapshot(hyperliquidSnapshot(NOW, "68000"), "websocket")) {
            context.onStatus("live");
          }
        },
        stop() {},
      }),
    });

    controller.start();
    expect(controller.getState()).toMatchObject({
      status: "live",
      transport: "websocket",
      stale: false,
    });
    expect(controller.getState().telemetry.fallbackCount).toBe(0);
    controller.stop();
  });

  it("advances source age on the existing freshness tick without changing market sequence", () => {
    vi.useFakeTimers();
    let now = NOW;
    let context: UnifiedMarketAdapterContext | null = null;
    const controller = createUnifiedLiveMarket({
      ...selection("hyperliquid", "BTC"),
      now: () => now,
      onState: () => {},
      createStream: (nextContext) => {
        context = nextContext;
        return { start() {}, stop() {} };
      },
    });
    controller.start();
    const activeContext = context as unknown as UnifiedMarketAdapterContext;
    activeContext.onStatus("live");
    activeContext.onSnapshot(hyperliquidSnapshot(NOW, "68000"));
    const sequence = controller.getState().sequence;

    now += 2_000;
    vi.advanceTimersByTime(2_000);
    expect(controller.getState().sequence).toBe(sequence);
    expect(controller.getState().telemetry.sourceAgeMs).toBe(2_000);
    controller.stop();
  });

  it("does not let malformed or crossed data replace the last valid sequence", () => {
    vi.useFakeTimers();
    let context: UnifiedMarketAdapterContext | null = null;
    const controller = createUnifiedLiveMarket({
      ...selection("hyperliquid", "BTC"),
      now: () => NOW,
      onState: () => {},
      createStream: (nextContext) => {
        context = nextContext;
        return { start() {}, stop() {} };
      },
    });
    controller.start();
    const activeContext = context as unknown as UnifiedMarketAdapterContext;
    activeContext.onStatus("live");
    activeContext.onSnapshot(hyperliquidSnapshot(NOW, "68000"));
    const sequence = controller.getState().sequence;

    activeContext.onSnapshot({
      ...hyperliquidSnapshot(NOW + 1_000, "68010"),
      best_bid: "68020",
      best_ask: "68010",
    });

    expect(controller.getState().sequence).toBe(sequence);
    expect(controller.getState().frame?.mid).toBe("68000");
    expect(controller.getState().status).toBe("live");
    controller.stop();
  });

  it("accepts collection limits and rejects every limit-plus-one snapshot before replacement", () => {
    vi.useFakeTimers();
    expect(UNIFIED_MARKET_COLLECTION_LIMITS).toEqual({
      candles: 240,
      bids: 20,
      asks: 20,
      recent_trades: 20,
    });
    let context: UnifiedMarketAdapterContext | null = null;
    const controller = createUnifiedLiveMarket({
      ...selection("hyperliquid", "BTC"),
      now: () => NOW,
      onState: () => {},
      createStream: (nextContext) => {
        context = nextContext;
        return { start() {}, stop() {} };
      },
    });
    controller.start();
    const activeContext = context as unknown as UnifiedMarketAdapterContext;
    activeContext.onStatus("live");

    const bounded = hyperliquidSnapshotAtCollectionLimits(NOW, "68000");
    expect(activeContext.onSnapshot(bounded)).toBe(true);
    expect(controller.getState().frame?.candles).toHaveLength(UNIFIED_MARKET_COLLECTION_LIMITS.candles);
    expect(controller.getState().frame?.bids).toHaveLength(UNIFIED_MARKET_COLLECTION_LIMITS.bids);
    expect(controller.getState().frame?.asks).toHaveLength(UNIFIED_MARKET_COLLECTION_LIMITS.asks);
    expect(controller.getState().frame?.trades).toHaveLength(UNIFIED_MARKET_COLLECTION_LIMITS.recent_trades);
    const acceptedSequence = controller.getState().sequence;

    const oversizedSnapshots: HyperliquidMarketSnapshot[] = [
      { ...bounded, candles: [...bounded.candles, candle(NOW, "68000")] },
      { ...bounded, bids: [...bounded.bids, { px: "67979", sz: "1", n: 1 }] },
      { ...bounded, asks: [...bounded.asks, { px: "68021", sz: "1", n: 1 }] },
      {
        ...bounded,
        recent_trades: [
          ...bounded.recent_trades,
          { side: "buy", px: "68000", sz: "1", time: NOW },
        ],
      },
    ];
    for (const oversized of oversizedSnapshots) {
      expect(activeContext.onSnapshot(oversized)).toBe(false);
      expect(controller.getState().sequence).toBe(acceptedSequence);
    }
    expect(controller.getState().frame?.mid).toBe("68000");
    expect(controller.getState().telemetry.rejectedUpdateCount).toBe(oversizedSnapshots.length);
    controller.stop();
  });

  it("marks a retained frame stale and tears down timers, fetch, and late callbacks", async () => {
    vi.useFakeTimers();
    let context: UnifiedMarketAdapterContext | null = null;
    let stopped = false;
    let fetchSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      fetchSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        fetchSignal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    }) as unknown as typeof fetch;
    const controller = createUnifiedLiveMarket({
      ...selection("hyperliquid", "BTC"),
      fetchImpl,
      now: () => NOW,
      onState: () => {},
      createStream: (nextContext) => {
        context = nextContext;
        return {
          start() {
            void nextContext.getFallbackSnapshot().catch(() => undefined);
          },
          stop() { stopped = true; },
        };
      },
    });
    controller.start();
    const activeContext = context as unknown as UnifiedMarketAdapterContext;
    activeContext.onStatus("live");
    activeContext.onSnapshot(hyperliquidSnapshot(NOW, "68000"));
    activeContext.onStatus("stale");
    const sequenceAtStop = controller.getState().sequence;
    expect(controller.getState().frame?.stale).toBe(true);
    expect(controller.getState().frame?.fetchedAt).toBe(new Date(NOW).toISOString());

    controller.stop();
    expect(stopped).toBe(true);
    expect(fetchSignal?.aborted).toBe(true);
    activeContext.onSnapshot(hyperliquidSnapshot(NOW + 1_000, "69000"));
    await vi.runAllTimersAsync();
    expect(controller.getState().sequence).toBe(sequenceAtStop);
    expect(controller.getState().frame?.mid).toBe("68000");
  });
});

function selection(venue: UnifiedMarketSelection["venue"], market: string): UnifiedMarketSelection {
  return { venue, market, interval: "5m", hyperliquidNetwork: "mainnet" };
}

function hyperliquidSnapshot(now: number, mid: string): HyperliquidMarketSnapshot {
  return {
    version: 1,
    platform: "hyperliquid",
    network: "mainnet",
    coin: "BTC",
    interval: "5m",
    fetched_at: new Date(now).toISOString(),
    source_timestamp: now,
    stale: false,
    mid,
    best_bid: String(Number(mid) - 1),
    best_ask: String(Number(mid) + 1),
    spread_bps: 0.3,
    mark_price: mid,
    oracle_price: mid,
    prev_day_price: null,
    day_notional_volume: null,
    day_base_volume: null,
    open_interest: null,
    funding_rate: null,
    funding_rate_unit: null,
    funding_rate_source: null,
    funding_time_basis: null,
    funding_updated_at: null,
    premium: null,
    max_leverage: null,
    candles: [],
    bids: [],
    asks: [],
    recent_trades: [],
  };
}

function hyperliquidSnapshotAtCollectionLimits(now: number, mid: string): HyperliquidMarketSnapshot {
  const numericMid = Number(mid);
  const intervalMs = 5 * 60_000;
  return {
    ...hyperliquidSnapshot(now, mid),
    candles: Array.from(
      { length: UNIFIED_MARKET_COLLECTION_LIMITS.candles },
      (_, index) => candle(
        now - (UNIFIED_MARKET_COLLECTION_LIMITS.candles - index) * intervalMs,
        mid,
      ),
    ),
    bids: Array.from(
      { length: UNIFIED_MARKET_COLLECTION_LIMITS.bids },
      (_, index) => ({ px: String(numericMid - index - 1), sz: "1", n: 1 }),
    ),
    asks: Array.from(
      { length: UNIFIED_MARKET_COLLECTION_LIMITS.asks },
      (_, index) => ({ px: String(numericMid + index + 1), sz: "1", n: 1 }),
    ),
    recent_trades: Array.from(
      { length: UNIFIED_MARKET_COLLECTION_LIMITS.recent_trades },
      (_, index) => ({
        side: index % 2 === 0 ? "buy" as const : "sell" as const,
        px: mid,
        sz: "1",
        time: now - index,
      }),
    ),
  };
}

function coinbaseSnapshot(now: number, mid: string): CoinbaseMarketSnapshot {
  return {
    version: 1,
    platform: "coinbase",
    product_id: "BTC-USD",
    base_currency_id: "BTC",
    quote_currency_id: "USD",
    interval: "5m",
    fetched_at: new Date(now).toISOString(),
    source: "websocket",
    source_timestamp: now,
    stale: false,
    price: mid,
    mid,
    best_bid: String(Number(mid) - 1),
    best_ask: String(Number(mid) + 1),
    spread_bps: 0.3,
    price_percentage_change_24h: null,
    volume_24h: null,
    approximate_quote_24h_volume: null,
    base_increment: null,
    quote_increment: null,
    quote_min_size: null,
    trading_disabled: false,
    product_type: null,
    candles: [],
    bids: [],
    asks: [],
    recent_trades: [],
  };
}

function phoenixSnapshot(now: number, mid: string): PhoenixMarketSnapshot {
  return {
    version: 1,
    platform: "phoenix",
    network: "mainnet",
    symbol: "SOL",
    interval: "5m",
    fetched_at: new Date(now).toISOString(),
    source: "websocket",
    source_timestamp: now,
    book_updated_at: new Date(now).toISOString(),
    market_updated_at: new Date(now).toISOString(),
    candles_updated_at: null,
    trades_updated_at: null,
    slot: null,
    stale: false,
    mid,
    mark_price: mid,
    oracle_price: mid,
    best_bid: String(Number(mid) - 0.1),
    best_ask: String(Number(mid) + 0.1),
    spread_bps: 1,
    prev_day_price: null,
    day_notional_volume: null,
    funding_rate: null,
    funding_rate_unit: null,
    funding_rate_source: null,
    funding_time_basis: null,
    funding_updated_at: null,
    open_interest: null,
    candles: [],
    bids: [],
    asks: [],
    recent_trades: [],
  };
}

function candle(t: number, close: string) {
  return {
    t,
    T: t + 299_999,
    o: close,
    h: close,
    l: close,
    c: close,
    v: "1",
    n: 1,
  };
}

function promiseWithResolvers<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
