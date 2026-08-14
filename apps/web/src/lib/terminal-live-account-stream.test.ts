import { describe, expect, it } from "vitest";
import type { HyperliquidAccountSnapshot } from "./private-account-client";
import {
  terminalLiveAccountPublicationPriority,
  terminalLiveAccountStreamKey,
  transitionTerminalLiveAccountStreamState,
} from "./terminal-live-account-stream";

describe("terminal live account stream state", () => {
  it("keeps authorization-bearing snapshots, status, and expiry urgent", () => {
    expect(terminalLiveAccountPublicationPriority("snapshot")).toBe("urgent");
    expect(terminalLiveAccountPublicationPriority("status")).toBe("urgent");
    expect(terminalLiveAccountPublicationPriority("freshness_clock")).toBe("urgent");
    expect(terminalLiveAccountPublicationPriority("account_event")).toBe("deferred");
  });
  it("creates a new exact identity for each explicit reconnect", () => {
    const input = { authenticated: true, subjectScope: "subject_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", selectedVenue: "hyperliquid", expectedNetwork: "mainnet" as const, coin: "BTC" as const };
    expect(terminalLiveAccountStreamKey(input)).not.toBe(terminalLiveAccountStreamKey({ ...input, restartKey: 1 }));
    expect(terminalLiveAccountStreamKey({ ...input, restartKey: 1 })).toBe(terminalLiveAccountStreamKey({ ...input, restartKey: 1 }));
  });

  it("separates authenticated subjects and fails closed when subject scope is absent", () => {
    const input = { authenticated: true, subjectScope: "subject_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", selectedVenue: "hyperliquid", expectedNetwork: "mainnet" as const, coin: "BTC" as const };
    expect(terminalLiveAccountStreamKey(input)).not.toBe(terminalLiveAccountStreamKey({ ...input, subjectScope: "subject_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }));
    expect(terminalLiveAccountStreamKey(input)).not.toBe(terminalLiveAccountStreamKey({ ...input, subjectScope: null }));
  });

  it("never lets a status heartbeat refresh portfolio snapshot age", () => {
    const token = Symbol("BTC-mainnet");
    const current = state(token, snapshot(), 100);
    const next = transitionTerminalLiveAccountStreamState({
      current,
      selectedToken: token,
      eventToken: token,
      key: "BTC-mainnet",
      event: { type: "status", status: "live" },
    });

    expect(next.snapshot).toBe(current.snapshot);
    expect(next.snapshotObservedAtMs).toBe(100);
    expect(next.status).toBe("live");
  });

  it("allows the current selection to replace prior keyed state", () => {
    const oldToken = Symbol("old");
    const nextToken = Symbol("next");
    const nextSnapshot = snapshot();
    const next = transitionTerminalLiveAccountStreamState({
      current: state(oldToken, snapshot(), 100),
      selectedToken: nextToken,
      eventToken: nextToken,
      key: "ETH-testnet",
      event: { type: "snapshot", snapshot: nextSnapshot, observedAtMs: 200 },
    });

    expect(next).toMatchObject({ key: "ETH-testnet", snapshot: nextSnapshot, snapshotObservedAtMs: 200 });
    expect(next.token).toBe(nextToken);
  });

  it("rejects delayed callbacks from an old ABA token", () => {
    const oldA = Symbol("A-old");
    const newA = Symbol("A-new");
    const current = state(newA, snapshot(), 300);
    const next = transitionTerminalLiveAccountStreamState({
      current,
      selectedToken: newA,
      eventToken: oldA,
      key: "BTC-mainnet",
      event: { type: "snapshot", snapshot: snapshot(), observedAtMs: 400 },
    });

    expect(next).toBe(current);
  });

  it("a status-first new stream remains data-empty until a snapshot arrives", () => {
    const oldToken = Symbol("old");
    const nextToken = Symbol("next");
    const next = transitionTerminalLiveAccountStreamState({
      current: state(oldToken, snapshot(), 100),
      selectedToken: nextToken,
      eventToken: nextToken,
      key: "SOL-mainnet",
      event: { type: "status", status: "connecting" },
    });

    expect(next).toMatchObject({ key: "SOL-mainnet", snapshot: null, snapshotObservedAtMs: null, status: "connecting", orderEvents: [] });
  });

  it("retains bounded lifecycle events only for the exact selection token", () => {
    const token = Symbol("BTC-mainnet");
    const current = state(token, snapshot(), 100);
    const next = transitionTerminalLiveAccountStreamState({
      current,
      selectedToken: token,
      eventToken: token,
      key: "BTC-mainnet",
      event: { type: "account_event", raw: orderEvent(), observedAtMs: Date.parse("2026-08-13T12:00:01.000Z") },
    });
    expect(next.orderEvents).toHaveLength(1);
    const delayed = transitionTerminalLiveAccountStreamState({
      current: next,
      selectedToken: Symbol("new"),
      eventToken: token,
      key: "ETH-mainnet",
      event: { type: "account_event", raw: orderEvent(), observedAtMs: Date.parse("2026-08-13T12:00:02.000Z") },
    });
    expect(delayed).toBe(next);
  });
});

function state(token: symbol, value: HyperliquidAccountSnapshot | null, observedAtMs: number | null) {
  return { token, key: "BTC-mainnet", snapshot: value, status: "live" as const, snapshotObservedAtMs: observedAtMs, orderEvents: [] };
}

function orderEvent() {
  return {
    type: "order_update",
    updated_at: "2026-08-13T12:00:00.000Z",
    updates: [{ order_handle_commitment: "order_commitment_123", market: "BTC", status: "canceled", side: "sell", size_bucket: "0.1-1", price_bucket: "10k+", time_bucket: "2026-08-13T12:00:00.000Z" }],
  };
}

function snapshot(): HyperliquidAccountSnapshot {
  return {
    version: 1,
    platform_class: "hyperliquid_style_market",
    venue_id: "hyperliquid",
    status: "ready_to_trade",
    account_source: "sealed_byo",
    network: "mainnet",
    trading_enabled: true,
    equity_bucket: "ready",
    margin_utilization_bucket: "<25%",
    position_count: 0,
    position_total_count: 0,
    positions_truncated: false,
    open_order_count: 0,
    open_order_total_count: 0,
    open_orders_truncated: false,
    stream_status: "live",
    last_checked_at: "2026-08-13T12:00:00.000Z",
    next_step: "ready",
    positions: [],
    open_orders: [],
    recent_fills: [],
  };
}
