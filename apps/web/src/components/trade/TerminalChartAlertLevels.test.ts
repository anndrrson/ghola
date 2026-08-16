import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalChartAlertLevels } from "./TerminalChartAlertLevels";
import { deriveTerminalChartPriceAlerts } from "@/lib/terminal-alert-chart";
import type { TerminalAlertRule } from "@/lib/terminal-alerts";

describe("TerminalChartAlertLevels", () => {
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

  it("shows bounded armed levels and opens their manager", () => {
    const onManage = vi.fn();
    const projection = deriveTerminalChartPriceAlerts({
      snapshot: {
        scope: "BTC",
        rules: [
          alertRule("plan-target", "Plan target", 110),
          alertRule("custom-one", "Breakout", 105),
        ],
      },
      expectedScope: "BTC",
    });
    act(() => root.render(createElement(TerminalChartAlertLevels, { projection, replayActive: false, onManage })));

    expect(container.textContent).toContain("Alerts 2/2");
    expect(container.textContent).toContain("↑ 110.00 · Plan target");
    expect(container.textContent).toContain("never stage, preview, or submit orders");
    act(() => requiredButton(container, "Manage").click());
    expect(onManage).toHaveBeenCalledOnce();
  });

  it("hides future alert lines during replay", () => {
    const projection = deriveTerminalChartPriceAlerts({
      snapshot: { scope: "BTC", rules: [alertRule("price-up", "Price up", 101)] },
      expectedScope: "BTC",
    });
    act(() => root.render(createElement(TerminalChartAlertLevels, {
      projection,
      replayActive: true,
      onManage: vi.fn(),
    })));
    expect(container.textContent).toContain("hidden during replay");
    expect(container.textContent).not.toContain("101.00");
  });
});

function requiredButton(container: HTMLElement, text: string) {
  const button = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === text);
  if (!(button instanceof HTMLButtonElement)) throw new Error(`missing button: ${text}`);
  return button;
}

function alertRule(id: string, label: string, threshold: number): TerminalAlertRule {
  return {
    id,
    label,
    metric: "price",
    operator: "above",
    threshold,
    enabled: true,
    cooldownMs: 60_000,
    rearmDelta: 1,
  };
}
