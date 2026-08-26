import { describe, expect, it } from "vitest";
import {
  decidePerpsTurnkeyBoundary,
  isPerpsTurnkeyClientConfigured,
  isPerpsTurnkeyClientLoading,
} from "./perps-turnkey-session-boundary";

const authenticated = {
  thumperLoading: false,
  turnkeyAuthenticated: true,
  turnkeyOrganizationId: "org-a",
  pendingBindingUserId: null,
  freshAuthenticationOrganizationId: null,
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
      pendingBindingUserId: "user-a",
      freshAuthenticationOrganizationId: "org-a",
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
      pendingBindingUserId: "user-a",
      freshAuthenticationOrganizationId: "org-a",
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
      pendingBindingUserId: "user-a",
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
      pendingBindingUserId: "user-a",
      requireFreshAuthentication: true,
    })).toEqual({
      kind: "await_fresh_turnkey_auth",
      ready: false,
      clearPending: false,
    });
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
