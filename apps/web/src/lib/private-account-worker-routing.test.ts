import { describe, expect, it } from "vitest";
import {
  resolveHyperliquidWorkerUrl,
  resolvePrivateAccountWorkerConfig,
} from "./private-account-worker-routing";
import type { PrivateAgentRuntimeStatus } from "./private-agent-runtime";

describe("resolveHyperliquidWorkerUrl", () => {
  it("prefers the selected attested provider over stale static endpoints", () => {
    expect(resolveHyperliquidWorkerUrl({
      selected_provider_execution_url: "https://worker.prod9.example",
      connector_url: "https://worker.prod5.example",
      execution_url: "https://worker.prod5.example",
      worker_url: "https://worker.prod9.example",
    })).toBe("https://worker.prod9.example");
  });

  it("preserves the static endpoint fallback order without a selected provider", () => {
    expect(resolveHyperliquidWorkerUrl({
      connector_url: "https://connector.example",
      execution_url: "https://execution.example",
      worker_url: "https://worker.example",
      phala_endpoint: "https://phala.example",
    })).toBe("https://connector.example");
  });
});

describe("resolvePrivateAccountWorkerConfig", () => {
  it("keeps worker routing and the sealed recipient on the selected ready provider", async () => {
    const runtime: PrivateAgentRuntimeStatus = {
      version: 1,
      checked_at: "2026-08-30T12:00:00.000Z",
      sealed_execution_required: true,
      entitlement_required: "paid_private_agent_plan",
      bounded_beta_enabled: true,
      operator_spend_lock: false,
      preferred_provider: "phala",
      selected_provider: "phala",
      remote_execution_ready: true,
      shielded_rail_ready: true,
      providers: [{
        id: "phala",
        label: "Phala",
        configured: true,
        available: true,
        attested: true,
        supports_sealed_secrets: true,
        supports_background_agents: true,
        supports_trading_execution: true,
        reason: null,
        execution_url: "https://provider-a.example",
        sealed_recipient: {
          recipient_id: "phala:cvm:provider-a",
          x25519_pub_hex: "11".repeat(32),
        },
      }],
      blocking_reasons: [],
      disclosure: "test",
    };

    const config = await resolvePrivateAccountWorkerConfig({
      runtime,
      env: {
        GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_URL: "https://connector-a.example",
        GHOLA_PRIVATE_AGENT_EXECUTION_URL: "https://execution-b.example",
        GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_TOKEN: "connector-token",
        GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN: "execution-token",
      },
    });

    expect(config.url?.origin).toBe("https://provider-a.example");
    expect(config.recipient_id).toBe("phala:cvm:provider-a");
    expect(config.token).toBe("connector-token");
  });
});
