import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalInvalidationPlan } from "@/lib/terminal-invalidation-planner";
import { TerminalInvalidationPlanner } from "./TerminalInvalidationPlanner";

describe("TerminalInvalidationPlanner", () => {
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

  it("renders candidates and stages only the selected exact level", () => {
    const onStage = vi.fn();
    act(() => root.render(createElement(TerminalInvalidationPlanner, { plan: readyPlan(), onStage })));
    expect(container.textContent).toContain("ATR 2");
    expect(container.textContent).toContain("1.5× ATR");
    expect(container.textContent).toContain("Safe size");
    const button = [...container.querySelectorAll("button")].find((candidate) => candidate.getAttribute("aria-label")?.startsWith("Stage 1.5"));
    act(() => button?.click());
    expect(onStage).toHaveBeenCalledTimes(1);
    expect(onStage).toHaveBeenCalledWith(1.5, 97);
    expect(container.textContent).toContain("never previews or submits");
  });

  it("fails visibly closed without certified ATR", () => {
    act(() => root.render(createElement(TerminalInvalidationPlanner, {
      plan: { status: "unavailable", blocker: "atr_invalid", atr: null, candidates: [] },
      onStage: vi.fn(),
    })));
    expect(container.textContent).toContain("paused");
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    expect(container.querySelector("button")).toBeNull();
  });
});

function readyPlan(): TerminalInvalidationPlan {
  return {
    status: "ready",
    blocker: null,
    atr: 2,
    candidates: [1, 1.5, 2].map((multiplier) => ({
      multiplier: multiplier as 1 | 1.5 | 2,
      invalidationPrice: 100 - 2 * multiplier,
      distanceBps: 200 * multiplier,
      modeledLossUsd: 2 * multiplier,
      budgetUtilizationPct: 20 * multiplier,
      safeNotionalUsd: 100 / multiplier,
    })),
  };
}
