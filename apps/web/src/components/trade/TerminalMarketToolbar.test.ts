import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TerminalMarketToolbar,
  terminalMarketToolbarPropsEqual,
  type TerminalMarketToolbarProps,
} from "./TerminalMarketToolbar";

const VENUES = [
  { id: "hyperliquid" as const, label: "Hyperliquid", markets: ["BTC", "ETH"] },
  { id: "phoenix" as const, label: "Phoenix", markets: ["SOL"] },
  { id: "coinbase" as const, label: "Coinbase", markets: ["BTC", "ETH"] },
] as const;

describe("TerminalMarketToolbar", () => {
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

  it("preserves exact venue, market, and interval staging", () => {
    const onSelectVenue = vi.fn();
    const onSelectMarket = vi.fn();
    const onSelectInterval = vi.fn();
    act(() => root.render(createElement(TerminalMarketToolbar, props({ onSelectVenue, onSelectMarket, onSelectInterval }))));

    const venueSelect = container.querySelector<HTMLSelectElement>('select[aria-label="Venue"]');
    if (!venueSelect) throw new Error("venue_select_missing");
    venueSelect.value = "phoenix";
    act(() => venueSelect.dispatchEvent(new Event("change", { bubbles: true })));
    click(buttonNamed("1h"));
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Market"]');
    if (!select) throw new Error("market_select_missing");
    expect(select.getAttribute("aria-label")).toBe("Market");
    select.value = "ETH";
    act(() => select.dispatchEvent(new Event("change", { bubbles: true })));

    expect(onSelectVenue).toHaveBeenCalledWith("phoenix");
    expect(onSelectMarket).toHaveBeenCalledWith("ETH");
    expect(onSelectInterval).toHaveBeenCalledWith("1h");
    expect(buttonNamed("5m").getAttribute("aria-pressed")).toBe("true");
    expect(buttonNamed("1h").getAttribute("aria-keyshortcuts")).toBe("4");
  });

  it("defines a strict cold-render bailout", () => {
    const value = props();
    expect(terminalMarketToolbarPropsEqual(value, { ...value })).toBe(true);
    expect(terminalMarketToolbarPropsEqual(value, { ...value, interval: "1h" })).toBe(false);
    expect(terminalMarketToolbarPropsEqual(value, { ...value, onSelectMarket: vi.fn() })).toBe(false);
  });

  function buttonNamed(label: string) {
    const button = [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === label);
    if (!button) throw new Error(`button_not_found:${label}`);
    return button;
  }
});

function props(overrides: Partial<TerminalMarketToolbarProps> = {}): TerminalMarketToolbarProps {
  return {
    venues: VENUES,
    venueId: "hyperliquid",
    market: "BTC",
    network: "mainnet",
    interval: "5m",
    onSelectVenue: vi.fn(),
    onSelectMarket: vi.fn(),
    onSelectInterval: vi.fn(),
    ...overrides,
  };
}

function click(button: HTMLButtonElement) {
  act(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}
