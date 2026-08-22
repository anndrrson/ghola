import { afterEach, describe, expect, it, vi } from "vitest";

import { POST as postApiWebhook } from "./route";
import { POST as postV1Webhook } from "../../../v1/billing/webhook/route";

function signedWebhook(url: string) {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": "t=1,v1=signed",
    },
    body: '{"id":"evt_route"}',
  });
}

describe("billing webhook route aliases", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("proxies the canonical api webhook route to the Thumper webhook", async () => {
    vi.stubEnv("NEXT_PUBLIC_THUMPER_API_URL", "https://thumper.test");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response('{"ok":true}', { status: 200 }));

    const res = await postApiWebhook(
      signedWebhook("https://ghola.test/api/billing/webhook"),
    );

    expect(res.status).toBe(200);
    expect(String(fetchSpy.mock.calls[0][0])).toBe(
      "https://thumper.test/api/billing/webhook",
    );
  });

  it("proxies the legacy v1 webhook route to the same Thumper webhook", async () => {
    vi.stubEnv("NEXT_PUBLIC_THUMPER_API_URL", "https://thumper.test");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response('{"ok":true}', { status: 200 }));

    const res = await postV1Webhook(
      signedWebhook("https://ghola.test/v1/billing/webhook"),
    );

    expect(res.status).toBe(200);
    expect(String(fetchSpy.mock.calls[0][0])).toBe(
      "https://thumper.test/api/billing/webhook",
    );
  });
});
