import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { PATCH } from "./route";

function request(origin: string | null) {
  return new NextRequest("https://ghola.test/api/billing/private-agent/trading/cap", {
    method: "PATCH",
    headers: {
      cookie: "ghola_thumper_session=session-token",
      "content-type": "application/json",
      ...(origin ? { origin } : {}),
    },
    body: JSON.stringify({ monthly_fee_cap_micro_usd: 5_000_000 }),
  });
}

describe("private-agent trading cap session proxy", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards PATCH with the cookie-backed identity and exact body", async () => {
    const privateAgentTrading = {
      monthly_fee_cap_micro_usd: 5_000_000,
      live_trading_allowed: true,
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(privateAgentTrading), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await PATCH(request("https://ghola.test"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(privateAgentTrading);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://thumper-cloud.onrender.com/api/billing/private-agent/trading/cap",
      expect.objectContaining({
        method: "PATCH",
        headers: expect.objectContaining({
          authorization: "Bearer session-token",
          "content-type": "application/json",
        }),
        body: JSON.stringify({ monthly_fee_cap_micro_usd: 5_000_000 }),
        cache: "no-store",
      }),
    );
  });

  it("rejects cross-site cookie-backed PATCH requests", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await PATCH(request("https://evil.example"));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "cross-site request rejected" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
