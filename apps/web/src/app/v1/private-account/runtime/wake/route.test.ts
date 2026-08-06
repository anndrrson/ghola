import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  wakePhalaPrivateAgentForUse: vi.fn(),
  discoverPhalaPrivateAgentProvider: vi.fn(),
}));

vi.mock("@/lib/private-agent-phala", () => ({
  wakePhalaPrivateAgentForUse: mocks.wakePhalaPrivateAgentForUse,
  discoverPhalaPrivateAgentProvider: mocks.discoverPhalaPrivateAgentProvider,
}));

import { GET, POST, resetNativeWakeRateLimitForTests } from "./route";

const ORIGINAL_ENV = { ...process.env };

function request(method: "GET" | "POST", authenticated = true) {
  return new Request("https://ghola.test/v1/private-account/runtime/wake", {
    method,
    headers: {
      ...(authenticated ? { authorization: "Bearer seeker-test-token" } : {}),
      ...(method === "POST" ? { "content-type": "application/json" } : {}),
    },
    ...(method === "POST" ? { body: JSON.stringify({ product_id: "SOL-USD" }) } : {}),
  });
}

describe("Seeker native private-agent prewarm", () => {
  beforeEach(() => {
    process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS = "true";
    resetNativeWakeRateLimitForTests();
    mocks.wakePhalaPrivateAgentForUse.mockReset().mockResolvedValue({
      attempted: true,
      ready: false,
      status: "provisioning",
      cvm_name: "ghola-private-agent-worker",
    });
    mocks.discoverPhalaPrivateAgentProvider.mockReset().mockResolvedValue({
      id: "phala",
      configured: true,
      available: false,
      attested: false,
      supports_trading_execution: false,
      evidence: { cvm_status: "starting" },
    });
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("rejects an unauthenticated wake", async () => {
    const response = await POST(request("POST", false));
    expect(response.status).toBe(401);
    expect(mocks.wakePhalaPrivateAgentForUse).not.toHaveBeenCalled();
  });

  it("starts a paid authenticated wake with a bounded lease", async () => {
    const response = await POST(request("POST"));
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      status: "waking",
      ready: false,
      wake_accepted: true,
      lease_ms: 600_000,
    });
    expect(mocks.wakePhalaPrivateAgentForUse).toHaveBeenCalledWith({
      reason: "seeker_native_prewarm:SOL-USD",
      waitForReadyMs: 0,
      leaseMs: 600_000,
    });
  });

  it("reports readiness without extending the lease", async () => {
    mocks.discoverPhalaPrivateAgentProvider.mockResolvedValue({
      id: "phala",
      configured: true,
      available: true,
      attested: true,
      supports_trading_execution: true,
      evidence: { cvm_status: "running" },
    });
    const response = await GET(request("GET"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "ready",
      ready: true,
      wake_accepted: false,
    });
    expect(mocks.wakePhalaPrivateAgentForUse).not.toHaveBeenCalled();
  });

  it("deduplicates repeated wake requests from the same owner", async () => {
    await POST(request("POST"));
    const response = await POST(request("POST"));
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body.wake_accepted).toBe(false);
    expect(body.retry_after_ms).toBeGreaterThan(0);
    expect(mocks.wakePhalaPrivateAgentForUse).toHaveBeenCalledTimes(1);
  });
});
