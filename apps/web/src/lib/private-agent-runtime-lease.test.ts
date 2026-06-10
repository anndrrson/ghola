import { afterEach, describe, expect, it } from "vitest";
import {
  getPrivateAgentRuntimeLease,
  markPrivateAgentRuntimeActivity,
  markPrivateAgentRuntimeStopped,
  privateAgentRuntimeLeaseActive,
  resetPrivateAgentRuntimeLeaseStoreForTests,
} from "./private-agent-runtime-lease";

const ORIGINAL_ENV = { ...process.env };
const TEST_ENV_KEYS = ["GHOLA_PRIVATE_AGENT_LEASE_STORE"];

afterEach(() => {
  resetPrivateAgentRuntimeLeaseStoreForTests();
  for (const key of TEST_ENV_KEYS) {
    if (ORIGINAL_ENV[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = ORIGINAL_ENV[key];
    }
  }
});

describe("private-agent runtime lease store", () => {
  it("records active use and exposes an expiring lease", async () => {
    process.env.GHOLA_PRIVATE_AGENT_LEASE_STORE = "memory";
    const now = new Date("2026-06-06T12:00:00.000Z");

    await markPrivateAgentRuntimeActivity({
      provider_id: "phala",
      reason: "pooled_hyperliquid_access_request",
      lease_ms: 20 * 60_000,
      now,
    });
    const lease = await getPrivateAgentRuntimeLease("phala");

    expect(lease?.state).toBe("active");
    expect(lease?.last_reason).toBe("pooled_hyperliquid_access_request");
    expect(lease?.lease_expires_at).toBe("2026-06-06T12:20:00.000Z");
    expect(privateAgentRuntimeLeaseActive(lease, new Date("2026-06-06T12:19:59.000Z"))).toBe(true);
    expect(privateAgentRuntimeLeaseActive(lease, new Date("2026-06-06T12:20:01.000Z"))).toBe(false);
  });

  it("marks the provider stopped without preserving an active lease", async () => {
    process.env.GHOLA_PRIVATE_AGENT_LEASE_STORE = "memory";
    const now = new Date("2026-06-06T12:00:00.000Z");
    await markPrivateAgentRuntimeActivity({
      provider_id: "phala",
      reason: "session",
      lease_ms: 20 * 60_000,
      now,
    });

    await markPrivateAgentRuntimeStopped({
      provider_id: "phala",
      reason: "idle_stop",
      now: new Date("2026-06-06T12:21:00.000Z"),
    });
    const lease = await getPrivateAgentRuntimeLease("phala");

    expect(lease?.state).toBe("stopped");
    expect(lease?.last_reason).toBe("idle_stop");
    expect(privateAgentRuntimeLeaseActive(lease, new Date("2026-06-06T12:21:01.000Z"))).toBe(false);
  });
});
