import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { didKeyFromVerifying, RecipientKind, seal } from "./envelope";
import {
  chooseConfidentialComputeProvider,
  providerReadyForPrivateAgents,
  type ConfidentialComputeProviderStatus,
  type PrivateAgentRuntimeStatus,
} from "./private-agent-runtime";
import { fetchPrivateAgentRuntimeStatus } from "./hyperliquid-vault-seal";

export type SolanaPerpsVenueId = "phoenix";
export type SolanaPerpsExecutionMode = "user_stealth" | "ghola_pooled";

export interface SolanaPerpsExecutionCredentialDraft {
  venue_id: SolanaPerpsVenueId;
  network: "mainnet";
  authority_private_key: string;
  authority?: string;
  rpc_url?: string;
  api_url?: string;
  trader_pda_index?: string;
  trader_subaccount_index?: string;
}

export interface SolanaPerpsEncryptedExecutionVaultBundle {
  alg: "sealed-provider-v1";
  ciphertext: string;
  recipient: string;
  aad: string;
}

export interface SolanaPerpsCredentialImportResult {
  draft: SolanaPerpsExecutionCredentialDraft;
  fields: Array<
    | "authority_private_key"
    | "authority"
    | "rpc_url"
    | "api_url"
    | "trader_pda_index"
    | "trader_subaccount_index"
  >;
}

export interface BuildSolanaPerpsExecutionVaultBundleOptions {
  accountCommitment: string;
  ownerWalletAddress: string;
  credential: SolanaPerpsExecutionCredentialDraft;
  signBytes: (bytes: Uint8Array) => Promise<Uint8Array>;
  executionMode?: SolanaPerpsExecutionMode;
  runtimeStatus?: PrivateAgentRuntimeStatus;
  fetchRuntimeStatus?: () => Promise<PrivateAgentRuntimeStatus>;
  now?: Date;
}

export interface BuildSolanaPerpsExecutionVaultBundleResult {
  encrypted_execution_vault: SolanaPerpsEncryptedExecutionVaultBundle;
  recipient: ConfidentialComputeProviderStatus["sealed_recipient"];
  associated_data: string;
  execution_mode: SolanaPerpsExecutionMode;
  authority: string;
}

const DEFAULT_DRAFT: SolanaPerpsExecutionCredentialDraft = {
  venue_id: "phoenix",
  network: "mainnet",
  authority_private_key: "",
  authority: "",
  rpc_url: "",
  api_url: "",
  trader_pda_index: "0",
  trader_subaccount_index: "0",
};

const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const URL_RE = /^https:\/\/[^\s]+$/;

export function validateSolanaPerpsExecutionCredentialDraft(
  draft: SolanaPerpsExecutionCredentialDraft,
): string[] {
  const errors: string[] = [];
  if (draft.venue_id !== "phoenix") errors.push("Phoenix is the only live Solana perps venue.");
  if (draft.network !== "mainnet") errors.push("Phoenix live trading uses mainnet.");
  const keypair = tryKeypairFromSecret(draft.authority_private_key);
  if (!keypair) errors.push("Paste a Phoenix trader authority secret key.");
  const authority = keypair?.publicKey.toBase58() || "";
  if (draft.authority?.trim() && draft.authority.trim() !== authority) {
    errors.push("Authority address does not match the secret key.");
  }
  if (draft.rpc_url?.trim() && !URL_RE.test(draft.rpc_url.trim())) {
    errors.push("RPC URL must be an https URL.");
  }
  if (draft.api_url?.trim() && !URL_RE.test(draft.api_url.trim())) {
    errors.push("Phoenix API URL must be an https URL.");
  }
  if (!nonNegativeInteger(draft.trader_pda_index || "0")) {
    errors.push("Trader PDA index must be a non-negative integer.");
  }
  if (!nonNegativeInteger(draft.trader_subaccount_index || "0")) {
    errors.push("Trader subaccount index must be a non-negative integer.");
  }
  return errors;
}

export function parseSolanaPerpsCredentialImport(
  value: string,
  current: SolanaPerpsExecutionCredentialDraft = DEFAULT_DRAFT,
): SolanaPerpsCredentialImportResult {
  const parsed = parseImportValue(value);
  const fields: SolanaPerpsCredentialImportResult["fields"] = [];
  const next: SolanaPerpsExecutionCredentialDraft = { ...current };
  const secret = firstSecretByKeys(parsed, [
    "authority_private_key",
    "authorityPrivateKey",
    "wallet_private_key",
    "walletPrivateKey",
    "secret_key",
    "secretKey",
    "private_key",
    "privateKey",
    "keypair",
  ]) || looksLikeSecret(value);
  if (secret && tryKeypairFromSecret(secret)) {
    next.authority_private_key = secret.trim();
    next.authority = tryKeypairFromSecret(secret)?.publicKey.toBase58() || next.authority;
    fields.push("authority_private_key", "authority");
  }
  const authority = firstStringByKeys(parsed, ["authority", "public_key", "publicKey", "address"]) || "";
  if (SOLANA_ADDRESS_RE.test(authority.trim())) {
    next.authority = authority.trim();
    fields.push("authority");
  }
  const rpcUrl = firstStringByKeys(parsed, ["rpc_url", "rpcUrl", "solana_rpc_url", "solanaRpcUrl"]) || "";
  if (rpcUrl.trim()) {
    next.rpc_url = rpcUrl.trim();
    fields.push("rpc_url");
  }
  const apiUrl = firstStringByKeys(parsed, ["api_url", "apiUrl", "phoenix_api_url", "phoenixApiUrl"]) || "";
  if (apiUrl.trim()) {
    next.api_url = apiUrl.trim();
    fields.push("api_url");
  }
  const pdaIndex = firstStringByKeys(parsed, ["trader_pda_index", "traderPdaIndex"]) || "";
  if (pdaIndex.trim()) {
    next.trader_pda_index = pdaIndex.trim();
    fields.push("trader_pda_index");
  }
  const subaccountIndex = firstStringByKeys(parsed, ["trader_subaccount_index", "traderSubaccountIndex"]) || "";
  if (subaccountIndex.trim()) {
    next.trader_subaccount_index = subaccountIndex.trim();
    fields.push("trader_subaccount_index");
  }
  return {
    draft: next,
    fields: Array.from(new Set(fields)),
  };
}

export async function buildSolanaPerpsExecutionVaultBundle(
  options: BuildSolanaPerpsExecutionVaultBundleOptions,
): Promise<BuildSolanaPerpsExecutionVaultBundleResult> {
  const validationErrors = validateSolanaPerpsExecutionCredentialDraft(options.credential);
  if (validationErrors.length > 0) throw new Error(validationErrors[0]);
  if (!options.accountCommitment.trim()) throw new Error("Private account commitment is unavailable.");
  const keypair = keypairFromSecret(options.credential.authority_private_key);
  const authority = keypair.publicKey.toBase58();
  const runtime = options.runtimeStatus ??
    await (options.fetchRuntimeStatus ?? fetchPrivateAgentRuntimeStatus)();
  const provider = selectedReadyProvider(runtime);
  const recipient = provider?.sealed_recipient;
  if (!recipient) throw new Error("Attested private-agent recipient is unavailable.");
  const recipientX25519 = hexToBytes(recipient.x25519_pub_hex);
  if (recipientX25519.length !== 32) throw new Error("Attested private-agent recipient key is invalid.");
  const ownerDid = solanaAddressToDid(options.ownerWalletAddress);
  if (!ownerDid) throw new Error("Turnkey wallet identity is unavailable.");

  const executionMode = options.executionMode ?? "user_stealth";
  const associatedData = solanaPerpsVaultAssociatedData({
    accountCommitment: options.accountCommitment,
    recipientId: recipient.recipient_id,
    executionMode,
    venueId: "phoenix",
    network: "mainnet",
  });
  const sealedPlaintext = {
    version: 1,
    kind: "ghola_solana_perps_execution_vault",
    venue_id: "phoenix",
    network: "mainnet",
    execution_mode: executionMode,
    authority,
    wallet_private_key: options.credential.authority_private_key.trim(),
    rpc_url: options.credential.rpc_url?.trim() || null,
    api_url: options.credential.api_url?.trim() || null,
    trader_pda_index: Number.parseInt(options.credential.trader_pda_index || "0", 10),
    trader_subaccount_index: Number.parseInt(options.credential.trader_subaccount_index || "0", 10),
    allowed_operations: ["read", "perp_limit_order", "cancel", "fills", "reconcile"],
    blocked_operations: ["withdraw", "vault_transfer", "leverage_escalation", "staking", "raw_custody_transfer"],
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
    authority,
    encrypted_execution_vault: {
      alg: "sealed-provider-v1",
      ciphertext: bytesToBase64(sealedBytes),
      recipient: recipient.recipient_id,
      aad: associatedData,
    },
  };
}

export function solanaPerpsVaultAssociatedData(input: {
  accountCommitment: string;
  recipientId: string;
  executionMode: SolanaPerpsExecutionMode;
  venueId: SolanaPerpsVenueId;
  network: "mainnet";
}) {
  return [
    "ghola/solana-perps-execution-vault-v1",
    `account:${input.accountCommitment}`,
    `recipient:${input.recipientId}`,
    `mode:${input.executionMode}`,
    `network:${input.network}`,
    `venue:${input.venueId}`,
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

function keypairFromSecret(value: string): Keypair {
  const keypair = tryKeypairFromSecret(value);
  if (!keypair) throw new Error("Paste a Phoenix trader authority secret key.");
  return keypair;
}

function tryKeypairFromSecret(value: string | undefined): Keypair | null {
  const bytes = secretBytes(value);
  if (!bytes) return null;
  try {
    if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
    if (bytes.length === 32) return Keypair.fromSeed(bytes);
  } catch {
    return null;
  }
  return null;
}

function secretBytes(value: string | undefined): Uint8Array | null {
  const text = value?.trim();
  if (!text) return null;
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return Uint8Array.from(parsed.map((item) => Number(item)));
    } catch {
      return null;
    }
  }
  const cleanHex = text.startsWith("0x") ? text.slice(2) : text;
  if (/^[0-9a-fA-F]{64}$/.test(cleanHex) || /^[0-9a-fA-F]{128}$/.test(cleanHex)) {
    return hexToBytes(cleanHex);
  }
  try {
    return bs58.decode(text);
  } catch {
    return null;
  }
}

function looksLikeSecret(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("0x")) return trimmed;
  const token = trimmed.match(/[1-9A-HJ-NP-Za-km-z]{32,100}/)?.[0] || "";
  return token;
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

function firstSecretByKeys(value: unknown, keys: string[]): string | null {
  return secretValueToString(firstValueByKeys(value, keys));
}

function secretValueToString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => Number.isInteger(Number(item)) && Number(item) >= 0 && Number(item) <= 255)
  ) {
    return JSON.stringify(value.map((item) => Number(item)));
  }
  return null;
}

function firstStringByKeys(value: unknown, keys: string[]): string | null {
  const found = firstValueByKeys(value, keys);
  return typeof found === "string" && found.trim() ? found.trim() : null;
}

function firstValueByKeys(value: unknown, keys: string[]): unknown {
  const wanted = new Set(keys.map((key) => key.toLowerCase()));
  const seen = new Set<unknown>();
  function visit(node: unknown): unknown {
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
      if (wanted.has(key.toLowerCase())) {
        return child;
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

function nonNegativeInteger(value: string): boolean {
  return /^\d+$/.test(value.trim()) && Number.parseInt(value.trim(), 10) >= 0;
}
