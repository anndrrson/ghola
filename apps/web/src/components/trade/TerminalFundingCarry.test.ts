import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GholaMarketFrame } from "@/lib/ghola-market-chart";
import { deriveTerminalFundingCarry } from "@/lib/terminal-funding-carry";
import { TerminalFundingCarry } from "./TerminalFundingCarry";

describe("TerminalFundingCarry", () => {
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

  it("announces side-aware carry, unknown cadence, and informational scope", () => {
    const frame = marketFrame();
    act(() => root.render(createElement(TerminalFundingCarry, {
      preview: deriveTerminalFundingCarry({
        frame,
        marketState: {
          status: "live",
          frame,
          loading: false,
          stale: false,
          error: null,
          lastUpdateAt: frame.fetchedAt,
        },
        source: "unified_live",
        selection: { venue: "hyperliquid", network: "mainnet", market: "BTC", interval: "5m" },
        productClass: "perpetual",
        side: "buy",
        notionalUsd: 100,
        nowMs: Date.parse("2026-08-12T12:00:05.000Z"),
      }),
    })));

    expect(container.querySelector('[role="status"]')?.textContent).toContain("LIVE SNAPSHOT");
    expect(container.textContent).toContain("LONG pays $0.01 per reported funding interval");
    expect(container.textContent).toContain("next settlement are unavailable");
    expect(container.textContent).toContain("not an execution blocker or trigger-bound signal");
  });
});

function marketFrame(): GholaMarketFrame {
  return {
    version: 1,
    venue: "hyperliquid",
    network: "mainnet",
    product: "BTC",
    interval: "5m",
    fetchedAt: "2026-08-12T12:00:00.000Z",
    stale: false,
    mid: "100",
    bestBid: "99",
    bestAsk: "101",
    spreadBps: 20,
    markPrice: "100",
    oraclePrice: "100",
    fundingRate: "0.0001",
    fundingRateUnit: "decimal_fraction",
    fundingRateSource: "hyperliquid_ws_active_asset_context_received",
    fundingRateTimeBasis: "received_at",
    fundingRateUpdatedAt: "2026-08-12T12:00:00.000Z",
    openInterest: "1000",
    dayVolume: "10000",
    candles: [],
    bids: [],
    asks: [],
    trades: [],
    routeQuotes: [],
  };
}
