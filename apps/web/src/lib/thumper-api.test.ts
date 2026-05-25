import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { thumperSignIn, thumperSignUp } from "./thumper-api";

describe("thumper auth helpers", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("uses the cookie-backed email signup session route", async () => {
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

  it("uses the cookie-backed email signin session route", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({
          user: {
            id: "user_signin",
            email: "signin@example.test",
          },
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const res = await thumperSignIn({
      email: "signin@example.test",
      password: "correct horse battery staple",
    });

    expect(res.user).toEqual({
      id: "user_signin",
      email: "signin@example.test",
    });
    expect(res.token).toBeUndefined();
    expect(localStorage.getItem("thumper_token")).toBeNull();
  });
});
