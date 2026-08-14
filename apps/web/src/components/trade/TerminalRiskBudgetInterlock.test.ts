import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveTerminalRiskBudgetInterlock } from "@/lib/terminal-risk-budget-interlock";
import { TerminalRiskBudgetInterlock } from "./TerminalRiskBudgetInterlock";
import { deriveTerminalPlanLossEnvelope } from "@/lib/terminal-plan-loss-envelope";

describe("TerminalRiskBudgetInterlock", () => {
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

  it("announces a block, discloses local limitations, and applies the safe size", () => {
    const onApplySafeNotional = vi.fn();
    const decision = deriveTerminalRiskBudgetInterlock({
      riskBudgetUsd: 10,
      modeledLossUsd: 12.5,
      safeNotionalUsd: 80,
      currentNotionalUsd: 100,
      minimumNotionalUsd: 1,
    });

    act(() => root.render(createElement(TerminalRiskBudgetInterlock, {
      decision,
      lossEnvelope: envelope(),
      sizeRecommendation: {
        notionalUsd: 60,
        constraint: "visible_liquidity",
        canApply: true,
        riskCapNotionalUsd: 80,
        visibleFullFillNotionalUsd: 60,
      },
      onApplySafeNotional,
      onOpenCostPolicy: vi.fn(),
    })));

    expect(container.querySelector('[role="status"]')?.textContent).toContain("BLOCKED");
    expect(container.textContent).toContain("$12.50");
    expect(container.textContent).toContain("$10.00");
    expect(container.textContent).toContain("125.0%");
    expect(container.textContent).toContain("not a venue bracket order");
    expect(container.textContent).toContain("Round-trip cost");
    const button = container.querySelector<HTMLButtonElement>("button");
    expect(button?.id).toBe("terminal-apply-safe-size");
    expect(button?.textContent).toContain("Reduce to $60.00 · depth cap");
    act(() => button?.click());
    expect(onApplySafeNotional).toHaveBeenCalledWith(60);
  });

  it("renders unavailable values and routes missing cost evidence to configuration", () => {
    const decision = deriveTerminalRiskBudgetInterlock({
      riskBudgetUsd: 0,
      modeledLossUsd: null,
      safeNotionalUsd: 0.5,
      currentNotionalUsd: 10,
      minimumNotionalUsd: 1,
    });

    const onOpenCostPolicy = vi.fn();
    act(() => root.render(createElement(TerminalRiskBudgetInterlock, {
      decision,
      lossEnvelope: envelope({ status: "blocked", feeConfigured: false, bufferConfigured: false }),
      sizeRecommendation: null,
      onApplySafeNotional: vi.fn(),
      onOpenCostPolicy,
    })));

    expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuetext")).toBe("Unavailable");
    const button = container.querySelector<HTMLButtonElement>("button");
    expect(button?.textContent).toBe("Set route costs");
    act(() => button?.click());
    expect(onOpenCostPolicy).toHaveBeenCalledOnce();
  });

  it("labels a larger modeled cap without offering an upsize action", () => {
    act(() => root.render(createElement(TerminalRiskBudgetInterlock, {
      decision: deriveTerminalRiskBudgetInterlock({
        riskBudgetUsd: 10,
        modeledLossUsd: 1,
        safeNotionalUsd: 100,
        currentNotionalUsd: 10,
        minimumNotionalUsd: 1,
      }),
      lossEnvelope: envelope(),
      sizeRecommendation: {
        notionalUsd: 100,
        constraint: "risk_budget",
        canApply: false,
        riskCapNotionalUsd: 100,
        visibleFullFillNotionalUsd: null,
      },
      onApplySafeNotional: vi.fn(),
      onOpenCostPolicy: vi.fn(),
    })));
    const button = container.querySelector<HTMLButtonElement>("button");
    expect(button?.disabled).toBe(true);
    expect(button?.textContent).toContain("Modeled cap $100.00 · risk cap");
    expect(container.textContent).toContain("never upsizes");
  });
});

function envelope(costEvidence: Partial<Parameters<typeof deriveTerminalPlanLossEnvelope>[0]["costEvidence"]> = {}) {
  return deriveTerminalPlanLossEnvelope({
    notionalUsd: 100,
    stopAndSlippageLossUsd: 5,
    stopAndSlippageRiskBps: 500,
    riskBudgetUsd: 10,
    maxNotionalUsd: 100,
    costEvidence: { status: "ready", feeBps: 5, bufferBps: 5, feeConfigured: true, bufferConfigured: true, feeCurrent: true, bufferCurrent: true, feeUpdatedAtMs: 1, bufferUpdatedAtMs: 1, ageMs: 0, expiresAtMs: 1, ...costEvidence },
  });
}
