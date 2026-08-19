import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const countActiveSessions = vi.hoisted(() => vi.fn());

vi.mock("./private-account-store", () => ({
  countActivePrivateAutopilotSessions: countActiveSessions,
}));

import { stopIdlePhalaPrivateAgent } from "./private-agent-phala";
import { resetPrivateAgentRuntimeLeaseStoreForTests } from "./private-agent-runtime-lease";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = {
    ...ORIGINAL_ENV,
    GHOLA_PRIVATE_AGENT_IDLE_SHUTDOWN: "true",
    GHOLA_PRIVATE_AGENT_LEASE_STORE: "memory",
    PHALA_CLOUD_API_KEY: "phala-key",
  };
  delete process.env.GHOLA_HYPERLIQUID_LIVE_MODE;
  delete process.env.GHOLA_LIVE_TRADING_PUBLIC_ENABLED;
  delete process.env.PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE;
  countActiveSessions.mockReset();
  resetPrivateAgentRuntimeLeaseStoreForTests();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  resetPrivateAgentRuntimeLeaseStoreForTests();
});

describe("Phala idle-stop fail-closed checks", () => {
  it("does not stop when durable active-session inspection fails", async () => {
    countActiveSessions.mockRejectedValue(new Error("database unavailable"));

    const result = await stopIdlePhalaPrivateAgent();

    expect(result).toMatchObject({
      attempted: false,
      stopped: false,
      status: "failed",
      reason: expect.stringContaining("database unavailable"),
    });
  });
});
