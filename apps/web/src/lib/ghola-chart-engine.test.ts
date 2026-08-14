import { describe, expect, it } from "vitest";
import {
  defaultGholaChartViewport,
  GHOLA_CHART_WORKER_VISIBLE_TIMEOUT_MS,
  GholaChartEngineState,
  gholaChartCompareFramesCanPreserveVisibleData,
  gholaChartFrameCanPreserveVisibleData,
  gholaChartFrameCanUseScalarPatch,
  gholaChartFrameGeometryCanReuse,
  gholaChartCompareFramesCanUseScalarPatches,
  gholaChartFrameScalarPatch,
  gholaChartShouldAwaitWorkerVisibleData,
  gholaChartVisibleGeometryMatches,
  gholaChartWorkerResponseIsCurrent,
  gholaChartWorkerRequestIsPending,
  handleGholaChartWorkerRequest,
  panGholaViewport,
  zoomGholaViewport,
} from "./ghola-chart-engine";
import type { GholaChartCandle, GholaChartOverlay, GholaMarketFrame, GholaRouteQuotePoint } from "./ghola-market-chart";

describe("ghola chart engine", () => {
  it("returns decimated visible candles and includes explicitly range-bound overlays", () => {
    const engine = new GholaChartEngineState();
    const overlay: GholaChartOverlay = {
      id: "agent-entry",
      kind: "price_line",
      label: "entry",
      tone: "accent",
      price: 150,
      rangeBehavior: "include",
      interaction: { kind: "drag_price", ariaLabel: "Drag planned entry price" },
    };
    engine.ingestFrame(marketFrame("hyperliquid", candles(500)));
    engine.setOverlays([overlay]);

    const visible = engine.visibleData({ width: 360, height: 260, mode: "candles" });

    expect(visible.frame?.candles).toHaveLength(500);
    expect(visible.candles.length).toBeLessThanOrEqual(120);
    expect(visible.range.max).toBeGreaterThan(150);
    expect(visible.overlays[0]).toMatchObject({
      id: "agent-entry",
      price: 150,
      interaction: { kind: "drag_price", ariaLabel: "Drag planned entry price" },
    });
  });

  it("keeps overlays out of automatic price bounds unless explicitly included", () => {
    const engine = new GholaChartEngineState();
    engine.ingestFrame(marketFrame("hyperliquid", [
      candle(0, 98, 102, 96, 100),
      candle(1, 100, 106, 99, 104),
    ]));
    engine.setOverlays([{
      id: "terminal-alert:far",
      kind: "price_line",
      label: "↑ alert 1000.0",
      tone: "warn",
      price: 1_000,
    }]);

    const visible = engine.visibleData({ width: 500, height: 260, mode: "candles" });
    expect(visible.range.max).toBeLessThan(115);
    expect(visible.overlays[0]).toMatchObject({ price: 1_000 });
  });

  it("does not let non-plotted invalid reference prices collapse the visible series", () => {
    const engine = new GholaChartEngineState();
    engine.ingestFrame({
      ...marketFrame("hyperliquid", [
        candle(0, 98, 102, 96, 100),
        candle(1, 100, 106, 99, 104),
      ]),
      markPrice: "1",
      oraclePrice: "0",
    });

    const visible = engine.visibleData({ width: 500, height: 260, mode: "candles" });
    expect(visible.range.min).toBeGreaterThan(90);
    expect(visible.range.max).toBeLessThan(115);
    expect(visible.range.min).toBeLessThan(96);
    expect(visible.range.max).toBeGreaterThan(106);
  });

  it("reuses candle geometry while applying quote-only frame changes", () => {
    const engine = new GholaChartEngineState();
    const firstFrame = marketFrame("hyperliquid", candles(500));
    engine.ingestFrame(firstFrame);
    const first = engine.visibleData({ width: 360, height: 260, mode: "candles" });

    engine.ingestFrame({
      ...firstFrame,
      fetchedAt: "2026-06-03T12:00:01.000Z",
      mid: "120",
      bestBid: "119",
      bestAsk: "121",
    });
    const quoteOnly = engine.visibleData({ width: 360, height: 260, mode: "candles" });

    expect(quoteOnly.frame?.mid).toBe("120");
    expect(quoteOnly.candles).toBe(first.candles);
    expect(quoteOnly.lineCandles).toBe(first.lineCandles);
    expect(quoteOnly.range.max).toBeGreaterThan(120);
    expect(gholaChartVisibleGeometryMatches(first, quoteOnly)).toBe(false);

    engine.ingestFrame({ ...firstFrame, fetchedAt: "2026-06-03T12:00:02.000Z", trades: [{ side: "buy", px: "101", sz: "1", time: 10 }] });
    const tradeOnly = engine.visibleData({ width: 360, height: 260, mode: "candles" });
    expect(gholaChartVisibleGeometryMatches(first, tradeOnly)).toBe(true);

    engine.ingestFrame({ ...firstFrame, candles: [...firstFrame.candles, candle(501, 100, 103, 99, 102)] });
    const changed = engine.visibleData({ width: 360, height: 260, mode: "candles" });
    expect(changed.candles).not.toBe(first.candles);
    expect(gholaChartVisibleGeometryMatches(first, changed)).toBe(false);
  });

  it("sends scalar-only patches only when every collection and identity is unchanged", () => {
    const first = marketFrame("hyperliquid", candles(3));
    const quoteOnly = { ...first, fetchedAt: "2026-06-03T12:00:01.000Z", mid: "101" };
    const patch = gholaChartFrameScalarPatch(quoteOnly);

    expect(gholaChartFrameCanUseScalarPatch(first, quoteOnly)).toBe(true);
    expect(patch).toMatchObject({ venue: "hyperliquid", product: "BTC", mid: "101" });
    expect(patch).not.toHaveProperty("candles");
    expect(patch).not.toHaveProperty("bids");
    expect(patch).not.toHaveProperty("trades");
    expect(gholaChartFrameCanUseScalarPatch(first, { ...quoteOnly, candles: [...first.candles] })).toBe(false);
    expect(gholaChartFrameCanUseScalarPatch(first, { ...quoteOnly, network: "testnet" })).toBe(false);
  });

  it("reuses price geometry for book or trade updates and preserves only same-live identity", () => {
    const first = marketFrame("hyperliquid", candles(3));
    const tradeUpdate = { ...first, trades: [{ side: "buy" as const, px: "101", sz: "1", time: 10 }] };
    const bookUpdate = { ...first, bids: [{ px: "100", sz: "2", n: 1 }] };
    const candleUpdate = { ...first, candles: [...first.candles, candle(4, 100, 102, 99, 101)] };

    expect(gholaChartFrameGeometryCanReuse(first, tradeUpdate, "candles")).toBe(true);
    expect(gholaChartFrameGeometryCanReuse(first, bookUpdate, "candles")).toBe(true);
    expect(gholaChartFrameGeometryCanReuse(first, bookUpdate, "depth")).toBe(false);
    expect(gholaChartFrameGeometryCanReuse(first, candleUpdate, "candles")).toBe(false);
    expect(gholaChartFrameCanPreserveVisibleData(first, candleUpdate, false)).toBe(true);
    expect(gholaChartFrameCanPreserveVisibleData(first, candleUpdate, true)).toBe(false);
    expect(gholaChartFrameCanPreserveVisibleData(first, { ...first, product: "ETH" }, false)).toBe(false);
    expect(gholaChartCompareFramesCanPreserveVisibleData([first], [tradeUpdate], false)).toBe(true);
    expect(gholaChartCompareFramesCanPreserveVisibleData([first], [tradeUpdate], true)).toBe(false);
    expect(gholaChartCompareFramesCanPreserveVisibleData([first], [], false)).toBe(false);
  });

  it("applies worker scalar patches without replacing collection snapshots", () => {
    const engine = new GholaChartEngineState();
    const first = marketFrame("hyperliquid", candles(3));
    handleGholaChartWorkerRequest(engine, { type: "set-frame", frame: first });
    const before = engine.visibleData({ width: 420, height: 240 });
    const response = handleGholaChartWorkerRequest(engine, {
      type: "patch-frame-scalars",
      patch: gholaChartFrameScalarPatch({ ...first, mid: "101", bestBid: "100", bestAsk: "102" }),
    });
    const after = engine.visibleData({ width: 420, height: 240 });

    expect(response.type).toBe("ack");
    expect(after.frame).toMatchObject({ mid: "101", bestBid: "100", bestAsk: "102" });
    expect(after.candles).toBe(before.candles);
    expect(handleGholaChartWorkerRequest(engine, {
      type: "patch-frame-scalars",
      patch: { ...gholaChartFrameScalarPatch(first), network: "testnet" },
    })).toMatchObject({ type: "error", message: "ghola_chart_frame_patch_identity_mismatch" });
  });

  it("applies ordered compare scalar patches without cloning peer collections", () => {
    const first = marketFrame("hyperliquid", candles(3));
    const second = { ...marketFrame("coinbase", candles(3)), product: "BTC-USD" };
    const next = [
      { ...first, mid: "101" },
      { ...second, mid: "102" },
    ];
    expect(gholaChartCompareFramesCanUseScalarPatches([first, second], next)).toBe(true);
    expect(gholaChartCompareFramesCanUseScalarPatches([second, first], next)).toBe(false);

    const engine = new GholaChartEngineState();
    handleGholaChartWorkerRequest(engine, { type: "set-compare", frames: [first, second] });
    const before = engine.visibleData({ width: 420, height: 240, mode: "compare" });
    expect(handleGholaChartWorkerRequest(engine, {
      type: "patch-compare-scalars",
      patches: next.map(gholaChartFrameScalarPatch),
    }).type).toBe("ack");
    const after = engine.visibleData({ width: 420, height: 240, mode: "compare" });
    expect(after.compareFrames.map((frame) => frame.mid)).toEqual(["101", "102"]);
    expect(after.compareLineCandles[0]).toBe(before.compareLineCandles[0]);
    expect(handleGholaChartWorkerRequest(engine, {
      type: "patch-compare-scalars",
      patches: [gholaChartFrameScalarPatch(next[0])],
    })).toMatchObject({ type: "error", message: "ghola_chart_compare_patch_identity_mismatch" });
  });

  it("zooms and pans without relying on React state", () => {
    const zoomed = zoomGholaViewport(defaultGholaChartViewport(), 4, 200, 400);
    const panned = panGholaViewport(zoomed, 120, 400, 1_000);

    expect(zoomed.zoom).toBeGreaterThan(1);
    expect(zoomed.followLatest).toBe(false);
    expect(panned.offset).toBeGreaterThan(zoomed.offset);
    expect(panned.followLatest).toBe(false);
  });

  it("prepares cumulative depth snapshots", () => {
    const engine = new GholaChartEngineState();
    engine.ingestFrame({
      ...marketFrame("hyperliquid", []),
      bids: [{ px: "99", sz: "2", n: 1 }, { px: "98", sz: "3", n: 1 }],
      asks: [{ px: "101", sz: "1", n: 1 }, { px: "102", sz: "4", n: 1 }],
    });
    engine.setMode("depth");

    const visible = engine.visibleData({ width: 500, height: 260, mode: "depth" });

    expect(visible.bids.map((point) => point.cumulative)).toEqual([5, 2]);
    expect(visible.asks.map((point) => point.cumulative)).toEqual([1, 5]);
    expect(visible.range).toMatchObject({ min: expect.any(Number), max: expect.any(Number) });
  });

  it("handles the worker request path and preserves Jupiter route quote history", () => {
    const engine = new GholaChartEngineState();
    handleGholaChartWorkerRequest(engine, { type: "set-mode", mode: "route" });
    handleGholaChartWorkerRequest(engine, { type: "set-frame", frame: jupiterFrame(routeQuote(1, "74.10")) });
    handleGholaChartWorkerRequest(engine, { type: "set-frame", frame: jupiterFrame(routeQuote(2, "74.14")) });

    const response = handleGholaChartWorkerRequest(engine, { id: 7, type: "visible-data", width: 420, height: 240 });

    expect(response).toMatchObject({ id: 7, type: "visible-data" });
    if (response.type !== "visible-data") throw new Error("expected visible-data");
    expect(response.data.routeQuotes.map((quote) => quote.price)).toEqual(["74.10", "74.14"]);
  });

  it("rejects visible-data responses from an old request or input revision", () => {
    const engine = new GholaChartEngineState();
    engine.ingestFrame(marketFrame("hyperliquid", candles(3)));
    const stale = handleGholaChartWorkerRequest(engine, { id: 7, type: "visible-data", width: 420, height: 240 });
    const current = handleGholaChartWorkerRequest(engine, { id: 8, type: "visible-data", width: 420, height: 240 });
    const pending = { id: 8, inputRevision: 4 };

    expect(gholaChartWorkerResponseIsCurrent(stale, pending, 4)).toBe(false);
    expect(gholaChartWorkerResponseIsCurrent(current, pending, 5)).toBe(false);
    expect(gholaChartWorkerResponseIsCurrent(current, pending, 4)).toBe(true);
  });

  it("matches watchdog cleanup only to the exact pending request", () => {
    const pending = { id: 8, inputRevision: 4 };

    expect(GHOLA_CHART_WORKER_VISIBLE_TIMEOUT_MS).toBe(1_000);
    expect(gholaChartWorkerRequestIsPending(8, pending)).toBe(true);
    expect(gholaChartWorkerRequestIsPending(7, pending)).toBe(false);
    expect(gholaChartWorkerRequestIsPending(undefined, pending)).toBe(false);
    expect(gholaChartWorkerRequestIsPending(8, null)).toBe(false);
  });

  it("fails closed while a healthy worker has no accepted visible data", () => {
    expect(gholaChartShouldAwaitWorkerVisibleData(true, false)).toBe(true);
    expect(gholaChartShouldAwaitWorkerVisibleData(true, true)).toBe(false);
    expect(gholaChartShouldAwaitWorkerVisibleData(false, false)).toBe(false);
  });
});

function candles(count: number): GholaChartCandle[] {
  return Array.from({ length: count }, (_, index) => {
    const base = 100 + Math.sin(index / 12) * 4;
    return candle(index, base, base + 2, base - 2, base + Math.sin(index / 5));
  });
}

function candle(index: number, open: number, high: number, low: number, close: number): GholaChartCandle {
  const t = 1_780_000_000_000 + index * 300_000;
  return {
    t,
    T: t + 299_999,
    o: open.toFixed(2),
    h: high.toFixed(2),
    l: low.toFixed(2),
    c: close.toFixed(2),
    v: String(100 + index),
    n: 2,
  };
}

function marketFrame(venue: GholaMarketFrame["venue"], frameCandles: GholaChartCandle[]): GholaMarketFrame {
  const last = frameCandles.at(-1)?.c ?? "100";
  return {
    version: 1,
    venue,
    product: venue === "coinbase" ? "BTC-USD" : "BTC",
    interval: "5m",
    fetchedAt: "2026-06-03T12:00:00.000Z",
    stale: false,
    mid: last,
    bestBid: "99",
    bestAsk: "101",
    spreadBps: 1,
    markPrice: last,
    oraclePrice: last,
    fundingRate: "0.0001",
    openInterest: "1000",
    dayVolume: "1000000",
    candles: frameCandles,
    bids: [],
    asks: [],
    trades: [],
    routeQuotes: [],
  };
}

function jupiterFrame(quote: GholaRouteQuotePoint): GholaMarketFrame {
  return {
    ...marketFrame("jupiter", []),
    product: "SOL/USDC",
    interval: "quote",
    mid: quote.price,
    markPrice: quote.price,
    bestBid: null,
    bestAsk: null,
    spreadBps: null,
    fundingRate: null,
    openInterest: null,
    dayVolume: null,
    routeQuotes: [quote],
  };
}

function routeQuote(index: number, price: string): GholaRouteQuotePoint {
  return {
    t: 1_780_000_000_000 + index * 1_000,
    inputAmount: "1",
    outputAmount: "74",
    price,
    priceImpactPct: "0.02",
    slippageBps: 50,
    routeSummary: ["Meteora"],
  };
}
