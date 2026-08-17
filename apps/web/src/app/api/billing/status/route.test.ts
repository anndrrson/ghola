import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./route";

function request(cookie = "") {
  return new NextRequest("https://ghola.test/api/billing/status", {
    headers: cookie ? { cookie } : {},
  });
}

describe("billing status session proxy", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards the HttpOnly session as an upstream bearer without exposing it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        tier: "starter",
        access_source: "complimentary_pass",
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie": "upstream_billing=must-not-leak; HttpOnly; Secure",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await GET(request("ghola_thumper_session=session-token"));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      tier: "starter",
      access_source: "complimentary_pass",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://thumper-cloud.onrender.com/api/billing/status",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ authorization: "Bearer session-token" }),
        cache: "no-store",
      }),
    );
    expect(res.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("fails closed when the upstream request times out", async () => {
    const fetchMock = vi.fn().mockRejectedValue(
      new DOMException("The operation timed out", "TimeoutError"),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await GET(request("ghola_thumper_session=session-token"));

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "billing unavailable" });
    expect(res.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("fails closed without a session", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await GET(request());

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "sign in required" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
