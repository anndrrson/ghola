import { describe, expect, it } from "vitest";
import { levelTriggerPlanFromOrderDraft } from "./ArmAgentButton";

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
