import { describe, expect, it } from "vitest";
import { privateAccountLaunchStatus } from "./private-account-launch-status";
import type { PrivateAgentRuntimeStatus } from "./private-agent-runtime";

const READY_RUNTIME: PrivateAgentRuntimeStatus = {
  version: 1,
  checked_at: "2026-05-28T00:00:00.000Z",
  sealed_execution_required: true,
  entitlement_required: "paid_private_agent_plan",
  bounded_beta_enabled: true,
  operator_spend_lock: false,
  preferred_provider: "phala",
  selected_provider: "phala",
  remote_execution_ready: true,
  shielded_rail_ready: true,
  providers: [
    {
      id: "phala",
      label: "Phala TEE",
      configured: true,
      available: true,
      attested: true,
      supports_sealed_secrets: true,
      supports_background_agents: true,
      supports_trading_execution: true,
      execution_url: "https://worker.test",
      reason: null,
      sealed_recipient: {
        recipient_id: "phala:cvm:test",
        x25519_pub_hex: "00".repeat(32),
        tee_kind: "phala",
        measurement_hex: "measurement-test",
        attestation_hash: "attestation-test",
      },
    },
  ],
  blocking_reasons: [],
  disclosure: "test",
};

const READY_ENV = {
  NEXT_PUBLIC_THUMPER_API_URL: "https://thumper.test",
  GHOLA_PRIVATE_AGENT_BETA_PUBLIC_ENABLED: "true",
  GHOLA_LIVE_TRADING_PUBLIC_ENABLED: "true",
  GHOLA_V6_HYPERLIQUID_PILOT_ENABLED: "true",
  NEXT_PUBLIC_GHOLA_LEGACY_HYPERLIQUID_API_KEYS: "true",
  GHOLA_HYPERLIQUID_LIVE_MODE: "tiny_fill",
  GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_MODE: "enforce",
  GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_SECRET: "secure-production-request-proof-secret-2026",
  GHOLA_LIVE_TRADING_MAX_ORDER_NOTIONAL_USD: "50",
  GHOLA_LIVE_TRADING_DAILY_CAP_USD: "250",
  GHOLA_LIVE_TRADING_MAX_SLIPPAGE_BPS: "100",
  PRIVATE_AGENT_GLOBAL_KILL_SWITCH: "false",
  GHOLA_PUBLIC_BETA_MONITORING_ENABLED: "true",
  GHOLA_VERCEL_ALERTS_CONFIGURED: "true",
  GHOLA_PUBLIC_BETA_ROLLBACK_READY: "true",
  GHOLA_PUBLIC_BETA_RUNBOOK_VERSION: "2026-08-23",
  PRIVATE_AGENT_WORKER_CAPABILITY_SECRET: "capability-secret",
} as const;

describe("private account launch status", () => {
  it("reports the live Hyperliquid path ready only when deployment and runtime gates pass", async () => {
    const status = await privateAccountLaunchStatus(READY_ENV, READY_RUNTIME);

    expect(status.ready_to_accept_users).toBe(true);
    expect(status.checks.every((check) => check.status === "ready")).toBe(true);
    expect(status.enterprise_gate.status).toBe("blocked");
  });

  it("surfaces exact missing live deployment gates without leaking secrets", async () => {
    const status = await privateAccountLaunchStatus({
      GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_TOKEN: "super-secret-token-value",
    }, {
      ...READY_RUNTIME,
      selected_provider: null,
      remote_execution_ready: false,
      blocking_reasons: ["no_attested_confidential_compute_provider"],
    });

    expect(status.ready_to_accept_users).toBe(false);
    expect(status.checks.map((check) => check.reason)).toEqual(expect.arrayContaining([
      "auth_api_missing",
      "hyperliquid_pilot_disabled",
      "hyperliquid_connector_url_missing",
    ]));
    expect(JSON.stringify(status)).not.toContain("super-secret-token-value");
  });

  it("does not couple Hyperliquid launch to an unrelated shielded settlement rail", async () => {
    const status = await privateAccountLaunchStatus({
      ...READY_ENV,
      GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_URL: "https://worker.test",
      GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_READINESS: "ready",
      GHOLA_PRIVATE_RUNTIME_URL: "https://worker.test",
    }, {
      ...READY_RUNTIME,
      selected_provider: null,
      remote_execution_ready: false,
      shielded_rail_ready: false,
      providers: [],
      blocking_reasons: ["no_ready_shielded_settlement_rail"],
    });

    expect(status.ready_to_accept_users).toBe(true);
    expect(status.runtime.remote_execution_ready).toBe(false);
    expect(status.checks.some((check) => check.check === "attested_private_agent_ready")).toBe(false);
  });

  it("blocks release when worker capability secret aliases disagree", async () => {
    const status = await privateAccountLaunchStatus({
      ...READY_ENV,
      PRIVATE_AGENT_WORKER_CAPABILITY_SECRET: "current-secret",
      GHOLA_WORKER_CAPABILITY_SECRET: "stale-secret",
    }, READY_RUNTIME);

    expect(status.ready_to_accept_users).toBe(false);
    expect(status.checks).toContainEqual({
      check: "worker_capability_secret_aliases_coherent",
      status: "blocked",
      reason: "worker_capability_secret_alias_mismatch",
    });
    expect(JSON.stringify(status)).not.toContain("current-secret");
    expect(JSON.stringify(status)).not.toContain("stale-secret");
  });

  it("blocks launch when the browser would fall through to unverified Turnkey onboarding", async () => {
    const status = await privateAccountLaunchStatus({
      ...READY_ENV,
      NEXT_PUBLIC_GHOLA_LEGACY_HYPERLIQUID_API_KEYS: undefined,
    }, READY_RUNTIME);

    expect(status.ready_to_accept_users).toBe(false);
    expect(status.checks).toContainEqual({
      check: "scoped_api_wallet_onboarding_enabled",
      status: "blocked",
      reason: "scoped_api_wallet_onboarding_disabled",
    });
  });

  it("blocks public launch when safety operations are implicit or unmonitored", async () => {
    const status = await privateAccountLaunchStatus({
      ...READY_ENV,
      PRIVATE_AGENT_GLOBAL_KILL_SWITCH: undefined,
      GHOLA_PUBLIC_BETA_MONITORING_ENABLED: undefined,
      GHOLA_VERCEL_ALERTS_CONFIGURED: undefined,
      GHOLA_LIVE_TRADING_MAX_ORDER_NOTIONAL_USD: "1000",
    }, READY_RUNTIME);

    expect(status.ready_to_accept_users).toBe(false);
    expect(status.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ check: "global_kill_switch_configured", status: "blocked" }),
      expect.objectContaining({ check: "production_monitoring_enabled", status: "blocked" }),
      expect.objectContaining({ check: "actionable_alerting_configured", status: "blocked" }),
      expect.objectContaining({ check: "public_beta_order_cap", status: "blocked" }),
    ]));
  });
});
