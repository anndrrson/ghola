import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalTradeTape } from "./TerminalTradeTape";
import type { TerminalCertifiedMarketSignals } from "@/lib/terminal-certified-market-signals";

describe("TerminalTradeTape", () => {
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

  it("stages the exact certified print and never claims submission", () => {
    const onStagePrice = vi.fn();
    act(() => root.render(createElement(TerminalTradeTape, { signals: signals(true), onStagePrice })));
    const button = requiredElement<HTMLButtonElement>(container, 'button[aria-label*="Stage buy-initiated print 100.05"]');
    expect(button.getAttribute("aria-label")).toContain("no order submitted");
    act(() => button.click());
    expect(onStagePrice).toHaveBeenCalledWith(100.05, "coinbase:mainnet:btc:1m");
    expect(container.textContent).toContain("never previews or submits");
  });

  it("hides all actionable rows when trade certification fails", () => {
    const onStagePrice = vi.fn();
    act(() => root.render(createElement(TerminalTradeTape, { signals: signals(false), onStagePrice })));
    expect(container.textContent).toContain("Tape paused");
    expect(container.querySelector("button")).toBeNull();
    expect(onStagePrice).not.toHaveBeenCalled();
  });

  it("keeps certified prints visible but disables staging during live execution", () => {
    const onStagePrice = vi.fn();
    act(() => root.render(createElement(TerminalTradeTape, {
      signals: signals(true),
      onStagePrice,
      stagingDisabled: true,
    })));

    expect(container.textContent).toContain("Price staging locked");
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
    expect(buttons).toHaveLength(3);
    expect(buttons.every((button) => button.disabled)).toBe(true);
    act(() => buttons[0]?.click());
    expect(onStagePrice).not.toHaveBeenCalled();
  });
});

function requiredElement<T extends Element>(container: ParentNode, selector: string): T {
  const element = container.querySelector(selector);
  if (!element) throw new Error(`missing ${selector}`);
  return element as T;
}

function signals(ready: boolean): TerminalCertifiedMarketSignals {
  return {
    snapshotInstrument: "BTC",
    evaluationIdentityKey: "coinbase:mainnet:btc:1m",
    referencePrice: 100,
    bookFrame: null,
    alertSnapshot: {},
    availableAlertMetrics: [],
    components: {
      quote: { ready: false, blocker: "clock_missing", ageMs: null },
      book: { ready: false, blocker: "clock_missing", ageMs: null },
      trades: { ready, blocker: ready ? null : "component_stale", ageMs: ready ? 0 : 31_000 },
      candles: { ready: false, blocker: "clock_missing", ageMs: null },
    },
    intelligence: {
      sessionChangePct: null,
      sessionHigh: null,
      sessionLow: null,
      atr: null,
      atrBps: null,
      realizedVolatilityBps: null,
      bookImbalancePct: null,
      microprice: null,
      micropriceEdgeBps: null,
      bidDepthUsd: null,
      askDepthUsd: null,
      tradeVwap: 100.03,
      buyFlowPct: 91,
    },
    tape: {
      trades: [
        { id: "3", side: "buy", px: "100.05", sz: "5", time: 2_000 },
        { id: "2", side: "sell", px: "100.01", sz: "1", time: 1_000 },
        { id: "1", side: "buy", px: "100", sz: "5", time: 0 },
      ],
      tradeVwap: 100.03,
      buyFlowPct: 91,
    },
    surfaces: {
      intelligence: { status: "degraded", message: "test" },
      tape: { status: ready ? "ready" : "paused", message: "test" },
      alerts: { status: "paused", message: "test" },
    },
  };
}
