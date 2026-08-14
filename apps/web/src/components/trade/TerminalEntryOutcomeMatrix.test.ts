import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalEntryOutcomeMatrix as Matrix } from "@/lib/terminal-entry-outcome-matrix";
import { TerminalEntryOutcomeMatrix } from "./TerminalEntryOutcomeMatrix";

describe("TerminalEntryOutcomeMatrix", () => {
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

  it("renders honest visible outcomes and stages only explicit alternatives", () => {
    const onStage = vi.fn();
    const onStageSafeSized = vi.fn();
    act(() => root.render(createElement(TerminalEntryOutcomeMatrix, { matrix: ready(), onStage, onStageSafeSized })));

    expect(container.textContent).toContain("certified depth · no submit");
    expect(container.textContent).toContain("Current");
    expect(container.textContent).toContain("50%");
    expect(container.textContent).toContain("$500");
    expect(container.textContent).toContain("$12.50");
    expect(container.textContent).toContain("25% pass");
    expect(container.textContent).toContain("Marketable modeled cap is the smaller");
    expect(container.textContent).toContain("depth cap");
    const join = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Stage join");
    if (!join) throw new Error("join action missing");
    act(() => join.click());
    expect(onStage).toHaveBeenCalledWith("join");
    expect(join.getAttribute("aria-keyshortcuts")).toBe("J");
    const safeSize = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Stage + cap $40"));
    if (!safeSize) throw new Error("safe-size action missing");
    act(() => safeSize.click());
    expect(onStageSafeSized).toHaveBeenCalledWith("cross", 101, {
      notionalUsd: 40,
      constraint: "visible_liquidity",
      canApply: true,
      riskCapNotionalUsd: 40,
      visibleFullFillNotionalUsd: 40,
    });
    expect(safeSize.getAttribute("aria-keyshortcuts")).toBe("Shift+X");
    expect(container.textContent).toContain("Apply actions only reduce exposure");
  });

  it("explains fail-closed depth", () => {
    act(() => root.render(createElement(TerminalEntryOutcomeMatrix, {
      matrix: { status: "unavailable", blocker: "book_unavailable", outcomes: [] },
      onStage: vi.fn(),
      onStageSafeSized: vi.fn(),
    })));
    expect(container.textContent).toContain("waiting for certified depth");
    expect(container.querySelector("button")).toBeNull();
  });
});

function ready(): Matrix {
  const quality = {
    status: "partial" as const,
    targetBaseSize: 10,
    filledBaseSize: 5,
    filledNotionalUsd: 505,
    unfilledNotionalUsd: 500,
    fillPct: 50,
    vwap: 101,
    worstPrice: 101,
    impactBps: 100,
    feeUsd: 0,
    arrivalCostUsd: 5,
    allInImpactBps: 100,
    levelsConsumed: 1,
  };
  return {
    status: "ready",
    blocker: null,
    outcomes: [
      { mode: "join", price: 99, intent: "resting", quality: { ...quality, status: "none", fillPct: 0, vwap: null, impactBps: null }, risk: risk(true) },
      { mode: "current", price: 100, intent: "resting", quality, risk: risk(true) },
      { mode: "cross", price: 101, intent: "marketable", quality, risk: risk(false) },
    ],
  };
}

function risk(allowed: boolean) {
  return {
    stopValid: true,
    invalidationPrice: 95,
    modeledLossUsd: allowed ? 12.5 : 62.5,
    stopDistanceBps: allowed ? 75 : 575,
    budgetUtilizationPct: allowed ? 25 : 125,
    budgetAllowed: allowed,
    safeNotionalUsd: allowed ? 100 : 40,
    visibleFullFillNotionalUsd: allowed ? null : 40,
    recommendedNotionalUsd: allowed ? 100 : 40,
    recommendationConstraint: allowed ? "risk_budget" as const : "visible_liquidity" as const,
    canApplyRecommendedNotional: !allowed,
    twoRTargetPrice: 110,
  };
}
