import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TerminalClassicMarketChart, type TerminalClassicMarketChartProps } from "./TerminalClassicMarketChart";
import type { GholaMarketFrame } from "@/lib/ghola-market-chart";

describe("TerminalClassicMarketChart", () => {
  it("keeps projected levels off the default market chart", () => {
    const markup = render(false);

    expect(markup).toContain("Plan trade");
    expect(markup).toContain("No projected order levels shown");
    expect(markup).not.toContain("PLAN EXIT");
    expect(markup).not.toContain("PLAN TARGET");
    expect(markup).not.toContain("1R risk band");
    expect(markup).not.toContain("Slippage cap");
  });

  it("shows only a truthful projected entry, exit, and target in planning mode", () => {
    const markup = render(true);

    expect(markup).toContain("Plan · DRAFT");
    expect(markup).toContain("DRAFT · BUY ENTRY");
    expect(markup).toContain("PLAN EXIT · NOT SENT");
    expect(markup).toContain("PLAN TARGET · NOT SENT");
    expect(markup).toContain("planned exit and target are not venue orders");
    expect(markup).not.toContain("1R risk band");
    expect(markup).not.toContain("Slippage cap");
  });
});

function render(planning: boolean) {
  return renderToStaticMarkup(createElement(TerminalClassicMarketChart, props({ planning })));
}

function props(overrides: Partial<TerminalClassicMarketChartProps> = {}): TerminalClassicMarketChartProps {
  return {
    frame: FRAME,
    feedLabel: "Live",
    loading: false,
    planning: false,
    planState: "draft",
    side: "buy",
    entryPrice: 100.4,
    stopPrice: 99.8,
    targetPrice: 101.6,
    interactionAllowed: true,
    onPlanningChange: vi.fn(),
    onEntryDrag: vi.fn(),
    onStopDrag: vi.fn(),
    ...overrides,
  };
}

const FRAME: GholaMarketFrame = {
  version: 1,
  venue: "hyperliquid",
  network: "mainnet",
  product: "BTC-PERP",
  interval: "5m",
  fetchedAt: "2026-08-15T09:00:00.000Z",
  stale: false,
  mid: "100.4",
  bestBid: "100.3",
  bestAsk: "100.5",
  spreadBps: 19.92,
  markPrice: "100.4",
  oraclePrice: "100.4",
  fundingRate: "0.000013",
  openInterest: "1000",
  dayVolume: "5000",
  candles: [
    { t: 1_723_710_000_000, T: null, o: "100.0", h: "100.5", l: "99.9", c: "100.3", v: "2", n: 2 },
    { t: 1_723_710_300_000, T: null, o: "100.3", h: "100.8", l: "100.1", c: "100.6", v: "3", n: 3 },
  ],
  bids: [],
  asks: [],
  trades: [],
  routeQuotes: [],
};
