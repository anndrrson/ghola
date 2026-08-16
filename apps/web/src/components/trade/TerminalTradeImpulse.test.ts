import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TerminalTradeImpulse } from "./TerminalTradeImpulse";
import type { TerminalCertifiedMarketSignals } from "@/lib/terminal-certified-market-signals";

describe("TerminalTradeImpulse", () => {
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

  it("renders certified impulse metrics with non-predictive copy", () => {
    act(() => root.render(createElement(TerminalTradeImpulse, { signals: signals(true) })));
    expect(container.textContent).toContain("Buy impulse");
    expect(container.textContent).toContain("Net aggressor");
    expect(container.textContent).toContain("Print drift");
    expect(container.textContent).toContain("do not forecast direction");
  });

  it("renders nothing for uncertified retained prints", () => {
    act(() => root.render(createElement(TerminalTradeImpulse, { signals: signals(false) })));
    expect(container.textContent).toBe("");
  });
});

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
