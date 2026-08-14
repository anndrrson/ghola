import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalMarketContextRail, type TerminalMarketContextRailProps } from "./TerminalMarketContextRail";

describe("TerminalMarketContextRail", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("keeps certified market, staged plan, and risk context in one sticky row", () => {
    act(() => root.render(createElement(TerminalMarketContextRail, props())));
    const rail = container.querySelector("#terminal-market-context");
    expect(rail?.className).toContain("sticky");
    expect(rail?.textContent).toContain("63,824.5");
    expect(rail?.textContent).toContain("$0.75 / $1");
    expect(container.querySelector('[aria-keyshortcuts="J"]')?.hasAttribute("disabled")).toBe(false);
  });

  it("fails price staging closed when the executable quote is uncertified", () => {
    const onAuto = vi.fn();
    const onJoin = vi.fn();
    const onCross = vi.fn();
    act(() => root.render(createElement(TerminalMarketContextRail, props({
      quoteReady: false,
      onAuto,
      onJoin,
      onCross,
    }))));
    expect(container.textContent).toContain("PAUSED");
    const auto = button(container, "U");
    const join = button(container, "J");
    const cross = button(container, "X");
    expect(join.disabled).toBe(true);
    expect(cross.disabled).toBe(true);
    act(() => auto.click());
    expect(onAuto).toHaveBeenCalledOnce();
    expect(onJoin).not.toHaveBeenCalled();
    expect(onCross).not.toHaveBeenCalled();
  });
});

function props(overrides: Partial<TerminalMarketContextRailProps> = {}): TerminalMarketContextRailProps {
  return {
    venue: "Hyperliquid",
    product: "BTC-PERP",
    side: "buy",
    notionalUsd: 10,
    quoteReady: true,
    quoteMid: 63_824.5,
    bestBid: 63_824,
    bestAsk: 63_825,
    quoteAgeMs: 125,
    entryPrice: 63_824,
    invalidationPrice: 63_345,
    riskAllowed: true,
    modeledLossUsd: 0.75,
    riskBudgetUsd: 1,
    onAuto: vi.fn(),
    onJoin: vi.fn(),
    onCross: vi.fn(),
    ...overrides,
  };
}

function button(container: HTMLElement, shortcut: string) {
  const match = container.querySelector<HTMLButtonElement>(`button[aria-keyshortcuts="${shortcut}"]`);
  if (!match) throw new Error(`missing button ${shortcut}`);
  return match;
}
