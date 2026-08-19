import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const exposure = vi.hoisted(() => ({
  consumer: vi.fn(),
  crossVenue: vi.fn(),
}));

vi.mock("@/lib/consumer-production-store", () => ({
  hasActiveConsumerExposure: exposure.consumer,
}));
vi.mock("@/lib/cross-venue-execution-store", () => ({
  hasActiveCrossVenueExposure: exposure.crossVenue,
}));

import { POST } from "./route";
import {
  markPrivateAgentRuntimeActivity,
  resetPrivateAgentRuntimeLeaseStoreForTests,
} from "@/lib/private-agent-runtime-lease";

const ENV_KEYS = [
  "CRON_SECRET",
  "GHOLA_PRIVATE_AGENT_IDLE_CRON_SECRET",
  "GHOLA_PRIVATE_AGENT_PROVISION_TOKEN",
  "GHOLA_PRIVATE_ACCOUNT_INTERNAL_TOKEN",
  "GHOLA_PRIVATE_AGENT_IDLE_SHUTDOWN",
  "GHOLA_PRIVATE_AGENT_LEASE_STORE",
  "PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE",
  "PHALA_CLOUD_API_KEY",
] as const;

const STRONG_CRON_SECRET = "cron_secret_0123456789abcdef_0123456789abcdef";

beforeEach(() => {
  exposure.consumer.mockReset().mockResolvedValue(false);
  exposure.crossVenue.mockReset().mockResolvedValue(false);
});

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  resetPrivateAgentRuntimeLeaseStoreForTests();
});

function request(
  path = "/api/private-agent/idle",
  headers: Record<string, string> = {},
  body?: string,
) {
  return new NextRequest(`https://ghola.test${path}`, { method: "POST", headers, body });
}

describe("private-agent idle route", () => {
  it("rejects unauthenticated idle requests", async () => {
    const res = await POST(request());
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe("unauthorized");
  });

  it("never accepts x-vercel-cron without the dedicated bearer", async () => {
    process.env.CRON_SECRET = STRONG_CRON_SECRET;

    const res = await POST(request("/api/private-agent/idle", { "x-vercel-cron": "1" }));
    expect(res.status).toBe(401);
  });

  it("rejects matching CRON_SECRET values shorter than 32 characters", async () => {
    process.env.CRON_SECRET = "short-cron-secret";

    const res = await POST(request("/api/private-agent/idle", {
      authorization: "Bearer short-cron-secret",
    }));

    expect(res.status).toBe(401);
  });

  it("accepts only a strong dedicated CRON_SECRET bearer", async () => {
    process.env.GHOLA_PRIVATE_AGENT_IDLE_CRON_SECRET = STRONG_CRON_SECRET;
    process.env.GHOLA_PRIVATE_AGENT_PROVISION_TOKEN = STRONG_CRON_SECRET;
    process.env.GHOLA_PRIVATE_ACCOUNT_INTERNAL_TOKEN = STRONG_CRON_SECRET;
    const alias = await POST(request("/api/private-agent/idle", {
      authorization: `Bearer ${STRONG_CRON_SECRET}`,
      "x-ghola-internal-token": STRONG_CRON_SECRET,
    }));
    expect(alias.status).toBe(401);

    process.env.CRON_SECRET = STRONG_CRON_SECRET;
    const bearer = await POST(request("/api/private-agent/idle", {
      authorization: `Bearer ${STRONG_CRON_SECRET}`,
    }));
    expect(bearer.status).toBe(200);
  });

  it("does not let legacy force query or body input bypass active exposure", async () => {
    process.env.CRON_SECRET = STRONG_CRON_SECRET;
    exposure.consumer.mockResolvedValue(true);

    const res = await POST(
      request("/api/private-agent/idle?force=true", {
        authorization: `Bearer ${STRONG_CRON_SECRET}`,
        "content-type": "application/json",
      }, JSON.stringify({ force: true })),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      version: 1,
      provider_id: "phala",
      idle: {
        stopped: false,
        reason: "active_consumer_exposure_or_reconciliation",
      },
    });
  });

  it("does not let legacy force query or body input bypass an active lease", async () => {
    process.env.CRON_SECRET = STRONG_CRON_SECRET;
    process.env.GHOLA_PRIVATE_AGENT_IDLE_SHUTDOWN = "true";
    process.env.GHOLA_PRIVATE_AGENT_LEASE_STORE = "memory";
    process.env.PHALA_CLOUD_API_KEY = "phala-key";
    await markPrivateAgentRuntimeActivity({
      provider_id: "phala",
      reason: "test_active_use",
      lease_ms: 30 * 60_000,
    });

    const res = await POST(request("/api/private-agent/idle?force=true", {
      authorization: `Bearer ${STRONG_CRON_SECRET}`,
      "content-type": "application/json",
    }, JSON.stringify({ force: true })));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.idle).toMatchObject({
      attempted: false,
      stopped: false,
      status: "lease_active",
    });
  });

  it("refuses idle stop for an investor live release", async () => {
    process.env.CRON_SECRET = STRONG_CRON_SECRET;
    process.env.PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE = "full_ticket";

    const res = await POST(request("/api/private-agent/idle", {
      authorization: `Bearer ${STRONG_CRON_SECRET}`,
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.idle).toMatchObject({
      attempted: false,
      stopped: false,
      status: "disabled",
      reason: expect.stringContaining("investor live trading"),
    });
  });
});
