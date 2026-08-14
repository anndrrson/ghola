import { describe, expect, it } from "vitest";
import type { PrivateAccountLiveTradingStatus } from "./private-account-client";
import {
  inspectTerminalLiveTradingStatus,
  terminalByoExecutionReadiness,
  terminalByoVenueReady,
  terminalLiveStatusChronologyDecision,
} from "./terminal-live-readiness";

const NOW = Date.parse("2026-08-12T17:00:00.000Z");

describe("terminal BYO readiness", () => {
  it("requires fresh global BYO and selected-venue green gates", () => {
    const status = fixture();
    expect(terminalByoVenueReady(status, "hyperliquid", NOW, NOW)).toBe(true);
    expect(terminalByoVenueReady({ ...status, status: "red" }, "hyperliquid", NOW, NOW)).toBe(false);
    expect(terminalByoVenueReady({ ...status, byo_live_trading_enabled: false }, "hyperliquid", NOW, NOW)).toBe(false);
    expect(terminalByoVenueReady(status, "coinbase", NOW, NOW)).toBe(false);
    expect(terminalByoVenueReady(status, "hyperliquid", NOW - 30_001, NOW)).toBe(false);
    expect(terminalByoVenueReady({
      ...status,
      checked_at: new Date(NOW - 30_001).toISOString(),
    }, "hyperliquid", NOW, NOW)).toBe(false);
  });

  it("allows Hyperliquid IOC and blocks resting terminal plans despite green venue gates", () => {
    const status = fixture(["hyperliquid", "coinbase", "phoenix"]);
    expect(terminalByoExecutionReadiness(
      status,
      "hyperliquid",
      NOW,
      liveOrder("hyperliquid"),
      NOW,
    ).allowed).toBe(true);
    expect(terminalByoExecutionReadiness(
      status,
      "coinbase",
      NOW,
      liveOrder("coinbase"),
      NOW,
    )).toMatchObject({
      allowed: false,
      reason_code: "coinbase_live_execution_recovery_unproven",
    });
    expect(terminalByoExecutionReadiness(
      status,
      "phoenix",
      NOW,
      liveOrder("phoenix"),
      NOW,
    )).toMatchObject({
      allowed: false,
      reason_code: "phoenix_live_execution_recovery_unproven",
    });
  });

  it("keeps Coinbase visibly unavailable even when both live gates are green", () => {
    const status = fixture(["coinbase"]);
    expect(terminalByoExecutionReadiness(
      status,
      "coinbase",
      NOW,
      { ...liveOrder("coinbase"), time_in_force: "ioc", post_only: false },
      NOW,
    )).toMatchObject({
      allowed: false,
      reason_code: "coinbase_live_execution_recovery_unproven",
    });
  });

  it("fails closed for a missing or cross-venue exact plan", () => {
    const status = fixture(["hyperliquid", "coinbase"]);
    expect(terminalByoExecutionReadiness(status, "coinbase", NOW, null, NOW).reason_code)
      .toBe("terminal_exact_order_plan_unavailable");
    expect(terminalByoExecutionReadiness(
      status,
      "coinbase",
      NOW,
      liveOrder("hyperliquid"),
      NOW,
    ).reason_code).toBe("terminal_exact_order_plan_unavailable");
  });

  it("blocks equal-clock authorization contradictions until a strictly newer status", () => {
    const green = fixture();
    const accepted = terminalLiveStatusChronologyDecision({
      current: null,
      latestCheckedAtMs: Number.NEGATIVE_INFINITY,
      candidate: green,
      nowMs: NOW,
    });
    expect(accepted.action).toBe("accept");
    const collision = terminalLiveStatusChronologyDecision({
      current: green,
      latestCheckedAtMs: NOW,
      candidate: { ...green, status: "red" },
      nowMs: NOW,
    });
    expect(collision).toEqual({ action: "block", status: null, checkedAtMs: NOW });
    expect(terminalLiveStatusChronologyDecision({
      current: null,
      latestCheckedAtMs: collision.checkedAtMs,
      candidate: green,
      nowMs: NOW,
    }).action).toBe("block");
    expect(terminalLiveStatusChronologyDecision({
      current: null,
      latestCheckedAtMs: collision.checkedAtMs,
      candidate: { ...green, checked_at: new Date(NOW + 1).toISOString() },
      nowMs: NOW + 1,
    }).action).toBe("accept");
  });

  it("rejects malformed live-status payloads without throwing readiness", () => {
    expect(inspectTerminalLiveTradingStatus({ ...fixture(), byo_live_venues: null })).toBeNull();
    expect(inspectTerminalLiveTradingStatus({ ...fixture(), reason_codes: ["x", 1] })).toBeNull();
    expect(inspectTerminalLiveTradingStatus({
      ...fixture(),
      byo_live_venues: [fixture().byo_live_venues[0], { ...fixture().byo_live_venues[0], status: "red" }],
    })).toBeNull();
    expect(terminalByoVenueReady({ ...fixture(), byo_live_venues: null } as unknown as PrivateAccountLiveTradingStatus, "hyperliquid", NOW, NOW)).toBe(false);
  });

  it("blocks future status clocks without poisoning the accepted high-water mark", () => {
    expect(terminalLiveStatusChronologyDecision({
      current: fixture(),
      latestCheckedAtMs: NOW,
      candidate: { ...fixture(), checked_at: new Date(NOW + 30_001).toISOString() },
      nowMs: NOW,
    })).toEqual({ action: "block", status: null, checkedAtMs: NOW });
  });
});

function fixture(
  venues: Array<"hyperliquid" | "phoenix" | "coinbase"> = ["hyperliquid"],
): PrivateAccountLiveTradingStatus {
  return {
    version: 1,
    status: "green",
    live_trading_enabled: true,
    live_submit_mode: "byo_mainnet",
    byo_live_trading_enabled: true,
    pooled_live_trading_enabled: false,
    public_live_copy_allowed: false,
    public_market_data_enabled: false,
    default_access_mode: "ghola_auto_access",
    required_venues: [],
    byo_live_venues: venues.map((id) => ({
      id,
      label: id === "hyperliquid" ? "Hyperliquid" : id === "phoenix" ? "Phoenix" : "Coinbase",
      submit_source: "user_scoped_credential",
      status: "green",
      reason_codes: [],
    })),
    pooled_reason_codes: [],
    reason_codes: [],
    gate_commitment: "gate",
    checked_at: new Date(NOW).toISOString(),
  };
}

function liveOrder(venue_id: "hyperliquid" | "phoenix" | "coinbase") {
  return {
    venue_id,
    order_type: "limit",
    time_in_force: venue_id === "hyperliquid" ? "ioc" : "gtc",
  };
}
