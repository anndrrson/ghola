import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PAPER_TRADING_GUEST_SCOPE } from "@/lib/paper-trading-engine";

const probe = vi.hoisted(() => ({ renders: 0, lastProduct: "" }));

vi.mock("next/dynamic", () => ({
  default: () => function MockPaperPanel(props: { product: string }) {
    probe.renders += 1;
    probe.lastProduct = props.product;
    return createElement("div", { "data-testid": "paper-panel" }, props.product);
  },
}));

import {
  TERMINAL_OPEN_PAPER_EVENT,
  TerminalPaperWorkstation,
} from "./TerminalPaperWorkstation";

describe("TerminalPaperWorkstation", () => {
  let container: HTMLDivElement;
  let root: Root;
  let observerCallback: IntersectionObserverCallback | null;

  beforeEach(() => {
    probe.renders = 0;
    probe.lastProduct = "";
    observerCallback = null;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: IntersectionObserverCallback) { observerCallback = callback; }
      observe() {}
      disconnect() {}
      unobserve() {}
      takeRecords() { return []; }
      root = null;
      rootMargin = "400px 0px";
      thresholds = [0];
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("keeps PAPER code cold across parent feed renders until explicitly opened", () => {
    act(() => root.render(createElement(TerminalPaperWorkstation, workstationProps("BTC-PERP"))));
    expect(probe.renders).toBe(0);
    expect(container.textContent).toContain("loads only when opened");

    act(() => root.render(createElement(TerminalPaperWorkstation, workstationProps("ETH-PERP"))));
    expect(probe.renders).toBe(0);

    act(() => requiredElement<HTMLButtonElement>(container, "button").click());
    expect(probe.renders).toBe(1);
    expect(probe.lastProduct).toBe("ETH-PERP");
  });

  it("activates from the command event or viewport proximity", () => {
    act(() => root.render(createElement(TerminalPaperWorkstation, workstationProps("BTC-PERP"))));
    act(() => window.dispatchEvent(new Event(TERMINAL_OPEN_PAPER_EVENT)));
    expect(container.querySelector('[data-testid="paper-panel"]')).toBeTruthy();

    act(() => root.unmount());
    root = createRoot(container);
    probe.renders = 0;
    act(() => root.render(createElement(TerminalPaperWorkstation, workstationProps("SOL-PERP"))));
    act(() => observerCallback?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
    expect(probe.renders).toBe(1);
    expect(probe.lastProduct).toBe("SOL-PERP");
  });
});

function workstationProps(product: string) {
  return {
    persistenceScope: PAPER_TRADING_GUEST_SCOPE,
    frame: null,
    venueId: "hyperliquid" as const,
    network: "mainnet" as const,
    product,
    side: "buy" as const,
    limitPrice: 100,
    quoteNotionalUsd: 10,
    stopLevel: 99,
    targetPrice: 102,
    targetRewardMultiple: 2 as const,
    marketDataLive: false,
    marketMaxAgeMs: 30_000,
    onSelectMarkMarket: vi.fn(() => false),
  };
}

function requiredElement<T extends Element>(root: ParentNode, selector: string): T {
  const value = root.querySelector<T>(selector);
  if (!value) throw new Error(`Missing test element: ${selector}`);
  return value;
}
