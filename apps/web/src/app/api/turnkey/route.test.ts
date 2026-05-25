import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as createWallet } from "./create-wallet/route";
import { POST as signMessage } from "./sign-message/route";

// The defense-in-depth tests drive session validation by stubbing the
// upstream profile fetch that the real `fetchSessionUser` performs
// (GET ${THUMPER_API_BASE}/api/user/profile). This keeps the real
// sameOrigin/cookie/session logic exercised end-to-end rather than
// mocking it away. `setSessionProfile(null)` simulates an invalid token
// (upstream 401); a profile object simulates a valid session for that
// user.
type SessionProfile = { id: string; email: string; display_name?: string } | null;
let currentSessionProfile: SessionProfile = null;
function setSessionProfile(profile: SessionProfile) {
  currentSessionProfile = profile;
}
const realFetch = globalThis.fetch;
function installSessionFetchStub() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/user/profile")) {
      if (!currentSessionProfile) {
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
      }
      return new Response(JSON.stringify(currentSessionProfile), { status: 200 });
    }
    // Any other upstream call (e.g. a real Turnkey API hit) is not
    // expected in these tests; fail loudly rather than reaching the net.
    return new Response(JSON.stringify({ error: "unexpected upstream call" }), {
      status: 599,
    });
  }) as typeof globalThis.fetch;
}
function restoreFetch() {
  globalThis.fetch = realFetch;
}

function jsonRequest(path: string, body: unknown) {
  return new Request(`https://ghola.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as never;
}

// A NextRequest-shaped object that lets us drive the cookie + origin
// inputs the turnkey defense-in-depth checks read, without standing up a
// real Turnkey backend. Mirrors how proxy.test.ts fakes a request.
function authedRequest(
  path: string,
  body: unknown,
  opts: { origin?: string | null; cookie?: string | null } = {}
) {
  const { origin = "https://ghola.test", cookie = "valid-session-token" } = opts;
  const headers = new Headers({ "content-type": "application/json" });
  if (origin) headers.set("origin", origin);
  return {
    headers,
    nextUrl: { origin: "https://ghola.test" },
    cookies: {
      get: (name: string) =>
        cookie && name === "ghola_thumper_session" ? { value: cookie } : undefined,
    },
    json: async () => body,
  } as never;
}

function enableSigningInProd() {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("TURNKEY_SERVER_SIGNING_ENABLED", "true");
  vi.stubEnv("TURNKEY_DANGEROUS_SERVER_SIGNING_ALLOW_PRODUCTION", "true");
}

function enableWalletsInProd() {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("TURNKEY_SERVER_CONTROLLED_WALLETS_ENABLED", "true");
  vi.stubEnv("TURNKEY_DANGEROUS_SERVER_CONTROLLED_WALLETS_ALLOW_PRODUCTION", "true");
}

describe("Turnkey route privacy defaults", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.TURNKEY_SERVER_CONTROLLED_WALLETS_ENABLED;
    delete process.env.TURNKEY_DANGEROUS_SERVER_CONTROLLED_WALLETS_ALLOW_PRODUCTION;
    delete process.env.TURNKEY_SERVER_SIGNING_ENABLED;
    delete process.env.TURNKEY_DANGEROUS_SERVER_SIGNING_ALLOW_PRODUCTION;
  });

  it("fails closed for server-controlled wallet creation", async () => {
    delete process.env.TURNKEY_SERVER_CONTROLLED_WALLETS_ENABLED;

    const res = await createWallet(
      jsonRequest("/api/turnkey/create-wallet", {
        email: "alice@example.com",
      })
    );
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.code).toBe("turnkey_server_controlled_wallets_disabled");
  });

  it("fails closed for server-side Turnkey signing", async () => {
    delete process.env.TURNKEY_SERVER_SIGNING_ENABLED;

    const res = await signMessage(
      jsonRequest("/api/turnkey/sign-message", {
        message: "Sign in to Ghola\nNonce: abc\nIssued At: 1\nExpires At: 2\nURI: https://ghola.xyz\nVersion: 1",
        subOrgId: "sub-org",
        walletAddress: "wallet-address",
      })
    );
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.code).toBe("turnkey_server_signing_disabled");
  });

  it("keeps server-controlled wallet creation closed in production without the dangerous override", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TURNKEY_SERVER_CONTROLLED_WALLETS_ENABLED", "true");

    const res = await createWallet(
      jsonRequest("/api/turnkey/create-wallet", {
        email: "alice@example.com",
      })
    );
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.code).toBe("turnkey_server_controlled_wallets_disabled");
  });

  it("keeps server-side Turnkey signing closed in production without the dangerous override", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TURNKEY_SERVER_SIGNING_ENABLED", "true");

    const res = await signMessage(
      jsonRequest("/api/turnkey/sign-message", {
        message: "Sign in to Ghola",
        subOrgId: "sub-org",
        walletAddress: "wallet-address",
      })
    );
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.code).toBe("turnkey_server_signing_disabled");
  });
});

// These exercise the defense-in-depth checks that only become reachable
// once the dangerous production override is set. They must hold so the
// guards aren't silently dropped before anyone flips the flag.
describe("Turnkey defense-in-depth (when enabled)", () => {
  beforeEach(() => {
    setSessionProfile(null);
    installSessionFetchStub();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    restoreFetch();
  });

  it("sign-message rejects cross-site requests", async () => {
    enableSigningInProd();
    setSessionProfile({ id: "u1", email: "alice@example.com" });
    const res = await signMessage(
      authedRequest(
        "/api/turnkey/sign-message",
        { message: "hi", subOrgId: "sub-org", walletAddress: "wallet" },
        { origin: "https://evil.example" }
      )
    );
    const body = await res.json();
    expect(res.status).toBe(403);
    expect(body.code).toBe("turnkey_cross_site_rejected");
  });

  it("sign-message requires an authenticated session", async () => {
    enableSigningInProd();
    const res = await signMessage(
      authedRequest(
        "/api/turnkey/sign-message",
        { message: "hi", subOrgId: "sub-org", walletAddress: "wallet" },
        { cookie: null }
      )
    );
    const body = await res.json();
    expect(res.status).toBe(401);
    expect(body.code).toBe("turnkey_auth_required");
  });

  it("sign-message rejects an invalid session token", async () => {
    enableSigningInProd();
    setSessionProfile(null); // upstream profile fetch returns 401
    const res = await signMessage(
      authedRequest("/api/turnkey/sign-message", {
        message: "hi",
        subOrgId: "sub-org",
        walletAddress: "wallet",
      })
    );
    const body = await res.json();
    expect(res.status).toBe(401);
    expect(body.code).toBe("turnkey_auth_required");
  });

  it("create-wallet rejects cross-site requests", async () => {
    enableWalletsInProd();
    setSessionProfile({ id: "u1", email: "alice@example.com" });
    const res = await createWallet(
      authedRequest(
        "/api/turnkey/create-wallet",
        { email: "alice@example.com" },
        { origin: "https://evil.example" }
      )
    );
    const body = await res.json();
    expect(res.status).toBe(403);
    expect(body.code).toBe("turnkey_cross_site_rejected");
  });

  it("create-wallet requires an authenticated session", async () => {
    enableWalletsInProd();
    const res = await createWallet(
      authedRequest(
        "/api/turnkey/create-wallet",
        { email: "alice@example.com" },
        { cookie: null }
      )
    );
    const body = await res.json();
    expect(res.status).toBe(401);
    expect(body.code).toBe("turnkey_auth_required");
  });

  it("create-wallet rejects an email that does not match the session (IDOR)", async () => {
    enableWalletsInProd();
    setSessionProfile({ id: "u1", email: "alice@example.com" });
    const res = await createWallet(
      authedRequest("/api/turnkey/create-wallet", {
        email: "victim@example.com",
      })
    );
    const body = await res.json();
    expect(res.status).toBe(403);
    expect(body.code).toBe("turnkey_email_session_mismatch");
  });
});
