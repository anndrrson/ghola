import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPaperTradingState,
  paperPositionKey,
  type PaperTradingState,
} from "@/lib/paper-trading-engine";
import { PaperRiskDesk } from "./PaperRiskDesk";

const NOW = "2026-08-12T12:00:30.000Z";
const STALE = "2026-08-12T11:58:00.000Z";

describe("PaperRiskDesk mark recovery", () => {
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

  it("loads the exact supported target and then waits for a fresh mark", () => {
    const state = stalePositionState("hyperliquid", "mainnet", "BTC-PERP");
    const onLoadMarket = vi.fn();
    const props = {
      state,
      now: NOW,
      maxAgeMs: 30_000,
      pendingPositionKey: null,
      onLoadMarket,
    };
    act(() => root.render(createElement(PaperRiskDesk, props)));

    const load = buttonNamed(container, "Load market");
    expect(load.disabled).toBe(false);
    act(() => load.click());
    expect(onLoadMarket).toHaveBeenCalledWith("hyperliquid:mainnet:BTC-PERP", {
      venueId: "hyperliquid",
      network: "mainnet",
      market: "BTC",
      product: "BTC-PERP",
    });

    act(() => root.render(createElement(PaperRiskDesk, {
      ...props,
      pendingPositionKey: "hyperliquid:mainnet:BTC-PERP",
    })));
    const waiting = buttonNamed(container, "Await fresh mark");
    expect(waiting.disabled).toBe(true);
    expect(waiting.getAttribute("aria-label")).toContain("BTC-PERP on hyperliquid mainnet");
  });

  it("fails closed for an unsupported persisted venue/network/product identity", () => {
    const onLoadMarket = vi.fn();
    act(() => root.render(createElement(PaperRiskDesk, {
      state: stalePositionState("coinbase", "testnet", "BTC-USD"),
      now: NOW,
      maxAgeMs: 30_000,
      pendingPositionKey: null,
      onLoadMarket,
    })));

    const unavailable = buttonNamed(container, "Unavailable");
    expect(unavailable.disabled).toBe(true);
    expect(unavailable.title).toContain("not an exact supported terminal market");
    expect(onLoadMarket).not.toHaveBeenCalled();
  });
});

function stalePositionState(venueId: string, network: string, product: string): PaperTradingState {
  const identity = { venue_id: venueId, network, product };
  const positionKey = paperPositionKey(identity);
  return {
    ...createPaperTradingState({ now: NOW }),
    positions: [{
      position_key: positionKey,
      ...identity,
      quantity_base: 1,
      average_entry_price: 100,
      realized_pnl_gross_usd: 0,
      fees_paid_usd: 0,
      opened_at: STALE,
      updated_at: STALE,
    }],
    marks: [{
      position_key: positionKey,
      ...identity,
      mark_price: 100,
      fetched_at: STALE,
      observed_at: STALE,
    }],
  };
}

function buttonNamed(container: ParentNode, name: string) {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
    .find((item) => item.textContent?.trim() === name);
  if (!button) throw new Error(`Missing button: ${name}`);
  return button;
}
