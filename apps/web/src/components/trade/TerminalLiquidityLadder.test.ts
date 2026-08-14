import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GholaMarketFrame } from "@/lib/ghola-market-chart";
import {
  centeredLadderScrollTop,
  TerminalLiquidityLadder,
  type TerminalLiquidityLadderProps,
} from "./TerminalLiquidityLadder";

describe("TerminalLiquidityLadder", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders a semantic center DOM and stages exact keyboard-selected prices", () => {
    const onStagePrice = vi.fn();
    renderLadder(root, { onStagePrice });

    expect(container.querySelector("table")).toBeTruthy();
    expect(container.querySelector('[role="region"][data-depth-window="bounded"]')).toBeTruthy();
    expect(container.querySelector("thead")?.className).toContain("sticky");
    expect(container.textContent).toContain("MID");
    expect(container.textContent).toContain("Fees are not included");
    const prices = priceButtons(container);
    expect(prices).toHaveLength(4);
    const active = prices.find((button) => button.tabIndex === 0);
    expect(active?.getAttribute("aria-label")).toContain("ask price 101.00");

    act(() => {
      active?.focus();
      active?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(document.activeElement?.getAttribute("aria-label")).toContain("bid price 99.00");

    act(() => {
      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onStagePrice).toHaveBeenCalledWith(99);
  });

  it("centers the inside market within bounded scroll limits", () => {
    expect(centeredLadderScrollTop({
      rowTop: 400,
      rowHeight: 28,
      viewportHeight: 280,
      scrollHeight: 1_000,
    })).toBe(274);
    expect(centeredLadderScrollTop({
      rowTop: 980,
      rowHeight: 28,
      viewportHeight: 280,
      scrollHeight: 1_000,
    })).toBe(720);
    expect(centeredLadderScrollTop({
      rowTop: Number.NaN,
      rowHeight: 28,
      viewportHeight: 280,
      scrollHeight: 1_000,
    })).toBe(0);
  });

  it("resets roving focus to the inside market when instrument identity changes", () => {
    const onStagePrice = vi.fn();
    renderLadder(root, { onStagePrice });
    const active = priceButtons(container).find((button) => button.tabIndex === 0);
    act(() => {
      active?.focus();
      active?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });

    renderLadder(root, {
      frame: frame({
        product: "ETH-PERP",
        bestBid: "199",
        bestAsk: "201",
        mid: "200",
        bids: [level(199), level(198)],
        asks: [level(201), level(202)],
      }),
      selectedProduct: "ETH",
      selectedEntryPrice: 200,
      onStagePrice,
    });

    const nextActive = priceButtons(container).find((button) => button.tabIndex === 0);
    expect(nextActive?.getAttribute("aria-label")).toContain("ask price 201.00");
  });

  it("fails closed instead of rendering stale depth", () => {
    renderLadder(root, { stale: true, onStagePrice: vi.fn() });

    expect(container.querySelector("table")).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toContain("visible depth is stale");
  });

  it("keeps certified depth visible but disables every price stage while execution is live", () => {
    const onStagePrice = vi.fn();
    renderLadder(root, { stagingDisabled: true, onStagePrice });

    expect(container.textContent).toContain("Price staging locked");
    const prices = Array.from(container.querySelectorAll<HTMLButtonElement>('button[aria-label*="staging locked"]'));
    expect(prices).toHaveLength(4);
    expect(prices.every((button) => button.disabled)).toBe(true);
    act(() => prices[0]?.click());
    expect(onStagePrice).not.toHaveBeenCalled();
  });
});

function renderLadder(root: Root, overrides: Partial<TerminalLiquidityLadderProps>) {
  act(() => root.render(createElement(TerminalLiquidityLadder, {
    frame: frame(),
    side: "buy",
    requestedNotionalUsd: 100,
    selectedEntryPrice: 100,
    selectedVenue: "hyperliquid",
    selectedProduct: "BTC",
    selectedInterval: "5m",
    onStagePrice: vi.fn(),
    ...overrides,
  })));
}

function priceButtons(root: ParentNode) {
  return Array.from(root.querySelectorAll<HTMLButtonElement>('button[aria-label^="Stage "]'));
}

function frame(overrides: Partial<GholaMarketFrame> = {}): GholaMarketFrame {
  return {
    version: 1,
    venue: "hyperliquid",
    product: "BTC-PERP",
    interval: "5m",
    fetchedAt: "2026-08-12T18:00:00.000Z",
    stale: false,
    mid: "100",
    bestBid: "99",
    bestAsk: "101",
    spreadBps: 200,
    markPrice: "100",
    oraclePrice: "100",
    fundingRate: null,
    openInterest: null,
    dayVolume: null,
    candles: [],
    bids: [level(99), level(98)],
    asks: [level(101), level(102)],
    trades: [],
    routeQuotes: [],
    ...overrides,
  };
}

function level(price: number) {
  return { px: String(price), sz: "1", n: 1 };
}
