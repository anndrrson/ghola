import { describe, expect, it } from "vitest";
import {
  deriveTerminalLiveAccountView,
  terminalLiveAccountFreshnessDeadline,
  TERMINAL_LIVE_ACCOUNT_ROW_LIMIT,
} from "./terminal-live-account";

const NOW = Date.parse("2026-08-13T02:00:00.000Z");

describe("terminal live account", () => {
  it("accepts an exact fresh privacy-bucketed account snapshot", () => {
    const view = derive({ snapshot: snapshot(), streamStatus: "live", streamObservedAtMs: NOW - 500 });
    expect(view).toMatchObject({
      status: "live",
      blocker: null,
      network: "mainnet",
      accountStatus: "ready_to_trade",
      accountSource: "sealed_byo",
      tradingEnabled: true,
      streamAgeMs: 500,
      nearestLiquidationDistance: "2-5%",
    });
    expect(view.positions).toHaveLength(1);
    expect(view.openOrders).toHaveLength(1);
    expect(view.recentFills).toHaveLength(1);
  });

  it("hides rows for signed-out, wrong-venue, unknown-network, and network-mismatched contexts", () => {
    expect(derive({ authenticated: false }).blocker).toBe("signed_out");
    expect(derive({ selectedVenue: "coinbase" }).blocker).toBe("venue_not_selected");
    expect(derive({ snapshot: { ...snapshot(), network: null } }).blocker).toBe("network_unknown");
    const mismatch = derive({ expectedNetwork: "testnet" });
    expect(mismatch).toMatchObject({ status: "unavailable", blocker: "network_mismatch", positions: [] });
  });

  it("retains validated rows but marks reconnecting and expired streams degraded", () => {
    expect(derive({ streamStatus: "reconnecting" })).toMatchObject({ status: "degraded", blocker: "stream_not_live" });
    expect(derive({ streamObservedAtMs: NOW - 45_001 })).toMatchObject({ status: "degraded", blocker: "stream_stale" });
    expect(derive({ snapshot: { ...snapshot(), last_checked_at: new Date(NOW - 45_001).toISOString() } })).toMatchObject({
      status: "degraded",
      blocker: "stream_stale",
      streamAgeMs: 45_001,
    });
  });

  it("expires at the earliest trusted snapshot or receipt deadline", () => {
    expect(terminalLiveAccountFreshnessDeadline({
      snapshotCheckedAt: new Date(NOW - 5_000).toISOString(),
      streamObservedAtMs: NOW - 1_000,
    })).toBe(NOW + 40_001);
    expect(terminalLiveAccountFreshnessDeadline({
      snapshotCheckedAt: new Date(NOW - 1_000).toISOString(),
      streamObservedAtMs: NOW - 5_000,
    })).toBe(NOW + 40_001);
    expect(terminalLiveAccountFreshnessDeadline({ snapshotCheckedAt: "bad", streamObservedAtMs: NOW })).toBeNull();
  });

  it("surfaces the nearest liquidation bucket across the bounded portfolio", () => {
    const base = snapshot();
    const second = {
      ...base.positions[0],
      position_commitment: "position_commitment_critical",
      market: "ETH",
      liquidation_distance_bucket: "<2%" as const,
    };
    expect(derive({
      snapshot: { ...base, position_count: 2, position_total_count: 2, positions: [...base.positions, second] },
    }).nearestLiquidationDistance).toBe("<2%");
    expect(derive({
      snapshot: { ...base, position_count: 2, position_total_count: 2, positions: [base.positions[0], { ...second, liquidation_distance_bucket: "unknown" as const }] },
    }).nearestLiquidationDistance).toBe("unknown");
  });

  it("preserves an explicit bounded-view truncation signal", () => {
    expect(derive({ snapshot: { ...snapshot(), position_total_count: 13, positions_truncated: true } })).toMatchObject({
      status: "live",
      positionTotalCount: 13,
      positionsTruncated: true,
      positions: [{ market: "BTC" }],
    });
  });

  it("preserves an explicit bounded open-order truncation signal", () => {
    expect(derive({ snapshot: { ...snapshot(), open_order_total_count: 13, open_orders_truncated: true } })).toMatchObject({
      status: "live",
      openOrderTotalCount: 13,
      openOrdersTruncated: true,
      openOrders: [{ market: "BTC" }],
    });
  });

  it("rejects malformed commitments, buckets, timestamps, and oversized arrays", () => {
    const invalid = [
      { ...snapshot(), positions: [{ ...snapshot().positions[0], position_commitment: "raw account id" }] },
      { ...snapshot(), positions: [{ ...snapshot().positions[0], leverage_bucket: "100x exact" }] },
      { ...snapshot(), positions: [{ ...snapshot().positions[0], liquidation_distance_bucket: "3.14159%" }] },
      { ...snapshot(), open_orders: [{ ...snapshot().open_orders[0], price_bucket: "$63,000 exact" }] },
      { ...snapshot(), open_orders: [{ ...snapshot().open_orders[0], status: "canceled" }] },
      { ...snapshot(), recent_fills: [{ ...snapshot().recent_fills[0], time_bucket: "not-time" }] },
      { ...snapshot(), margin_utilization_bucket: "73.2% exact" },
      { ...snapshot(), positions: Array.from({ length: TERMINAL_LIVE_ACCOUNT_ROW_LIMIT + 1 }, () => snapshot().positions[0]) },
      { ...snapshot(), last_checked_at: new Date(NOW + 30_001).toISOString() },
      { ...snapshot(), position_count: 0 },
      { ...snapshot(), position_total_count: 0 },
      { ...snapshot(), positions_truncated: true },
      { ...snapshot(), open_order_total_count: 0 },
      { ...snapshot(), open_orders_truncated: true },
      { ...snapshot(), position_count: 2, position_total_count: 2, positions: [snapshot().positions[0], snapshot().positions[0]] },
      { ...snapshot(), open_order_count: 2, open_order_total_count: 2, open_orders: [snapshot().open_orders[0], snapshot().open_orders[0]] },
      { ...snapshot(), recent_fills: [snapshot().recent_fills[0], snapshot().recent_fills[0]] },
    ];
    for (const value of invalid) {
      expect(derive({ snapshot: value })).toMatchObject({ status: "unavailable", blocker: "snapshot_invalid", positions: [], openOrders: [], recentFills: [] });
    }
  });
});

function derive(overrides: Partial<Parameters<typeof deriveTerminalLiveAccountView>[0]> = {}) {
  return deriveTerminalLiveAccountView({
    authenticated: true,
    selectedVenue: "hyperliquid",
    expectedNetwork: "mainnet",
    snapshot: snapshot(),
    streamStatus: "live",
    streamObservedAtMs: NOW,
    nowMs: NOW,
    ...overrides,
  });
}

function snapshot() {
  return {
    version: 1,
    platform_class: "hyperliquid_style_market",
    venue_id: "hyperliquid",
    status: "ready_to_trade",
    account_source: "sealed_byo",
    network: "mainnet",
    trading_enabled: true,
    equity_bucket: "ready",
    margin_utilization_bucket: "25-50%",
    position_count: 1,
    position_total_count: 1,
    positions_truncated: false,
    open_order_count: 1,
    open_order_total_count: 1,
    open_orders_truncated: false,
    stream_status: "live",
    last_checked_at: new Date(NOW).toISOString(),
    next_step: "Preview trade",
    positions: [{ position_commitment: "position_commitment_123", market: "BTC", side: "long", size_bucket: "0.01-0.1", entry_price_bucket: "10k+", unrealized_pnl_bucket: "+1-10", leverage_bucket: "5-10x", liquidation_distance_bucket: "2-5%" }],
    open_orders: [{ order_handle_commitment: "order_commitment_123", market: "BTC", side: "sell", size_bucket: "0.01-0.1", price_bucket: "10k+", status: "open", reduce_only: true }],
    recent_fills: [{ fill_commitment: "fill_commitment_123", market: "BTC", side: "buy", size_bucket: "0.01-0.1", price_bucket: "10k+", fee_bucket: "-<0.001", time_bucket: new Date(NOW - 60_000).toISOString() }],
  };
}
