import { describe, expect, it } from "vitest";
import { buildHyperliquidCapitalFreeCanary } from "./hyperliquid-release-canary";

const verification = {
  status: "verified_no_funds",
  verification_commitment: "connector_no_submit_verification_test",
  result_commitment: "connector_no_submit_result_test",
  checks: {
    sealed_vault_opened: true,
    sealed_instruction_opened: true,
    authority_derived: true,
    policy_enforced: true,
    live_gate_enforced: true,
    api_wallet_loaded: true,
    hyperliquid_api_reachable: true,
    hyperliquid_sdk_ready: true,
    account_read_checked: true,
    order_request_built: true,
    live_venue_checked: true,
    transaction_broadcast: false,
  },
};

describe("Hyperliquid capital-free release canary", () => {
  it("builds green evidence only for a flat mainnet no-submit proof", () => {
    const result = buildHyperliquidCapitalFreeCanary({
      verification,
      connection_proof_persisted: true,
      network: "mainnet",
      account_state: {
        status: "ready_to_trade",
        position_count: 0,
        open_order_count: 0,
      },
      now: new Date("2026-08-23T07:00:00.000Z"),
      env: {
        GHOLA_LIVE_TRADING_MAX_ORDER_NOTIONAL_USD: "25",
        GHOLA_LIVE_TRADING_DAILY_CAP_USD: "100",
        GHOLA_LIVE_TRADING_MAX_SLIPPAGE_BPS: "50",
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report).toMatchObject({
      status: "green",
      network: "mainnet",
      live_mode: "no_submit",
      broadcast_performed: false,
      position_count: 0,
      open_order_count: 0,
      max_order_notional_usd: 25,
      daily_cap_usd: 100,
      max_slippage_bps: 50,
    });
  });

  it("fails closed if a transaction was broadcast", () => {
    const result = buildHyperliquidCapitalFreeCanary({
      verification: {
        ...verification,
        checks: { ...verification.checks, transaction_broadcast: true },
      },
      connection_proof_persisted: true,
      network: "mainnet",
      account_state: { status: "ready_to_trade", position_count: 0, open_order_count: 0 },
    });

    expect(result).toEqual({ ok: false, reason: "hyperliquid_no_submit_proof_incomplete" });
  });

  it("fails closed unless the venue is flat with zero orders", () => {
    const result = buildHyperliquidCapitalFreeCanary({
      verification,
      connection_proof_persisted: true,
      network: "mainnet",
      account_state: { status: "ready_to_trade", position_count: 1, open_order_count: 1 },
    });

    expect(result).toEqual({ ok: false, reason: "hyperliquid_no_submit_flat_zero_required" });
  });
});
