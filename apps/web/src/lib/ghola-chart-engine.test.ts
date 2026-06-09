import { describe, expect, it } from "vitest";
import {
  defaultGholaChartViewport,
  GholaChartEngineState,
  handleGholaChartWorkerRequest,
  panGholaViewport,
  zoomGholaViewport,
} from "./ghola-chart-engine";
import type { GholaChartCandle, GholaChartOverlay, GholaMarketFrame, GholaRouteQuotePoint } from "./ghola-market-chart";

describe("ghola chart engine", () => {
  it("returns decimated visible candles and includes agent overlay prices in the range", () => {
    const engine = new GholaChartEngineState();
    const overlay: GholaChartOverlay = {
      id: "agent-entry",
      kind: "price_line",
      label: "entry",
      tone: "accent",
      price: 150,
    };
    engine.ingestFrame(marketFrame("hyperliquid", candles(500)));
    engine.setOverlays([overlay]);

    const visible = engine.visibleData({ width: 360, height: 260, mode: "candles" });

    expect(visible.frame?.candles).toHaveLength(500);
    expect(visible.candles.length).toBeLessThanOrEqual(120);
    expect(visible.range.max).toBeGreaterThan(150);
    expect(visible.overlays[0]).toMatchObject({ id: "agent-entry", price: 150 });
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
