import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HYPERLIQUID_CLOSE_CONFIRMATION } from "@/lib/hyperliquid-risk-reduction.server";
import { POST } from "./route";

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS = "true";
  process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_MODE = "report_only";
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("Hyperliquid position close route", () => {
  it("requires an action-time mobile-wallet proof before any close authorization", async () => {
    const response = await POST(new Request("https://ghola.test/v1/private-account/hyperliquid/positions/close", {
      method: "POST",
      headers: { authorization: auth("close-user"), "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        market: "BTC",
        idempotency_key: "close_route_test_123",
        confirmation: HYPERLIQUID_CLOSE_CONFIRMATION,
      }),
    }));
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
