export type PerpsTurnkeyBindings = Record<string, string>;

export type PerpsTurnkeyBoundaryDecision =
  | { kind: "loading"; ready: false; clearPending: false }
  | { kind: "require_turnkey_auth"; ready: false; clearPending: boolean }
  | { kind: "await_fresh_turnkey_auth"; ready: false; clearPending: false }
  | {
      kind: "bind";
      ready: false;
      clearPending: true;
      binding: { userId: string; organizationId: string };
    }
  | { kind: "ready"; ready: true; clearPending: boolean }
  | {
      kind: "logout";
      ready: false;
      clearPending: true;
      reason:
        | "thumper_signed_out"
        | "turnkey_session_invalid"
        | "thumper_identity_mismatch"
        | "turnkey_organization_mismatch"
        | "unbound_turnkey_session";
    };

export function decidePerpsTurnkeyBoundary(input: {
  thumperLoading: boolean;
  thumperUserId: string | null;
  turnkeyAuthenticated: boolean;
  turnkeyOrganizationId: string | null;
  bindings: PerpsTurnkeyBindings;
  pendingBindingUserId: string | null;
  freshAuthenticationOrganizationId: string | null;
  requireFreshAuthentication: boolean;
}): PerpsTurnkeyBoundaryDecision {
  if (input.thumperLoading) {
    return { kind: "loading", ready: false, clearPending: false };
  }

  if (!input.thumperUserId) {
    if (input.turnkeyAuthenticated || input.turnkeyOrganizationId) {
      return {
        kind: "logout",
        ready: false,
        clearPending: true,
        reason: "thumper_signed_out",
      };
    }
    return {
      kind: "require_turnkey_auth",
      ready: false,
      clearPending: input.pendingBindingUserId !== null,
    };
  }

  if (!input.turnkeyAuthenticated) {
    return {
      kind: "require_turnkey_auth",
      ready: false,
      clearPending:
        input.pendingBindingUserId !== null &&
        input.pendingBindingUserId !== input.thumperUserId,
    };
  }

  if (!input.turnkeyOrganizationId) {
    return {
      kind: "logout",
      ready: false,
      clearPending: true,
      reason: "turnkey_session_invalid",
    };
  }

  const expectedOrganizationId = input.bindings[input.thumperUserId];
  if (expectedOrganizationId) {
    if (expectedOrganizationId !== input.turnkeyOrganizationId) {
      return {
        kind: "logout",
        ready: false,
        clearPending: true,
        reason: "turnkey_organization_mismatch",
      };
    }
    if (input.requireFreshAuthentication) {
      if (input.pendingBindingUserId !== input.thumperUserId) {
        return {
          kind: "logout",
          ready: false,
          clearPending: true,
          reason: "turnkey_session_invalid",
        };
      }
      if (input.freshAuthenticationOrganizationId !== input.turnkeyOrganizationId) {
        return {
          kind: "await_fresh_turnkey_auth",
          ready: false,
          clearPending: false,
        };
      }
    }
    return {
      kind: "ready",
      ready: true,
      clearPending: input.pendingBindingUserId !== null,
    };
  }

  const organizationOwner = Object.entries(input.bindings).find(
    ([, organizationId]) => organizationId === input.turnkeyOrganizationId,
  )?.[0];
  if (organizationOwner && organizationOwner !== input.thumperUserId) {
    return {
      kind: "logout",
      ready: false,
      clearPending: true,
      reason: "thumper_identity_mismatch",
    };
  }

  if (input.pendingBindingUserId !== input.thumperUserId) {
    return {
      kind: "logout",
      ready: false,
      clearPending: true,
      reason: "unbound_turnkey_session",
    };
  }

  if (input.freshAuthenticationOrganizationId !== input.turnkeyOrganizationId) {
    return {
      kind: "await_fresh_turnkey_auth",
      ready: false,
      clearPending: false,
    };
  }

  return {
    kind: "bind",
    ready: false,
    clearPending: true,
    binding: {
      userId: input.thumperUserId,
      organizationId: input.turnkeyOrganizationId,
    },
  };
}

export function parsePerpsTurnkeyBindings(value: string | null): PerpsTurnkeyBindings {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        ([userId, organizationId]) =>
          userId.length > 0 && typeof organizationId === "string" && organizationId.length > 0,
      ),
    );
  } catch {
    return {};
  }
}
