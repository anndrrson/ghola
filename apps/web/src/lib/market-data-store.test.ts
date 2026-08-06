import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyCoinbaseMarketSnapshot } from "./coinbase-market-data";

const mocks = vi.hoisted(() => ({
  coinbaseOptions: [] as Array<Record<string, unknown>>,
  starts: 0,
  stops: 0,
}));

vi.mock("./coinbase-live-market", () => ({
  createCoinbaseLiveMarketStream: (options: Record<string, unknown>) => {
    mocks.coinbaseOptions.push(options);
    return {
      start: () => { mocks.starts += 1; },
      stop: () => { mocks.stops += 1; },
    };
  },
}));
vi.mock("./hyperliquid-live-market", () => ({
  createHyperliquidLiveMarketStream: () => ({ start: () => {}, stop: () => {} }),
}));
vi.mock("./phoenix-live-market", () => ({
  createPhoenixLiveMarketStream: () => ({ start: () => {}, stop: () => {} }),
}));

import {
  acquireMarketData,
  applyMarketDataVisibility,
  getMarketDataRecord,
  marketDataKeyId,
  marketDataDiagnostics,
  resetMarketDataStoreForTests,
  subscribeMarketData,
} from "./market-data-store";

const key = { venue: "coinbase", productId: "SOL-USD", interval: "1m" } as const;

describe("bounded market data store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetMarketDataStoreForTests();
    mocks.coinbaseOptions.length = 0;
    mocks.starts = 0;
    mocks.stops = 0;
  });

  afterEach(() => {
    resetMarketDataStoreForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("shares one venue stream across duplicate consumers", () => {
    const releaseA = acquireMarketData(key);
    const releaseB = acquireMarketData(key);

    expect(mocks.starts).toBe(1);
    expect(marketDataDiagnostics()[0]).toMatchObject({ leases: 2, connected: true, demand: "foreground" });

    releaseA();
    expect(mocks.stops).toBe(0);
    releaseB();
    expect(marketDataDiagnostics()[0]).toMatchObject({ leases: 0, connected: true, demand: "warm" });
  });

  it("retains a warm stream for 30 seconds and then closes it", async () => {
    const release = acquireMarketData(key);
    release();

    await vi.advanceTimersByTimeAsync(29_999);
    expect(mocks.stops).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.stops).toBe(1);
    expect(marketDataDiagnostics()[0]).toMatchObject({ demand: "dormant", connected: false });
  });

  it("serves the cached snapshot instead of making HTTP fallback calls while warm", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const release = acquireMarketData(key);
    const options = mocks.coinbaseOptions[0] as {
      onSnapshot: (snapshot: ReturnType<typeof emptyCoinbaseMarketSnapshot>) => void;
      getFallbackSnapshot: () => Promise<ReturnType<typeof emptyCoinbaseMarketSnapshot>>;
    };
    const snapshot = {
      ...emptyCoinbaseMarketSnapshot({ productId: "SOL-USD", interval: "1m" }),
      stale: false,
      last_trade_price: "100",
      price: "100",
    };
    options.onSnapshot(snapshot);
    await vi.advanceTimersByTimeAsync(20);
    release();

    await expect(options.getFallbackSnapshot()).resolves.toBe(snapshot);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(getMarketDataRecord(key).snapshot).toBe(snapshot);
  });

  it("keeps at most one zero-lease stream warm", () => {
    const releaseSol = acquireMarketData(key);
    releaseSol();
    const btcKey = { venue: "coinbase", productId: "BTC-USD", interval: "1m" } as const;
    const releaseBtc = acquireMarketData(btcKey);
    releaseBtc();

    const diagnostics = marketDataDiagnostics();
    expect(diagnostics.filter((entry) => entry.demand === "warm")).toHaveLength(1);
    expect(mocks.stops).toBe(1);
  });

  it("coalesces burst updates into one notification per animation frame", async () => {
    const release = acquireMarketData(key);
    const listener = vi.fn();
    const unsubscribe = subscribeMarketData(key, listener);
    const options = mocks.coinbaseOptions[0] as {
      onSnapshot: (snapshot: ReturnType<typeof emptyCoinbaseMarketSnapshot>) => void;
    };
    const initial = emptyCoinbaseMarketSnapshot({ productId: "SOL-USD", interval: "1m" });

    options.onSnapshot({ ...initial, price: "100" });
    options.onSnapshot({ ...initial, price: "101" });
    options.onSnapshot({ ...initial, price: "102" });

    expect(listener).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getMarketDataRecord(key).snapshot).toMatchObject({ price: "102" });

    unsubscribe();
    release();
  });

  it("stops foreground streams after a long background period and restarts them on wake", async () => {
    const release = acquireMarketData(key);

    applyMarketDataVisibility(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.stops).toBe(1);

    applyMarketDataVisibility(false);
    expect(mocks.starts).toBe(2);

    release();
  });

  it("isolates Hyperliquid streams by network, market, and interval", () => {
    const mainnetBtc1m = marketDataKeyId({ venue: "hyperliquid", network: "mainnet", coin: "BTC", interval: "1m" });

    expect(marketDataKeyId({ venue: "hyperliquid", network: "testnet", coin: "BTC", interval: "1m" })).not.toBe(mainnetBtc1m);
    expect(marketDataKeyId({ venue: "hyperliquid", network: "mainnet", coin: "ETH", interval: "1m" })).not.toBe(mainnetBtc1m);
    expect(marketDataKeyId({ venue: "hyperliquid", network: "mainnet", coin: "BTC", interval: "5m" })).not.toBe(mainnetBtc1m);
  });
});
