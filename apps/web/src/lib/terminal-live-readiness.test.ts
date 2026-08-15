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

  it("allows recovery-backed IOC and blocks resting plans despite green venue gates", () => {
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
      reason_code: "coinbase_order_mode_recovery_unproven",
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

  it("requires the exact protected plan and every protection proof when protection is public", () => {
    const base = fixture();
    const protectedStatus: PrivateAccountLiveTradingStatus = {
      ...base,
      live_worker_readiness: {
        ...base.live_worker_readiness,
        capabilities: ["limit_order", "stop_loss", "take_profit"],
      },
      hyperliquid_capabilities: [
        ...base.hyperliquid_capabilities,
        liveCapability("stop_loss"),
        liveCapability("take_profit"),
      ],
    };
    expect(terminalByoExecutionReadiness(
      protectedStatus,
      "hyperliquid",
      NOW,
      liveOrder("hyperliquid"),
      NOW,
    )).toMatchObject({
      allowed: false,
      reason_code: "terminal_live_protection_plan_required",
    });
    expect(terminalByoExecutionReadiness(
      protectedStatus,
      "hyperliquid",
      NOW,
      { ...liveOrder("hyperliquid"), protection_intent: {} },
      NOW,
    ).allowed).toBe(true);

    const unprovenStatus = {
      ...protectedStatus,
      hyperliquid_capabilities: protectedStatus.hyperliquid_capabilities.map((capability) =>
        capability.id === "take_profit" ? { ...capability, state: "verifying" as const } : capability
      ),
    };
    expect(terminalByoExecutionReadiness(
      unprovenStatus,
      "hyperliquid",
      NOW,
      { ...liveOrder("hyperliquid"), protection_intent: {} },
      NOW,
    )).toMatchObject({
      allowed: false,
      reason_code: "terminal_live_capability_not_proven",
    });
  });

  it("keeps Coinbase execution hidden even when a legacy venue gate is green", () => {
    const status = fixture(["coinbase"]);
    expect(terminalByoExecutionReadiness(
      status,
      "coinbase",
      NOW,
      { ...liveOrder("coinbase"), time_in_force: "ioc", post_only: false },
      NOW,
    )).toMatchObject({
      allowed: false,
      reason_code: "terminal_live_capability_not_proven",
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
    contract_version: 2,
    status: "green",
    launch_state: "public",
    live_trading_enabled: true,
    live_submit_mode: "byo_mainnet",
    byo_live_trading_enabled: true,
    pooled_live_trading_enabled: false,
    public_live_copy_allowed: false,
    public_market_data_enabled: false,
    release_identity: {
      contract_version: 2,
      web_git_sha: "a".repeat(40),
      worker_git_sha: "a".repeat(40),
      worker_image_digest: `sha256:${"b".repeat(64)}`,
      config_fingerprint: "live_trading_config_test",
      valid: true,
      reason_codes: [],
    },
    live_worker_readiness: {
      ready: true,
      endpoint_configured: true,
      contract_version: 2,
      worker_git_sha: "a".repeat(40),
      worker_image_digest: `sha256:${"b".repeat(64)}`,
      config_fingerprint: "live_trading_config_test",
      capabilities: ["limit_order"],
      reason_codes: [],
      checked_at: new Date(NOW).toISOString(),
    },
    effective_caps: {
      first_proof_notional_usd: 10.5,
      max_order_notional_usd: 100,
      rolling_24h_notional_usd: 500,
      default_slippage_bps: 50,
      max_slippage_bps: 100,
    },
    proof_policy: {
      venue_id: "hyperliquid",
      network: "mainnet",
      first_proof_notional_usd: 10.5,
      required_consecutive_passes: 3,
      final_flat_required: true,
      zero_open_orders_required: true,
    },
    hyperliquid_capabilities: [{
      id: "limit_order",
      state: "live",
      visible: true,
      consecutive_mainnet_proofs: 3,
      required_mainnet_proofs: 3,
      last_proven_at: new Date(NOW).toISOString(),
      reason_codes: [],
    }],
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

function liveCapability(id: "stop_loss" | "take_profit") {
  return {
    id,
    state: "live" as const,
    visible: true,
    consecutive_mainnet_proofs: 3,
    required_mainnet_proofs: 3,
    last_proven_at: new Date(NOW).toISOString(),
    reason_codes: [],
  };
}
