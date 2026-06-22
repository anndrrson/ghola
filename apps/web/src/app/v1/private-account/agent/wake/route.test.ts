import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import { resetPrivateAccountStoreForTests } from "@/lib/private-account-store";
import {
  getPrivateAgentRuntimeLease,
  resetPrivateAgentRuntimeLeaseStoreForTests,
} from "@/lib/private-agent-runtime-lease";
import * as runtimeServer from "@/lib/private-agent-runtime-server";

const ENV_KEYS = [
  "GHOLA_PUBLIC_AGENT_WAKE_ENABLED",
  "GHOLA_PUBLIC_LIVE_WORKER_WAKE_ENABLED",
  "GHOLA_PRIVATE_AGENT_SPEND_LOCKDOWN",
  "GHOLA_PRIVATE_AGENT_SPEND_ARMED",
  "GHOLA_PRIVATE_AGENT_WAKE_ON_USE_ENABLED",
  "GHOLA_PRIVATE_AGENT_JIT_PROVISIONING",
  "GHOLA_PRIVATE_AGENT_PROVIDER",
  "GHOLA_PRIVATE_AGENT_EXECUTION_URL",
  "GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN",
  "PHALA_CLOUD_API_KEY",
  "PHALA_AGENT_ENDPOINT",
  "PHALA_API_KEY",
  "PHALA_ATTESTATION_VERIFIER_URL",
  "PHALA_CVM_IMAGE_DIGEST",
  "PHALA_ENCLAVE_KEY_ID",
  "PHALA_ENCLAVE_X25519_PUB_HEX",
  "GHOLA_PRIVATE_AGENT_ATTESTED_READY",
  "GHOLA_PRIVATE_AGENT_LEASE_STORE",
  "GHOLA_PUBLIC_AGENT_WAKE_LEASE_MS",
  "VERCEL_ENV",
] as const;

function wakeRequest(headers: Record<string, string> = {}) {
  return new Request("https://ghola.test/v1/private-account/agent/wake", {
    method: "POST",
    headers: {
      host: "ghola.test",
      origin: "https://ghola.test",
      ...headers,
    },
  });
}

describe("public agent wake route", () => {
  beforeEach(async () => {
    clearEnv();
    await resetPrivateAccountStoreForTests();
    await resetPrivateAgentRuntimeLeaseStoreForTests();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    clearEnv();
    await resetPrivateAccountStoreForTests();
    await resetPrivateAgentRuntimeLeaseStoreForTests();
  });

  it("is disabled unless explicitly enabled", async () => {
    const res = await POST(wakeRequest());
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body).toMatchObject({
      status: "blocked",
      ready: false,
      message: "Live agents are temporarily unavailable. Your venue access was not used.",
    });
  });

  it("requires same-origin POSTs", async () => {
    process.env.GHOLA_PUBLIC_AGENT_WAKE_ENABLED = "true";

    const res = await POST(wakeRequest({ origin: "https://evil.example" }));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe("same_origin_required");
  });

  it("fails closed without exposing operator blocker codes when spend is locked", async () => {
    process.env.GHOLA_PUBLIC_AGENT_WAKE_ENABLED = "true";
    process.env.GHOLA_PRIVATE_AGENT_SPEND_LOCKDOWN = "true";

    const res = await POST(wakeRequest());
    const body = await res.json();

    expect(res.status).toBe(202);
    expect(body).toMatchObject({
      status: "blocked",
      ready: false,
      message: "Live agents are temporarily unavailable. Your venue access was not used.",
      action: "wake_checked",
    });
    expect(JSON.stringify(body)).not.toContain("operator_spend_lock");
  });

  it("allows production wake-on-use from configured Phala credentials", async () => {
    process.env.VERCEL_ENV = "production";
    process.env.GHOLA_PRIVATE_AGENT_PROVIDER = "phala";
    process.env.GHOLA_PRIVATE_AGENT_EXECUTION_URL = "https://phala-worker.ghola.example";
    process.env.GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN = "phala-worker-token";
    process.env.PHALA_AGENT_ENDPOINT = "https://phala-worker.ghola.example";
    process.env.PHALA_API_KEY = "phala-api-key";
    process.env.PHALA_ATTESTATION_VERIFIER_URL = "https://verifier.ghola.example";
    process.env.PHALA_CVM_IMAGE_DIGEST = "sha256:abc";
    process.env.PHALA_ENCLAVE_KEY_ID = "phala:test";
    process.env.PHALA_ENCLAVE_X25519_PUB_HEX = "11".repeat(32);
    process.env.GHOLA_PRIVATE_AGENT_ATTESTED_READY = "true";
    mockPrivatePaymentRailReady();

    const res = await POST(wakeRequest());
    const body = await res.json();

    expect(res.status).toBe(202);
    expect(body).toMatchObject({
      ready: false,
      message: "Live agents are temporarily unavailable. Your venue access was not used.",
      action: expect.stringMatching(/^wake_(checked|requested)$/),
    });
    expect(["warming", "blocked"]).toContain(body.status);
    expect(body.provider).toMatchObject({
      remote_execution_ready: false,
    });
  });

  it("renews the idle lease when Phala is already running", async () => {
    process.env.GHOLA_PRIVATE_AGENT_LEASE_STORE = "memory";
    process.env.GHOLA_PUBLIC_AGENT_WAKE_ENABLED = "true";
    process.env.GHOLA_PUBLIC_AGENT_WAKE_LEASE_MS = "600000";
    vi.spyOn(runtimeServer, "getPrivateAgentRuntimeStatus").mockResolvedValue(readyPhalaRuntime());

    const res = await POST(wakeRequest());
    const body = await res.json();
    const lease = await getPrivateAgentRuntimeLease("phala");

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      status: "ready",
      ready: true,
      action: "already_running",
      lease_ms: 600000,
    });
    expect(body.lease_expires_at).toBe(lease?.lease_expires_at);
    expect(lease).toMatchObject({
      state: "active",
      last_reason: "public_agent_byo_wake:already_running",
    });
  });
});

function readyPhalaRuntime(): Awaited<ReturnType<typeof runtimeServer.getPrivateAgentRuntimeStatus>> {
  return {
    version: 1,
    checked_at: "2026-06-22T23:27:00.000Z",
    sealed_execution_required: true,
    entitlement_required: "paid_private_agent_plan",
    preferred_provider: "phala",
    selected_provider: "phala",
    remote_execution_ready: true,
    shielded_rail_ready: true,
    blocking_reasons: [],
    disclosure: "test",
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
        reason: null,
        execution_url: "https://phala-worker.ghola.example",
        sealed_recipient: {
          recipient_id: "phala:test",
          x25519_pub_hex: "11".repeat(32),
          tee_kind: "phala",
          measurement_hex: null,
          attestation_hash: null,
          expires_at_unix: null,
        },
        evidence: {
          cvm_status: "running",
        },
      },
    ],
  };
}

function clearEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
}

function mockPrivatePaymentRailReady() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/health/payments")) {
      return new Response(JSON.stringify({
        rails: {
          aleo_usdcx_shielded: {
            configured: true,
            ready: true,
            fallback_allowed: false,
          },
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 404 });
  });
}
