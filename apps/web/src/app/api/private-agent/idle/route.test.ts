import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./route";
import { resetPrivateAgentRuntimeLeaseStoreForTests } from "@/lib/private-agent-runtime-lease";

const ENV_KEYS = [
  "CRON_SECRET",
  "GHOLA_PRIVATE_AGENT_IDLE_CRON_SECRET",
  "GHOLA_PRIVATE_AGENT_PROVISION_TOKEN",
  "GHOLA_PRIVATE_ACCOUNT_INTERNAL_TOKEN",
  "GHOLA_PRIVATE_AGENT_IDLE_SHUTDOWN",
  "GHOLA_PRIVATE_AGENT_LEASE_STORE",
  "PHALA_CLOUD_API_KEY",
] as const;

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  resetPrivateAgentRuntimeLeaseStoreForTests();
});

function request(path = "/api/private-agent/idle", headers: Record<string, string> = {}) {
  return new NextRequest(`https://ghola.test${path}`, { headers });
}

describe("private-agent idle route", () => {
  it("rejects unauthenticated idle requests", async () => {
    const res = await GET(request());
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe("unauthorized");
  });

  it("accepts Vercel cron for normal idle checks even when CRON_SECRET exists", async () => {
    process.env.CRON_SECRET = "cron-secret";

    const res = await GET(request("/api/private-agent/idle", { "x-vercel-cron": "1" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      version: 1,
      provider_id: "phala",
      idle: {
        status: "disabled",
        attempted: false,
        stopped: false,
      },
    });
  });

  it("keeps forced idle stops behind bearer auth", async () => {
    process.env.CRON_SECRET = "cron-secret";

    const cronOnly = await GET(request("/api/private-agent/idle?force=true", { "x-vercel-cron": "1" }));
    expect(cronOnly.status).toBe(401);

    const bearer = await GET(
      request("/api/private-agent/idle?force=true", {
        authorization: "Bearer cron-secret",
      }),
    );
    const body = await bearer.json();

    expect(bearer.status).toBe(200);
    expect(body).toMatchObject({
      version: 1,
      provider_id: "phala",
      idle: {
        status: "missing_config",
        attempted: false,
        stopped: false,
      },
    });
  });
});
