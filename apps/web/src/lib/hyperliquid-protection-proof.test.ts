import { describe, expect, it } from "vitest";
import type { HyperliquidAccountSnapshot } from "@/lib/private-account-client";
import type { PrivateExecutionOrderDraft } from "@/lib/private-execution-instruction-seal";
import {
  hyperliquidTriggerPriceCommitment,
  proveHyperliquidEntryProtection,
} from "@/lib/hyperliquid-protection-proof";

const order: PrivateExecutionOrderDraft = {
  venue_id: "hyperliquid",
  operation_class: "limit_order",
  market: "HYPE",
  side: "buy",
  base_size: "",
  quote_size: "11",
  limit_price: "",
  order_type: "market",
  size_mode: "quote",
  live_order_mode: "tiny_fill",
  tif: "Ioc",
  max_slippage_bps: "50",
  reduce_only: false,
  post_only: false,
  leverage: 1,
  margin_mode: "cross",
  protective_orders: { stop_loss: "77.35" },
};

function snapshot(overrides: Partial<HyperliquidAccountSnapshot> = {}): HyperliquidAccountSnapshot {
  return {
    version: 1,
    platform_class: "hyperliquid_style_market",
    venue_id: "hyperliquid",
    status: "ready_to_trade",
    account_source: "sealed_byo",
    trading_enabled: true,
    equity_bucket: "ready",
    position_count: 1,
    open_order_count: 1,
    positions: [{
      position_commitment: "position_hype_long",
      market: "HYPE",
      side: "long",
      size_bucket: "0.1-1",
      entry_price_bucket: "10-100",
      unrealized_pnl_bucket: "none",
    }],
    open_orders: [{
      order_handle_commitment: "stop_order_commitment",
      market: "HYPE",
      side: "sell",
      size_bucket: "0.1-1",
      price_bucket: "10-100",
      status: "open",
      reduce_only: true,
      is_trigger: true,
      trigger_kind: "sl",
      trigger_price_bucket: "10-100",
      trigger_price_commitment: hyperliquidTriggerPriceCommitment({
        network: "mainnet",
        market: "HYPE",
        triggerPrice: "77.3500",
      }),
    }],
    last_checked_at: "2026-08-22T23:00:00.000Z",
    next_step: "Preview trade",
    ...overrides,
  };
}

describe("Hyperliquid protection proof", () => {
  it("proves the exact reduce-only stop from venue trigger metadata", () => {
    expect(proveHyperliquidEntryProtection({ network: "mainnet", order, snapshot: snapshot() })).toEqual({
      status: "proven",
      expected_order_count: 1,
      matched_order_count: 1,
      matching_order_commitments: ["stop_order_commitment"],
      checked_at: "2026-08-22T23:00:00.000Z",
    });
  });

  it("fails closed when the trigger price or order set does not match", () => {
    const wrongPrice = snapshot({
      open_orders: [{
        ...snapshot().open_orders![0],
        trigger_price_commitment: hyperliquidTriggerPriceCommitment({
          network: "mainnet",
          market: "HYPE",
          triggerPrice: "76",
        }),
      }],
    });
    expect(proveHyperliquidEntryProtection({ network: "mainnet", order, snapshot: wrongPrice }).status).toBe("unproven");
    expect(proveHyperliquidEntryProtection({
      network: "mainnet",
      order,
      snapshot: snapshot({ open_order_count: 2 }),
    }).status).toBe("unproven");
  });
});
