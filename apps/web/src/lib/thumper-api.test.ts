import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  thumperSignIn,
  thumperSignUp,
  withdrawEarnings,
  withdrawProviderEarnings,
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

  it("sends the caller's stable idempotency key for bounty withdrawals", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        payout_id: "payout_1",
        amount_usdc: 1_000_000,
        to_address: "solana-address",
        signature: "signature",
        status: "confirmed",
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await withdrawEarnings({
      to_address: "solana-address",
      amount_usdc: 1_000_000,
      idempotency_key: "payout_11111111_1111_4111_8111_111111111111",
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/wallet/withdraw-earnings", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        to_address: "solana-address",
        amount_usdc: 1_000_000,
        idempotency_key: "payout_11111111_1111_4111_8111_111111111111",
      }),
    }));
  });

  it("sends the caller's stable idempotency key for provider withdrawals", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        payout_id: "payout_2",
        amount_usdc: 2_000_000,
        to_address: "provider-address",
        signature: "signature",
        explorer_url: "https://explorer.test/tx/signature",
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await withdrawProviderEarnings({
      amount_usdc: 2_000_000,
      idempotency_key: "payout_22222222_2222_4222_8222_222222222222",
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/compute/providers/me/withdraw", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        amount_usdc: 2_000_000,
        idempotency_key: "payout_22222222_2222_4222_8222_222222222222",
      }),
    }));
  });
});
