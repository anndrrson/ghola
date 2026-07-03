import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Turnkey SDK mock. The ownership-binding tests drive the
// `getSubOrgIds`/`getWallets`/`getWalletAccounts` responses without
// reaching the network. `vi.mock` is hoisted above the route imports.
const turnkeyApiState = {
  ownedSubOrgIds: [] as string[],
  walletAccounts: [] as { walletId: string; address: string }[],
  signResult: { r: "00".repeat(32), s: "11".repeat(32) } as
    | { r?: string; s?: string }
    | null,
  throwOnGetSubOrgIds: null as Error | null,
};
function resetTurnkeyApiState() {
  turnkeyApiState.ownedSubOrgIds = [];
  turnkeyApiState.walletAccounts = [];
  turnkeyApiState.signResult = { r: "00".repeat(32), s: "11".repeat(32) };
  turnkeyApiState.throwOnGetSubOrgIds = null;
}
/* eslint-disable @typescript-eslint/no-unused-vars */
vi.mock("@turnkey/sdk-server", () => {
  class Turnkey {
    constructor(_cfg: unknown) {}
    apiClient() {
      return {
        getSubOrgIds: async (_args: unknown) => {
          if (turnkeyApiState.throwOnGetSubOrgIds) {
            throw turnkeyApiState.throwOnGetSubOrgIds;
          }
          return { organizationIds: turnkeyApiState.ownedSubOrgIds };
        },
        getWallets: async (_args: unknown) => {
          const ids = new Set(
            turnkeyApiState.walletAccounts.map((a) => a.walletId)
          );
          return {
            wallets: Array.from(ids).map((walletId) => ({ walletId })),
          };
        },
        getWalletAccounts: async (args: { walletId: string }) => ({
          accounts: turnkeyApiState.walletAccounts
            .filter((a) => a.walletId === args.walletId)
            .map((a) => ({ address: a.address })),
        }),
        signRawPayload: async (_args: unknown) => {
          if (!turnkeyApiState.signResult) {
            throw new Error("sign failed");
          }
          return turnkeyApiState.signResult;
        },
      };
    }
  }
  return { Turnkey };
});
/* eslint-enable @typescript-eslint/no-unused-vars */

import { POST as createWallet } from "./create-wallet/route";
import { POST as signMessage } from "./sign-message/route";

// The defense-in-depth tests drive session validation by stubbing the
// upstream profile fetch that the real `fetchSessionUser` performs
// (GET ${THUMPER_API_BASE}/api/user/profile). This keeps the real
// sameOrigin/cookie/session logic exercised end-to-end rather than
// mocking it away. `setSessionProfile(null)` simulates an invalid token
// (upstream 401); a profile object simulates a valid session.
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

// A NextRequest-shaped object that drives the cookie + origin inputs the
// turnkey defense-in-depth checks read, without a real Turnkey backend.
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

// Main's gate is a single flag: TURNKEY_SERVER_SIGNING_ENABLED=true.
function enableSigning() {
  vi.stubEnv("TURNKEY_SERVER_SIGNING_ENABLED", "true");
  vi.stubEnv("TURNKEY_ORG_ID", "parent-org");
  vi.stubEnv("TURNKEY_API_PUBLIC_KEY", "pub");
  vi.stubEnv("TURNKEY_API_PRIVATE_KEY", "priv");
}

describe("Turnkey route privacy defaults", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.TURNKEY_SERVER_CONTROLLED_WALLETS_ENABLED;
    delete process.env.TURNKEY_SERVER_SIGNING_ENABLED;
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
});

// These exercise the IDOR / defense-in-depth checks that only become
// reachable once server signing is explicitly enabled. They must hold so
// the guards aren't silently dropped before anyone flips the flag.
describe("Turnkey sign-message ownership binding (when enabled)", () => {
  beforeEach(() => {
    resetTurnkeyApiState();
    setSessionProfile(null);
    installSessionFetchStub();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    restoreFetch();
  });

  it("rejects cross-site requests", async () => {
    enableSigning();
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

  it("requires an authenticated session", async () => {
    enableSigning();
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

  it("rejects an invalid session token", async () => {
    enableSigning();
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

  it("rejects user A signing with user B's subOrgId (the original IDOR)", async () => {
    enableSigning();
    setSessionProfile({ id: "alice", email: "alice@example.com" });
    turnkeyApiState.ownedSubOrgIds = ["alice-sub-org"]; // alice owns only this
    const res = await signMessage(
      authedRequest("/api/turnkey/sign-message", {
        message: "hi",
        subOrgId: "bob-sub-org", // bob's
        walletAddress: "bob-wallet",
      })
    );
    const body = await res.json();
    expect(res.status).toBe(403);
    expect(body.code).toBe("turnkey_sub_org_not_owned");
  });

  it("rejects an owned sub-org paired with a wallet that lives elsewhere", async () => {
    enableSigning();
    setSessionProfile({ id: "alice", email: "alice@example.com" });
    turnkeyApiState.ownedSubOrgIds = ["alice-sub-org"];
    turnkeyApiState.walletAccounts = [
      { walletId: "w1", address: "alice-real-wallet" },
    ];
    const res = await signMessage(
      authedRequest("/api/turnkey/sign-message", {
        message: "hi",
        subOrgId: "alice-sub-org",
        walletAddress: "someone-elses-wallet",
      })
    );
    const body = await res.json();
    expect(res.status).toBe(403);
    expect(body.code).toBe("turnkey_wallet_sub_org_mismatch");
  });

  it("fails closed if the ownership check itself errors", async () => {
    enableSigning();
    setSessionProfile({ id: "alice", email: "alice@example.com" });
    turnkeyApiState.throwOnGetSubOrgIds = new Error("turnkey down");
    const res = await signMessage(
      authedRequest("/api/turnkey/sign-message", {
        message: "hi",
        subOrgId: "alice-sub-org",
        walletAddress: "alice-wallet",
      })
    );
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.code).toBe("turnkey_ownership_check_failed");
  });

  it("signs when the sub-org and wallet both belong to the session user", async () => {
    enableSigning();
    setSessionProfile({ id: "alice", email: "alice@example.com" });
    turnkeyApiState.ownedSubOrgIds = ["alice-sub-org"];
    turnkeyApiState.walletAccounts = [
      { walletId: "w1", address: "alice-wallet" },
    ];
    const res = await signMessage(
      authedRequest("/api/turnkey/sign-message", {
        message: "hi",
        subOrgId: "alice-sub-org",
        walletAddress: "alice-wallet",
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.signature).toBe("string");
  });
});
