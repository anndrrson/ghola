import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";

function request(origin: string | null) {
  return new NextRequest("https://ghola.test/api/billing/checkout", {
    method: "POST",
    headers: {
      cookie: "ghola_thumper_session=session-token",
      "content-type": "application/json",
      ...(origin ? { origin } : {}),
    },
    body: JSON.stringify({ tier: "starter" }),
  });
}

describe("billing checkout session proxy", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards an exact same-origin checkout request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ checkout_url: "https://checkout.example/session" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(request("https://ghola.test"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ checkout_url: "https://checkout.example/session" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://thumper-cloud.onrender.com/api/billing/checkout",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer session-token",
          "content-type": "application/json",
        }),
        body: JSON.stringify({ tier: "starter" }),
        cache: "no-store",
      }),
    );
  });

  it("rejects a cookie-backed checkout without a same-origin Origin", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(request(null));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "cross-site request rejected" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
