import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { thumperSignIn, thumperSignUp } from "./thumper-api";

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
});
