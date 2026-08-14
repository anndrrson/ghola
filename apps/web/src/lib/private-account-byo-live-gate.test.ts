import { describe, expect, it } from "vitest";
import {
  privateAccountByoExecutionGate,
  privateAccountByoGlobalFailures,
  privateAccountByoPlanContainment,
  privateAccountByoVenueGate,
} from "./private-account-byo-live-gate";
import {
  buildTradeOrderPlan,
  type TradeOrderPlan,
  type TradeOrderVenueId,
} from "./trade-order-plan";

describe("BYO live execution gate", () => {
  it("requires both global and selected-venue readiness", () => {
    const env = hyperliquidEnv();
    const plan = tradePlan({ timeInForce: "ioc" });
    expect(privateAccountByoExecutionGate(plan, env)).toMatchObject({
      allowed: true,
      reason_codes: [],
      venue: { status: "green" },
    });

    delete env.GHOLA_LIVE_TRADING_PUBLIC_ENABLED;
    expect(privateAccountByoVenueGate("hyperliquid", env).status).toBe("green");
    expect(privateAccountByoExecutionGate(plan, env)).toMatchObject({
      allowed: false,
      reason_codes: ["live_trading_public_flag_disabled"],
    });
  });

  it("fails closed for missing global caps, proof, dry-run, and venue controls", () => {
    const env = hyperliquidEnv();
    env.PRIVATE_AGENT_VENUE_DRY_RUN = "true";
    env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_SECRET = "local-test-secret";
    delete env.GHOLA_LIVE_TRADING_DAILY_CAP_USD;
    delete env.PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET;

    expect(privateAccountByoGlobalFailures(env)).toEqual(expect.arrayContaining([
      "venue_dry_run_enabled",
      "request_proof_secret_missing",
      "launch_daily_cap_missing",
    ]));
    expect(privateAccountByoExecutionGate(tradePlan({ timeInForce: "ioc" }), env).reason_codes).toContain(
      "hyperliquid_mainnet_worker_disabled",
    );
  });

  it("rejects a verified plan outside the BYO mainnet execution network", () => {
    expect(
      privateAccountByoExecutionGate(
        tradePlan({ network: "testnet", timeInForce: "ioc" }),
        hyperliquidEnv(),
      ).reason_codes,
    ).toContain("byo_live_network_not_mainnet");
  });

  it("rejects legacy plans without a server-validated all-in risk envelope", () => {
    const plan = tradePlan({ timeInForce: "ioc" });
    delete plan.risk_envelope;
    expect(privateAccountByoExecutionGate(plan, hyperliquidEnv()).reason_codes).toContain("order_plan_risk_envelope_missing");
  });

  it("rejects legacy risk envelopes without bound freshness evidence", () => {
    const plan = tradePlan({ timeInForce: "ioc" });
    delete plan.risk_envelope?.fee_evidence_at;
    delete plan.risk_envelope?.buffer_evidence_at;
    expect(privateAccountByoExecutionGate(plan, hyperliquidEnv()).reason_codes).toContain("order_plan_risk_evidence_time_missing");
  });

  it("enforces the terminal venue product allowlists", () => {
    expect(
      privateAccountByoExecutionGate(
        tradePlan({ coin: "DOGE", product: "DOGE-PERP", timeInForce: "ioc" }),
        hyperliquidEnv(),
      ).reason_codes,
    ).toContain("hyperliquid_product_not_allowed");

    expect(
      privateAccountByoExecutionGate(
        tradePlan({ venueId: "phoenix", coin: "BTC", product: "BTC-PERP" }),
        phoenixEnv(),
      ).reason_codes,
    ).toContain("phoenix_product_not_allowed");
  });

  it("requires exact Coinbase product allowlist membership before mode containment", () => {
    const plan = tradePlan({
      venueId: "coinbase",
      coin: "BTC",
      product: "BTC-USD",
    });
    const blockedEnv = coinbaseEnv("ETH-USD,SOL-USD");
    expect(privateAccountByoExecutionGate(plan, blockedEnv).reason_codes).toEqual(expect.arrayContaining([
      "coinbase_product_not_allowed",
      "coinbase_live_execution_recovery_unproven",
    ]));

    const allowedEnv = coinbaseEnv("eth-usd, BTC-USD");
    expect(privateAccountByoExecutionGate(plan, allowedEnv)).toMatchObject({
      allowed: false,
      reason_codes: ["coinbase_live_execution_recovery_unproven"],
    });

    const iocPlan = tradePlan({
      venueId: "coinbase",
      coin: "BTC",
      product: "BTC-USD",
      timeInForce: "ioc",
    });
    expect(privateAccountByoExecutionGate(iocPlan, allowedEnv)).toMatchObject({
      allowed: false,
      reason_codes: ["coinbase_live_execution_recovery_unproven"],
    });
  });

  it("matches worker containment for exact BYO order modes", () => {
    expect(privateAccountByoPlanContainment(tradePlan({ timeInForce: "ioc" }))).toEqual({
      allowed: true,
      reason_code: null,
      message: null,
    });
    expect(privateAccountByoPlanContainment(tradePlan())).toMatchObject({
      allowed: false,
      reason_code: "hyperliquid_resting_order_recovery_unproven",
    });
    expect(privateAccountByoPlanContainment(tradePlan({
      venueId: "coinbase",
      coin: "BTC",
      product: "BTC-USD",
    }))).toMatchObject({
      allowed: false,
      reason_code: "coinbase_live_execution_recovery_unproven",
    });
    expect(privateAccountByoPlanContainment({
      venue_id: "coinbase",
      order_type: "limit",
      time_in_force: "ioc",
      post_only: false,
    }).reason_code).toBe("coinbase_live_execution_recovery_unproven");
    expect(privateAccountByoPlanContainment({
      venue_id: "coinbase",
      order_type: "limit",
      time_in_force: "ioc",
      post_only: true,
    }).reason_code).toBe("coinbase_live_execution_recovery_unproven");
    expect(privateAccountByoPlanContainment({
      venue_id: "coinbase",
      order_type: "market",
      time_in_force: "ioc",
    }).reason_code).toBe("coinbase_live_execution_recovery_unproven");
    expect(privateAccountByoPlanContainment({
      venue_id: "phoenix",
      order_type: "limit",
      time_in_force: "gtc",
    }).reason_code).toBe("phoenix_live_execution_recovery_unproven");
    expect(privateAccountByoPlanContainment({
      venue_id: "phoenix",
      order_type: "limit",
      time_in_force: "ioc",
      live_order_mode: "tiny_fill",
    }).reason_code).toBe("phoenix_live_execution_recovery_unproven");
  });
});

function tradePlan(
  overrides: Partial<{
    venueId: TradeOrderVenueId;
    network: "mainnet" | "testnet";
    coin: string;
    product: string;
    timeInForce: "gtc" | "ioc" | "fok";
  }> = {},
): TradeOrderPlan {
  const nowMs = Date.now();
  const plan = buildTradeOrderPlan({
    venueId: overrides.venueId ?? "hyperliquid",
    network: overrides.network ?? "mainnet",
    coin: overrides.coin ?? "BTC",
    product: overrides.product ?? "BTC-PERP",
    side: "buy",
    timeInForce: overrides.timeInForce,
    quoteNotionalUsd: 25,
    baseSize: 0.0004,
    limitPrice: 62_500,
    maxSlippageBps: 50,
    stopLevel: 62_000,
    strategyProfile: "breakout",
    entryTrigger: "break_level",
    exitRule: "exit_on_invalidation",
    timeHorizon: "intraday",
    triggerLevel: 62_550,
    interval: "5m",
    marketFetchedAt: new Date(nowMs).toISOString(),
    executionReferencePrice: 62_490,
    frameVersion: 1,
    riskEnvelope: { riskBudgetUsd: 1, stopAndSlippageLossUsd: 0.325, roundTripCostLossUsd: 0.05, allInLossUsd: 0.375, feeBps: 5, bufferBps: 5, feeEvidenceAtMs: nowMs, bufferEvidenceAtMs: nowMs },
    nowMs,
  });
  if (!plan) throw new Error("test_order_plan_invalid");
  return plan;
}

function hyperliquidEnv(): Record<string, string | undefined> {
  return {
    GHOLA_LIVE_TRADING_PUBLIC_ENABLED: "true",
    PRIVATE_AGENT_VENUE_DRY_RUN: "false",
    GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_SECRET: "a-secure-request-proof-secret-value-123456789",
    GHOLA_LIVE_TRADING_MAX_ORDER_NOTIONAL_USD: "1000",
    GHOLA_LIVE_TRADING_DAILY_CAP_USD: "5000",
    GHOLA_LIVE_TRADING_MAX_SLIPPAGE_BPS: "100",
    GHOLA_V6_HYPERLIQUID_PILOT_ENABLED: "true",
    PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET: "true",
    PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE: "full_ticket",
    PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_MAX_NOTIONAL_USD: "1000",
    PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_DAILY_NOTIONAL_CAP_USD: "5000",
    PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS: "100",
  };
}

function phoenixEnv(): Record<string, string | undefined> {
  return {
    ...globalEnv(),
    GHOLA_VENUE_PHOENIX_PILOT_ENABLED: "true",
    PRIVATE_AGENT_SOLANA_PERPS_ALLOW_MAINNET: "true",
    PRIVATE_AGENT_SOLANA_PERPS_LIVE_MODE: "full_ticket",
    PRIVATE_AGENT_SOLANA_PERPS_FULL_TICKET_MAX_NOTIONAL_USD: "1000",
    PRIVATE_AGENT_SOLANA_PERPS_MAX_SLIPPAGE_BPS: "100",
  };
}

function coinbaseEnv(products: string): Record<string, string | undefined> {
  return {
    ...globalEnv(),
    GHOLA_V6_COINBASE_PILOT_ENABLED: "true",
    PRIVATE_AGENT_COINBASE_LIVE_MODE: "full",
    PRIVATE_AGENT_COINBASE_ALLOWED_PRODUCTS: products,
    PRIVATE_AGENT_COINBASE_LIVE_MAX_NOTIONAL_USD: "1000",
  };
}

function globalEnv(): Record<string, string | undefined> {
  return {
    GHOLA_LIVE_TRADING_PUBLIC_ENABLED: "true",
    PRIVATE_AGENT_VENUE_DRY_RUN: "false",
    GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_SECRET: "a-secure-request-proof-secret-value-123456789",
    GHOLA_LIVE_TRADING_MAX_ORDER_NOTIONAL_USD: "1000",
    GHOLA_LIVE_TRADING_DAILY_CAP_USD: "5000",
    GHOLA_LIVE_TRADING_MAX_SLIPPAGE_BPS: "100",
  };
}
