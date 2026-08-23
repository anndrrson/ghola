import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const ENV_KEYS = [
  "GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS",
  "GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_SECRET",
  "GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_MODE",
] as const;

describe("private account live proxy", () => {
  beforeEach(() => {
    clearEnv();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS = "true";
    process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_SECRET = "secure_private_account_request_proof_secret_32bytes";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearEnv();
  });

  it("proxies allowed live mutations with server-side request proof headers", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      ok: true,
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    const res = await POST(proxyRequest({
      path: "/v1/private-account/connectors/submit",
      body: {
        version: 1,
        work_order_commitment: "work_order_123",
      },
    }));

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [, init] = fetchSpy.mock.calls[0] as [URL, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["x-ghola-request-timestamp"]).toBeTruthy();
    expect(headers["x-ghola-request-nonce"]).toMatch(/^web-/);
    expect(headers["x-ghola-request-proof"]).toMatch(/^[0-9a-f]{64}$/);
    expect(headers["x-ghola-correlation-id"]).toBe("ghola-correlation-test-123");
    expect(headers.authorization).toBe("Bearer local-live-user");
    expect(res.headers.get("x-ghola-correlation-id")).toBe("ghola-correlation-test-123");
    expect(res.headers.get("server-timing")).toMatch(/^ghola-live-proxy;dur=/);
  });

  it("fails an uncertain execution closed with a retry-forbidden correlation record", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("connection reset"));

    const res = await POST(proxyRequest({
      path: "/v1/private-account/actions/execute",
      body: { version: 1 },
    }));
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body).toMatchObject({
      error: "connector_submit_ambiguous",
      correlation_id: "ghola-correlation-test-123",
      retry_forbidden: true,
    });
    expect(res.headers.get("x-ghola-correlation-id")).toBe("ghola-correlation-test-123");
  });

  it("rejects paths outside the live mutation allowlist", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));

    const res = await POST(proxyRequest({
      path: "/v1/private-account/live-trading/status",
      body: { version: 1 },
    }));

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("live_proxy_path_not_allowed");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails closed when proof mode is enforced but the proof secret is missing", async () => {
    delete process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_SECRET;
    process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_MODE = "enforce";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));

    const res = await POST(proxyRequest({
      path: "/v1/private-account/connectors/submit",
      body: { version: 1 },
    }));

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("private_account_request_proof_unconfigured");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects raw private-account fields before proxying", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));

    const res = await POST(proxyRequest({
      path: "/v1/private-account/connectors/submit",
      body: {
        version: 1,
        api_wallet_private_key: "0x1111111111111111111111111111111111111111111111111111111111111111",
      },
    }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("forbidden raw private-account fields");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

function proxyRequest(payload: { path: string; body: Record<string, unknown> }) {
  return new Request("https://ghola.example/api/private-account/live-proxy", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer local-live-user",
      "x-ghola-correlation-id": "ghola-correlation-test-123",
    },
    body: JSON.stringify({
      path: payload.path,
      method: "POST",
      body: payload.body,
    }),
  });
}

function clearEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
}
