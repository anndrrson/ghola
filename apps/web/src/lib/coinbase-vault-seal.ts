import bs58 from "bs58";
import { didKeyFromVerifying, RecipientKind, seal } from "./envelope";
import {
  chooseConfidentialComputeProvider,
  providerReadyForPrivateAgents,
  type ConfidentialComputeProviderStatus,
  type PrivateAgentRuntimeStatus,
} from "./private-agent-runtime";
import { fetchPrivateAgentRuntimeStatus } from "./hyperliquid-vault-seal";

export type CoinbaseAdvancedNetwork = "mainnet" | "sandbox";
export type CoinbaseExecutionMode = "byo_api_key" | "partner_omnibus";

export interface CoinbaseExecutionCredentialDraft {
  network: CoinbaseAdvancedNetwork;
  api_key_name: string;
  api_private_key_pem: string;
  portfolio_id?: string;
}

export interface CoinbaseEncryptedExecutionVaultBundle {
  alg: "sealed-provider-v1";
  ciphertext: string;
  recipient: string;
  aad: string;
}

export interface CoinbaseCredentialImportResult {
  draft: CoinbaseExecutionCredentialDraft;
  fields: Array<"network" | "api_key_name" | "api_private_key_pem" | "portfolio_id">;
}

export interface BuildCoinbaseExecutionVaultBundleOptions {
  accountCommitment: string;
  ownerWalletAddress: string;
  credential: CoinbaseExecutionCredentialDraft;
  signBytes: (bytes: Uint8Array) => Promise<Uint8Array>;
  executionMode?: CoinbaseExecutionMode;
  runtimeStatus?: PrivateAgentRuntimeStatus;
  fetchRuntimeStatus?: () => Promise<PrivateAgentRuntimeStatus>;
  now?: Date;
}

export interface BuildCoinbaseExecutionVaultBundleResult {
  encrypted_execution_vault: CoinbaseEncryptedExecutionVaultBundle;
  recipient: ConfidentialComputeProviderStatus["sealed_recipient"];
  associated_data: string;
  execution_mode: CoinbaseExecutionMode;
}

const KEY_NAME_RE = /^organizations\/[A-Za-z0-9_-]+\/apiKeys\/[A-Za-z0-9_-]+$/;
const PORTFOLIO_ID_RE = /^[A-Za-z0-9_-]{6,128}$/;
const DEFAULT_COINBASE_DRAFT: CoinbaseExecutionCredentialDraft = {
  network: "mainnet",
  api_key_name: "",
  api_private_key_pem: "",
  portfolio_id: "",
};

export function validateCoinbaseExecutionCredentialDraft(
  draft: CoinbaseExecutionCredentialDraft,
): string[] {
  const errors: string[] = [];
  if (draft.network !== "mainnet" && draft.network !== "sandbox") {
    errors.push("Select a Coinbase network.");
  }
  if (!KEY_NAME_RE.test(draft.api_key_name.trim())) {
    errors.push("Enter a Coinbase CDP API key name.");
  }
  if (!isEcPrivateKeyPem(draft.api_private_key_pem)) {
    errors.push("Paste the Coinbase EC private key PEM.");
  }
  if (draft.portfolio_id?.trim() && !PORTFOLIO_ID_RE.test(draft.portfolio_id.trim())) {
    errors.push("Portfolio id can use letters, numbers, dash, or underscore.");
  }
  return errors;
}

export function parseCoinbaseCredentialImport(
  value: string,
  current: CoinbaseExecutionCredentialDraft = DEFAULT_COINBASE_DRAFT,
): CoinbaseCredentialImportResult {
  const parsed = parseImportValue(value);
  const fields: CoinbaseCredentialImportResult["fields"] = [];
  const next: CoinbaseExecutionCredentialDraft = {
    network: current.network,
    api_key_name: current.api_key_name,
    api_private_key_pem: current.api_private_key_pem,
    portfolio_id: current.portfolio_id || "",
  };
  const network = normalizeNetwork(firstStringByKeys(parsed, [
    "network",
    "coinbase_network",
    "environment",
  ]) || value);
  if (network) {
    next.network = network;
    fields.push("network");
  }
  const apiKeyName = firstStringByKeys(parsed, [
    "api_key_name",
    "apiKeyName",
    "key_name",
    "keyName",
    "name",
    "kid",
  ]) || value.match(/organizations\/[A-Za-z0-9_-]+\/apiKeys\/[A-Za-z0-9_-]+/)?.[0] || "";
  if (KEY_NAME_RE.test(apiKeyName.trim())) {
    next.api_key_name = apiKeyName.trim();
    fields.push("api_key_name");
  }
  const pem = firstStringByKeys(parsed, [
    "api_private_key_pem",
    "apiPrivateKeyPem",
    "private_key",
    "privateKey",
    "key_secret",
    "keySecret",
    "secret",
  ]) || value.match(/-----BEGIN EC PRIVATE KEY-----[\s\S]+?-----END EC PRIVATE KEY-----/)?.[0] || "";
  if (isEcPrivateKeyPem(pem)) {
    next.api_private_key_pem = normalizePem(pem);
    fields.push("api_private_key_pem");
  }
  const portfolioId = firstStringByKeys(parsed, [
    "portfolio_id",
    "portfolioId",
    "portfolio",
  ]) || "";
  if (portfolioId.trim() && PORTFOLIO_ID_RE.test(portfolioId.trim())) {
    next.portfolio_id = portfolioId.trim();
    fields.push("portfolio_id");
  }
  return {
    draft: next,
    fields: Array.from(new Set(fields)),
  };
}

export async function buildCoinbaseExecutionVaultBundle(
  options: BuildCoinbaseExecutionVaultBundleOptions,
): Promise<BuildCoinbaseExecutionVaultBundleResult> {
  const validationErrors = validateCoinbaseExecutionCredentialDraft(options.credential);
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

  const executionMode = options.executionMode ?? "byo_api_key";
  const associatedData = coinbaseVaultAssociatedData({
    accountCommitment: options.accountCommitment,
    recipientId: recipient.recipient_id,
    executionMode,
    network: options.credential.network,
  });
  const sealedPlaintext = {
    version: 1,
    kind: "ghola_coinbase_advanced_execution_vault",
    network: options.credential.network,
    base_url: options.credential.network === "sandbox"
      ? "https://api-sandbox.coinbase.com/api/v3/brokerage"
      : "https://api.coinbase.com/api/v3/brokerage",
    execution_mode: executionMode,
    api_key_name: options.credential.api_key_name.trim(),
    api_private_key_pem: normalizePem(options.credential.api_private_key_pem),
    portfolio_id: options.credential.portfolio_id?.trim() || null,
    allowed_operations: ["read", "preview_order", "spot_limit_order", "spot_market_order", "cancel", "fills", "reconcile"],
    blocked_operations: ["withdraw", "vault_transfer", "leverage_escalation", "margin", "futures", "staking", "portfolio_mutation", "raw_custody_transfer"],
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
    execution_mode: executionMode,
    encrypted_execution_vault: {
      alg: "sealed-provider-v1",
      ciphertext: bytesToBase64(sealedBytes),
      recipient: recipient.recipient_id,
      aad: associatedData,
    },
  };
}

export function coinbaseVaultAssociatedData(input: {
  accountCommitment: string;
  recipientId: string;
  executionMode: CoinbaseExecutionMode;
  network: CoinbaseAdvancedNetwork;
}) {
  return [
    "ghola/coinbase-advanced-execution-vault-v1",
    `account:${input.accountCommitment}`,
    `recipient:${input.recipientId}`,
    `mode:${input.executionMode}`,
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

function normalizeNetwork(value: string): CoinbaseAdvancedNetwork | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.includes("sandbox") || normalized.includes("test")) return "sandbox";
  if (normalized.includes("mainnet") || normalized.includes("main") || normalized.includes("prod")) return "mainnet";
  return null;
}

function isEcPrivateKeyPem(value: string): boolean {
  const normalized = normalizePem(value);
  return normalized.startsWith("-----BEGIN EC PRIVATE KEY-----") &&
    normalized.endsWith("-----END EC PRIVATE KEY-----") &&
    normalized.split(/\r?\n/).length >= 3;
}

function normalizePem(value: string): string {
  return value.replace(/\\n/g, "\n").trim();
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
