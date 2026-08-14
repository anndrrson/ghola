import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalEntryPriceStages } from "@/lib/terminal-entry-price-staging";
import { TerminalEntryPriceStager } from "./TerminalEntryPriceStager";

describe("TerminalEntryPriceStager", () => {
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

  it("stages join or cross without exposing submission", () => {
    const onStage = vi.fn();
    const onAuto = vi.fn();
    act(() => root.render(createElement(TerminalEntryPriceStager, {
      stages: readyStages(),
      entryPinned: false,
      entryPrice: 100,
      onAuto,
      onStage,
    })));

    click(buttonNamed(container, "Join"));
    click(buttonNamed(container, "Cross"));
    click(buttonNamed(container, "Auto mid"));

    expect(onStage.mock.calls).toEqual([["join"], ["cross"]]);
    expect(onAuto).toHaveBeenCalledOnce();
    expect(buttonNamed(container, "Auto mid").getAttribute("aria-keyshortcuts")).toBe("U");
    expect(buttonNamed(container, "Join").getAttribute("aria-keyshortcuts")).toBe("J");
    expect(buttonNamed(container, "Cross").getAttribute("aria-keyshortcuts")).toBe("X");
    expect(container.textContent).toContain("Staging never submits");
    expect(container.textContent).not.toMatch(/preview|execute order/iu);
  });

  it("marks the exact staged quote and fails closed without certification", () => {
    const { rerender } = render({
      stages: readyStages(),
      entryPinned: true,
      entryPrice: 101,
    });
    expect(buttonNamed(container, "Cross").getAttribute("aria-pressed")).toBe("true");

    rerender({
      stages: { ...readyStages(), status: "unavailable", blocker: "quote_expired", join: null, cross: null },
      entryPinned: true,
      entryPrice: 101,
    });
    expect(buttonNamed(container, "Join").disabled).toBe(true);
    expect(buttonNamed(container, "Cross").disabled).toBe(true);
    expect(container.textContent).toContain("fresh quote required");
  });

  function render(overrides: {
    stages: TerminalEntryPriceStages;
    entryPinned: boolean;
    entryPrice: number | null;
  }) {
    const props = { ...overrides, onAuto: vi.fn(), onStage: vi.fn() };
    act(() => root.render(createElement(TerminalEntryPriceStager, props)));
    return {
      rerender(next: typeof overrides) {
        act(() => root.render(createElement(TerminalEntryPriceStager, { ...props, ...next })));
      },
    };
  }
});

function readyStages(): TerminalEntryPriceStages {
  return {
    status: "ready",
    blocker: null,
    quoteAgeMs: 125,
    bestBid: 99,
    bestAsk: 101,
    join: { mode: "join", price: 99, quoteAgeMs: 125, sourceSide: "bid", marketable: false },
    cross: { mode: "cross", price: 101, quoteAgeMs: 125, sourceSide: "ask", marketable: true },
  };
}

function buttonNamed(container: HTMLElement, label: string) {
  const button = [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(label));
  if (!button) throw new Error(`button_not_found:${label}`);
  return button;
}

function click(button: HTMLButtonElement) {
  act(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}
