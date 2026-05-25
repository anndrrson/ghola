import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { POST } from "./route";

type NextRequestInit = ConstructorParameters<typeof NextRequest>[1];

function request(url: string, init?: NextRequestInit) {
  return new NextRequest(url, init);
}

function forwardedHeaders(fetchSpy: { mock: { calls: unknown[][] } }): Headers {
  const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
  return new Headers(init?.headers);
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
