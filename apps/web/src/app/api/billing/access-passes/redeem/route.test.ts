import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";

function request(origin: string | null) {
  return new NextRequest("https://ghola.test/api/billing/access-passes/redeem", {
    method: "POST",
    headers: {
      cookie: "ghola_thumper_session=session-token",
      "content-type": "application/json",
      ...(origin ? { origin } : {}),
    },
    body: JSON.stringify({ code: "one-time-code" }),
  });
}

describe("complimentary access redemption session proxy", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards a same-origin redemption with the cookie-backed identity", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        ok: true,
        tier: "starter",
        access_source: "complimentary_pass",
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(request("https://ghola.test"));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      tier: "starter",
      access_source: "complimentary_pass",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://thumper-cloud.onrender.com/api/billing/access-passes/redeem",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer session-token" }),
        body: JSON.stringify({ code: "one-time-code" }),
        cache: "no-store",
      }),
    );
  });

  it("rejects cross-site cookie-backed redemption", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(request("https://evil.example"));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "cross-site request rejected" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects cookie-backed redemption when Origin is missing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(request(null));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "cross-site request rejected" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
