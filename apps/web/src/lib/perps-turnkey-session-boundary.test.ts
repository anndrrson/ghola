import { describe, expect, it } from "vitest";
import {
  decidePerpsTurnkeyBoundary,
  isPerpsTurnkeyClientConfigured,
  isPerpsTurnkeyClientLoading,
  mergePerpsTurnkeyBinding,
  parsePerpsTurnkeyAcceptedSessions,
  parsePerpsTurnkeyPendingBinding,
  perpsTurnkeyPendingBindingValue,
  resolveExactActivePerpsTurnkeySession,
} from "./perps-turnkey-session-boundary";

const pending = {
  userId: "user-a",
  attemptId: "ghola-perps-00000000-0000-4000-8000-000000000001",
  createdAt: 1_000_000,
  expiresAt: 1_300_000,
};

const authenticated = {
  thumperLoading: false,
  turnkeyAuthenticated: true,
  turnkeyOrganizationId: "org-a",
  activeTurnkeySessionKey: "ghola-perps-00000000-0000-4000-8000-000000000000",
  acceptedTurnkeySessionKey: "ghola-perps-00000000-0000-4000-8000-000000000000",
  pendingBinding: null,
  requireFreshAuthentication: false,
};

describe("decidePerpsTurnkeyBoundary", () => {
  it("completes one fresh login and restores the same session without rebinding", () => {
    expect(decidePerpsTurnkeyBoundary({
      ...authenticated,
      thumperUserId: "user-a",
      turnkeyAuthenticated: false,
      turnkeyOrganizationId: null,
      bindings: {},
    })).toEqual({ kind: "require_turnkey_auth", ready: false, clearPending: false });

    expect(decidePerpsTurnkeyBoundary({
      ...authenticated,
      thumperUserId: "user-a",
      bindings: {},
      pendingBinding: pending,
      activeTurnkeySessionKey: pending.attemptId,
      requireFreshAuthentication: true,
    })).toEqual({
      kind: "bind",
      ready: false,
      clearPending: true,
      binding: { userId: "user-a", organizationId: "org-a" },
    });

    expect(decidePerpsTurnkeyBoundary({
      ...authenticated,
      thumperUserId: "user-a",
      bindings: { "user-a": "org-a" },
    })).toEqual({ kind: "ready", ready: true, clearPending: false });
  });

  it("logs Turnkey out when Thumper changes from user A to user B", () => {
    expect(decidePerpsTurnkeyBoundary({
      ...authenticated,
      thumperUserId: "user-b",
      bindings: { "user-a": "org-a" },
    })).toMatchObject({
      kind: "logout",
      ready: false,
      reason: "thumper_identity_mismatch",
    });
  });

  it("logs Turnkey out when Thumper logs out", () => {
    expect(decidePerpsTurnkeyBoundary({
      ...authenticated,
      thumperUserId: null,
      bindings: { "user-a": "org-a" },
    })).toMatchObject({
      kind: "logout",
      ready: false,
      reason: "thumper_signed_out",
    });
  });

  it("restores readiness for the same user and organization", () => {
    expect(decidePerpsTurnkeyBoundary({
      ...authenticated,
      thumperUserId: "user-a",
      bindings: { "user-a": "org-a" },
    })).toEqual({ kind: "ready", ready: true, clearPending: false });
  });

  it("logs Turnkey out on an organization mismatch", () => {
    expect(decidePerpsTurnkeyBoundary({
      ...authenticated,
      turnkeyOrganizationId: "org-b",
      thumperUserId: "user-a",
      bindings: { "user-a": "org-a" },
    })).toMatchObject({
      kind: "logout",
      ready: false,
      reason: "turnkey_organization_mismatch",
    });
  });

  it("binds a first login exactly when the current user initiated it", () => {
    const decision = decidePerpsTurnkeyBoundary({
      ...authenticated,
      thumperUserId: "user-a",
      bindings: {},
      pendingBinding: pending,
      activeTurnkeySessionKey: pending.attemptId,
    });
    expect(decision).toEqual({
      kind: "bind",
      ready: false,
      clearPending: true,
      binding: { userId: "user-a", organizationId: "org-a" },
    });

    expect(decidePerpsTurnkeyBoundary({
      ...authenticated,
      thumperUserId: "user-a",
      bindings: { "user-a": "org-a" },
    })).toEqual({ kind: "ready", ready: true, clearPending: false });
  });

  it("never claims a pre-existing unbound Turnkey session", () => {
    expect(decidePerpsTurnkeyBoundary({
      ...authenticated,
      thumperUserId: "user-a",
      bindings: {},
    })).toMatchObject({
      kind: "logout",
      ready: false,
      reason: "unbound_turnkey_session",
    });
  });

  it("does not bind while a fresh authentication receipt is pending", () => {
    expect(decidePerpsTurnkeyBoundary({
      ...authenticated,
      thumperUserId: "user-a",
      bindings: {},
      pendingBinding: pending,
    })).toEqual({
      kind: "await_fresh_turnkey_auth",
      ready: false,
      clearPending: false,
    });
  });

  it("does not restore an invalidated session without fresh authentication", () => {
    expect(decidePerpsTurnkeyBoundary({
      ...authenticated,
      thumperUserId: "user-a",
      bindings: { "user-a": "org-a" },
      pendingBinding: pending,
      requireFreshAuthentication: true,
    })).toEqual({
      kind: "await_fresh_turnkey_auth",
      ready: false,
      clearPending: false,
    });

    expect(decidePerpsTurnkeyBoundary({
      ...authenticated,
      thumperUserId: "user-a",
      bindings: { "user-a": "org-a" },
      requireFreshAuthentication: true,
      acceptedTurnkeySessionKey: null,
    })).toMatchObject({
      kind: "logout",
      ready: false,
      reason: "turnkey_session_invalid",
    });

    expect(decidePerpsTurnkeyBoundary({
      ...authenticated,
      thumperUserId: "user-a",
      bindings: { "user-a": "org-a" },
      requireFreshAuthentication: true,
    })).toEqual({ kind: "ready", ready: true, clearPending: false });
  });
});

describe("isPerpsTurnkeyClientLoading", () => {
  it("stays loading until Turnkey reports a concrete client state", () => {
    expect(isPerpsTurnkeyClientLoading(undefined)).toBe(true);
    expect(isPerpsTurnkeyClientLoading("loading")).toBe(true);
    expect(isPerpsTurnkeyClientLoading("ready")).toBe(false);
    expect(isPerpsTurnkeyClientLoading("error")).toBe(false);
  });

  it("fails configuration closed until Turnkey is fully ready", () => {
    expect(isPerpsTurnkeyClientConfigured(undefined)).toBe(false);
    expect(isPerpsTurnkeyClientConfigured("loading")).toBe(false);
    expect(isPerpsTurnkeyClientConfigured("ready")).toBe(true);
    expect(isPerpsTurnkeyClientConfigured("error")).toBe(false);
  });
});

describe("cross-tab Turnkey authentication", () => {
  it("resolves one exact active, unexpired read-write session", async () => {
    const sessionKey = pending.attemptId;
    const session = {
      sessionType: "SESSION_TYPE_READ_WRITE",
      userId: "turnkey-user-a",
      organizationId: "org-a",
      expiry: 2_000,
      token: "header.payload.signature",
      publicKey: "public-key-a",
    };
    await expect(resolveExactActivePerpsTurnkeySession({
      getActiveSessionKey: async () => sessionKey,
      getSession: async ({ sessionKey: requested }) =>
        requested === sessionKey ? session : undefined,
    }, 1_000_000)).resolves.toEqual({ sessionKey, ...session });
  });

  it("rejects expired, read-only, or concurrently replaced sessions", async () => {
    let activeRead = 0;
    const baseSession = {
      sessionType: "SESSION_TYPE_READ_WRITE",
      userId: "turnkey-user-a",
      organizationId: "org-a",
      expiry: 2_000,
      token: "header.payload.signature",
      publicKey: "public-key-a",
    };
    await expect(resolveExactActivePerpsTurnkeySession({
      getActiveSessionKey: async () =>
        activeRead++ === 0 ? pending.attemptId : authenticated.activeTurnkeySessionKey,
      getSession: async () => baseSession,
    }, 1_000_000)).resolves.toBeNull();
    await expect(resolveExactActivePerpsTurnkeySession({
      getActiveSessionKey: async () => pending.attemptId,
      getSession: async () => ({ ...baseSession, expiry: 1_000 }),
    }, 1_000_000)).resolves.toBeNull();
    await expect(resolveExactActivePerpsTurnkeySession({
      getActiveSessionKey: async () => pending.attemptId,
      getSession: async () => ({ ...baseSession, sessionType: "SESSION_TYPE_READ_ONLY" }),
    }, 1_000_000)).resolves.toBeNull();
  });

  it("shares only a short-lived pending binding", () => {
    const now = 1_000_000;
    const value = perpsTurnkeyPendingBindingValue("user-a", pending.attemptId, now);
    expect(parsePerpsTurnkeyPendingBinding(value, now)).toEqual(pending);
    expect(parsePerpsTurnkeyPendingBinding(value, now + 5 * 60_000)).toBeNull();
  });

  it("rejects malformed or unbounded pending records", () => {
    const now = 1_000_000;
    expect(parsePerpsTurnkeyPendingBinding("user-a", now)).toBeNull();
    expect(parsePerpsTurnkeyPendingBinding(JSON.stringify({
      userId: "user-a",
      attemptId: pending.attemptId,
      createdAt: now,
      expiresAt: now + 5 * 60_000 + 1,
    }), now)).toBeNull();
  });

  it("makes every tab wait while a bound identity is being freshly authenticated", () => {
    expect(decidePerpsTurnkeyBoundary({
      thumperLoading: false,
      thumperUserId: "user-a",
      turnkeyAuthenticated: true,
      turnkeyOrganizationId: "org-a",
      activeTurnkeySessionKey: null,
      acceptedTurnkeySessionKey: authenticated.acceptedTurnkeySessionKey,
      bindings: { "user-a": "org-a" },
      pendingBinding: pending,
      requireFreshAuthentication: false,
    })).toEqual({
      kind: "await_fresh_turnkey_auth",
      ready: false,
      clearPending: false,
    });
  });

  it("accepts freshness only from the exact Turnkey session key", () => {
    expect(decidePerpsTurnkeyBoundary({
      ...authenticated,
      thumperUserId: "user-a",
      bindings: { "user-a": "org-a" },
      pendingBinding: pending,
      activeTurnkeySessionKey: pending.attemptId,
    })).toEqual({
      kind: "bind",
      ready: false,
      clearPending: true,
      binding: { userId: "user-a", organizationId: "org-a" },
    });
    expect(decidePerpsTurnkeyBoundary({
      ...authenticated,
      thumperUserId: "user-a",
      bindings: { "user-a": "org-a" },
      pendingBinding: pending,
      activeTurnkeySessionKey: "ghola-perps-00000000-0000-4000-8000-000000000002",
    }).kind).toBe("await_fresh_turnkey_auth");
  });

  it("rejects a restored session that was never accepted by Ghola", () => {
    expect(decidePerpsTurnkeyBoundary({
      ...authenticated,
      thumperUserId: "user-a",
      bindings: { "user-a": "org-a" },
      acceptedTurnkeySessionKey: null,
    })).toMatchObject({
      kind: "logout",
      reason: "turnkey_session_invalid",
    });
  });

  it("parses only bounded Ghola session receipts", () => {
    expect(parsePerpsTurnkeyAcceptedSessions(JSON.stringify({
      "user-a": {
        organizationId: "org-a",
        sessionKey: pending.attemptId,
      },
      "user-b": { organizationId: "org-b", sessionKey: "default" },
    }))).toEqual({
      "user-a": { organizationId: "org-a", sessionKey: pending.attemptId },
    });
  });

  it("merges bindings without overwriting another identity", () => {
    expect(mergePerpsTurnkeyBinding({ "user-a": "org-a" }, {
      userId: "user-b",
      organizationId: "org-b",
    })).toEqual({ "user-a": "org-a", "user-b": "org-b" });
    expect(mergePerpsTurnkeyBinding({ "user-a": "org-a" }, {
      userId: "user-a",
      organizationId: "org-b",
    })).toBeNull();
    expect(mergePerpsTurnkeyBinding({ "user-a": "org-a" }, {
      userId: "user-b",
      organizationId: "org-a",
    })).toBeNull();
  });
});
