import { describe, expect, it } from "vitest";
import { privateAgentTradingMeterEvent } from "./private-agent-trading-billing";

const receipt = {
  work_order_commitment: "work_order_12345678",
  connector_result_commitment: "connector_result_12345678",
  platform_class: "hyperliquid_style_market",
  fill_commitments: ["fill_b", "fill_a"],
  fill_summary: { fill_count: 2, filled_notional_usd: 123.456789 },
};

describe("privateAgentTradingMeterEvent", () => {
  it("meters actual partial-fill notional in micro USD", () => {
    expect(privateAgentTradingMeterEvent(receipt)).toMatchObject({
      fill_count: 2,
      filled_notional_micro_usd: 123_456_789,
    });
  });

  it("uses the fill set as the idempotency identity across submit and reconcile", () => {
    const submit = privateAgentTradingMeterEvent(receipt);
    const reconcile = privateAgentTradingMeterEvent({
      ...receipt,
      connector_result_commitment: "connector_result_reconciled_12345678",
      fill_commitments: ["fill_a", "fill_b"],
    });
    expect(reconcile?.event_id).toBe(submit?.event_id);
  });

  it("does not meter rejected or completely unfilled orders", () => {
    expect(privateAgentTradingMeterEvent({
      ...receipt,
      fill_commitments: [],
      fill_summary: { fill_count: 0, filled_notional_usd: 0 },
    })).toBeNull();
  });
});
