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
  type TurnkeyCallbacks,
  type TurnkeyProviderConfig,
  type Wallet,
  type WalletAccount,
} from "@turnkey/react-wallet-kit";
import { createAccountWithAddress } from "@turnkey/viem";
import { ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import {
  buildTurnkeyHyperliquidPolicies,
  ownerMandateMessage,
} from "@ghola/perps-core";
import { carryRiskMandateMessage } from "@ghola/execution-core";
import { useThumperAuth } from "./thumper-auth-context";
import { opaqueTurnkeyWalletScope } from "./turnkey-provider";
import {
  decidePerpsTurnkeyBoundary,
  isPerpsTurnkeyClientConfigured,
  isPerpsTurnkeyClientLoading,
  parsePerpsTurnkeyBindings,
  type PerpsTurnkeyBindings,
} from "./perps-turnkey-session-boundary";
import type { AsterV3AgentApprovalTypedData } from "./aster-agent-onboarding";
import {
  signAsterAgentApprovalWithTurnkey,
  TURNKEY_PERPS_OWNER_PATH,
} from "./perps-turnkey-aster-signing";
import type { LighterChangePubKeyTransactionPlan } from "./lighter-agent-association";
import { signLighterChangePubKeyWithTurnkey } from "./perps-turnkey-lighter-signing";

const PERPS_WALLET_NAME = "Ghola Perps";
const OWNER_PATH = TURNKEY_PERPS_OWNER_PATH;
const AGENT_PATH = "m/44'/60'/0'/0/1";
const TOMBSTONE_PATH = "m/44'/60'/0'/0/2";
const SEALING_PATH = "m/44'/501'/0'/0'";
const TURNKEY_BINDINGS_STORAGE_KEY = "ghola_perps_turnkey_bindings_v1";
const TURNKEY_PENDING_BINDING_STORAGE_KEY = "ghola_perps_turnkey_pending_binding_v1";
const TURNKEY_WALLET_BINDINGS_STORAGE_KEY = "ghola_perps_turnkey_wallet_bindings_v1";

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
  login: () => Promise<void>;
  logout: () => Promise<void>;
  ensureWalletPair: (includeTombstone?: boolean) => Promise<PerpsWalletPair>;
  replaceWalletPair: () => Promise<PerpsWalletPair>;
  installDelegation: (publicKey: string) => Promise<InstallDelegationResult>;
  signOwnerMandate: (mandate: unknown) => Promise<`0x${string}`>;
  signCarryRiskMandate: (mandate: unknown) => Promise<`0x${string}`>;
  signAgentBinding: (message: string) => Promise<`0x${string}`>;
  signAsterAgentApproval: (typedData: AsterV3AgentApprovalTypedData) => Promise<`0x${string}`>;
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
  login: unavailable,
  logout: async () => {},
  ensureWalletPair: unavailable,
  replaceWalletPair: unavailable,
  installDelegation: unavailable,
  signOwnerMandate: unavailable,
  signCarryRiskMandate: unavailable,
  signAgentBinding: unavailable,
  signAsterAgentApproval: unavailable,
  signLighterKeyAssociation: unavailable,
  signSealingBytes: unavailable,
  configureHyperliquid: unavailable,
  revokeHyperliquid: unavailable,
});

const parentOrganizationId = process.env.NEXT_PUBLIC_TURNKEY_PERPS_ORGANIZATION_ID || "";
const authProxyConfigId = process.env.NEXT_PUBLIC_TURNKEY_PERPS_AUTH_PROXY_CONFIG_ID || "";

export function PerpsTurnkeyProvider({ children }: { children: ReactNode }) {
  if (!parentOrganizationId || !authProxyConfigId) {
    return <PerpsTurnkeyContext.Provider value={{ ...CONTEXT_DEFAULTS }}>{children}</PerpsTurnkeyContext.Provider>;
  }
  const customWallet = {
    walletName: PERPS_WALLET_NAME,
    walletAccounts: [OWNER_ACCOUNT, AGENT_ACCOUNT, SEALING_ACCOUNT],
  };
  const createSuborgParams = { customWallet };
  const config: TurnkeyProviderConfig = {
    organizationId: parentOrganizationId,
    authProxyConfigId,
    passkeyConfig: {
      withPlatformKey: true,
    },
    autoRefreshManagedState: true,
    auth: {
      autoRefreshSession: true,
      createSuborgParams: {
        emailOtpAuth: createSuborgParams,
        passkeyAuth: createSuborgParams,
        walletAuth: createSuborgParams,
        oauth: createSuborgParams,
      },
    },
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
        methodOrder: ["passkey", "email"],
        oauthOrder: [],
      },
    },
  };
  return (
    <ConfiguredPerpsTurnkeyProvider config={config}>
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
  const [freshAuthenticationOrganizationId, setFreshAuthenticationOrganizationId] =
    useState<string | null>(null);
  const callbacks = useMemo<TurnkeyCallbacks>(() => ({
    onAuthenticationSuccess: ({ session }) => {
      setFreshAuthenticationOrganizationId(session?.organizationId || null);
    },
    onSessionExpired: () => {
      setFreshAuthenticationOrganizationId(null);
    },
  }), []);
  const clearFreshAuthentication = useCallback(() => {
    setFreshAuthenticationOrganizationId(null);
  }, []);
  return (
    <TurnkeyProvider config={config} callbacks={callbacks}>
      <PerpsTurnkeySession
        freshAuthenticationOrganizationId={freshAuthenticationOrganizationId}
        clearFreshAuthentication={clearFreshAuthentication}
      >
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
  login: unavailable,
  logout: async () => {},
  ensureWalletPair: unavailable,
  replaceWalletPair: unavailable,
  installDelegation: unavailable,
  signOwnerMandate: unavailable,
  signCarryRiskMandate: unavailable,
  signAgentBinding: unavailable,
  signAsterAgentApproval: unavailable,
  signLighterKeyAssociation: unavailable,
  signSealingBytes: unavailable,
  configureHyperliquid: unavailable,
  revokeHyperliquid: unavailable,
} satisfies PerpsTurnkeyContextValue;

function PerpsTurnkeySession({
  children,
  freshAuthenticationOrganizationId,
  clearFreshAuthentication,
}: {
  children: ReactNode;
  freshAuthenticationOrganizationId: string | null;
  clearFreshAuthentication: () => void;
}) {
  const turnkey = useTurnkey();
  const thumper = useThumperAuth();
  const thumperUserScope = opaqueTurnkeyWalletScope(thumper.user?.id || "");
  const turnkeyOrganizationId = turnkey.session?.organizationId || null;
  const turnkeyAuthenticated = turnkey.authState === "authenticated";
  const [bindings, setBindings] = useState<PerpsTurnkeyBindings>({});
  const [bindingsLoaded, setBindingsLoaded] = useState(false);
  const [pendingBindingUserId, setPendingBindingUserId] = useState<string | null>(null);
  const [requireFreshAuthentication, setRequireFreshAuthentication] = useState(false);
  const forcedLogoutKey = useRef<string | null>(null);

  useEffect(() => {
    let stored: string | null = null;
    let pending: string | null = null;
    try {
      stored = localStorage.getItem(`${TURNKEY_BINDINGS_STORAGE_KEY}:${parentOrganizationId}`);
      pending = sessionStorage.getItem(`${TURNKEY_PENDING_BINDING_STORAGE_KEY}:${parentOrganizationId}`);
    } catch {
      // A blocked storage boundary must never restore an unverified session.
    }
    setBindings(parsePerpsTurnkeyBindings(stored));
    setPendingBindingUserId(pending);
    setBindingsLoaded(true);
  }, []);

  const boundary = useMemo(() => decidePerpsTurnkeyBoundary({
    thumperLoading: thumper.loading || !bindingsLoaded,
    thumperUserId: thumperUserScope,
    turnkeyAuthenticated,
    turnkeyOrganizationId,
    bindings,
    pendingBindingUserId,
    freshAuthenticationOrganizationId,
    requireFreshAuthentication,
  }), [
    bindings,
    bindingsLoaded,
    freshAuthenticationOrganizationId,
    pendingBindingUserId,
    requireFreshAuthentication,
    thumper.loading,
    thumperUserScope,
    turnkeyAuthenticated,
    turnkeyOrganizationId,
  ]);

  useEffect(() => {
    if (boundary.kind !== "bind") return;
    const next = {
      ...bindings,
      [boundary.binding.userId]: boundary.binding.organizationId,
    };
    try {
      localStorage.setItem(
        `${TURNKEY_BINDINGS_STORAGE_KEY}:${parentOrganizationId}`,
        JSON.stringify(next),
      );
    } catch {
      setPendingBindingUserId(null);
      setRequireFreshAuthentication(true);
      clearFreshAuthentication();
      void turnkey.logout().catch(() => {});
      return;
    }
    setBindings(next);
    try {
      sessionStorage.removeItem(`${TURNKEY_PENDING_BINDING_STORAGE_KEY}:${parentOrganizationId}`);
    } catch {
      // The verified binding is already durable; stale session state is ignored.
    }
    setPendingBindingUserId(null);
    setRequireFreshAuthentication(false);
    clearFreshAuthentication();
  }, [bindings, boundary, clearFreshAuthentication, turnkey]);

  useEffect(() => {
    if (!boundary.clearPending || boundary.kind === "bind") return;
    try {
      sessionStorage.removeItem(`${TURNKEY_PENDING_BINDING_STORAGE_KEY}:${parentOrganizationId}`);
    } catch {
      // A blocked storage boundary is handled by the identity boundary.
    }
    setPendingBindingUserId(null);
  }, [boundary.clearPending, boundary.kind]);

  const logoutBoundaryKey = boundary.kind === "logout"
    ? `${boundary.reason}:${thumperUserScope || "signed-out"}:${turnkeyOrganizationId || "no-org"}`
    : null;
  useEffect(() => {
    if (!logoutBoundaryKey) {
      forcedLogoutKey.current = null;
      return;
    }
    if (forcedLogoutKey.current === logoutBoundaryKey) return;
    forcedLogoutKey.current = logoutBoundaryKey;
    setPendingBindingUserId(null);
    setRequireFreshAuthentication(true);
    clearFreshAuthentication();
    void turnkey.logout().catch(() => {});
  }, [clearFreshAuthentication, logoutBoundaryKey, turnkey]);

  useEffect(() => {
    if (boundary.kind !== "await_fresh_turnkey_auth") return;
    const timeout = window.setTimeout(() => {
      setPendingBindingUserId(null);
      setRequireFreshAuthentication(true);
      clearFreshAuthentication();
      void turnkey.logout().catch(() => {});
    }, 10_000);
    return () => window.clearTimeout(timeout);
  }, [boundary.kind, clearFreshAuthentication, turnkey]);

  useEffect(() => {
    if (!boundary.ready || !requireFreshAuthentication) return;
    setPendingBindingUserId(null);
    setRequireFreshAuthentication(false);
    clearFreshAuthentication();
  }, [boundary.ready, clearFreshAuthentication, requireFreshAuthentication]);

  const organizationId = boundary.ready ? turnkeyOrganizationId : null;
  const authenticated = boundary.ready;
  const configured = isPerpsTurnkeyClientConfigured(turnkey.clientState);
  const loading =
    isPerpsTurnkeyClientLoading(turnkey.clientState) ||
    thumper.loading ||
    !bindingsLoaded ||
    boundary.kind === "bind" ||
    boundary.kind === "await_fresh_turnkey_auth" ||
    boundary.kind === "logout";

  const login = useCallback(async () => {
    const userId = thumperUserScope;
    if (!userId || thumper.loading) {
      throw new Error("Sign in to Ghola before authenticating the perps wallet.");
    }
    if (!bindingsLoaded) {
      throw new Error("The perps identity boundary is still loading.");
    }
    if (boundary.ready) return;
    setRequireFreshAuthentication(true);
    clearFreshAuthentication();
    setPendingBindingUserId(null);
    if (turnkeyAuthenticated || turnkeyOrganizationId) {
      await turnkey.logout();
    }
    sessionStorage.setItem(`${TURNKEY_PENDING_BINDING_STORAGE_KEY}:${parentOrganizationId}`, userId);
    setPendingBindingUserId(userId);
    try {
      await turnkey.handleLogin({ title: "Secure Ghola trading access" });
    } catch (error) {
      sessionStorage.removeItem(`${TURNKEY_PENDING_BINDING_STORAGE_KEY}:${parentOrganizationId}`);
      setPendingBindingUserId((current) => (current === userId ? null : current));
      throw error;
    }
  }, [
    bindingsLoaded,
    boundary.ready,
    clearFreshAuthentication,
    thumper.loading,
    thumperUserScope,
    turnkey,
    turnkeyAuthenticated,
    turnkeyOrganizationId,
  ]);

  const logout = useCallback(async () => {
    try {
      sessionStorage.removeItem(`${TURNKEY_PENDING_BINDING_STORAGE_KEY}:${parentOrganizationId}`);
    } catch {
      // Best-effort cleanup only.
    }
    setPendingBindingUserId(null);
    setRequireFreshAuthentication(true);
    clearFreshAuthentication();
    await turnkey.logout();
  }, [clearFreshAuthentication, turnkey]);

  const ensureWalletPair = useCallback(async (includeTombstone = false) => {
    if (!organizationId || !turnkey.httpClient || !authenticated) {
      throw new Error("Authenticate with Turnkey before creating the perps wallets.");
    }
    let wallets = await turnkey.refreshWallets({ organizationId });
    const binding = readPerpsWalletBinding(thumperUserScope, organizationId);
    let wallet: Wallet | null = findPerpsWallet(wallets, binding?.walletId || null, includeTombstone);
    if (!wallet) {
      const walletId = await turnkey.createWallet({
        organizationId,
        walletName: PERPS_WALLET_NAME,
        accounts: [OWNER_ACCOUNT, AGENT_ACCOUNT, SEALING_ACCOUNT],
      });
      wallets = await turnkey.refreshWallets({ organizationId });
      wallet = wallets.find((candidate) => candidate.walletId === walletId) || null;
    }
    if (!wallet) throw new Error("Turnkey did not return the Ghola perps wallet.");
    const required = includeTombstone
      ? [OWNER_ACCOUNT, AGENT_ACCOUNT, SEALING_ACCOUNT, TOMBSTONE_ACCOUNT]
      : [OWNER_ACCOUNT, AGENT_ACCOUNT, SEALING_ACCOUNT];
    const missing = required.filter((params) => !wallet?.accounts.some((account) => account.path === params.path));
    if (missing.length > 0) {
      const selectedWalletId = wallet.walletId;
      await turnkey.createWalletAccounts({
        organizationId,
        walletId: selectedWalletId,
        accounts: missing,
      });
      wallets = await turnkey.refreshWallets({ organizationId });
      wallet = wallets.find((candidate) => candidate.walletId === selectedWalletId) || null;
    }
    if (!wallet) throw new Error("Turnkey perps wallet refresh failed.");
    writePerpsWalletBinding(thumperUserScope, organizationId, wallet.walletId);
    const owner = accountAt(wallet, OWNER_PATH);
    const agent = accountAt(wallet, AGENT_PATH);
    const sealing = accountAt(wallet, SEALING_PATH);
    const tombstone = includeTombstone ? accountAt(wallet, TOMBSTONE_PATH) : undefined;
    return { organizationId, walletId: wallet.walletId, owner, agent, sealing, tombstone };
  }, [authenticated, organizationId, thumperUserScope, turnkey]);

  const replaceWalletPair = useCallback(async () => {
    if (!organizationId || !turnkey.httpClient || !authenticated || !thumperUserScope) {
      throw new Error("Authenticate with Turnkey before repairing the perps wallet.");
    }
    const walletId = await turnkey.createWallet({
      organizationId,
      walletName: PERPS_WALLET_NAME,
      accounts: [OWNER_ACCOUNT, AGENT_ACCOUNT, SEALING_ACCOUNT],
    });
    const wallets = await turnkey.refreshWallets({ organizationId });
    const wallet = wallets.find((candidate) => candidate.walletId === walletId) || null;
    if (!wallet) throw new Error("Turnkey did not return the replacement Ghola perps wallet.");
    writePerpsWalletBinding(thumperUserScope, organizationId, wallet.walletId);
    return {
      organizationId,
      walletId: wallet.walletId,
      owner: accountAt(wallet, OWNER_PATH),
      agent: accountAt(wallet, AGENT_PATH),
      sealing: accountAt(wallet, SEALING_PATH),
    };
  }, [authenticated, organizationId, thumperUserScope, turnkey]);

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
    const pair = await ensureWalletPair();
    if (!turnkey.httpClient) throw new Error("Turnkey signing client is unavailable.");
    return signAsterAgentApprovalWithTurnkey({
      client: turnkey.httpClient,
      organizationId: pair.organizationId,
      owner: pair.owner,
      typedData,
    });
  }, [ensureWalletPair, turnkey.httpClient]);

  const signLighterKeyAssociation = useCallback(async (
    transactionPlan: LighterChangePubKeyTransactionPlan,
  ) => {
    const pair = await ensureWalletPair();
    if (!turnkey.httpClient) throw new Error("Turnkey signing client is unavailable.");
    return signLighterChangePubKeyWithTurnkey({
      client: turnkey.httpClient,
      organizationId: pair.organizationId,
      owner: pair.owner,
      transactionPlan,
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
    login,
    logout,
    ensureWalletPair,
    replaceWalletPair,
    installDelegation,
    signOwnerMandate,
    signCarryRiskMandate,
    signAgentBinding,
    signAsterAgentApproval,
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
    organizationId,
    revokeHyperliquid,
    signOwnerMandate,
    signCarryRiskMandate,
    signAgentBinding,
    signAsterAgentApproval,
    signLighterKeyAssociation,
    signSealingBytes,
  ]);
  return <PerpsTurnkeyContext.Provider value={value}>{children}</PerpsTurnkeyContext.Provider>;
}

export function usePerpsTurnkey() {
  return useContext(PerpsTurnkeyContext);
}

function findPerpsWallet(
  wallets: Wallet[],
  boundWalletId: string | null,
  includeTombstone: boolean,
) {
  if (boundWalletId) {
    const bound = wallets.find((wallet) => wallet.walletId === boundWalletId) || null;
    if (!bound) throw new Error("The bound Ghola perps wallet is unavailable; repair is required.");
    return bound;
  }
  const candidates = wallets.filter((wallet) => wallet.walletName === PERPS_WALLET_NAME);
  if (candidates.length <= 1) return candidates[0] || null;
  const requiredPaths = includeTombstone
    ? [OWNER_PATH, AGENT_PATH, SEALING_PATH, TOMBSTONE_PATH]
    : [OWNER_PATH, AGENT_PATH, SEALING_PATH];
  const complete = candidates.filter((wallet) => requiredPaths.every((path) =>
    wallet.accounts.filter((account) => account.path === path).length === 1
  ));
  if (complete.length === 1) return complete[0];
  throw new Error("Multiple Ghola perps wallets are active; bind or repair one exact wallet before signing.");
}

function accountAt(wallet: Wallet, path: string) {
  const accounts = wallet.accounts.filter((candidate) => candidate.path === path);
  if (accounts.length !== 1) throw new Error(`Turnkey wallet account ${path} is unavailable or ambiguous.`);
  const account = accounts[0];
  if (account.walletId !== wallet.walletId) {
    throw new Error(`Turnkey wallet account ${path} is bound to a different wallet.`);
  }
  return account;
}

function readPerpsWalletBinding(userScope: string | null, organizationId: string) {
  if (!userScope) return null;
  try {
    const parsed = JSON.parse(localStorage.getItem(TURNKEY_WALLET_BINDINGS_STORAGE_KEY) || "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const binding = (parsed as Record<string, unknown>)[userScope];
    if (!binding || typeof binding !== "object" || Array.isArray(binding)) return null;
    const record = binding as Record<string, unknown>;
    return record.organizationId === organizationId && typeof record.walletId === "string" && record.walletId
      ? { organizationId, walletId: record.walletId }
      : null;
  } catch {
    return null;
  }
}

function writePerpsWalletBinding(userScope: string | null, organizationId: string, walletId: string) {
  if (!userScope || !walletId) throw new Error("A verified Ghola wallet identity is required.");
  let current: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(localStorage.getItem(TURNKEY_WALLET_BINDINGS_STORAGE_KEY) || "{}") as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) current = parsed as Record<string, unknown>;
    localStorage.setItem(TURNKEY_WALLET_BINDINGS_STORAGE_KEY, JSON.stringify({
      ...current,
      [userScope]: { organizationId, walletId },
    }));
  } catch {
    throw new Error("The exact Ghola perps wallet binding could not be saved.");
  }
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
