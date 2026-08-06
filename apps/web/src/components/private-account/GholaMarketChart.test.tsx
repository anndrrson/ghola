import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GholaMarketChart } from "./GholaMarketChart";
import type { GholaMarketFrame } from "@/lib/ghola-market-chart";

describe("Ghola market chart rendering", () => {
  let container: HTMLDivElement;
  let root: Root;
  const fillRect = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal("Worker", class WorkerUnavailable {
      constructor() {
        throw new Error("worker unavailable");
      }
    });
    vi.stubGlobal("ResizeObserver", class ResizeObserverMock {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element) {
        this.callback([{ target, isIntersecting: true } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      disconnect() {}
      unobserve() {}
    });
    vi.stubGlobal("IntersectionObserver", class IntersectionObserverMock {
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe(target: Element) {
        this.callback([{ target, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
      }
      disconnect() {}
      unobserve() {}
      takeRecords() { return []; }
      root = null;
      rootMargin = "0px";
      thresholds = [0];
    });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(Date.now()), 0));
    vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
    vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 600,
      height: 390,
      top: 0,
      right: 600,
      bottom: 390,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const context = new Proxy({
      canvas: document.createElement("canvas"),
      fillRect,
      measureText: (text: string) => ({ width: text.length * 7 }),
    } as unknown as CanvasRenderingContext2D, {
      get(target, property) {
        if (property in target) return target[property as keyof CanvasRenderingContext2D];
        return () => undefined;
      },
      set(target, property, value) {
        Object.assign(target, { [property]: value });
        return true;
      },
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((kind) => (
      kind === "2d" ? context : null
    ) as RenderingContext | null);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("falls back to the main-thread engine and redraws active-candle replacements", async () => {
    await act(async () => {
      root.render(createElement(GholaMarketChart, {
        frame: frame("100"),
        mode: "candles",
        feedStatus: "live",
        height: 390,
      }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });
    const firstDrawCount = fillRect.mock.calls.length;
    expect(firstDrawCount).toBeGreaterThan(0);
    expect(container.textContent).toContain("candles · live");

    await act(async () => {
      root.render(createElement(GholaMarketChart, {
        frame: frame("102"),
        mode: "candles",
        feedStatus: "live",
        height: 390,
      }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });

    expect(fillRect.mock.calls.length).toBeGreaterThan(firstDrawCount);
  });
});

function frame(close: string): GholaMarketFrame {
  const candleAt = new Date("2026-08-06T06:00:00.000Z").getTime();
  return {
    version: 1,
    venue: "hyperliquid",
    product: "BTC",
    interval: "1m",
    fetchedAt: new Date(candleAt).toISOString(),
    stale: false,
    channelUpdatedAt: {
      candle: candleAt,
      trades: candleAt,
      bbo: candleAt,
      order_book: candleAt,
      market_context: candleAt,
      mid: candleAt,
    },
    mid: close,
    bestBid: "99",
    bestAsk: "103",
    spreadBps: 4,
    markPrice: close,
    oraclePrice: close,
    fundingRate: "0.0001",
    openInterest: "1000",
    dayVolume: "1000000",
    candles: [{
      t: candleAt,
      T: candleAt + 59_999,
      o: "100",
      h: close,
      l: "99",
      c: close,
      v: "1",
      n: 1,
    }],
    bids: [],
    asks: [],
    trades: [],
    routeQuotes: [],
  };
}
