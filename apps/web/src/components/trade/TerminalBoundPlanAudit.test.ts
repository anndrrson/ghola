import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalBoundPlanAudit as TerminalBoundPlanAuditDecision } from "@/lib/terminal-bound-plan-audit";
import type { TradeOrderPlan } from "@/lib/trade-order-plan";
import { TerminalBoundPlanAudit } from "./TerminalBoundPlanAudit";

describe("TerminalBoundPlanAudit", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("shows bounded changes and only focuses editable fields", () => {
    const onFocusField = vi.fn();
    act(() => root.render(createElement(TerminalBoundPlanAudit, {
      audit: audit(),
      onFocusField,
    })));

    expect(container.textContent).toContain("Audit-only snapshot; it contains no token and cannot authorize execution.");
    expect(container.textContent).toContain("2 bound fields changed");
    const buttons = [...container.querySelectorAll("button")];
    expect(buttons.map((button) => button.textContent)).toEqual(["Order value"]);
    act(() => buttons[0].click());
    expect(onFocusField).toHaveBeenCalledWith("notional");
  });
});

function audit(): TerminalBoundPlanAuditDecision {
  return {
    status: "changed",
    snapshot: {
      planDigest: `sha256:${"a".repeat(64)}`,
      issuedAt: "2026-08-13T11:59:50.000Z",
      expiresAt: "2026-08-13T12:00:10.000Z",
      orderPlan: {} as TradeOrderPlan,
    },
    differences: [
      { field: "notional", label: "Order value", boundValue: "10", currentValue: "25" },
      { field: "strategy", label: "Strategy", boundValue: "trend_following", currentValue: "mean_reversion" },
    ],
    expired: false,
    marketStale: false,
  };
}
