"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  TurnkeyProvider,
  useTurnkey,
  type TurnkeyProviderConfig,
  type WalletAccount,
} from "@turnkey/react-wallet-kit";
import { createAccountWithAddress } from "@turnkey/viem";
import { ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import {
  buildTurnkeyHyperliquidPolicies,
  ownerMandateMessage,
} from "@ghola/perps-core";
import { carryCollateralReviewMessage, carryRiskMandateMessage } from "@ghola/execution-core";
import { useThumperAuth } from "./thumper-auth-context";
import { opaqueTurnkeyWalletScope } from "./turnkey-provider";
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
  parsePerpsTurnkeyBindings,
  PERPS_TURNKEY_SESSION_EXPIRY_SKEW_MS,
  reconcileExactPerpsTurnkeySessionAttempt,
  resolveExactActivePerpsTurnkeySession,
  samePerpsTurnkeyPendingBinding,
  type PerpsTurnkeyBindings,
  type PerpsTurnkeyAcceptedSessions,
  type PerpsTurnkeyPendingBinding,
  type PerpsTurnkeySessionSnapshot,
} from "./perps-turnkey-session-boundary";
import {
  createTurnkeyAuthModalLock,
  TURNKEY_AUTH_MODAL_CLOSED_EVENT,
} from "./turnkey-auth-single-flight";
import type { AsterV3AgentApprovalTypedData } from "./aster-agent-onboarding";
import {
  signAsterAgentApprovalWithTurnkey,
  signAsterOwnerActivationWithTurnkey,
  TURNKEY_PERPS_OWNER_PATH,
} from "./perps-turnkey-aster-signing";
import type { AsterOwnerActivationChallenge } from "./aster-owner-activation";
import type { LighterChangePubKeyTransactionPlan } from "./lighter-agent-association";
import { signLighterChangePubKeyWithTurnkey } from "./perps-turnkey-lighter-signing";
import { signLighterRecoveryReadinessWithTurnkey } from "./perps-turnkey-lighter-recovery-signing";
import type {
  LighterOwnerRecoveryReadinessAuthorization,
  LighterOwnerRecoveryReadinessSigningProof,
} from "./lighter-owner-recovery-readiness.client";
import { validateLighterDepositAuthorizationMessage } from "./lighter-universal-deposit-address.client";
import {
  createPerpsWalletProvisioningQueue,
  PERPS_TURNKEY_AUTH_CONFIG,
  PERPS_TURNKEY_AUTH_METHOD_ORDER,
  perpsWalletProvisioningError,
  withPerpsTurnkeyOperationTimeout,
} from "./perps-turnkey-wallet-provisioning";
import {
  bindExactPerpsWalletIdentity,
  exactWalletAccount,
  readPerpsWalletIdentityBinding,
  selectBoundPerpsWallet,
  withOneStableTurnkeyRefresh,
} from "./perps-turnkey-wallet-identity";

const PERPS_WALLET_NAME = "Ghola Perps";
const OWNER_PATH = TURNKEY_PERPS_OWNER_PATH;
const AGENT_PATH = "m/44'/60'/0'/0/1";
const TOMBSTONE_PATH = "m/44'/60'/0'/0/2";
const SEALING_PATH = "m/44'/501'/0'/0'";
const TURNKEY_BINDINGS_STORAGE_KEY = "ghola_perps_turnkey_bindings_v1";
const TURNKEY_PENDING_BINDING_STORAGE_KEY = "ghola_perps_turnkey_pending_binding_v1";
const TURNKEY_ACCEPTED_SESSIONS_STORAGE_KEY = "ghola_perps_turnkey_accepted_sessions_v1";
const TURNKEY_ACTIVE_SESSION_STORAGE_KEY = "@turnkey/active-session-key";
const TURNKEY_WALLET_BINDINGS_STORAGE_KEY = "ghola_perps_turnkey_wallet_bindings_v1";
const TURNKEY_READ_TIMEOUT_MS = 12_000;
const TURNKEY_MUTATION_TIMEOUT_MS = 25_000;

async function withPerpsTurnkeyStorageLock<T>(
  scope: "identity" | "pending",
  operation: () => T | Promise<T>,
): Promise<T> {
  if (typeof navigator === "undefined" || !navigator.locks) {
    throw new Error("Secure cross-tab wallet coordination is unavailable in this browser.");
  }
  return navigator.locks.request(
    `ghola:perps-turnkey:${scope}:${parentOrganizationId}`,
    { mode: "exclusive" },
    operation,
  );
}

function hasSecurePerpsTurnkeyCoordination(): boolean {
  return typeof window !== "undefined" &&
    window.isSecureContext &&
    typeof navigator.locks?.request === "function";
}

function pendingBindingStorageKey(): string {
  return `${TURNKEY_PENDING_BINDING_STORAGE_KEY}:${parentOrganizationId}`;
}

async function createPendingBinding(
  userId: string,
  locallyOwnedAttemptId: string | null,
): Promise<PerpsTurnkeyPendingBinding> {
  return withPerpsTurnkeyStorageLock("pending", () => {
    return claimPerpsTurnkeyPendingBinding({
      storage: localStorage,
      storageKey: pendingBindingStorageKey(),
      userId,
      locallyOwnedAttemptId,
      createAttemptId: () => `ghola-perps-${globalThis.crypto.randomUUID()}`,
    }).pending;
  });
}

async function removePendingBindingIfExact(
  expected: PerpsTurnkeyPendingBinding,
): Promise<boolean> {
  let removed = false;
  await withPerpsTurnkeyStorageLock("pending", () => {
    const key = pendingBindingStorageKey();
    if (localStorage.getItem(key) === JSON.stringify(expected)) {
      localStorage.removeItem(key);
      removed = true;
    }
  });
  return removed;
}

async function persistPerpsTurnkeyBinding(
  binding: { userId: string; organizationId: string },
  expectedPending: PerpsTurnkeyPendingBinding,
  resolveExactSession: () => Promise<PerpsTurnkeySessionSnapshot | null>,
): Promise<{
  bindings: PerpsTurnkeyBindings;
  acceptedSessions: PerpsTurnkeyAcceptedSessions;
}> {
  return withPerpsTurnkeyStorageLock("pending", () =>
    withPerpsTurnkeyStorageLock("identity", async () => {
      const pendingKey = pendingBindingStorageKey();
      const currentPending = parsePerpsTurnkeyPendingBinding(
        localStorage.getItem(pendingKey),
      );
      if (!samePerpsTurnkeyPendingBinding(currentPending, expectedPending)) {
        throw new Error("The Turnkey authentication attempt expired before it could be bound.");
      }

      const exactSession = await resolveExactSession();
      const confirmedPending = parsePerpsTurnkeyPendingBinding(
        localStorage.getItem(pendingKey),
      );
      if (
        !samePerpsTurnkeyPendingBinding(confirmedPending, expectedPending) ||
        exactSession?.sessionKey !== expectedPending.attemptId ||
        exactSession.organizationId !== binding.organizationId
      ) {
        throw new Error("The Turnkey session changed before its identity could be bound.");
      }

      const bindingsKey = `${TURNKEY_BINDINGS_STORAGE_KEY}:${parentOrganizationId}`;
      const acceptedKey = `${TURNKEY_ACCEPTED_SESSIONS_STORAGE_KEY}:${parentOrganizationId}`;
      const current = parsePerpsTurnkeyBindings(localStorage.getItem(bindingsKey));
      const next = mergePerpsTurnkeyBinding(current, binding);
      if (!next) throw new Error("The Turnkey identity binding conflicts with another Ghola user.");
      const acceptedSessions = {
        ...parsePerpsTurnkeyAcceptedSessions(localStorage.getItem(acceptedKey)),
        [binding.userId]: {
          organizationId: binding.organizationId,
          sessionKey: exactSession.sessionKey,
        },
      };
      localStorage.setItem(bindingsKey, JSON.stringify(next));
      localStorage.setItem(acceptedKey, JSON.stringify(acceptedSessions));
      return { bindings: next, acceptedSessions };
    }),
  );
}

const OWNER_ACCOUNT = {
  curve: "CURVE_SECP256K1",
  pathFormat: "PATH_FORMAT_BIP32",
  path: OWNER_PATH,
  addressFormat: "ADDRESS_FORMAT_ETHEREUM",
} as const;
const AGENT_ACCOUNT = { ...OWNER_ACCOUNT, path: AGENT_PATH } as const;
const TOMBSTONE_ACCOUNT = { ...OWNER_ACCOUNT, path: TOMBSTONE_PATH } as const;
const SEALING_ACCOUNT = {
  curve: "CURVE_ED25519",
  pathFormat: "PATH_FORMAT_BIP32",
  path: SEALING_PATH,
  addressFormat: "ADDRESS_FORMAT_SOLANA",
} as const;

export interface PerpsWalletPair {
  organizationId: string;
  walletId: string;
  owner: WalletAccount;
  agent: WalletAccount;
  sealing: WalletAccount;
  tombstone?: WalletAccount;
}

interface InstallDelegationResult {
  delegatedUserId: string;
  policyIds: string[];
}

interface PerpsTurnkeyContextValue {
  configured: boolean;
  authenticated: boolean;
  loading: boolean;
  organizationId: string | null;
  hasPasskey: boolean;
  login: () => Promise<void>;
  logout: () => Promise<void>;
  addPasskey: () => Promise<void>;
  ensureWalletPair: (includeTombstone?: boolean) => Promise<PerpsWalletPair>;
  replaceWalletPair: () => Promise<PerpsWalletPair>;
  installDelegation: (publicKey: string) => Promise<InstallDelegationResult>;
  signLighterDepositAuthorization: (message: string, expectedOwnerAddress: string) => Promise<`0x${string}`>;
  signLighterRecoveryReadiness: (
    authorization: LighterOwnerRecoveryReadinessAuthorization,
  ) => Promise<LighterOwnerRecoveryReadinessSigningProof>;
  signOwnerMandate: (mandate: unknown) => Promise<`0x${string}`>;
  signCarryRiskMandate: (mandate: unknown) => Promise<`0x${string}`>;
  signCarryCollateralReview: (review: unknown) => Promise<`0x${string}`>;
  signAgentBinding: (message: string) => Promise<`0x${string}`>;
  signAsterAgentApproval: (typedData: AsterV3AgentApprovalTypedData) => Promise<`0x${string}`>;
  signAsterOwnerActivation: (challenge: AsterOwnerActivationChallenge) => Promise<`0x${string}`>;
  signLighterKeyAssociation: (transactionPlan: LighterChangePubKeyTransactionPlan) => Promise<{
    raw_transaction: `0x02${string}`;
    transaction_hash: `0x${string}`;
  }>;
  signSealingBytes: (bytes: Uint8Array) => Promise<Uint8Array>;
  configureHyperliquid: (input: {
    network: "mainnet" | "testnet";
    markets: string[];
    leverage: number;
    marginMode: "cross" | "isolated";
    agentName: string;
  }) => Promise<void>;
  revokeHyperliquid: (input: {
    network: "mainnet" | "testnet";
    agentName: string;
    delegatedUserId: string;
  }) => Promise<void>;
}

const unavailable = async () => {
  throw new Error("Turnkey Embedded Wallets is not configured for this environment.");
};

const PerpsTurnkeyContext = createContext<PerpsTurnkeyContextValue>({
  configured: false,
  authenticated: false,
  loading: false,
  organizationId: null,
  hasPasskey: false,
  login: unavailable,
  logout: async () => {},
  addPasskey: unavailable,
  ensureWalletPair: unavailable,
  replaceWalletPair: unavailable,
  installDelegation: unavailable,
  signLighterDepositAuthorization: unavailable,
  signLighterRecoveryReadiness: unavailable,
  signOwnerMandate: unavailable,
  signCarryRiskMandate: unavailable,
  signCarryCollateralReview: unavailable,
  signAgentBinding: unavailable,
  signAsterAgentApproval: unavailable,
  signAsterOwnerActivation: unavailable,
  signLighterKeyAssociation: unavailable,
  signSealingBytes: unavailable,
  configureHyperliquid: unavailable,
  revokeHyperliquid: unavailable,
});

const parentOrganizationId = process.env.NEXT_PUBLIC_TURNKEY_PERPS_ORGANIZATION_ID || "";
const authProxyConfigId = process.env.NEXT_PUBLIC_TURNKEY_PERPS_AUTH_PROXY_CONFIG_ID || "";
const perpsTurnkeyProviderConfig: TurnkeyProviderConfig | null = parentOrganizationId && authProxyConfigId
  ? {
      organizationId: parentOrganizationId,
      authProxyConfigId,
      passkeyConfig: {
        withPlatformKey: true,
      },
      autoRefreshManagedState: true,
      auth: PERPS_TURNKEY_AUTH_CONFIG,
      ui: {
        darkMode: true,
        preferLargeActionButtons: true,
        borderRadius: 8,
        authModal: {
          methods: {
            emailOtpAuthEnabled: true,
            passkeyAuthEnabled: true,
            walletAuthEnabled: false,
            googleOauthEnabled: false,
          },
          methodOrder: PERPS_TURNKEY_AUTH_METHOD_ORDER,
          oauthOrder: [],
        },
      },
    }
  : null;

export function PerpsTurnkeyProvider({ children }: { children: ReactNode }) {
  if (!perpsTurnkeyProviderConfig) {
    return <PerpsTurnkeyContext.Provider value={{ ...CONTEXT_DEFAULTS }}>{children}</PerpsTurnkeyContext.Provider>;
  }
  return (
    <ConfiguredPerpsTurnkeyProvider config={perpsTurnkeyProviderConfig}>
      {children}
    </ConfiguredPerpsTurnkeyProvider>
  );
}

function ConfiguredPerpsTurnkeyProvider({
  children,
  config,
}: {
  children: ReactNode;
  config: TurnkeyProviderConfig;
}) {
  return (
    <TurnkeyProvider config={config}>
      <PerpsTurnkeySession>
        {children}
      </PerpsTurnkeySession>
    </TurnkeyProvider>
  );
}

const CONTEXT_DEFAULTS = {
  configured: false,
  authenticated: false,
  loading: false,
  organizationId: null,
  hasPasskey: false,
  login: unavailable,
  logout: async () => {},
  addPasskey: unavailable,
  ensureWalletPair: unavailable,
  replaceWalletPair: unavailable,
  installDelegation: unavailable,
  signLighterDepositAuthorization: unavailable,
  signLighterRecoveryReadiness: unavailable,
  signOwnerMandate: unavailable,
  signCarryRiskMandate: unavailable,
  signCarryCollateralReview: unavailable,
  signAgentBinding: unavailable,
  signAsterAgentApproval: unavailable,
  signAsterOwnerActivation: unavailable,
  signLighterKeyAssociation: unavailable,
  signSealingBytes: unavailable,
  configureHyperliquid: unavailable,
  revokeHyperliquid: unavailable,
} satisfies PerpsTurnkeyContextValue;

function PerpsTurnkeySession({ children }: { children: ReactNode }) {
  const turnkey = useTurnkey();
  const thumper = useThumperAuth();
  const thumperUserScope = opaqueTurnkeyWalletScope(thumper.user?.id || "");
  const [bindings, setBindings] = useState<PerpsTurnkeyBindings>({});
  const [acceptedSessions, setAcceptedSessions] = useState<PerpsTurnkeyAcceptedSessions>({});
  const [bindingsLoaded, setBindingsLoaded] = useState(false);
  const [pendingBinding, setPendingBinding] = useState<PerpsTurnkeyPendingBinding | null>(null);
  const [resolvedTurnkeySession, setResolvedTurnkeySession] =
    useState<PerpsTurnkeySessionSnapshot | null>(null);
  const [resolvedSessionLoaded, setResolvedSessionLoaded] = useState(false);
  const [requireFreshAuthentication, setRequireFreshAuthentication] = useState(false);
  const localAttemptId = useRef<string | null>(null);
  const bindingCommitKey = useRef<string | null>(null);
  const sessionSyncRevision = useRef(0);
  const [authModalLock] = useState(() => createTurnkeyAuthModalLock());
  const enqueueWalletProvisioning = useRef(createPerpsWalletProvisioningQueue()).current;
  const getActiveSessionKey = turnkey.getActiveSessionKey;
  const getSession = turnkey.getSession;

  const readExactTurnkeySession = useCallback(
    () => resolveExactActivePerpsTurnkeySession({ getActiveSessionKey, getSession }),
    [getActiveSessionKey, getSession],
  );

  const syncResolvedTurnkeySession = useCallback(async () => {
    const revision = sessionSyncRevision.current + 1;
    sessionSyncRevision.current = revision;
    setResolvedTurnkeySession(null);
    setResolvedSessionLoaded(false);
    let resolved: PerpsTurnkeySessionSnapshot | null = null;
    try {
      resolved = await readExactTurnkeySession();
    } catch {
      resolved = null;
    }
    if (sessionSyncRevision.current === revision) {
      setResolvedTurnkeySession(resolved);
      setResolvedSessionLoaded(true);
    }
    return resolved;
  }, [readExactTurnkeySession]);

  const adoptResolvedTurnkeySession = useCallback(
    (resolved: PerpsTurnkeySessionSnapshot) => {
      sessionSyncRevision.current += 1;
      setResolvedTurnkeySession(resolved);
      setResolvedSessionLoaded(true);
    },
    [],
  );

  const activeTurnkeySessionKey = resolvedTurnkeySession?.sessionKey || null;
  const turnkeyOrganizationId = resolvedTurnkeySession?.organizationId || null;
  const turnkeyAuthenticated = resolvedTurnkeySession !== null;

  useEffect(() => {
    const bindingsKey = `${TURNKEY_BINDINGS_STORAGE_KEY}:${parentOrganizationId}`;
    const acceptedKey = `${TURNKEY_ACCEPTED_SESSIONS_STORAGE_KEY}:${parentOrganizationId}`;
    const pendingKey = pendingBindingStorageKey();
    const sync = () => {
      let stored: string | null = null;
      let storedAccepted: string | null = null;
      let pendingValue: PerpsTurnkeyPendingBinding | null = null;
      try {
        stored = localStorage.getItem(bindingsKey);
        storedAccepted = localStorage.getItem(acceptedKey);
        const rawPending = localStorage.getItem(pendingKey);
        pendingValue = parsePerpsTurnkeyPendingBinding(rawPending);
        sessionStorage.removeItem(pendingKey);
      } catch {
        // A blocked storage boundary must never restore an unverified session.
      }
      setBindings(parsePerpsTurnkeyBindings(stored));
      setAcceptedSessions(parsePerpsTurnkeyAcceptedSessions(storedAccepted));
      setPendingBinding(pendingValue);
      if (pendingValue) setRequireFreshAuthentication(true);
      setBindingsLoaded(true);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === bindingsKey || event.key === acceptedKey || event.key === pendingKey) sync();
      if (event.key === TURNKEY_ACTIVE_SESSION_STORAGE_KEY) void syncResolvedTurnkeySession();
    };
    sync();
    void syncResolvedTurnkeySession();
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [syncResolvedTurnkeySession]);

  useEffect(() => {
    void syncResolvedTurnkeySession();
  }, [syncResolvedTurnkeySession, turnkey.authState, turnkey.session?.token]);

  useEffect(() => {
    if (!resolvedTurnkeySession) return;
    const revalidateAt =
      resolvedTurnkeySession.expiry * 1_000 - PERPS_TURNKEY_SESSION_EXPIRY_SKEW_MS;
    const timeout = window.setTimeout(
      () => void syncResolvedTurnkeySession(),
      Math.min(Math.max(0, revalidateAt - Date.now()), 2_147_483_647),
    );
    return () => window.clearTimeout(timeout);
  }, [resolvedTurnkeySession, syncResolvedTurnkeySession]);

  useEffect(() => {
    if (!pendingBinding) return;
    const timeout = window.setTimeout(() => {
      void removePendingBindingIfExact(pendingBinding).catch(() => {}).finally(() => {
        setPendingBinding((current) =>
          samePerpsTurnkeyPendingBinding(current, pendingBinding) ? null : current);
      });
    }, Math.max(0, pendingBinding.expiresAt - Date.now()));
    return () => window.clearTimeout(timeout);
  }, [pendingBinding]);

  useEffect(() => {
    const clearLocalAttempt = () => {
      try {
        const cleared = clearLocallyOwnedPerpsTurnkeyPendingBinding({
          storage: localStorage,
          storageKey: pendingBindingStorageKey(),
          locallyOwnedAttemptId: localAttemptId.current,
        });
        if (cleared && localAttemptId.current === cleared.attemptId) {
          localAttemptId.current = null;
        }
      } catch {
        // Best effort only; the bounded pending record still expires automatically.
      }
    };
    window.addEventListener("pagehide", clearLocalAttempt);
    return () => {
      window.removeEventListener("pagehide", clearLocalAttempt);
      clearLocalAttempt();
    };
  }, []);

  useEffect(() => {
    let reconcileTimer: number | null = null;
    let reconciliationInFlight = false;
    let disposed = false;
    const release = () => {
      if (disposed || reconciliationInFlight) return;
      if (reconcileTimer !== null) window.clearTimeout(reconcileTimer);
      reconcileTimer = window.setTimeout(() => {
        reconcileTimer = null;
        if (disposed || reconciliationInFlight) return;
        reconciliationInFlight = true;
        void (async () => {
          let attemptId: string | null = null;
          let current: PerpsTurnkeyPendingBinding | null = null;
          try {
            if (disposed) return;
            attemptId = localAttemptId.current;
            if (!attemptId) return;
            current = parsePerpsTurnkeyPendingBinding(
              localStorage.getItem(pendingBindingStorageKey()),
            );
            if (!current || current.attemptId !== attemptId) return;
            const reconciliation = await reconcileExactPerpsTurnkeySessionAttempt({
              attemptId,
              readExactSession: readExactTurnkeySession,
              isCancelled: () => disposed,
            });
            if (disposed || reconciliation.kind === "cancelled") return;
            if (reconciliation.kind === "matched") {
              if (!isExactLocallyOwnedPerpsTurnkeyPendingBinding({
                storage: localStorage,
                storageKey: pendingBindingStorageKey(),
                expected: current,
                locallyOwnedAttemptId: localAttemptId.current,
              })) return;
              adoptResolvedTurnkeySession(reconciliation.session);
              return;
            }
            if (!isExactLocallyOwnedPerpsTurnkeyPendingBinding({
              storage: localStorage,
              storageKey: pendingBindingStorageKey(),
              expected: current,
              locallyOwnedAttemptId: localAttemptId.current,
            })) return;
            if (!await removePendingBindingIfExact(current)) return;
            setPendingBinding((pending) =>
              samePerpsTurnkeyPendingBinding(pending, current) ? null : pending);
            if (localAttemptId.current === attemptId) localAttemptId.current = null;
            setRequireFreshAuthentication(true);
          } catch {
            if (disposed) return;
            setRequireFreshAuthentication(true);
            await syncResolvedTurnkeySession();
          } finally {
            reconciliationInFlight = false;
            if (!disposed) authModalLock.release();
          }
        })().catch(() => {});
      }, 250);
    };
    window.addEventListener(TURNKEY_AUTH_MODAL_CLOSED_EVENT, release);
    return () => {
      disposed = true;
      window.removeEventListener(TURNKEY_AUTH_MODAL_CLOSED_EVENT, release);
      if (reconcileTimer !== null) window.clearTimeout(reconcileTimer);
      authModalLock.release();
    };
  }, [
    adoptResolvedTurnkeySession,
    authModalLock,
    readExactTurnkeySession,
    syncResolvedTurnkeySession,
  ]);

  const boundary = useMemo(() => decidePerpsTurnkeyBoundary({
    thumperLoading: thumper.loading || !bindingsLoaded || !resolvedSessionLoaded,
    thumperUserId: thumperUserScope,
    turnkeyAuthenticated,
    turnkeyOrganizationId,
    activeTurnkeySessionKey,
    acceptedTurnkeySessionKey:
      thumperUserScope &&
      acceptedSessions[thumperUserScope]?.organizationId === turnkeyOrganizationId
        ? acceptedSessions[thumperUserScope]?.sessionKey || null
        : null,
    bindings,
    pendingBinding,
    requireFreshAuthentication,
  }), [
    resolvedSessionLoaded,
    activeTurnkeySessionKey,
    acceptedSessions,
    bindings,
    bindingsLoaded,
    pendingBinding,
    requireFreshAuthentication,
    thumper.loading,
    thumperUserScope,
    turnkeyAuthenticated,
    turnkeyOrganizationId,
  ]);

  useEffect(() => {
    if (boundary.kind !== "bind") return;
    const expectedPending = pendingBinding;
    if (!expectedPending) return;
    const commitKey = `${boundary.binding.userId}:${boundary.binding.organizationId}:${expectedPending.attemptId}`;
    if (bindingCommitKey.current === commitKey) return;
    bindingCommitKey.current = commitKey;
    void persistPerpsTurnkeyBinding(
      boundary.binding,
      expectedPending,
      readExactTurnkeySession,
    ).then(async ({ bindings: next, acceptedSessions: nextAccepted }) => {
      await removePendingBindingIfExact(expectedPending);
      setBindings(next);
      setAcceptedSessions(nextAccepted);
      setPendingBinding((current) =>
        samePerpsTurnkeyPendingBinding(current, expectedPending) ? null : current);
      if (localAttemptId.current === expectedPending.attemptId) localAttemptId.current = null;
      setRequireFreshAuthentication(false);
    }).catch(() => {
      void (async () => {
        setRequireFreshAuthentication(true);
        await turnkey.logout({ sessionKey: expectedPending.attemptId }).catch(() => {});
        await removePendingBindingIfExact(expectedPending).catch(() => {});
        setPendingBinding((current) =>
          samePerpsTurnkeyPendingBinding(current, expectedPending) ? null : current);
        if (localAttemptId.current === expectedPending.attemptId) localAttemptId.current = null;
        bindingCommitKey.current = null;
        await syncResolvedTurnkeySession();
      })();
    });
  }, [boundary, pendingBinding, readExactTurnkeySession, syncResolvedTurnkeySession, turnkey]);

  useEffect(() => {
    if (!boundary.clearPending || boundary.kind === "bind" || !pendingBinding) return;
    const expectedPending = pendingBinding;
    if (localAttemptId.current !== expectedPending.attemptId) return;
    void removePendingBindingIfExact(expectedPending).catch(() => {}).finally(() => {
      setPendingBinding((current) =>
        samePerpsTurnkeyPendingBinding(current, expectedPending) ? null : current);
      if (localAttemptId.current === expectedPending.attemptId) localAttemptId.current = null;
    });
  }, [boundary.clearPending, boundary.kind, pendingBinding]);

  useEffect(() => {
    if (!boundary.ready || !requireFreshAuthentication) return;
    setRequireFreshAuthentication(false);
  }, [boundary.ready, requireFreshAuthentication]);

  const organizationId = boundary.ready ? turnkeyOrganizationId : null;
  const authenticated = boundary.ready;
  const hasPasskey = (turnkey.user?.authenticators.length || 0) > 0;
  const configured = isPerpsTurnkeyClientConfigured(turnkey.clientState);
  const loading =
    isPerpsTurnkeyClientLoading(turnkey.clientState) ||
    thumper.loading ||
    !bindingsLoaded ||
    !resolvedSessionLoaded ||
    boundary.kind === "bind" ||
    boundary.kind === "await_fresh_turnkey_auth";

  const login = useCallback(() => authModalLock.run(async () => {
    const userId = thumperUserScope;
    if (!userId || thumper.loading) {
      throw new Error("Sign in to Ghola before authenticating the perps wallet.");
    }
    if (!bindingsLoaded) {
      throw new Error("The perps identity boundary is still loading.");
    }
    if (!resolvedSessionLoaded) {
      throw new Error("The secure Turnkey session boundary is still loading.");
    }
    if (!hasSecurePerpsTurnkeyCoordination()) {
      throw new Error("Open Ghola in a supported secure browser to authenticate the trading wallet.");
    }
    if (boundary.ready) return;
    const attempt = await createPendingBinding(userId, localAttemptId.current);
    localAttemptId.current = attempt.attemptId;
    setPendingBinding(attempt);
    setRequireFreshAuthentication(true);
    try {
      if (turnkeyAuthenticated || turnkeyOrganizationId) {
        const sessionKey = resolvedTurnkeySession?.sessionKey;
        if (sessionKey) await turnkey.logout({ sessionKey });
        await syncResolvedTurnkeySession();
      }
      await turnkey.handleLogin({
        title: "Secure Ghola trading access",
        sessionKey: attempt.attemptId,
      });
    } catch (error) {
      await removePendingBindingIfExact(attempt).catch(() => {});
      setPendingBinding((current) =>
        samePerpsTurnkeyPendingBinding(current, attempt) ? null : current);
      if (localAttemptId.current === attempt.attemptId) localAttemptId.current = null;
      throw error;
    }
  }), [
    resolvedSessionLoaded,
    bindingsLoaded,
    boundary.ready,
    thumper.loading,
    thumperUserScope,
    turnkey,
    turnkeyAuthenticated,
    turnkeyOrganizationId,
    resolvedTurnkeySession,
    authModalLock,
    syncResolvedTurnkeySession,
  ]);

  const logout = useCallback(async () => {
    authModalLock.release();
    const attempt = pendingBinding?.attemptId === localAttemptId.current ? pendingBinding : null;
    if (attempt) {
      await removePendingBindingIfExact(attempt).catch(() => {});
      setPendingBinding((current) =>
        samePerpsTurnkeyPendingBinding(current, attempt) ? null : current);
      localAttemptId.current = null;
    }
    setRequireFreshAuthentication(true);
    const sessionKey = resolvedTurnkeySession?.sessionKey;
    if (sessionKey) await turnkey.logout({ sessionKey });
    await syncResolvedTurnkeySession();
  }, [authModalLock, pendingBinding, resolvedTurnkeySession, syncResolvedTurnkeySession, turnkey]);

  const addPasskey = useCallback(async () => {
    if (!organizationId || !authenticated) {
      throw new Error("Authenticate with email before enabling Touch ID.");
    }
    await turnkey.handleAddPasskey({
      organizationId,
      name: "Ghola Touch ID",
      displayName: "Ghola Touch ID",
      successPageDuration: 1200,
    });
  }, [authenticated, organizationId, turnkey]);

  const ensureWalletPair = useCallback((includeTombstone = false) => enqueueWalletProvisioning(async () => {
    try {
      const expectedSession = resolvedTurnkeySession;
      if (
        !organizationId ||
        !turnkey.httpClient ||
        !authenticated ||
        !thumperUserScope ||
        !expectedSession
      ) {
        throw new Error("Authenticate with Turnkey before creating the perps wallets.");
      }
      const exactSession = await readExactTurnkeySession();
      if (
        exactSession?.sessionKey !== expectedSession.sessionKey ||
        exactSession.organizationId !== organizationId
      ) {
        await syncResolvedTurnkeySession();
        throw new Error("The Turnkey trading session changed. Authenticate again before continuing.");
      }
      let wallets = await withPerpsTurnkeyOperationTimeout(
        turnkey.refreshWallets({ organizationId }),
        { timeoutMs: TURNKEY_READ_TIMEOUT_MS, ambiguous: false },
      );
      const binding = readPerpsWalletIdentityBinding(
        localStorage,
        TURNKEY_WALLET_BINDINGS_STORAGE_KEY,
        thumperUserScope,
        organizationId,
      );
      let wallet = selectBoundPerpsWallet(wallets, PERPS_WALLET_NAME, binding?.walletId || null);
      if (!wallet) {
        const walletId = await withPerpsTurnkeyOperationTimeout(
          turnkey.createWallet({
            organizationId,
            walletName: PERPS_WALLET_NAME,
            accounts: [OWNER_ACCOUNT, AGENT_ACCOUNT, SEALING_ACCOUNT],
          }),
          { timeoutMs: TURNKEY_MUTATION_TIMEOUT_MS, ambiguous: true },
        );
        wallets = await withPerpsTurnkeyOperationTimeout(
          turnkey.refreshWallets({ organizationId }),
          { timeoutMs: TURNKEY_READ_TIMEOUT_MS, ambiguous: false },
        );
        wallet = selectBoundPerpsWallet(wallets, PERPS_WALLET_NAME, walletId);
      }
      if (!wallet) throw new Error("Turnkey did not return the Ghola perps wallet.");
      const required = includeTombstone
        ? [OWNER_ACCOUNT, AGENT_ACCOUNT, SEALING_ACCOUNT, TOMBSTONE_ACCOUNT]
        : [OWNER_ACCOUNT, AGENT_ACCOUNT, SEALING_ACCOUNT];
      const missing = required.filter((params) => !wallet?.accounts.some((account) => account.path === params.path));
      if (missing.length > 0) {
        const selectedWalletId = wallet.walletId;
        await withPerpsTurnkeyOperationTimeout(
          turnkey.createWalletAccounts({
            organizationId,
            walletId: selectedWalletId,
            accounts: missing,
          }),
          { timeoutMs: TURNKEY_MUTATION_TIMEOUT_MS, ambiguous: true },
        );
        wallets = await withPerpsTurnkeyOperationTimeout(
          turnkey.refreshWallets({ organizationId }),
          { timeoutMs: TURNKEY_READ_TIMEOUT_MS, ambiguous: false },
        );
        wallet = selectBoundPerpsWallet(wallets, PERPS_WALLET_NAME, selectedWalletId);
      }
      if (!wallet) throw new Error("Turnkey perps wallet refresh failed.");
      const owner = exactWalletAccount(wallet, organizationId, OWNER_PATH);
      const agent = exactWalletAccount(wallet, organizationId, AGENT_PATH);
      const sealing = exactWalletAccount(wallet, organizationId, SEALING_PATH);
      const tombstone = includeTombstone
        ? exactWalletAccount(wallet, organizationId, TOMBSTONE_PATH)
        : undefined;
      bindExactPerpsWalletIdentity({
        storage: localStorage,
        storageKey: TURNKEY_WALLET_BINDINGS_STORAGE_KEY,
        userScope: thumperUserScope,
        organizationId,
        walletId: wallet.walletId,
        accounts: { owner, agent, sealing, tombstone },
      });
      return { organizationId, walletId: wallet.walletId, owner, agent, sealing, tombstone };
    } catch (caught) {
      throw perpsWalletProvisioningError(caught);
    }
  }), [
    authenticated,
    enqueueWalletProvisioning,
    organizationId,
    readExactTurnkeySession,
    resolvedTurnkeySession,
    syncResolvedTurnkeySession,
    thumperUserScope,
    turnkey,
  ]);

  const replaceWalletPair = useCallback(() => ensureWalletPair(), [ensureWalletPair]);

  const installDelegation = useCallback(async (publicKey: string) => {
    const pair = await ensureWalletPair();
    if (!/^(?:04[0-9a-f]{128}|0[23][0-9a-f]{64})$/i.test(publicKey)) {
      throw new Error("The delegated worker public key is invalid.");
    }
    const delegatedUser = await turnkey.fetchOrCreateP256ApiKeyUser({
      publicKey,
      organizationId: pair.organizationId,
      createParams: {
        userName: "Ghola Perps Worker",
        apiKeyName: "ghola-perps-worker",
      },
    });
    const policies = buildTurnkeyHyperliquidPolicies({
      delegated_user_id: delegatedUser.userId,
      owner_address: pair.owner.address,
      agent_address: pair.agent.address,
    });
    const installed = await turnkey.fetchOrCreatePolicies({
      organizationId: pair.organizationId,
      policies: policies.map((policy) => ({ ...policy })),
    });
    return {
      delegatedUserId: delegatedUser.userId,
      policyIds: installed.map((policy) => policy.policyId),
    };
  }, [ensureWalletPair, turnkey]);

  const signOwnerMandate = useCallback(async (mandate: unknown) => {
    const pair = await ensureWalletPair();
    if (!turnkey.httpClient) throw new Error("Turnkey signing client is unavailable.");
    const account = createAccountWithAddress({
      client: turnkey.httpClient,
      organizationId: pair.organizationId,
      signWith: pair.owner.address,
      ethereumAddress: pair.owner.address,
    });
    return account.signMessage({ message: ownerMandateMessage(mandate) });
  }, [ensureWalletPair, turnkey.httpClient]);

  const signLighterDepositAuthorization = useCallback(async (message: string, expectedOwnerAddress: string) => {
    validateLighterDepositAuthorizationMessage(message, expectedOwnerAddress);
    const client = turnkey.httpClient;
    if (!client) throw new Error("Turnkey signing client is unavailable.");
    return withOneStableTurnkeyRefresh({
      load: () => ensureWalletPair(),
      account: (pair) => pair.owner,
      execute: async (pair) => {
        if (pair.owner.address.toLowerCase() !== expectedOwnerAddress.toLowerCase()) {
          throw new Error("Lighter deposit authorization owner changed.");
        }
        const account = createAccountWithAddress({
          client,
          organizationId: pair.organizationId,
          signWith: pair.owner.address,
          ethereumAddress: pair.owner.address,
        });
        return account.signMessage({ message });
      },
    });
  }, [ensureWalletPair, turnkey.httpClient]);

  const signLighterRecoveryReadiness = useCallback(async (
    authorization: LighterOwnerRecoveryReadinessAuthorization,
  ) => {
    const client = turnkey.httpClient;
    if (!client) throw new Error("Turnkey signing client is unavailable.");
    return withOneStableTurnkeyRefresh({
      load: () => ensureWalletPair(),
      account: (pair) => pair.owner,
      execute: (pair) => signLighterRecoveryReadinessWithTurnkey({
        client,
        organizationId: pair.organizationId,
        owner: pair.owner,
        authorization,
      }),
    });
  }, [ensureWalletPair, turnkey.httpClient]);

  const signCarryRiskMandate = useCallback(async (mandate: unknown) => {
    const pair = await ensureWalletPair();
    if (!turnkey.httpClient) throw new Error("Turnkey signing client is unavailable.");
    const account = createAccountWithAddress({
      client: turnkey.httpClient,
      organizationId: pair.organizationId,
      signWith: pair.owner.address,
      ethereumAddress: pair.owner.address,
    });
    return account.signMessage({ message: carryRiskMandateMessage(mandate) });
  }, [ensureWalletPair, turnkey.httpClient]);

  const signCarryCollateralReview = useCallback(async (review: unknown) => {
    const pair = await ensureWalletPair();
    if (!turnkey.httpClient) throw new Error("Turnkey signing client is unavailable.");
    const account = createAccountWithAddress({
      client: turnkey.httpClient,
      organizationId: pair.organizationId,
      signWith: pair.owner.address,
      ethereumAddress: pair.owner.address,
    });
    return account.signMessage({ message: carryCollateralReviewMessage(review) });
  }, [ensureWalletPair, turnkey.httpClient]);

  const signAgentBinding = useCallback(async (message: string) => {
    const pair = await ensureWalletPair();
    if (!turnkey.httpClient) throw new Error("Turnkey signing client is unavailable.");
    const account = createAccountWithAddress({
      client: turnkey.httpClient,
      organizationId: pair.organizationId,
      signWith: pair.agent.address,
      ethereumAddress: pair.agent.address,
    });
    return account.signMessage({ message });
  }, [ensureWalletPair, turnkey.httpClient]);

  const signAsterAgentApproval = useCallback(async (typedData: AsterV3AgentApprovalTypedData) => {
    const client = turnkey.httpClient;
    if (!client) throw new Error("Turnkey signing client is unavailable.");
    return withOneStableTurnkeyRefresh({
      load: () => ensureWalletPair(),
      account: (pair) => pair.owner,
      execute: (pair) => signAsterAgentApprovalWithTurnkey({
        client,
        organizationId: pair.organizationId,
        owner: pair.owner,
        typedData,
      }),
    });
  }, [ensureWalletPair, turnkey.httpClient]);

  const signAsterOwnerActivation = useCallback(async (challenge: AsterOwnerActivationChallenge) => {
    const client = turnkey.httpClient;
    if (!client) throw new Error("Turnkey signing client is unavailable.");
    return withOneStableTurnkeyRefresh({
      load: () => ensureWalletPair(),
      account: (pair) => pair.owner,
      execute: (pair) => signAsterOwnerActivationWithTurnkey({
        client,
        organizationId: pair.organizationId,
        owner: pair.owner,
        challenge,
      }),
    });
  }, [ensureWalletPair, turnkey.httpClient]);

  const signLighterKeyAssociation = useCallback(async (
    transactionPlan: LighterChangePubKeyTransactionPlan,
  ) => {
    const client = turnkey.httpClient;
    if (!client) throw new Error("Turnkey signing client is unavailable.");
    return withOneStableTurnkeyRefresh({
      load: () => ensureWalletPair(),
      account: (pair) => pair.owner,
      execute: (pair) => signLighterChangePubKeyWithTurnkey({
        client,
        organizationId: pair.organizationId,
        owner: pair.owner,
        transactionPlan,
      }),
    });
  }, [ensureWalletPair, turnkey.httpClient]);

  const signSealingBytes = useCallback(async (bytes: Uint8Array) => {
    const pair = await ensureWalletPair();
    if (!turnkey.httpClient) throw new Error("Turnkey signing client is unavailable.");
    const result = await turnkey.httpClient.signRawPayload({
      organizationId: pair.organizationId,
      signWith: pair.sealing.address,
      payload: bytesToHex(bytes),
      encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
      hashFunction: "HASH_FUNCTION_NOT_APPLICABLE",
    });
    const signature = hexToBytes(`${result.r || ""}${result.s || ""}`);
    if (signature.length !== 64) throw new Error("Turnkey returned an invalid sealing signature.");
    return signature;
  }, [ensureWalletPair, turnkey.httpClient]);

  const configureHyperliquid = useCallback(async (input: {
    network: "mainnet" | "testnet";
    markets: string[];
    leverage: number;
    marginMode: "cross" | "isolated";
    agentName: string;
  }) => {
    assertVenueMutationAllowed(input.network);
    const pair = await ensureWalletPair();
    const client = turnkey.httpClient;
    if (!client) throw new Error("Turnkey signing client is unavailable.");
    const { exchange, info } = ownerClients(client, pair, input.network);
    const meta = await info.meta();
    for (const market of input.markets) {
      const asset = meta.universe.findIndex((item) => item.name === market);
      if (asset < 0) throw new Error(`${market} is not available on Hyperliquid ${input.network}.`);
      await exchange.updateLeverage({
        asset,
        isCross: input.marginMode === "cross",
        leverage: input.leverage,
      });
    }
    await exchange.approveAgent({
      agentAddress: pair.agent.address as `0x${string}`,
      agentName: input.agentName,
    });
  }, [ensureWalletPair, turnkey.httpClient]);

  const revokeHyperliquid = useCallback(async (input: {
    network: "mainnet" | "testnet";
    agentName: string;
    delegatedUserId: string;
  }) => {
    assertVenueMutationAllowed(input.network);
    const pair = await ensureWalletPair(true);
    if (!pair.tombstone || !turnkey.httpClient) throw new Error("Turnkey revocation account is unavailable.");
    await turnkey.httpClient.deleteUsers({
      organizationId: pair.organizationId,
      userIds: [input.delegatedUserId],
    });
    const { exchange } = ownerClients(turnkey.httpClient, pair, input.network);
    await exchange.approveAgent({
      agentAddress: pair.tombstone.address as `0x${string}`,
      agentName: input.agentName,
    });
  }, [ensureWalletPair, turnkey.httpClient]);

  const value = useMemo<PerpsTurnkeyContextValue>(() => ({
    configured,
    authenticated,
    loading,
    organizationId,
    hasPasskey,
    login,
    logout,
    addPasskey,
    ensureWalletPair,
    replaceWalletPair,
    installDelegation,
    signLighterDepositAuthorization,
    signLighterRecoveryReadiness,
    signOwnerMandate,
    signCarryRiskMandate,
    signCarryCollateralReview,
    signAgentBinding,
    signAsterAgentApproval,
    signAsterOwnerActivation,
    signLighterKeyAssociation,
    signSealingBytes,
    configureHyperliquid,
    revokeHyperliquid,
  }), [
    authenticated,
    configured,
    configureHyperliquid,
    ensureWalletPair,
    replaceWalletPair,
    installDelegation,
    loading,
    login,
    logout,
    addPasskey,
    hasPasskey,
    organizationId,
    revokeHyperliquid,
    signLighterDepositAuthorization,
    signLighterRecoveryReadiness,
    signOwnerMandate,
    signCarryRiskMandate,
    signCarryCollateralReview,
    signAgentBinding,
    signAsterAgentApproval,
    signAsterOwnerActivation,
    signLighterKeyAssociation,
    signSealingBytes,
  ]);
  return <PerpsTurnkeyContext.Provider value={value}>{children}</PerpsTurnkeyContext.Provider>;
}

export function usePerpsTurnkey() {
  return useContext(PerpsTurnkeyContext);
}

function ownerClients(
  client: NonNullable<ReturnType<typeof useTurnkey>["httpClient"]>,
  pair: PerpsWalletPair,
  network: "mainnet" | "testnet",
) {
  if (!client) throw new Error("Turnkey signing client is unavailable.");
  const wallet = createAccountWithAddress({
    client,
    organizationId: pair.organizationId,
    signWith: pair.owner.address,
    ethereumAddress: pair.owner.address,
  });
  const transport = new HttpTransport({ isTestnet: network === "testnet", timeout: 12_000 });
  return {
    exchange: new ExchangeClient({ transport, wallet }),
    info: new InfoClient({ transport }),
  };
}

function assertVenueMutationAllowed(network: "mainnet" | "testnet") {
  if (network === "mainnet" && process.env.NEXT_PUBLIC_GHOLA_PERPS_MAINNET_ENABLED !== "true") {
    throw new Error("Mainnet perps setup is disabled. Use testnet.");
  }
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(value: string) {
  if (!/^[0-9a-f]*$/i.test(value) || value.length % 2 !== 0) throw new Error("Invalid signature hex.");
  return Uint8Array.from({ length: value.length / 2 }, (_, index) => Number.parseInt(value.slice(index * 2, index * 2 + 2), 16));
}
