import { createHash, createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gholaCommitment } from "@/lib/private-account";
import { POST } from "./route";

const ORIGINAL_ENV = { ...process.env };
const PROOF_SECRET = "test_live_proxy_request_proof_secret_123456";

function auth(userId: string) {
  return `Bearer ${[
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify({ sub: userId, email: `${userId}@example.com` })).toString("base64url"),
    "sig",
  ].join(".")}`;
}

function request(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("https://ghola.test/api/private-account/live-proxy", {
    method: "POST",
    headers: {
      origin: "https://ghola.test",
      "content-type": "application/json",
      authorization: auth("agent_user"),
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("private account live proxy", () => {
  beforeEach(() => {
    process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS = "true";
    process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_SECRET = PROOF_SECRET;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("signs and forwards live guarded autopilot session creation", async () => {
    const upstreamBody = { version: 1, session: { autopilot_session_id: "autopilot_test" } };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json(upstreamBody, {
        status: 201,
        headers: { "x-ghola-session-id": "autopilot_test" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const body = {
      session_policy: {
        agent_kind: "level_trigger",
        venue_id: "phoenix",
        market: "SOL-PERP",
      },
    };
    const res = await POST(request({
      path: "/v1/private-account/autopilot/sessions",
      method: "POST",
      body,
    }));
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json).toEqual(upstreamBody);
    expect(res.headers.get("x-ghola-session-id")).toBe("autopilot_test");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://ghola.test/v1/private-account/autopilot/sessions",
    );

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe(auth("agent_user"));
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual(body);

    const timestamp = headers.get("x-ghola-request-timestamp") ?? "";
    const nonce = headers.get("x-ghola-request-nonce") ?? "";
    const proof = headers.get("x-ghola-request-proof") ?? "";
    const ownerCommitment = gholaCommitment("owner", "agent_user");
    const canonicalBody = stableJson(body);
    const bodyHash = createHash("sha256").update(canonicalBody).digest("hex");
    const expected = createHmac("sha256", PROOF_SECRET)
      .update([
        "POST",
        "/v1/private-account/autopilot/sessions",
        ownerCommitment,
        timestamp,
        nonce,
        bodyHash,
      ].join("\n"))
      .digest("hex");

    expect(timestamp).toMatch(/^\d+$/);
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(proof).toBe(expected);
  });

  it("rejects non-live-guarded paths before upstream fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await POST(request({
      path: "/v1/private-account/status",
      method: "POST",
      body: {},
    }));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "live_proxy_path_not_allowed" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails closed when proof mode is enforced but the proof secret is missing", async () => {
    delete process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_SECRET;
    process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_MODE = "enforce";
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await POST(request({
      path: "/v1/private-account/autopilot/sessions",
      method: "POST",
      body: {},
    }));

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "private_account_request_proof_unconfigured" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects raw private-account fields before upstream fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await POST(request({
      path: "/v1/private-account/autopilot/sessions",
      method: "POST",
      body: {
        api_wallet_private_key: "0x1111111111111111111111111111111111111111111111111111111111111111",
      },
    }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "request contains forbidden raw private-account fields" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects cross-site attempts before upstream fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await POST(request({
      path: "/v1/private-account/autopilot/sessions",
      method: "POST",
      body: {},
    }, { origin: "https://evil.example" }));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "cross_site_live_proxy_rejected" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}
