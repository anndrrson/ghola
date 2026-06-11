import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GET, POST } from "./route";

type NextRequestInit = ConstructorParameters<typeof NextRequest>[1];

function request(url: string, init?: NextRequestInit) {
  return new NextRequest(url, init);
}

function forwardedHeaders(fetchSpy: { mock: { calls: unknown[][] } }): Headers {
  const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
  return new Headers(init?.headers);
}

function forwardedUrl(fetchSpy: { mock: { calls: unknown[][] } }): string {
  return String(fetchSpy.mock.calls[0]?.[0]);
}

describe("v1 x402 proxy privacy", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards payment headers but strips sensitive correlators", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));

    const res = await POST(
      request("https://ghola.test/v1/chat/completions", {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: "Bearer sk-ghola-test",
          "content-type": "application/json",
          "payment-signature": "paid",
          "x402-payment": "paid",
          "x-ghola-payment-rail": "railgun_evm_shielded",
          "x-payment-rail": "railgun_evm_shielded",
          "x-request-id": "durable-client-trace",
          "x-user-id": "user-123",
          "x-wallet-address": "0x1111111111111111111111111111111111111111",
          "x-viewing-key": "view-secret",
          "x-forwarded-for": "203.0.113.9",
          cookie: "ghola_thumper_session=session-token",
          referer: "https://wallet.example/private",
        },
        body: JSON.stringify({ model: "agent:test", messages: [] }),
      }),
      { params: Promise.resolve({ path: ["chat", "completions"] }) },
    );

    expect(res.status).toBe(200);
    expect(forwardedUrl(fetchSpy)).toBe(
      "https://thumper-cloud.onrender.com/v1/chat/completions",
    );
    const headers = forwardedHeaders(fetchSpy);
    expect(headers.get("authorization")).toBe("Bearer sk-ghola-test");
    expect(headers.get("payment-signature")).toBe("paid");
    expect(headers.get("x402-payment")).toBe("paid");
    expect(headers.get("x-ghola-payment-rail")).toBe("railgun_evm_shielded");
    expect(headers.get("x-payment-rail")).toBe("railgun_evm_shielded");

    for (const forbidden of [
      "cookie",
      "referer",
      "x-request-id",
      "x-user-id",
      "x-wallet-address",
      "x-viewing-key",
      "x-forwarded-for",
    ]) {
      expect(headers.get(forbidden), forbidden).toBeNull();
    }
  });

  it("strips upstream Set-Cookie while preserving payment response headers", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", {
        status: 200,
        headers: {
          "payment-response": "settled",
          "x-payment-response": "settled",
          "set-cookie": "leak=1",
          connection: "close",
        },
      }),
    );

    const res = await POST(
      request("https://ghola.test/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      { params: Promise.resolve({ path: ["chat", "completions"] }) },
    );

    expect(res.headers.get("payment-response")).toBe("settled");
    expect(res.headers.get("x-payment-response")).toBe("settled");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("connection")).toBeNull();
  });
});

describe("v1 execution proxy routing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes trading readiness through the Ghola execution gateway", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ status: "ready" }), { status: 200 }),
    );

    const res = await GET(
      request("https://ghola.test/v1/trading/live/readiness?venue=phoenix", {
        method: "GET",
        headers: { accept: "application/json" },
      }),
      {
        params: Promise.resolve({
          path: ["trading", "live", "readiness"],
        }),
      },
    );

    expect(res.status).toBe(200);
    expect(forwardedUrl(fetchSpy)).toBe(
      "https://ghola-gateway.onrender.com/v1/trading/live/readiness?venue=phoenix",
    );
    expect(forwardedHeaders(fetchSpy).get("accept")).toBe("application/json");
  });

  it("preserves trading auth, idempotency, metadata, and body", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 202 }));

    const res = await POST(
      request("https://ghola.test/v1/trading/orders/preflight", {
        method: "POST",
        headers: {
          authorization: "Bearer execution-token",
          "content-type": "application/json",
          "idempotency-key": "preflight-1",
          "x-ghola-account-id": "acct_123",
          "x-ghola-client-order-id": "client_order_123",
          "x-ghola-venue": "phoenix",
          "x-request-id": "browser-trace",
          cookie: "ghola_thumper_session=session-token",
        },
        body: JSON.stringify({ symbol: "SOL-PERP", side: "buy" }),
      }),
      {
        params: Promise.resolve({
          path: ["trading", "orders", "preflight"],
        }),
      },
    );

    expect(res.status).toBe(202);
    expect(forwardedUrl(fetchSpy)).toBe(
      "https://ghola-gateway.onrender.com/v1/trading/orders/preflight",
    );
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = forwardedHeaders(fetchSpy);
    expect(headers.get("authorization")).toBe("Bearer execution-token");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("idempotency-key")).toBe("preflight-1");
    expect(headers.get("x-ghola-account-id")).toBe("acct_123");
    expect(headers.get("x-ghola-client-order-id")).toBe("client_order_123");
    expect(headers.get("x-ghola-venue")).toBe("phoenix");
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("x-request-id")).toBeNull();
    expect(new TextDecoder().decode(init?.body as ArrayBuffer)).toBe(
      JSON.stringify({ symbol: "SOL-PERP", side: "buy" }),
    );
  });
});
