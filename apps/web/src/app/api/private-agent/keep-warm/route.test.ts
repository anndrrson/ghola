import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";
import { resetPrivateAutopilotStoreForTests } from "@/lib/private-account-store";

const ENV_KEYS = [
  "CRON_SECRET",
  "GHOLA_PRIVATE_AGENT_IDLE_CRON_SECRET",
  "GHOLA_PRIVATE_AGENT_PROVISION_TOKEN",
  "GHOLA_PRIVATE_ACCOUNT_INTERNAL_TOKEN",
] as const;
const STRONG_CRON_SECRET = "cron_secret_0123456789abcdef_0123456789abcdef";

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  resetPrivateAutopilotStoreForTests();
});

function request(headers: Record<string, string> = {}) {
  return new NextRequest("https://ghola.test/api/private-agent/keep-warm", {
    method: "POST",
    headers,
  });
}

describe("private-agent keep-warm route", () => {
  it("rejects unauthenticated and x-vercel-cron-only requests", async () => {
    process.env.CRON_SECRET = STRONG_CRON_SECRET;

    expect((await POST(request())).status).toBe(401);
    expect((await POST(request({ "x-vercel-cron": "1" }))).status).toBe(401);
  });

  it("rejects a matching CRON_SECRET shorter than 32 characters", async () => {
    process.env.CRON_SECRET = "short-cron-secret";

    const response = await POST(request({ authorization: "Bearer short-cron-secret" }));
    expect(response.status).toBe(401);
  });

  it("does not accept provision, internal, or legacy idle secrets", async () => {
    process.env.GHOLA_PRIVATE_AGENT_IDLE_CRON_SECRET = STRONG_CRON_SECRET;
    process.env.GHOLA_PRIVATE_AGENT_PROVISION_TOKEN = STRONG_CRON_SECRET;
    process.env.GHOLA_PRIVATE_ACCOUNT_INTERNAL_TOKEN = STRONG_CRON_SECRET;

    const response = await POST(request({
      authorization: `Bearer ${STRONG_CRON_SECRET}`,
      "x-ghola-internal-token": STRONG_CRON_SECRET,
    }));
    expect(response.status).toBe(401);
  });

  it("accepts a strong dedicated CRON_SECRET bearer", async () => {
    process.env.CRON_SECRET = STRONG_CRON_SECRET;

    const response = await POST(request({
      authorization: `Bearer ${STRONG_CRON_SECRET}`,
      "x-vercel-cron": "1",
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      version: 1,
      provider_id: "phala",
      keep_warm: { active_sessions: 0, status: "no_active_sessions" },
    });
  });
});
