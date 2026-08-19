import bs58 from "bs58";
import { didKeyFromVerifying, RecipientKind, seal } from "./envelope";
import {
  chooseConfidentialComputeProvider,
  providerReadyForPrivateAgents,
  type ConfidentialComputeProviderStatus,
  type PrivateAgentRuntimeStatus,
} from "./private-agent-runtime";
import { gholaCommitment } from "./private-account";

export type HyperliquidNetwork = "mainnet" | "testnet";

export interface HyperliquidExecutionCredentialDraft {
  network: HyperliquidNetwork;
  hyperliquid_account_address: string;
  api_wallet_private_key: string;
  agent_name?: string;
}

export interface HyperliquidEncryptedExecutionVaultBundle {
  alg: "sealed-provider-v1";
  ciphertext: string;
  recipient: string;
  aad: string;
}

export interface BuildHyperliquidExecutionVaultBundleOptions {
  accountCommitment: string;
  ownerWalletAddress: string;
  credential: HyperliquidExecutionCredentialDraft;
  agentWalletAddress?: string;
  signBytes: (bytes: Uint8Array) => Promise<Uint8Array>;
  runtimeStatus?: PrivateAgentRuntimeStatus;
  fetchRuntimeStatus?: () => Promise<PrivateAgentRuntimeStatus>;
  now?: Date;
}

export interface BuildHyperliquidExecutionVaultBundleResult {
  encrypted_execution_vault: HyperliquidEncryptedExecutionVaultBundle;
  recipient: ConfidentialComputeProviderStatus["sealed_recipient"];
  associated_data: string;
}

const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;
const AGENT_NAME_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

export function validateHyperliquidExecutionCredentialDraft(
  draft: HyperliquidExecutionCredentialDraft,
): string[] {
  const errors: string[] = [];
  if (draft.network !== "mainnet" && draft.network !== "testnet") {
    errors.push("Select a Hyperliquid network.");
  }
  if (!ETH_ADDRESS_RE.test(draft.hyperliquid_account_address.trim())) {
    errors.push("Enter a 0x Hyperliquid account address.");
  }
  const privateKey = draft.api_wallet_private_key.trim();
  if (/\s/.test(privateKey) || !PRIVATE_KEY_RE.test(privateKey)) {
    errors.push("Enter a 0x API wallet private key.");
  }
  if (draft.agent_name?.trim() && !AGENT_NAME_RE.test(draft.agent_name.trim())) {
    errors.push("Agent name can use letters, numbers, dash, underscore, dot, or colon.");
  }
  return errors;
}

export async function fetchPrivateAgentRuntimeStatus(): Promise<PrivateAgentRuntimeStatus> {
  const res = await fetch("/api/private-agent/status", {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
  });
  const body = await res.json().catch(() => null) as unknown;
  if (!res.ok || !isPrivateAgentRuntimeStatus(body)) {
    throw new Error("Attested private-agent recipient is unavailable.");
  }
  return body;
}

export async function buildHyperliquidExecutionVaultBundle(
  options: BuildHyperliquidExecutionVaultBundleOptions,
): Promise<BuildHyperliquidExecutionVaultBundleResult> {
  const validationErrors = validateHyperliquidExecutionCredentialDraft(options.credential);
  if (validationErrors.length > 0) {
    throw new Error(validationErrors[0]);
  }
  if (!options.accountCommitment.trim()) {
    throw new Error("Private account commitment is unavailable.");
  }

  const runtime = options.runtimeStatus ??
    await (options.fetchRuntimeStatus ?? fetchPrivateAgentRuntimeStatus)();
  const provider = selectedReadyProvider(runtime);
  const recipient = provider?.sealed_recipient;
  if (!recipient) {
    throw new Error("Attested private-agent recipient is unavailable.");
  }
  const recipientX25519 = hexToBytes(recipient.x25519_pub_hex);
  if (recipientX25519.length !== 32) {
    throw new Error("Attested private-agent recipient key is invalid.");
  }

  const ownerDid = solanaAddressToDid(options.ownerWalletAddress);
  if (!ownerDid) {
    throw new Error("Turnkey wallet identity is unavailable.");
  }

  const normalizedNetwork = options.credential.network;
  const associatedData = hyperliquidVaultAssociatedData({
    accountCommitment: options.accountCommitment,
    recipientId: recipient.recipient_id,
    network: normalizedNetwork,
    ...(options.agentWalletAddress
      ? {
          venueAccountAddress: options.credential.hyperliquid_account_address,
          agentWalletAddress: options.agentWalletAddress,
        }
      : {}),
  });
  const sealedPlaintext = {
    version: 1,
    kind: "ghola_hyperliquid_execution_vault",
    network: normalizedNetwork,
    hyperliquid_account_address: options.credential.hyperliquid_account_address.trim().toLowerCase(),
    api_wallet_private_key: options.credential.api_wallet_private_key.trim().toLowerCase(),
    agent_name: options.credential.agent_name?.trim() || null,
    allowed_operations: ["read", "limit_order", "cancel", "reconcile"],
    blocked_operations: ["withdraw", "vault_transfer", "leverage_escalation"],
    created_at: (options.now ?? new Date()).toISOString(),
  };

  const sealedBytes = await seal({
    senderDid: ownerDid,
    recipientId: recipient.recipient_id,
    recipientX25519,
    kind: RecipientKind.ModelBridge,
    associatedData: new TextEncoder().encode(associatedData),
    plaintext: new TextEncoder().encode(JSON.stringify(sealedPlaintext)),
    signBody: options.signBytes,
  });

  return {
    recipient,
    associated_data: associatedData,
    encrypted_execution_vault: {
      alg: "sealed-provider-v1",
      ciphertext: bytesToBase64(sealedBytes),
      recipient: recipient.recipient_id,
      aad: associatedData,
    },
  };
}

export function hyperliquidVaultAssociatedData(input: {
  accountCommitment: string;
  recipientId: string;
  network: HyperliquidNetwork;
  venueAccountAddress?: string;
  agentWalletAddress?: string;
}) {
  const identity = input.venueAccountAddress && input.agentWalletAddress
    ? hyperliquidVaultIdentityCommitments({
        venueAccountAddress: input.venueAccountAddress,
        agentWalletAddress: input.agentWalletAddress,
      })
    : null;
  return [
    identity
      ? "ghola/hyperliquid-execution-vault-v2"
      : "ghola/hyperliquid-execution-vault-v1",
    `account:${input.accountCommitment}`,
    `recipient:${input.recipientId}`,
    `network:${input.network}`,
    ...(identity
      ? [
          `venue-account:${identity.venue_account_commitment}`,
          `agent-wallet:${identity.agent_wallet_commitment}`,
        ]
      : []),
  ].join("|");
}

export function parseHyperliquidVaultAssociatedData(value: string): {
  version: 1 | 2;
  account_commitment: string;
  recipient: string;
  network: HyperliquidNetwork;
  venue_account_commitment: string | null;
  agent_wallet_commitment: string | null;
} | null {
  const [version, accountPart, recipientPart, networkPart, venueAccountPart, agentWalletPart, ...extra] = value.split("|");
  const parsedVersion = version === "ghola/hyperliquid-execution-vault-v1"
    ? 1
    : version === "ghola/hyperliquid-execution-vault-v2"
      ? 2
      : null;
  if (!parsedVersion || extra.length > 0) return null;
  const account = accountPart?.startsWith("account:") ? accountPart.slice("account:".length) : "";
  const recipient = recipientPart?.startsWith("recipient:") ? recipientPart.slice("recipient:".length) : "";
  const network = networkPart?.startsWith("network:") ? networkPart.slice("network:".length) : "";
  if (!account || !recipient || (network !== "mainnet" && network !== "testnet")) return null;
  if (parsedVersion === 1) {
    if (venueAccountPart !== undefined || agentWalletPart !== undefined) return null;
    return {
      version: 1,
      account_commitment: account,
      recipient,
      network,
      venue_account_commitment: null,
      agent_wallet_commitment: null,
    };
  }
  const venueAccount = venueAccountPart?.startsWith("venue-account:")
    ? venueAccountPart.slice("venue-account:".length)
    : "";
  const agentWallet = agentWalletPart?.startsWith("agent-wallet:")
    ? agentWalletPart.slice("agent-wallet:".length)
    : "";
  if (!/^hyperliquid_venue_account_[0-9a-f]{48}$/.test(venueAccount) ||
      !/^hyperliquid_agent_wallet_[0-9a-f]{48}$/.test(agentWallet)) return null;
  return {
    version: 2,
    account_commitment: account,
    recipient,
    network,
    venue_account_commitment: venueAccount,
    agent_wallet_commitment: agentWallet,
  };
}

export function hyperliquidVaultIdentityCommitments(input: {
  venueAccountAddress: string;
  agentWalletAddress: string;
}) {
  const venueAccount = normalizedEvmAddress(input.venueAccountAddress);
  const agentWallet = normalizedEvmAddress(input.agentWalletAddress);
  if (venueAccount === agentWallet) throw new Error("Hyperliquid master and API wallet must differ.");
  return {
    venue_account_commitment: gholaCommitment("hyperliquid_venue_account", venueAccount),
    agent_wallet_commitment: gholaCommitment("hyperliquid_agent_wallet", agentWallet),
  };
}

function selectedReadyProvider(
  runtime: PrivateAgentRuntimeStatus,
): ConfidentialComputeProviderStatus | null {
  const selected = runtime.selected_provider
    ? runtime.providers.find((provider) =>
        provider.id === runtime.selected_provider && providerReadyForPrivateAgents(provider)
      ) ?? null
    : null;
  return selected ?? chooseConfidentialComputeProvider(runtime.providers, runtime.preferred_provider);
}

function isPrivateAgentRuntimeStatus(value: unknown): value is PrivateAgentRuntimeStatus {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<PrivateAgentRuntimeStatus>;
  return (
    record.version === 1 &&
    Array.isArray(record.providers) &&
    record.sealed_execution_required === true
  );
}

function normalizedEvmAddress(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!ETH_ADDRESS_RE.test(normalized)) throw new Error("Hyperliquid wallet address is invalid.");
  return normalized;
}

function solanaAddressToDid(address: string): string | null {
  try {
    const pub = bs58.decode(address);
    if (pub.length !== 32) return null;
    return didKeyFromVerifying(pub);
  } catch {
    return null;
  }
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2 !== 0) {
    throw new Error("invalid hex");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
