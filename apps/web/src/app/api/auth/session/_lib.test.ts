import { describe, expect, it } from "vitest";

import {
  parseJwtPayload,
  sameOrigin,
  sessionCookieMaxAge,
  userFromProfile,
  userFromToken,
} from "./_lib";

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

describe("auth session helpers", () => {
  it("extracts user from valid token payload", () => {
    const token = makeJwt({
      sub: "u_123",
      email: "alice@example.com",
      name: "Alice",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const user = userFromToken(token);
    expect(user).toEqual({
      id: "u_123",
      email: "alice@example.com",
      name: "Alice",
    });
  });

  it("returns null user for malformed token", () => {
    expect(parseJwtPayload("not-a-jwt")).toBeNull();
    expect(userFromToken("not-a-jwt")).toBeNull();
  });

  it("never returns negative cookie max-age", () => {
    const token = makeJwt({
      sub: "u_123",
      email: "alice@example.com",
      exp: Math.floor(Date.now() / 1000) - 10,
    });
    expect(sessionCookieMaxAge(token)).toBe(0);
  });

  it("builds a session user only from a backend profile shape", () => {
    expect(
      userFromProfile({
        id: "user-id",
        email: "alice@example.com",
        display_name: "Alice",
      }),
    ).toEqual({
      id: "user-id",
      email: "alice@example.com",
      name: "Alice",
    });
    expect(userFromProfile({ id: "user-id", email: null })).toBeNull();
  });

  it("requires a matching Origin header for cookie-backed state changes", () => {
    expect(
      sameOrigin({
        headers: new Headers({ origin: "https://ghola.test" }),
        nextUrl: { origin: "https://ghola.test" },
      }),
    ).toBe(true);
    expect(
      sameOrigin({
        headers: new Headers({ origin: "https://evil.test" }),
        nextUrl: { origin: "https://ghola.test" },
      }),
    ).toBe(false);
    expect(
      sameOrigin({
        headers: new Headers(),
        nextUrl: { origin: "https://ghola.test" },
      }),
    ).toBe(false);
  });
});
