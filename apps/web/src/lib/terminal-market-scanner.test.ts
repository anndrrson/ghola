import { afterEach, describe, expect, it, vi } from "vitest";
import type { HyperliquidMarketSnapshot } from "./hyperliquid-market-data";
import {
  createTerminalMarketScanner,
  inspectTerminalMarketScannerSnapshot,
  terminalMarketScannerUrl,
  type TerminalMarketScannerTarget,
} from "./terminal-market-scanner";

const NOW = Date.parse("2026-08-12T14:00:00.000Z");
const BTC: TerminalMarketScannerTarget = {
  venue: "hyperliquid",
  instrument: "BTC",
  interval: "5m",
  network: "mainnet",
};
const ETH: TerminalMarketScannerTarget = { ...BTC, instrument: "ETH" };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("terminal market scanner", () => {
  it("builds only supported same-origin snapshot URLs", () => {
    expect(terminalMarketScannerUrl(BTC)).toBe(
      "/v1/private-account/hyperliquid/market-snapshot?coin=BTC&interval=5m&network=mainnet",
    );
    expect(terminalMarketScannerUrl({
      venue: "coinbase",
      instrument: "ETH",
      interval: "1h",
      network: "mainnet",
    })).toBe("/v1/private-account/coinbase/market-snapshot?product_id=ETH-USD&interval=1h");
    expect(() => terminalMarketScannerUrl({
      venue: "phoenix",
      instrument: "BTC",
      interval: "5m",
      network: "mainnet",
    })).toThrow();
  });

  it("reuses exact unified identity, shape and component-clock validation", () => {
    const source = inspectTerminalMarketScannerSnapshot(BTC, snapshot("BTC"), NOW);
    expect(source).toMatchObject({
      status: "fallback_polling",
      stale: false,
      provenance: "public_live",
      healthGrade: null,
      transport: "polling",
      telemetryCapturedAtMs: NOW,
      componentAgesMs: { quote: 0, book: 0 },
      frame: { venue: "hyperliquid", network: "mainnet", product: "BTC" },
    });

    expect(inspectTerminalMarketScannerSnapshot(BTC, snapshot("ETH"), NOW)).toBeNull();
    expect(inspectTerminalMarketScannerSnapshot(BTC, {
      ...snapshot("BTC"),
      best_bid: "101",
      best_ask: "100",
    }, NOW)).toBeNull();
  });

  it("rotates sequentially with at most one request in flight", async () => {
    vi.useFakeTimers();
    const first = deferred<Response>();
    const fetchSpy = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return first.promise;
    });
    const fetchImpl = fetchSpy as unknown as typeof fetch;
    const onSource = vi.fn();
    const scanner = createTerminalMarketScanner({
      targets: [BTC, ETH],
      fetchImpl,
      onSource,
      now: () => NOW,
      isDocumentHidden: () => false,
      cadenceMs: 1_000,
      fetchTimeoutMs: 15_000,
    });

    scanner.start();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    first.resolve(response(snapshot("BTC")));
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(String(fetchSpy.mock.calls[1]?.[0])).toContain("coin=ETH");
    expect(onSource).toHaveBeenCalledTimes(1);
    scanner.stop();
  });

  it("pauses while hidden and aborts an active request on stop", async () => {
    vi.useFakeTimers();
    let hidden = true;
    let signal: AbortSignal | undefined;
    const fetchSpy = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    });
    const fetchImpl = fetchSpy as unknown as typeof fetch;
    const scanner = createTerminalMarketScanner({
      targets: [BTC],
      fetchImpl,
      onSource: () => undefined,
      isDocumentHidden: () => hidden,
      cadenceMs: 1_000,
    });

    scanner.start();
    expect(fetchSpy).not.toHaveBeenCalled();
    hidden = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    scanner.stop();
    expect(signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

function snapshot(coin: "BTC" | "ETH"): HyperliquidMarketSnapshot {
  const mid = coin === "BTC" ? 68_000 : 3_800;
  return {
    version: 1,
    platform: "hyperliquid",
    network: "mainnet",
    coin,
    interval: "5m",
    fetched_at: new Date(NOW).toISOString(),
    source_timestamp: NOW,
    stale: false,
    mid: String(mid),
    best_bid: String(mid - 1),
    best_ask: String(mid + 1),
    spread_bps: 0.3,
    mark_price: String(mid),
    oracle_price: String(mid),
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
    bids: [{ px: String(mid - 1), sz: "2", n: 1 }],
    asks: [{ px: String(mid + 1), sz: "2", n: 1 }],
    recent_trades: [],
  };
}

function response(value: unknown): Response {
  return { ok: true, json: async () => value } as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}
