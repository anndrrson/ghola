import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createThumperCheckout,
  getThumperBillingStatus,
  redeemComplimentaryAccessPass,
  thumperSignIn,
  thumperSignUp,
  updatePrivateAgentTradingFeeCap,
} from "./thumper-api";

describe("thumper auth helpers", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    localStorage.clear();
  });

  it("uses the cookie-backed email signup session route even when an upstream public API URL is configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_THUMPER_API_URL", "https://thumper-cloud.onrender.com");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        user: {
          id: "user_signup",
          email: "signup@example.test",
          name: "Signup User",
        },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await thumperSignUp({
      name: "Signup User",
      email: "signup@example.test",
      password: "correct horse battery staple",
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/auth/session/email/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        email: "signup@example.test",
        password: "correct horse battery staple",
        display_name: "Signup User",
      }),
    });
    expect(res.user).toEqual({
      id: "user_signup",
      email: "signup@example.test",
      name: "Signup User",
    });
    expect(res.token).toBeUndefined();
    expect(localStorage.getItem("thumper_token")).toBeNull();
  });

  it("uses the cookie-backed email signin session route even when an upstream public API URL is configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_THUMPER_API_URL", "https://thumper-cloud.onrender.com");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        user: {
          id: "user_signin",
          email: "signin@example.test",
        },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await thumperSignIn({
      email: "signin@example.test",
      password: "correct horse battery staple",
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/auth/session/email/signin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        email: "signin@example.test",
        password: "correct horse battery staple",
      }),
    });
    expect(res.user).toEqual({
      id: "user_signin",
      email: "signin@example.test",
    });
    expect(res.token).toBeUndefined();
    expect(localStorage.getItem("thumper_token")).toBeNull();
  });

  it("does not expose raw auth API 404s to users", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("not found", {
          status: 404,
          headers: { "Content-Type": "text/plain" },
        }),
      ),
    );

    await expect(thumperSignIn({
      email: "signin@example.test",
      password: "correct horse battery staple",
    })).rejects.toMatchObject({
      message: "Sign in is temporarily unavailable. Please refresh and try again.",
      status: 404,
      path: "/api/auth/session/email/signin",
    });
  });

  it("keeps cookie-backed billing status same-origin", async () => {
    vi.stubEnv("NEXT_PUBLIC_THUMPER_API_URL", "https://thumper-cloud.onrender.com");
    const status = {
      tier: "starter",
      access_source: "complimentary_pass",
      stripe_customer_id: null,
      limits: {
        calls_per_month: 30,
        emails_per_month: 50,
        private_compute_seconds: 72_000,
        active_private_agents: 1,
      },
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(status), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getThumperBillingStatus()).resolves.toEqual(status);
    expect(fetchMock).toHaveBeenCalledWith("/api/billing/status", {
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
    });
  });

  it("redeems complimentary access through the same-origin session proxy", async () => {
    vi.stubEnv("NEXT_PUBLIC_THUMPER_API_URL", "https://thumper-cloud.onrender.com");
    const redeemed = {
      ok: true,
      tier: "starter",
      expires_at: "2026-08-18T12:00:00.000Z",
      access_source: "complimentary_pass" as const,
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(redeemed), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(redeemComplimentaryAccessPass("one-time-code")).resolves.toEqual(redeemed);
    expect(fetchMock).toHaveBeenCalledWith("/api/billing/access-passes/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ code: "one-time-code" }),
    });
  });

  it("creates checkout through the same-origin session proxy", async () => {
    vi.stubEnv("NEXT_PUBLIC_THUMPER_API_URL", "https://thumper-cloud.onrender.com");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ checkout_url: "https://checkout.example/session" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(createThumperCheckout("starter")).resolves.toEqual({
      checkout_url: "https://checkout.example/session",
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/billing/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ tier: "starter" }),
    });
  });

  it("updates the trading cap through the same-origin session proxy", async () => {
    vi.stubEnv("NEXT_PUBLIC_THUMPER_API_URL", "https://thumper-cloud.onrender.com");
    const privateAgentTrading = {
      included_notional_micro_usd: 10_000_000,
      filled_notional_micro_usd: 0,
      overage_fee_bps: 25,
      accrued_fee_micro_usd: 0,
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

    await expect(updatePrivateAgentTradingFeeCap(5_000_000)).resolves.toEqual(
      privateAgentTrading,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/billing/private-agent/trading/cap",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ monthly_fee_cap_micro_usd: 5_000_000 }),
      },
    );
  });
});
