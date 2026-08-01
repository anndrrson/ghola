import { afterEach, describe, expect, it, vi } from "vitest";

import { proxyStripeBillingWebhook } from "./stripe-webhook-proxy";

function webhookRequest(init?: RequestInit) {
  return new Request("https://ghola.test/api/billing/webhook", {
    method: "POST",
    ...init,
  });
}

describe("stripe billing webhook proxy", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("forwards the raw body and Stripe signature to Thumper", async () => {
    vi.stubEnv("NEXT_PUBLIC_THUMPER_API_URL", "https://thumper.test");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response('{"ok":true}', {
        status: 200,
        headers: {
          "content-type": "application/json",
          "set-cookie": "leak=1",
        },
      }));

    const res = await proxyStripeBillingWebhook(
      webhookRequest({
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          cookie: "ghola_thumper_session=session-token",
          authorization: "Bearer user-token",
          "stripe-signature": "t=1,v1=signed",
          "x-forwarded-for": "203.0.113.9",
        },
        body: '{"id":"evt_test"}',
      }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(String(fetchSpy.mock.calls[0][0])).toBe(
      "https://thumper.test/api/billing/webhook",
    );

    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(init.method).toBe("POST");
    expect(headers.get("stripe-signature")).toBe("t=1,v1=signed");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-forwarded-for")).toBeNull();
    expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe(
      '{"id":"evt_test"}',
    );
  });

  it("rejects unsigned webhook requests before proxying", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await proxyStripeBillingWebhook(
      webhookRequest({
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("missing Stripe-Signature header");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 405 for non-POST methods", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await proxyStripeBillingWebhook(
      new Request("https://ghola.test/api/billing/webhook", { method: "GET" }),
    );

    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
