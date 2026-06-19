import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import { resetPrivateAccountStoreForTests } from "@/lib/private-account-store";

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
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    clearEnv();
    await resetPrivateAccountStoreForTests();
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
});

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
