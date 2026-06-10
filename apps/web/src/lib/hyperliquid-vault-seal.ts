import bs58 from "bs58";
import { didKeyFromVerifying, RecipientKind, seal } from "./envelope";
import {
  chooseConfidentialComputeProvider,
  providerReadyForPrivateAgents,
  type ConfidentialComputeProviderStatus,
  type PrivateAgentRuntimeStatus,
} from "./private-agent-runtime";

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

export interface HyperliquidCredentialImportResult {
  draft: HyperliquidExecutionCredentialDraft;
  fields: Array<"network" | "hyperliquid_account_address" | "api_wallet_private_key" | "agent_name">;
}

export interface BuildHyperliquidExecutionVaultBundleOptions {
  accountCommitment: string;
  ownerWalletAddress: string;
  credential: HyperliquidExecutionCredentialDraft;
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
const ETH_ADDRESS_TOKEN_RE = /(?:^|[^0-9a-fA-F])(0x[0-9a-fA-F]{40})(?![0-9a-fA-F])/;
const PRIVATE_KEY_TOKEN_RE = /(?:^|[^0-9a-fA-F])(0x[0-9a-fA-F]{64})(?![0-9a-fA-F])/;
const AGENT_NAME_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const DEFAULT_HYPERLIQUID_DRAFT: HyperliquidExecutionCredentialDraft = {
  network: "mainnet",
  hyperliquid_account_address: "",
  api_wallet_private_key: "",
  agent_name: "",
};

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

export function parseHyperliquidCredentialImport(
  value: string,
  current: HyperliquidExecutionCredentialDraft = DEFAULT_HYPERLIQUID_DRAFT,
): HyperliquidCredentialImportResult {
  const parsed = parseImportValue(value);
  const fields: HyperliquidCredentialImportResult["fields"] = [];
  const next: HyperliquidExecutionCredentialDraft = {
    network: current.network,
    hyperliquid_account_address: current.hyperliquid_account_address,
    api_wallet_private_key: current.api_wallet_private_key,
    agent_name: current.agent_name || "",
  };
  const network = normalizeNetwork(firstStringByKeys(parsed, [
    "network",
    "hyperliquid_network",
    "hl_network",
    "chain",
  ]) || value);
  if (network) {
    next.network = network;
    fields.push("network");
  }
  const account = firstStringByKeys(parsed, [
    "hyperliquid_account_address",
    "hyperliquid_account",
    "account_address",
    "accountAddress",
    "user",
    "user_address",
    "userAddress",
    "master",
    "master_address",
    "masterAddress",
    "address",
  ]) || value.match(ETH_ADDRESS_TOKEN_RE)?.[1] || "";
  if (ETH_ADDRESS_RE.test(account.trim())) {
    next.hyperliquid_account_address = account.trim().toLowerCase();
    fields.push("hyperliquid_account_address");
  }
  const privateKey = firstStringByKeys(parsed, [
    "api_wallet_private_key",
    "apiWalletPrivateKey",
    "agent_private_key",
    "agentPrivateKey",
    "private_key",
    "privateKey",
    "secret_key",
    "secretKey",
    "key",
  ]) || value.match(PRIVATE_KEY_TOKEN_RE)?.[1] || "";
  if (PRIVATE_KEY_RE.test(privateKey.trim())) {
    next.api_wallet_private_key = privateKey.trim().toLowerCase();
    fields.push("api_wallet_private_key");
  }
  const agentName = firstStringByKeys(parsed, [
    "agent_name",
    "agentName",
    "name",
    "label",
  ]) || "";
  if (agentName.trim() && AGENT_NAME_RE.test(agentName.trim())) {
    next.agent_name = agentName.trim();
    fields.push("agent_name");
  }
  return {
    draft: next,
    fields: Array.from(new Set(fields)),
  };
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
}) {
  return [
    "ghola/hyperliquid-execution-vault-v1",
    `account:${input.accountCommitment}`,
    `recipient:${input.recipientId}`,
    `network:${input.network}`,
  ].join("|");
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

function parseImportValue(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  const record: Record<string, string> = {};
  for (const line of trimmed.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9_.-]+)\s*(?:=|:)\s*(.+?)\s*$/);
    if (!match) continue;
    record[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  return Object.keys(record).length ? record : null;
}

function firstStringByKeys(value: unknown, keys: string[]): string | null {
  const wanted = new Set(keys.map((key) => key.toLowerCase()));
  const seen = new Set<unknown>();
  function visit(node: unknown): string | null {
    if (!node || typeof node !== "object" || seen.has(node)) return null;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = visit(child);
        if (found) return found;
      }
      return null;
    }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (wanted.has(key.toLowerCase()) && typeof child === "string" && child.trim()) {
        return child.trim();
      }
    }
    for (const child of Object.values(node as Record<string, unknown>)) {
      const found = visit(child);
      if (found) return found;
    }
    return null;
  }
  return visit(value);
}

function normalizeNetwork(value: string): HyperliquidNetwork | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.includes("testnet") || normalized.includes("test")) return "testnet";
  if (normalized.includes("mainnet") || normalized.includes("main")) return "mainnet";
  return null;
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
