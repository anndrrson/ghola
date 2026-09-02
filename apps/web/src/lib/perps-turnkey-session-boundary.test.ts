import { describe, expect, it } from "vitest";
import {
  claimPerpsTurnkeyPendingBinding,
  clearLocallyOwnedPerpsTurnkeyPendingBinding,
  decidePerpsTurnkeyBoundary,
  isPerpsTurnkeyClientConfigured,
  isPerpsTurnkeyClientLoading,
  isExactLocallyOwnedPerpsTurnkeyPendingBinding,
  mergePerpsTurnkeyBinding,
  parsePerpsTurnkeyAcceptedSessions,
  parsePerpsTurnkeyPendingBinding,
  perpsTurnkeyPendingBindingValue,
  reconcileExactPerpsTurnkeySessionAttempt,
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
  function memoryStorage() {
    const values = new Map<string, string>();
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    };
  }

  it("resumes only the exact pending attempt owned by this tab", () => {
    const storage = memoryStorage();
    const storageKey = "pending";
    const first = claimPerpsTurnkeyPendingBinding({
      storage,
      storageKey,
      userId: "user-a",
      locallyOwnedAttemptId: null,
      createAttemptId: () => pending.attemptId,
      now: pending.createdAt,
    });
    expect(first).toEqual({ pending, resumed: false });

    const resumed = claimPerpsTurnkeyPendingBinding({
      storage,
      storageKey,
      userId: "user-a",
      locallyOwnedAttemptId: pending.attemptId,
      createAttemptId: () => "ghola-perps-00000000-0000-4000-8000-000000000002",
      now: pending.createdAt,
    });
    expect(resumed).toEqual({ pending, resumed: true });
  });

  it("blocks a different tab or user from claiming an active attempt", () => {
    const storage = memoryStorage();
    storage.setItem("pending", JSON.stringify(pending));
    const claim = (userId: string, locallyOwnedAttemptId: string | null) =>
      claimPerpsTurnkeyPendingBinding({
        storage,
        storageKey: "pending",
        userId,
        locallyOwnedAttemptId,
        createAttemptId: () => "ghola-perps-00000000-0000-4000-8000-000000000002",
        now: pending.createdAt,
      });
    expect(() => claim("user-a", null)).toThrow("another Ghola tab");
    expect(() => claim("user-b", pending.attemptId)).toThrow("another Ghola tab");
    expect(storage.getItem("pending")).toBe(JSON.stringify(pending));
  });

  it("clears an exact local attempt on pagehide so a reload can start immediately", () => {
    const storage = memoryStorage();
    storage.setItem("pending", JSON.stringify(pending));
    expect(clearLocallyOwnedPerpsTurnkeyPendingBinding({
      storage,
      storageKey: "pending",
      locallyOwnedAttemptId: "ghola-perps-00000000-0000-4000-8000-000000000002",
      now: pending.createdAt,
    })).toBeNull();
    expect(storage.getItem("pending")).toBe(JSON.stringify(pending));

    expect(clearLocallyOwnedPerpsTurnkeyPendingBinding({
      storage,
      storageKey: "pending",
      locallyOwnedAttemptId: pending.attemptId,
      now: pending.createdAt,
    })).toEqual(pending);
    expect(storage.getItem("pending")).toBeNull();

    const next = claimPerpsTurnkeyPendingBinding({
      storage,
      storageKey: "pending",
      userId: "user-a",
      locallyOwnedAttemptId: null,
      createAttemptId: () => "ghola-perps-00000000-0000-4000-8000-000000000002",
      now: pending.createdAt + 1,
    });
    expect(next.resumed).toBe(false);
    expect(next.pending.attemptId).not.toBe(pending.attemptId);
  });

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

  it("adopts a delayed exact session without discarding the pending attempt", async () => {
    const exactSession = {
      sessionKey: pending.attemptId,
      sessionType: "SESSION_TYPE_READ_WRITE" as const,
      userId: "turnkey-user-a",
      organizationId: "org-a",
      expiry: 2_000,
      token: "header.payload.signature",
      publicKey: "public-key-a",
    };
    const reads = [null, null, exactSession];
    const waits: number[] = [];

    await expect(reconcileExactPerpsTurnkeySessionAttempt({
      attemptId: pending.attemptId,
      readExactSession: async () => reads.shift() ?? null,
      wait: async (durationMs) => { waits.push(durationMs); },
      pollIntervalMs: 100,
      maxWaitMs: 200,
    })).resolves.toEqual({ kind: "matched", session: exactSession });
    expect(waits).toEqual([100, 100]);
  });

  it("keeps a pending attempt fail-closed while the exact session remains unavailable", async () => {
    let reads = 0;
    await expect(reconcileExactPerpsTurnkeySessionAttempt({
      attemptId: pending.attemptId,
      readExactSession: async () => {
        reads += 1;
        return null;
      },
      wait: async () => {},
      pollIntervalMs: 100,
      maxWaitMs: 200,
    })).resolves.toEqual({ kind: "timed_out" });
    expect(reads).toBe(3);
  });

  it("keeps polling past a different session until the expected session appears", async () => {
    const differentSession = {
      sessionKey: "ghola-perps-00000000-0000-4000-8000-000000000002",
      sessionType: "SESSION_TYPE_READ_WRITE" as const,
      userId: "turnkey-user-a",
      organizationId: "org-a",
      expiry: 2_000,
      token: "header.payload.signature",
      publicKey: "public-key-b",
    };
    const expectedSession = { ...differentSession, sessionKey: pending.attemptId };
    const reads = [differentSession, expectedSession];
    const waits: number[] = [];
    await expect(reconcileExactPerpsTurnkeySessionAttempt({
      attemptId: pending.attemptId,
      readExactSession: async () => reads.shift() ?? null,
      wait: async (durationMs) => { waits.push(durationMs); },
      pollIntervalMs: 100,
      maxWaitMs: 100,
    })).resolves.toEqual({ kind: "matched", session: expectedSession });
    expect(waits).toEqual([100]);
  });

  it("times out without mutating a persistent different session", async () => {
    const differentSession = {
      sessionKey: "ghola-perps-00000000-0000-4000-8000-000000000002",
      sessionType: "SESSION_TYPE_READ_WRITE" as const,
      userId: "turnkey-user-a",
      organizationId: "org-a",
      expiry: 2_000,
      token: "header.payload.signature",
      publicKey: "public-key-b",
    };
    let reads = 0;
    await expect(reconcileExactPerpsTurnkeySessionAttempt({
      attemptId: pending.attemptId,
      readExactSession: async () => {
        reads += 1;
        return differentSession;
      },
      wait: async () => {},
      pollIntervalMs: 100,
      maxWaitMs: 200,
    })).resolves.toEqual({ kind: "timed_out" });
    expect(reads).toBe(3);
    expect(differentSession.sessionKey).toBe(
      "ghola-perps-00000000-0000-4000-8000-000000000002",
    );
  });

  it("does not adopt when the pending owner changes during reconciliation", async () => {
    const storage = memoryStorage();
    storage.setItem("pending", JSON.stringify(pending));
    const replacement = {
      ...pending,
      attemptId: "ghola-perps-00000000-0000-4000-8000-000000000002",
    };
    const exactSession = {
      sessionKey: pending.attemptId,
      sessionType: "SESSION_TYPE_READ_WRITE" as const,
      userId: "turnkey-user-a",
      organizationId: "org-a",
      expiry: 2_000,
      token: "header.payload.signature",
      publicKey: "public-key-a",
    };
    let reads = 0;
    const reconciliation = await reconcileExactPerpsTurnkeySessionAttempt({
      attemptId: pending.attemptId,
      readExactSession: async () => (++reads === 1 ? null : exactSession),
      wait: async () => { storage.setItem("pending", JSON.stringify(replacement)); },
      pollIntervalMs: 100,
      maxWaitMs: 100,
    });
    expect(reconciliation.kind).toBe("matched");
    expect(isExactLocallyOwnedPerpsTurnkeyPendingBinding({
      storage,
      storageKey: "pending",
      expected: pending,
      locallyOwnedAttemptId: pending.attemptId,
      now: pending.createdAt,
    })).toBe(false);
    expect(storage.getItem("pending")).toBe(JSON.stringify(replacement));
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
