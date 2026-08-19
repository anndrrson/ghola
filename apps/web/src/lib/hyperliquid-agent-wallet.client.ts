"use client";

import { recoverTypedDataAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  authorizePhantomHyperliquidAgent,
  disablePhantomHyperliquidAgent,
  preflightPhantomHyperliquidAccount,
} from "./private-account-client";
import {
  buildHyperliquidExecutionVaultBundle,
} from "./hyperliquid-vault-seal";
import type { PrivateAgentRuntimeStatus } from "./private-agent-runtime";
import {
  createBrowserEd25519Wallet,
  signBrowserEd25519Bytes,
} from "./browser-ed25519-wallet";
import {
  createHyperliquidApproveAgentAction,
  hyperliquidApproveAgentProviderPayload,
  hyperliquidApproveAgentTypedData,
  normalizedEvmAddress,
  parseHyperliquidEvmSignature,
  signatureHex,
  type HyperliquidAgentAuthorizationRequest,
  type HyperliquidAgentRevocationRequest,
} from "./hyperliquid-agent-wallet";

type EthereumProviderEvent = "accountsChanged" | "disconnect";
type EthereumProviderListener = (value?: unknown) => void;

export interface PhantomEthereumProvider {
  isPhantom?: boolean;
  request(input: { method: string; params?: readonly unknown[] }): Promise<unknown>;
  on?(event: EthereumProviderEvent, listener: EthereumProviderListener): void;
  removeListener?(event: EthereumProviderEvent, listener: EthereumProviderListener): void;
}

type PhantomWindow = Window & {
  phantom?: { ethereum?: PhantomEthereumProvider };
};

export interface HyperliquidAgentWalletClientDependencies {
  getProvider: () => PhantomEthereumProvider | undefined;
  generateKey: () => Hex;
  deriveAddress: (key: Hex) => Address;
  recoverAddress: typeof recoverTypedDataAddress;
  preflight: typeof preflightPhantomHyperliquidAccount;
  buildVault: typeof buildHyperliquidExecutionVaultBundle;
  now: () => number;
}

const DEFAULT_DEPENDENCIES: HyperliquidAgentWalletClientDependencies = {
  getProvider: canonicalPhantomEthereumProvider,
  generateKey: generatePrivateKey,
  deriveAddress: (key) => privateKeyToAccount(key).address.toLowerCase() as Address,
  recoverAddress: recoverTypedDataAddress,
  preflight: preflightPhantomHyperliquidAccount,
  buildVault: buildHyperliquidExecutionVaultBundle,
  now: Date.now,
};

export async function preparePhantomHyperliquidAgentAuthorization(input: {
  accountCommitment: string;
  runtime: PrivateAgentRuntimeStatus;
  dependencies?: Partial<HyperliquidAgentWalletClientDependencies>;
}): Promise<HyperliquidAgentAuthorizationRequest> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...input.dependencies };
  const session = await connectPinnedPhantom(dependencies.getProvider);
  let privateKey: Hex | null = null;
  try {
    await dependencies.preflight(session.account);
    session.assertCurrent();
    privateKey = dependencies.generateKey();
    const agentAddress = normalizedEvmAddress(dependencies.deriveAddress(privateKey));
    const envelopeSigner = createBrowserEd25519Wallet("ghola-hyperliquid-seal");
    const action = createHyperliquidApproveAgentAction({
      accountCommitment: input.accountCommitment,
      agentAddress,
      nowMs: dependencies.now(),
    });
    const bundle = await dependencies.buildVault({
      accountCommitment: input.accountCommitment,
      ownerWalletAddress: envelopeSigner.walletAddress,
      credential: {
        network: "mainnet",
        hyperliquid_account_address: session.account,
        api_wallet_private_key: privateKey,
        agent_name: "ghola-mainnet",
      },
      agentWalletAddress: agentAddress,
      runtimeStatus: input.runtime,
      signBytes: async (bytes) => signBrowserEd25519Bytes(envelopeSigner.secretKeyHex, bytes),
    });
    privateKey = null;
    session.assertCurrent();
    const rawSignature = await session.provider.request({
      method: "eth_signTypedData_v4",
      params: [session.account, JSON.stringify(hyperliquidApproveAgentProviderPayload(action))],
    });
    const signature = parseHyperliquidEvmSignature(rawSignature);
    session.assertCurrent();
    await session.assertAccountStillSelected();
    const recovered = normalizedEvmAddress(await dependencies.recoverAddress({
      ...hyperliquidApproveAgentTypedData(action),
      signature: signatureHex(signature),
    }));
    if (recovered !== session.account) {
      throw new Error("Phantom signed with a different EVM account. Reconnect the intended account.");
    }
    return {
      version: 1,
      action,
      signature,
      nonce: action.nonce,
      encrypted_execution_vault: bundle.encrypted_execution_vault,
    };
  } finally {
    privateKey = null;
    session.close();
  }
}

export async function preparePhantomHyperliquidAgentDisable(input: {
  accountCommitment: string;
  dependencies?: Partial<HyperliquidAgentWalletClientDependencies>;
}): Promise<HyperliquidAgentRevocationRequest> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...input.dependencies };
  const session = await connectPinnedPhantom(dependencies.getProvider);
  let discardedKey: Hex | null = null;
  try {
    session.assertCurrent();
    discardedKey = dependencies.generateKey();
    const replacementAddress = normalizedEvmAddress(dependencies.deriveAddress(discardedKey));
    discardedKey = null;
    const action = createHyperliquidApproveAgentAction({
      accountCommitment: input.accountCommitment,
      agentAddress: replacementAddress,
      nowMs: dependencies.now(),
    });
    const rawSignature = await session.provider.request({
      method: "eth_signTypedData_v4",
      params: [session.account, JSON.stringify(hyperliquidApproveAgentProviderPayload(action))],
    });
    const signature = parseHyperliquidEvmSignature(rawSignature);
    session.assertCurrent();
    await session.assertAccountStillSelected();
    const recovered = normalizedEvmAddress(await dependencies.recoverAddress({
      ...hyperliquidApproveAgentTypedData(action),
      signature: signatureHex(signature),
    }));
    if (recovered !== session.account) {
      throw new Error("Phantom signed with a different EVM account. Ghola access was not disabled.");
    }
    return { version: 1, action, signature, nonce: action.nonce };
  } finally {
    discardedKey = null;
    session.close();
  }
}

export async function submitPhantomHyperliquidAuthorization(
  request: HyperliquidAgentAuthorizationRequest,
) {
  return authorizePhantomHyperliquidAgent(request);
}

export async function submitPhantomHyperliquidDisable(request: HyperliquidAgentRevocationRequest) {
  return disablePhantomHyperliquidAgent(request);
}

export function canonicalPhantomEthereumProvider(): PhantomEthereumProvider | undefined {
  if (typeof window === "undefined") return undefined;
  const provider = (window as PhantomWindow).phantom?.ethereum;
  return provider?.isPhantom === true ? provider : undefined;
}

async function connectPinnedPhantom(
  getProvider: () => PhantomEthereumProvider | undefined,
): Promise<{
  provider: PhantomEthereumProvider;
  account: Address;
  assertCurrent: () => void;
  assertAccountStillSelected: () => Promise<void>;
  close: () => void;
}> {
  const provider = getProvider();
  if (!provider || provider.isPhantom !== true) {
    throw new Error("Unlock Phantom and enable its Ethereum account, then try again.");
  }
  let pinned: Address | null = null;
  const observed = { latestEventAccounts: null as Address[] | null, drifted: false };
  const accountsChanged = (value?: unknown) => {
    const accounts = parseAccounts(value);
    if (!accounts) {
      observed.drifted = true;
      return;
    }
    observed.latestEventAccounts = accounts;
    if (pinned && (accounts.length !== 1 || accounts[0] !== pinned)) observed.drifted = true;
  };
  const disconnected = () => { observed.drifted = true; };
  if ((provider.on && !provider.removeListener) || (!provider.on && provider.removeListener)) {
    throw new Error("Phantom’s Ethereum provider cannot be monitored safely. Reload Phantom and try again.");
  }
  provider.on?.("accountsChanged", accountsChanged);
  provider.on?.("disconnect", disconnected);
  const close = () => {
    provider.removeListener?.("accountsChanged", accountsChanged);
    provider.removeListener?.("disconnect", disconnected);
  };
  try {
    const requested = parseAccounts(await provider.request({ method: "eth_requestAccounts" }));
    if (!requested || requested.length !== 1) {
      throw new Error("Phantom did not return exactly one EVM account.");
    }
    pinned = requested[0];
    if (observed.latestEventAccounts &&
        (observed.latestEventAccounts.length !== 1 || observed.latestEventAccounts[0] !== pinned)) {
      observed.drifted = true;
    }
    const assertCurrent = () => {
      if (observed.drifted || getProvider() !== provider || provider.isPhantom !== true) {
        throw new Error("Phantom changed account or provider during authorization. Start again.");
      }
    };
    const assertAccountStillSelected = async () => {
      assertCurrent();
      const selected = parseAccounts(await provider.request({ method: "eth_accounts" }));
      assertCurrent();
      if (!selected || selected.length !== 1 || selected[0] !== pinned) {
        throw new Error("Phantom changed the selected EVM account. Start again.");
      }
    };
    await assertAccountStillSelected();
    return { provider, account: pinned, assertCurrent, assertAccountStillSelected, close };
  } catch (error) {
    close();
    throw error;
  }
}

function parseAccounts(value: unknown): Address[] | null {
  if (!Array.isArray(value)) return null;
  try {
    return value.map((account) => normalizedEvmAddress(typeof account === "string" ? account : ""));
  } catch {
    return null;
  }
}
