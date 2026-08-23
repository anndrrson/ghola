import { describe, expect, it } from "vitest";
import type { PrivateExecutionOrderDraft } from "@/lib/private-execution-instruction-seal";
import {
  buildHyperliquidReduceOnlyClose,
  classifyHyperliquidTradeFailure,
  hyperliquidAccountIsFlatAndClear,
  provenHyperliquidFill,
} from "@/lib/hyperliquid-trade-lifecycle";

function entryOrder(): PrivateExecutionOrderDraft {
  return {
    venue_id: "hyperliquid",
    operation_class: "limit_order",
    market: "HYPE",
    side: "buy",
    base_size: "",
    quote_size: "11",
    limit_price: "",
    order_type: "market",
    size_mode: "quote",
    tif: "Ioc",
    max_slippage_bps: "100",
    reduce_only: false,
    post_only: false,
    leverage: 1,
    margin_mode: "cross",
    protective_orders: { stop_loss: "77.35" },
  };
}

describe("Hyperliquid trade lifecycle", () => {
  it("locks ambiguous submissions and preserves their correlation ID", () => {
    const error = Object.assign(new Error("connector_submit_ambiguous"), {
      correlationId: "ghola_trace_123",
    });
    const failure = classifyHyperliquidTradeFailure(error);

    expect(failure).toMatchObject({
      code: "connector_submit_ambiguous",
      correlationId: "ghola_trace_123",
      retryForbidden: true,
      reconciliationRequired: true,
    });
    expect(failure.message).toContain("will never resubmit");
  });

  it("does not mislabel a venue rejection as a worker reconnect", () => {
    expect(classifyHyperliquidTradeFailure(new Error("venue_rejected"))).toMatchObject({
      code: "venue_rejected",
      retryForbidden: false,
      reconciliationRequired: false,
    });
  });

  it("requires proof-v2 reconciliation with an exact fill before closing", () => {
    expect(provenHyperliquidFill({
      status: "submitted",
      final_proof: {
        proof_kind: "hyperliquid_immediate_order_state_v1",
        final_venue_execution_proven: true,
        final_fill_proven: true,
        filled_base_size: "0.14",
      },
    })).toBeNull();

    expect(provenHyperliquidFill({
      status: "reconciled",
      final_proof: {
        proof_kind: "hyperliquid_order_status_reconciliation_v1",
        final_venue_execution_proven: true,
        final_fill_proven: true,
        filled_base_size: "0.14",
        checked_at: "2026-08-22T23:00:00.000Z",
      },
    })).toEqual({
      baseSize: "0.14",
      proofKind: "hyperliquid_order_status_reconciliation_v1",
      checkedAt: "2026-08-22T23:00:00.000Z",
    });
  });

  it("builds an exact-size opposite-side reduce-only close without protection", () => {
    const close = buildHyperliquidReduceOnlyClose(entryOrder(), {
      baseSize: "0.14",
      proofKind: "hyperliquid_order_status_reconciliation_v1",
      checkedAt: null,
    });

    expect(close).toMatchObject({
      market: "HYPE",
      side: "sell",
      base_size: "0.14",
      quote_size: "",
      order_type: "market",
      size_mode: "base",
      tif: "Ioc",
      reduce_only: true,
      post_only: false,
    });
    expect(close.protective_orders).toBeUndefined();
  });

  it("requires both zero positions and zero open orders", () => {
    expect(hyperliquidAccountIsFlatAndClear({ position_count: 0, open_order_count: 0 })).toBe(true);
    expect(hyperliquidAccountIsFlatAndClear({ position_count: 0, open_order_count: 1 })).toBe(false);
    expect(hyperliquidAccountIsFlatAndClear({ position_count: 1, open_order_count: 0 })).toBe(false);
  });
});
