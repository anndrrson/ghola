import { describe, expect, it } from "vitest";
import type { PrivateExecutionOrderDraft } from "@/lib/private-execution-instruction-seal";
import { validatePerpTicket } from "./PublicCoinbaseLiveTrade";

function ticket(quoteSize: string): PrivateExecutionOrderDraft {
  return {
    venue_id: "hyperliquid",
    operation_class: "limit_order",
    market: "SOL",
    side: "buy",
    base_size: "",
    quote_size: quoteSize,
    limit_price: "",
    order_type: "market",
    size_mode: "quote",
    tif: "Ioc",
    max_slippage_bps: "50",
    leverage: 1,
    margin_mode: "cross",
  };
}

describe("bounded Hyperliquid ticket", () => {
  it("accepts the exact $10 venue minimum and launch cap", () => {
    expect(validatePerpTicket(ticket("10"), "70", 20, 50)).toEqual([]);
  });

  it("rejects notionals below the venue minimum or above the launch cap", () => {
    expect(validatePerpTicket(ticket("5"), "70", 20, 50)).toContain(
      "Hyperliquid orders must be at least $10.",
    );
    expect(validatePerpTicket(ticket("11"), "70", 20, 50)).toContain(
      "Orders are capped at $10 during the bounded mainnet launch.",
    );
  });
});
