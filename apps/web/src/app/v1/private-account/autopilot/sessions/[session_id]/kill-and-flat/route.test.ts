import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST } from "./route";

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS = "true";
  process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_MODE = "report_only";
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("autopilot kill-and-flat route", () => {
  it("requires an action-time mobile-wallet proof before entitlement or worker control", async () => {
    const response = await POST(
      new Request("https://ghola.test/v1/private-account/autopilot/sessions/session_123/kill-and-flat", {
        method: "POST",
        headers: { authorization: auth("flat-user"), "content-type": "application/json" },
        body: "{}",
      }),
      { params: Promise.resolve({ session_id: "session_123" }) },
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "mobile_wallet_step_up_required" });
  });
});

function auth(userId: string) {
  return `Bearer ${[
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify({ sub: userId, email: `${userId}@example.com` })).toString("base64url"),
    "sig",
  ].join(".")}`;
}
