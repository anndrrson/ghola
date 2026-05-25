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

describe("thumper proxy privacy", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the session cookie for auth without forwarding payment or wallet metadata", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));

    const res = await POST(
      request("https://ghola.test/api/thumper/api/tasks", {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          cookie: "ghola_thumper_session=session-token",
          origin: "https://ghola.test",
          "payment-signature": "paid",
          "x402-payment": "paid",
          "x-ghola-payment-rail": "railgun_evm_shielded",
          "x-user-id": "user-123",
          "x-wallet-address": "0x1111111111111111111111111111111111111111",
          "x-viewing-key": "view-secret",
          "x-forwarded-for": "203.0.113.9",
        },
        body: "{}",
      }),
      { params: Promise.resolve({ path: ["api", "tasks"] }) },
    );

    expect(res.status).toBe(200);
    const headers = forwardedHeaders(fetchSpy);
    expect(headers.get("authorization")).toBe("Bearer session-token");
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("content-type")).toBe("application/json");

    for (const forbidden of [
      "cookie",
      "origin",
      "payment-signature",
      "x402-payment",
      "x-ghola-payment-rail",
      "x-user-id",
      "x-wallet-address",
      "x-viewing-key",
      "x-forwarded-for",
    ]) {
      expect(headers.get(forbidden), forbidden).toBeNull();
    }
  });
});
