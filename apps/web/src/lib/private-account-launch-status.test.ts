import { describe, expect, it } from "vitest";
import { privateAccountLaunchStatus } from "./private-account-launch-status";
import type { PrivateAgentRuntimeStatus } from "./private-agent-runtime";

const READY_RUNTIME: PrivateAgentRuntimeStatus = {
  version: 1,
  checked_at: "2026-05-28T00:00:00.000Z",
  sealed_execution_required: true,
  entitlement_required: "paid_private_agent_plan",
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

describe("private account launch status", () => {
  it("reports the live Hyperliquid path ready when tiny-fill deployment and runtime gates pass", async () => {
    const status = await privateAccountLaunchStatus({
      NEXT_PUBLIC_THUMPER_API_URL: "https://thumper.test",
      GHOLA_V6_HYPERLIQUID_PILOT_ENABLED: "true",
      GHOLA_HYPERLIQUID_LIVE_MODE: "tiny_fill",
      GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_TOKEN: "token",
    }, READY_RUNTIME);

    expect(status.ready_to_accept_users).toBe(true);
    expect(status.checks.every((check) => check.status === "ready")).toBe(true);
    expect(status.enterprise_gate.status).toBe("blocked");
  });

  it("accepts full-ticket Hyperliquid mode for the current production launch gate", async () => {
    const status = await privateAccountLaunchStatus({
      NEXT_PUBLIC_THUMPER_API_URL: "https://thumper.test",
      GHOLA_V6_HYPERLIQUID_PILOT_ENABLED: "true",
      GHOLA_HYPERLIQUID_LIVE_MODE: "full_ticket",
      GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_TOKEN: "token",
    }, READY_RUNTIME);

    expect(status.ready_to_accept_users).toBe(true);
    expect(status.live_flow).toBe("hyperliquid_live");
    expect(status.checks.find((check) => check.check === "hyperliquid_live_mode_enabled")).toMatchObject({
      status: "ready",
      reason: null,
    });
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
      "no_attested_confidential_compute_provider",
    ]));
    expect(JSON.stringify(status)).not.toContain("super-secret-token-value");
  });
});
