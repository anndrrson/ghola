import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deriveTerminalLiquidityStress } from "@/lib/terminal-liquidity-stress";
import { TerminalLiquidityStress } from "./TerminalLiquidityStress";

describe("TerminalLiquidityStress", () => {
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

  it("renders an accessible five-point curve and highlights current size", () => {
    const curve = deriveTerminalLiquidityStress({
      side: "buy",
      orderNotionalUsd: 1_000,
      sizingPrice: 100,
      limitPrice: 102,
      bids: [{ px: 99, sz: 20 }],
      asks: [{ px: 101, sz: 12 }],
    });
    act(() => root.render(createElement(TerminalLiquidityStress, { curve })));

    expect(container.querySelectorAll("tbody tr")).toHaveLength(5);
    expect(container.querySelector("caption")?.textContent).toContain("five multiples");
    expect(container.textContent).toContain("Capacity 1.2×");
    expect(container.textContent).toContain("certified BBO midpoint");
    expect(container.textContent).toContain("hidden liquidity");
  });

  it("explains why uncertified depth is unavailable", () => {
    const curve = deriveTerminalLiquidityStress({
      side: "buy",
      orderNotionalUsd: 1_000,
      sizingPrice: 100,
      bids: [],
      asks: [],
    });
    act(() => root.render(createElement(TerminalLiquidityStress, { curve })));

    expect(container.textContent).toContain("waiting for a certified two-sided book");
    expect(container.querySelector("table")).toBeNull();
  });
});
