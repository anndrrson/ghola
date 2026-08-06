import { describe, expect, it } from "vitest";
import {
  buildPrivateAgentRuntimeStatus,
  chooseConfidentialComputeProvider,
  evaluatePrivateAgentAccess,
  hasPrivateAgentEntitlement,
  providerReadyForPrivateAgents,
  type ConfidentialComputeProviderStatus,
} from "./private-agent-runtime";

const readyPhala: ConfidentialComputeProviderStatus = {
  id: "phala",
  label: "Phala",
  configured: true,
  available: true,
  attested: true,
  supports_sealed_secrets: true,
  supports_background_agents: true,
  supports_trading_execution: true,
  reason: null,
  sealed_recipient: {
    recipient_id: "phala:cvm:test",
    x25519_pub_hex: "11".repeat(32),
    tee_kind: "phala",
    measurement_hex: "22".repeat(32),
  },
};

const localOnly: ConfidentialComputeProviderStatus = {
  id: "local",
  label: "Local browser",
  configured: true,
  available: true,
  attested: false,
  supports_sealed_secrets: false,
  supports_background_agents: false,
  supports_trading_execution: false,
  reason: "Local execution cannot provide remote attestation.",
};

describe("private agent runtime", () => {
  it("treats paid private-agent tiers as private-agent entitlements", () => {
    expect(hasPrivateAgentEntitlement("free")).toBe(false);
    expect(hasPrivateAgentEntitlement("pro")).toBe(false);
    expect(hasPrivateAgentEntitlement("private_agent")).toBe(true);
    expect(hasPrivateAgentEntitlement("unlimited")).toBe(true);
    expect(hasPrivateAgentEntitlement("enterprise")).toBe(true);
  });

  it("requires attestation and sealed execution support for providers", () => {
    expect(providerReadyForPrivateAgents(readyPhala)).toBe(true);
    expect(providerReadyForPrivateAgents(localOnly)).toBe(false);
  });

  it("chooses a preferred ready provider", () => {
    expect(
      chooseConfidentialComputeProvider([localOnly, readyPhala], "phala")?.id,
    ).toBe("phala");
  });

  it("keeps remote execution fail-closed without a shielded rail", () => {
    const runtime = buildPrivateAgentRuntimeStatus({
      providers: [localOnly, readyPhala],
      preferredProvider: "phala",
      shieldedRailReady: false,
      checkedAt: "2026-05-24T00:00:00.000Z",
    });

    expect(runtime.remote_execution_ready).toBe(false);
    expect(runtime.blocking_reasons).toContain("no_ready_shielded_settlement_rail");
  });

  it("blocks free users even when the runtime is ready", () => {
    const runtime = buildPrivateAgentRuntimeStatus({
      providers: [readyPhala],
      preferredProvider: "phala",
      shieldedRailReady: true,
      checkedAt: "2026-05-24T00:00:00.000Z",
    });

    expect(runtime.remote_execution_ready).toBe(true);
    expect(evaluatePrivateAgentAccess({ runtime, tier: "free" })).toMatchObject({
      entitled: false,
      remote_execution_ready: false,
    });
    expect(evaluatePrivateAgentAccess({ runtime, tier: "pro" })).toMatchObject({
      entitled: false,
      remote_execution_ready: false,
    });
    expect(evaluatePrivateAgentAccess({ runtime, tier: "private_agent" })).toMatchObject({
      entitled: true,
      remote_execution_ready: true,
      selected_provider: "phala",
    });
  });
});
