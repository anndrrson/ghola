import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const master = "0x1111111111111111111111111111111111111111";
const agent = "0x2222222222222222222222222222222222222222";

beforeEach(() => {
  process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS = "true";
});

afterEach(() => {
  delete process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS;
  vi.unstubAllGlobals();
});

describe("Hyperliquid funding preflight route", () => {
  it("requires an authenticated Ghola session", async () => {
    const response = await POST(new Request("https://ghola.test/v1/private-account/hyperliquid/funding-preflight", {
      method: "POST",
      body: JSON.stringify({}),
    }));
    expect(response.status).toBe(401);
  });

  it("returns read-only mainnet identity, signer, collateral, and market checks", async () => {
    const networkCalls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      networkCalls.push(new URL(String(url)).pathname);
      const body = JSON.parse(String(init?.body));
      if (body.type === "userRole") {
        return json(body.user === master ? { role: "user" } : { role: "agent", data: { user: master } });
      }
      if (body.type === "userAbstraction") return json("unifiedAccount");
      if (body.type === "spotClearinghouseState") return json({ tokenToAvailableAfterMaintenance: [[0, "30"]] });
      if (body.type === "clearinghouseState") return json({ marginSummary: { accountValue: "0" } });
      if (body.type === "meta") return json({ universe: ["BTC", "ETH", "SOL"].map((name) => ({ name })) });
      throw new Error("unexpected request");
    }));
    const response = await POST(request({
      network: "mainnet",
      master_account_address: master,
      connected_wallet_address: master,
      api_wallet_address: agent,
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ready_to_trade", ready_to_trade: true });
    expect(networkCalls).toEqual(Array(6).fill("/info"));
  });
});

function request(body: unknown) {
  const token = [
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify({ sub: "funding-preflight-user", email: "funding@example.com" })).toString("base64url"),
    "sig",
  ].join(".");
  return new Request("https://ghola.test/v1/private-account/hyperliquid/funding-preflight", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

function json(value: unknown) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}
