import { describe, expect, it } from "vitest";
import { hasExactCarryFlatReconciliation } from "./carry-reconciliation";

describe("carry reconciliation", () => {
  it("rejects aggregate-only flat claims and accepts exact venue rows", () => {
    const evidence = {
      owner_commitment: "owner:carry:web:0001",
      carry_position_id: "carry:position:web:0001",
      account_state_checked: true,
      transaction_broadcast: false,
      gross_exposure_micro_usdc: 0,
      open_order_count: 0,
      checked_at_ms: 1_800_000_000_000,
      reconciliation_commitment: "carry:reconciliation:web:0001",
      venues: ["hyperliquid", "lighter"].map((venue_id) => ({
        venue_id,
        account_commitment: `account:${venue_id}:web:0001`,
        authorized: true,
        flat_zero_orders: true,
        position_count: 0,
        open_order_count: 0,
        account_state_checked: true,
      })),
    };
    expect(hasExactCarryFlatReconciliation({ ...evidence, venues: undefined }, ["hyperliquid", "lighter"])).toBe(false);
    expect(hasExactCarryFlatReconciliation(evidence, ["hyperliquid", "lighter"])).toBe(true);
    expect(hasExactCarryFlatReconciliation({ ...evidence, owner_commitment: "" }, ["hyperliquid", "lighter"])).toBe(false);
    expect(hasExactCarryFlatReconciliation({ ...evidence, venues: evidence.venues.map((item, index) => index ? { ...item, account_commitment: "" } : item) }, ["hyperliquid", "lighter"])).toBe(false);
  });
});
