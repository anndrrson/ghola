import { describe, expect, it } from "vitest";
import { hasExactCarryFlatReconciliation } from "./carry-reconciliation";

describe("carry reconciliation", () => {
  it("rejects aggregate-only flat claims and accepts exact venue rows", () => {
    const evidence = {
      account_state_checked: true,
      transaction_broadcast: false,
      gross_exposure_micro_usdc: 0,
      open_order_count: 0,
      checked_at_ms: 1_800_000_000_000,
      reconciliation_commitment: "carry:reconciliation:web:0001",
      venues: ["hyperliquid", "lighter"].map((venue_id) => ({
        venue_id,
        authorized: true,
        flat_zero_orders: true,
        position_count: 0,
        open_order_count: 0,
        account_state_checked: true,
      })),
    };
    expect(hasExactCarryFlatReconciliation({ ...evidence, venues: undefined }, ["hyperliquid", "lighter"])).toBe(false);
    expect(hasExactCarryFlatReconciliation(evidence, ["hyperliquid", "lighter"])).toBe(true);
  });
});
