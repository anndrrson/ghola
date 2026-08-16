import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TerminalPlanMarketState } from "./TerminalPlanMarketState";

describe("TerminalPlanMarketState", () => {
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

  it("makes a marketable limit and residual risk explicit", () => {
    act(() => root.render(createElement(TerminalPlanMarketState, { decision: {
      allowed: true, blocker: null, mode: "marketable", executablePrice: 100,
      distanceToMarketBps: 100, remainingRiskBps: 500,
    } })));
    expect(container.textContent).toContain("marketable");
    expect(container.textContent).toContain("100.0 bp");
    expect(container.textContent).toContain("500.0 bp");
    expect(container.textContent).toContain("crosses current BBO");
  });

  it("announces an already-invalid plan as blocked", () => {
    act(() => root.render(createElement(TerminalPlanMarketState, { decision: {
      allowed: false, blocker: "already_invalidated", mode: "marketable", executablePrice: 100,
      distanceToMarketBps: 100, remainingRiskBps: 0,
    } })));
    expect(container.textContent).toContain("blocked");
    expect(container.textContent).toContain("at or beyond the plan invalidation");
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });
});
