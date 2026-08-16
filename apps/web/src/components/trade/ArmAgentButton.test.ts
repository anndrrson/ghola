import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrivateExecutionOrderDraft } from "@/lib/private-execution-instruction-seal";

const clientMocks = vi.hoisted(() => ({ arm: vi.fn() }));

vi.mock("@/lib/private-account-client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/private-account-client")>(),
  armLevelTriggerAgent: clientMocks.arm,
}));

import { ArmAgentButton, levelTriggerPlanFromOrderDraft } from "./ArmAgentButton";

afterEach(() => clientMocks.arm.mockReset());

describe("levelTriggerPlanFromOrderDraft", () => {
  it("uses the displayed entry price as the immediate-entry mandate level", () => {
    const plan = levelTriggerPlanFromOrderDraft({
      venue_id: "hyperliquid",
      operation_class: "limit_order",
      market: "BTC-PERP",
      side: "buy",
      base_size: "0.001",
      quote_size: "10",
      limit_price: "65266.5",
      max_slippage_bps: "50",
      order_type: "limit",
      size_mode: "quote",
      agent_entry_trigger: "preview_now",
      agent_invalidation_level: "64777.0",
    });

    expect(plan.triggerLevel).toBe("65266.5");
    expect(plan.entryTrigger).toBe("preview_now");
  });
});

describe("ArmAgentButton exact-plan arming", () => {
  it("offers confirmation for a supported exact Hyperliquid plan", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const draft = orderDraft();

    await act(async () => root.render(createElement(ArmAgentButton, { orderDraft: draft, ready: true })));
    const button = findButton(container, "Arm agent for this plan");
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    expect(container.textContent).toContain("Yes, arm it");
    expect(clientMocks.arm).not.toHaveBeenCalled();

    act(() => root.unmount());
    container.remove();
  });
});

function orderDraft(): PrivateExecutionOrderDraft {
  return {
    venue_id: "hyperliquid",
    operation_class: "limit_order",
    market: "BTC-PERP",
    side: "buy",
    base_size: "0.001",
    quote_size: "10",
    limit_price: "65266.5",
    max_slippage_bps: "50",
    order_type: "limit",
    size_mode: "quote",
    agent_entry_trigger: "break_level",
    agent_trigger_level: "65266.5",
    agent_invalidation_level: "64777.0",
  };
}

function findButton(container: HTMLElement, label: string) {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
    .find((item) => item.textContent?.includes(label));
  if (!button) throw new Error(`button_not_found:${label}`);
  return button;
}
