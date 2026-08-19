import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPublicAgentWakePost,
  publicAgentWakeEntitlement,
  type PublicAgentWakeDependencies,
} from "./route";

const ENV_KEYS = [
  "GHOLA_PUBLIC_AGENT_WAKE_ENABLED",
  "GHOLA_PUBLIC_LIVE_WORKER_WAKE_ENABLED",
  "GHOLA_PRIVATE_AGENT_JIT_PROVISIONING",
  "GHOLA_PRIVATE_AGENT_WAKE_ON_USE_ENABLED",
  "PHALA_CLOUD_API_KEY",
  "GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN",
  "GHOLA_PRIVATE_AGENT_WORKER_IMAGE",
  "GHOLA_PRIVATE_AGENT_WORKER_IMAGE_DIGEST",
  "GHOLA_PUBLIC_AGENT_WAKE_RATE_LIMIT_PER_MINUTE",
] as const;

function wakeRequest(headers: Record<string, string> = {}) {
  return new Request("https://ghola.test/v1/private-account/agent/wake", {
    method: "POST",
    headers: {
      origin: "https://ghola.test",
      "content-type": "application/json",
      cookie: "ghola_thumper_session=verified-session",
      ...headers,
    },
    body: "{}",
  });
}

function authenticatedOwner() {
  return {
    user: { id: "web-user-1", email: "trader@example.com" },
    owner_commitment: "owner_verified_web_user_1",
  };
}

function readyPhalaRuntime() {
  return {
    version: 1 as const,
    checked_at: "2026-08-12T12:00:00.000Z",
    sealed_execution_required: true as const,
    entitlement_required: "paid_private_agent_plan" as const,
    preferred_provider: "phala" as const,
    selected_provider: "phala" as const,
    remote_execution_ready: true,
    shielded_rail_ready: true,
    blocking_reasons: [],
    disclosure: "test",
    providers: [{
      id: "phala" as const,
      label: "Phala TEE",
      configured: true,
      available: true,
      attested: true,
      supports_sealed_secrets: true,
      supports_background_agents: true,
      supports_trading_execution: true,
      reason: null,
      execution_url: "https://worker.example",
      sealed_recipient: {
        recipient_id: "phala:test",
        x25519_pub_hex: "11".repeat(32),
      },
      evidence: { cvm_status: "running" },
    }],
  };
}

function wakeDependencies(
  overrides: Partial<PublicAgentWakeDependencies> = {},
): PublicAgentWakeDependencies {
  return {
    authenticateImpl: vi.fn(async () => authenticatedOwner()),
    entitlementImpl: vi.fn(async () => ({ ok: true as const })),
    quotaStoreReadyImpl: vi.fn(async () => true),
    consumeRateLimitImpl: vi.fn(async () => ({ ok: true, count: 1, retry_after_seconds: 60 })),
    spendPolicyImpl: vi.fn(() => ({
      allowed: true as const,
      action: "wake" as const,
      environment: "production" as const,
    })),
    getRuntimeStatusImpl: vi.fn(async () => readyPhalaRuntime()),
    markActivityImpl: vi.fn(async (input) => ({
      version: 1 as const,
      provider_id: "phala",
      state: "active" as const,
      last_activity_at: "2026-08-12T12:00:00.000Z",
      lease_expires_at: "2026-08-12T12:10:00.000Z",
      last_reason: input.reason,
      updated_at: "2026-08-12T12:00:00.000Z",
    })),
    wakeImpl: vi.fn(async () => ({
      attempted: true,
      ready: false,
      status: "provisioning" as const,
    })),
    ...overrides,
  };
}

describe("public agent wake route", () => {
  beforeEach(clearEnv);

  afterEach(() => {
    vi.restoreAllMocks();
    clearEnv();
  });

  it("stays disabled when Phala JIT is configured but the explicit flag is off", async () => {
    process.env.GHOLA_PRIVATE_AGENT_JIT_PROVISIONING = "true";
    process.env.GHOLA_PRIVATE_AGENT_WAKE_ON_USE_ENABLED = "true";
    process.env.PHALA_CLOUD_API_KEY = "phala-key";
    process.env.GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN = "worker-token";
    process.env.GHOLA_PRIVATE_AGENT_WORKER_IMAGE = "ghola/worker";
    process.env.GHOLA_PRIVATE_AGENT_WORKER_IMAGE_DIGEST = `sha256:${"a".repeat(64)}`;
    const deps = wakeDependencies();

    const res = await createPublicAgentWakePost(deps)(wakeRequest());

    expect(res.status).toBe(403);
    expect(deps.authenticateImpl).not.toHaveBeenCalled();
    expect(deps.entitlementImpl).not.toHaveBeenCalled();
    expect(deps.getRuntimeStatusImpl).not.toHaveBeenCalled();
    expect(deps.markActivityImpl).not.toHaveBeenCalled();
    expect(deps.wakeImpl).not.toHaveBeenCalled();
  });

  it("does not treat the legacy public-worker flag as wake authorization", async () => {
    process.env.GHOLA_PUBLIC_LIVE_WORKER_WAKE_ENABLED = "true";
    const deps = wakeDependencies();

    const res = await createPublicAgentWakePost(deps)(wakeRequest());

    expect(res.status).toBe(403);
    expect(deps.getRuntimeStatusImpl).not.toHaveBeenCalled();
    expect(deps.wakeImpl).not.toHaveBeenCalled();
  });

  it("rejects cross-site or non-JSON requests before authentication", async () => {
    process.env.GHOLA_PUBLIC_AGENT_WAKE_ENABLED = "true";
    const deps = wakeDependencies();
    const handler = createPublicAgentWakePost(deps);

    const crossSite = await handler(wakeRequest({ origin: "https://evil.example" }));
    const simplePost = await handler(wakeRequest({ "content-type": "text/plain" }));

    expect(crossSite.status).toBe(403);
    expect(simplePost.status).toBe(403);
    expect(deps.authenticateImpl).not.toHaveBeenCalled();
    expect(deps.entitlementImpl).not.toHaveBeenCalled();
    expect(deps.getRuntimeStatusImpl).not.toHaveBeenCalled();
    expect(deps.wakeImpl).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated or spoofed session before quota/runtime access", async () => {
    process.env.GHOLA_PUBLIC_AGENT_WAKE_ENABLED = "true";
    const authenticateImpl = vi.fn(async () => null);
    const deps = wakeDependencies({ authenticateImpl });

    const res = await createPublicAgentWakePost(deps)(wakeRequest({
      authorization: "Bearer spoofed-session",
      cookie: "ghola_thumper_session=spoofed-session",
    }));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ version: 1, error: "private_account_auth_required" });
    expect(deps.quotaStoreReadyImpl).not.toHaveBeenCalled();
    expect(deps.entitlementImpl).not.toHaveBeenCalled();
    expect(deps.consumeRateLimitImpl).not.toHaveBeenCalled();
    expect(deps.getRuntimeStatusImpl).not.toHaveBeenCalled();
    expect(deps.markActivityImpl).not.toHaveBeenCalled();
    expect(deps.wakeImpl).not.toHaveBeenCalled();
  });

  it("requires an active private-agent entitlement before spend policy or quota access", async () => {
    process.env.GHOLA_PUBLIC_AGENT_WAKE_ENABLED = "true";
    const entitlementImpl = vi.fn(async () => ({
      ok: false as const,
      status: 402,
      error: "private_agent_subscription_required",
    }));
    const deps = wakeDependencies({ entitlementImpl });

    const res = await createPublicAgentWakePost(deps)(wakeRequest());
    const body = await res.json();

    expect(res.status).toBe(402);
    expect(body).toMatchObject({
      status: "blocked",
      ready: false,
      error: "private_agent_subscription_required",
    });
    expect(entitlementImpl).toHaveBeenCalledOnce();
    expect(deps.spendPolicyImpl).not.toHaveBeenCalled();
    expect(deps.quotaStoreReadyImpl).not.toHaveBeenCalled();
    expect(deps.getRuntimeStatusImpl).not.toHaveBeenCalled();
    expect(deps.wakeImpl).not.toHaveBeenCalled();
  });

  it("fails closed when the persistent quota store is unavailable", async () => {
    process.env.GHOLA_PUBLIC_AGENT_WAKE_ENABLED = "true";
    const deps = wakeDependencies({ quotaStoreReadyImpl: vi.fn(async () => false) });

    const res = await createPublicAgentWakePost(deps)(wakeRequest());

    expect(res.status).toBe(503);
    expect(deps.consumeRateLimitImpl).not.toHaveBeenCalled();
    expect(deps.getRuntimeStatusImpl).not.toHaveBeenCalled();
    expect(deps.wakeImpl).not.toHaveBeenCalled();
  });

  it("keys the persistent quota to verified owner identity and blocks overflow", async () => {
    process.env.GHOLA_PUBLIC_AGENT_WAKE_ENABLED = "true";
    const consumeRateLimitImpl = vi.fn(async () => ({
      ok: false,
      count: 4,
      retry_after_seconds: 41,
    }));
    const deps = wakeDependencies({ consumeRateLimitImpl });

    const res = await createPublicAgentWakePost(deps)(wakeRequest());

    expect(res.status).toBe(429);
    expect(consumeRateLimitImpl).toHaveBeenCalledWith({
      key: "private_agent_wake:owner_verified_web_user_1",
      limit: 3,
      window_ms: 60_000,
    });
    expect(deps.getRuntimeStatusImpl).not.toHaveBeenCalled();
    expect(deps.wakeImpl).not.toHaveBeenCalled();
  });

  it("renews an already-ready worker only after auth, policy, and quota pass", async () => {
    process.env.GHOLA_PUBLIC_AGENT_WAKE_ENABLED = "true";
    const deps = wakeDependencies();

    const res = await createPublicAgentWakePost(deps)(wakeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ status: "ready", ready: true, action: "already_running" });
    expect(deps.markActivityImpl).toHaveBeenCalledWith({
      reason: "public_agent_byo_wake:already_running",
      leaseMs: 600_000,
    });
    expect(deps.wakeImpl).not.toHaveBeenCalled();
  });

  it("checks cookie-backed billing without exposing the session and accepts founder-tier access", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      tier: "starter",
      access_source: "complimentary_pass",
    }), { status: 200 }));

    const result = await publicAgentWakeEntitlement(wakeRequest(), fetchImpl as typeof fetch);

    expect(result).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://thumper-cloud.onrender.com/api/billing/status",
      expect.objectContaining({
        method: "GET",
        headers: {
          authorization: "Bearer verified-session",
          accept: "application/json",
        },
        cache: "no-store",
      }),
    );
  });
});

function clearEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
}
