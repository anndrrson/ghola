export type PerpsTurnkeyBindings = Record<string, string>;
export type PerpsTurnkeyAcceptedSessions = Record<
  string,
  { organizationId: string; sessionKey: string }
>;

export interface PerpsTurnkeyPendingBinding {
  userId: string;
  attemptId: string;
  createdAt: number;
  expiresAt: number;
}

export interface PerpsTurnkeySessionSnapshot {
  sessionKey: string;
  sessionType: "SESSION_TYPE_READ_WRITE";
  userId: string;
  organizationId: string;
  expiry: number;
  token: string;
  publicKey: string;
}

interface PerpsTurnkeySessionReader {
  getActiveSessionKey: () => Promise<string | undefined>;
  getSession: (params: { sessionKey: string }) => Promise<{
    sessionType: string;
    userId: string;
    organizationId: string;
    expiry: number;
    token: string;
    publicKey?: string;
  } | undefined>;
}

const PENDING_BINDING_TTL_MS = 5 * 60_000;
export const PERPS_TURNKEY_SESSION_EXPIRY_SKEW_MS = 5_000;

export async function resolveExactActivePerpsTurnkeySession(
  reader: PerpsTurnkeySessionReader,
  now = Date.now(),
): Promise<PerpsTurnkeySessionSnapshot | null> {
  const sessionKey = await reader.getActiveSessionKey();
  if (!sessionKey) return null;
  const session = await reader.getSession({ sessionKey });
  const confirmedSessionKey = await reader.getActiveSessionKey();
  if (
    !session ||
    confirmedSessionKey !== sessionKey ||
    session.sessionType !== "SESSION_TYPE_READ_WRITE" ||
    !session.userId ||
    !session.organizationId ||
    !session.token ||
    !session.publicKey ||
    !Number.isSafeInteger(session.expiry) ||
    session.expiry * 1_000 <= now + PERPS_TURNKEY_SESSION_EXPIRY_SKEW_MS
  ) {
    return null;
  }
  return {
    sessionKey,
    sessionType: "SESSION_TYPE_READ_WRITE",
    userId: session.userId,
    organizationId: session.organizationId,
    expiry: session.expiry,
    token: session.token,
    publicKey: session.publicKey,
  };
}

export function perpsTurnkeyPendingBindingValue(
  userId: string,
  attemptId: string,
  now = Date.now(),
): string {
  return JSON.stringify({
    userId,
    attemptId,
    createdAt: now,
    expiresAt: now + PENDING_BINDING_TTL_MS,
  });
}

export function parsePerpsTurnkeyPendingBinding(
  value: string | null,
  now = Date.now(),
): PerpsTurnkeyPendingBinding | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const { userId, attemptId, createdAt, expiresAt } = parsed as {
      userId?: unknown;
      attemptId?: unknown;
      createdAt?: unknown;
      expiresAt?: unknown;
    };
    if (typeof userId !== "string" || userId.length === 0) return null;
    if (typeof attemptId !== "string" || !/^ghola-perps-[0-9a-f-]{36}$/.test(attemptId)) {
      return null;
    }
    if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) return null;
    if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return null;
    if (createdAt > now || expiresAt - createdAt !== PENDING_BINDING_TTL_MS) return null;
    return expiresAt > now ? { userId, attemptId, createdAt, expiresAt } : null;
  } catch {
    return null;
  }
}

export function samePerpsTurnkeyPendingBinding(
  left: PerpsTurnkeyPendingBinding | null,
  right: PerpsTurnkeyPendingBinding | null,
): boolean {
  return Boolean(
    left &&
    right &&
    left.userId === right.userId &&
    left.attemptId === right.attemptId &&
    left.createdAt === right.createdAt &&
    left.expiresAt === right.expiresAt,
  );
}

export function mergePerpsTurnkeyBinding(
  bindings: PerpsTurnkeyBindings,
  binding: { userId: string; organizationId: string },
): PerpsTurnkeyBindings | null {
  const existingOrganization = bindings[binding.userId];
  if (existingOrganization && existingOrganization !== binding.organizationId) return null;
  const existingUser = Object.entries(bindings).find(
    ([, organizationId]) => organizationId === binding.organizationId,
  )?.[0];
  if (existingUser && existingUser !== binding.userId) return null;
  return { ...bindings, [binding.userId]: binding.organizationId };
}

export function parsePerpsTurnkeyAcceptedSessions(
  value: string | null,
): PerpsTurnkeyAcceptedSessions {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [
      string,
      { organizationId: string; sessionKey: string },
    ] => {
      const [userId, candidate] = entry;
      if (!userId || !candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        return false;
      }
      const { organizationId, sessionKey } = candidate as {
        organizationId?: unknown;
        sessionKey?: unknown;
      };
      return typeof organizationId === "string" && organizationId.length > 0 &&
        typeof sessionKey === "string" && /^ghola-perps-[0-9a-f-]{36}$/.test(sessionKey);
    }));
  } catch {
    return {};
  }
}

export function isPerpsTurnkeyClientLoading(
  clientState: "loading" | "ready" | "error" | undefined,
): boolean {
  return clientState === undefined || clientState === "loading";
}

export function isPerpsTurnkeyClientConfigured(
  clientState: "loading" | "ready" | "error" | undefined,
): boolean {
  return clientState === "ready";
}

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
  activeTurnkeySessionKey: string | null;
  acceptedTurnkeySessionKey: string | null;
  bindings: PerpsTurnkeyBindings;
  pendingBinding: PerpsTurnkeyPendingBinding | null;
  requireFreshAuthentication: boolean;
}): PerpsTurnkeyBoundaryDecision {
  const pendingBindingUserId = input.pendingBinding?.userId || null;
  const freshAuthenticationMatches = Boolean(
    input.pendingBinding &&
    input.activeTurnkeySessionKey === input.pendingBinding.attemptId,
  );
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
      clearPending: pendingBindingUserId !== null,
    };
  }

  if (!input.turnkeyAuthenticated) {
    return {
      kind: "require_turnkey_auth",
      ready: false,
      clearPending:
        pendingBindingUserId !== null &&
        pendingBindingUserId !== input.thumperUserId,
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
    if (pendingBindingUserId && pendingBindingUserId !== input.thumperUserId) {
      return {
        kind: "logout",
        ready: false,
        clearPending: true,
        reason: "thumper_identity_mismatch",
      };
    }
    if (expectedOrganizationId !== input.turnkeyOrganizationId) {
      return {
        kind: "logout",
        ready: false,
        clearPending: true,
        reason: "turnkey_organization_mismatch",
      };
    }
    const sharedFreshAuthenticationPending =
      pendingBindingUserId === input.thumperUserId;
    const acceptedSessionMatches = Boolean(
      input.acceptedTurnkeySessionKey &&
      input.activeTurnkeySessionKey === input.acceptedTurnkeySessionKey,
    );
    if (input.requireFreshAuthentication || sharedFreshAuthenticationPending) {
      if (!sharedFreshAuthenticationPending && acceptedSessionMatches) {
        return { kind: "ready", ready: true, clearPending: false };
      }
      if (!sharedFreshAuthenticationPending) {
        return {
          kind: "logout",
          ready: false,
          clearPending: true,
          reason: "turnkey_session_invalid",
        };
      }
      if (!freshAuthenticationMatches) {
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
    } else if (!acceptedSessionMatches) {
      return {
        kind: "logout",
        ready: false,
        clearPending: true,
        reason: "turnkey_session_invalid",
      };
    }
    return {
      kind: "ready",
      ready: true,
      clearPending: false,
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

  if (pendingBindingUserId !== input.thumperUserId) {
    return {
      kind: "logout",
      ready: false,
      clearPending: true,
      reason: "unbound_turnkey_session",
    };
  }

  if (!freshAuthenticationMatches) {
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
