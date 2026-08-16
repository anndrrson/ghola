import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TerminalLivePrice } from "./TerminalLivePrice";

describe("TerminalLivePrice", () => {
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

  it("animates only an actual price change and remains stable for equal props", async () => {
    render(root, 100, "$100.00");
    const initial = priceNode(container);
    expect(initial.dataset.priceFlash).toBe("idle");

    await renderAsync(root, 101, "$101.00");
    const changed = priceNode(container);
    expect(changed).not.toBe(initial);
    expect(changed.dataset.priceFlash).toBe("active");
    expect(changed.className).toContain("trade-price-flash");

    render(root, 101, "$101.00");
    expect(priceNode(container)).toBe(changed);
  });
});

function render(root: Root, value: number | null, formattedValue: string) {
  act(() => root.render(createElement(TerminalLivePrice, { value, formattedValue })));
}

async function renderAsync(root: Root, value: number | null, formattedValue: string) {
  await act(async () => {
    root.render(createElement(TerminalLivePrice, { value, formattedValue }));
    await Promise.resolve();
  });
}

function priceNode(container: HTMLElement) {
  const node = container.querySelector<HTMLElement>("[data-price-flash]");
  if (!node) throw new Error("price_node_missing");
  return node;
}
