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

export const JUPITER_SOL_MINT = "So11111111111111111111111111111111111111112";
export const JUPITER_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export type SolanaSwapVenueId = "jupiter";
export type SolanaSwapExecutionMode = "user_stealth" | "ghola_pooled";

export interface SolanaSwapExecutionCredentialDraft {
  venue_id: SolanaSwapVenueId;
  network: "mainnet";
  authority_private_key: string;
  authority?: string;
  swap_api_url?: string;
  tx_api_url?: string;
}

export interface SolanaSwapEncryptedExecutionVaultBundle {
  alg: "sealed-provider-v1";
  ciphertext: string;
  recipient: string;
  aad: string;
}

export interface BuildSolanaSwapExecutionVaultBundleOptions {
  accountCommitment: string;
  ownerWalletAddress: string;
  credential: SolanaSwapExecutionCredentialDraft;
  signBytes: (bytes: Uint8Array) => Promise<Uint8Array>;
  executionMode?: SolanaSwapExecutionMode;
  runtimeStatus?: PrivateAgentRuntimeStatus;
  fetchRuntimeStatus?: () => Promise<PrivateAgentRuntimeStatus>;
  now?: Date;
}

export interface BuildSolanaSwapExecutionVaultBundleResult {
  encrypted_execution_vault: SolanaSwapEncryptedExecutionVaultBundle;
  recipient: ConfidentialComputeProviderStatus["sealed_recipient"];
  associated_data: string;
  execution_mode: SolanaSwapExecutionMode;
  authority: string;
}

const DEFAULT_DRAFT: SolanaSwapExecutionCredentialDraft = {
  venue_id: "jupiter",
  network: "mainnet",
  authority_private_key: "",
  authority: "",
  swap_api_url: "",
  tx_api_url: "",
};

const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const URL_RE = /^https:\/\/[^\s]+$/;

export function validateSolanaSwapExecutionCredentialDraft(
  draft: SolanaSwapExecutionCredentialDraft,
): string[] {
  const errors: string[] = [];
  if (draft.venue_id !== "jupiter") errors.push("Jupiter is the only live Solana swap venue.");
  if (draft.network !== "mainnet") errors.push("Jupiter live swaps use mainnet.");
  const keypair = tryKeypairFromSecret(draft.authority_private_key);
  if (!keypair) errors.push("Paste a Jupiter swap authority secret key.");
  const authority = keypair?.publicKey.toBase58() || "";
  if (draft.authority?.trim() && draft.authority.trim() !== authority) {
    errors.push("Authority address does not match the secret key.");
  }
  if (draft.swap_api_url?.trim() && !URL_RE.test(draft.swap_api_url.trim())) {
    errors.push("Swap API URL must be an https URL.");
  }
  if (draft.tx_api_url?.trim() && !URL_RE.test(draft.tx_api_url.trim())) {
    errors.push("Transaction API URL must be an https URL.");
  }
  return errors;
}

export function parseSolanaSwapCredentialImport(
  value: string,
  current: SolanaSwapExecutionCredentialDraft = DEFAULT_DRAFT,
) {
  const parsed = parseImportValue(value);
  const next: SolanaSwapExecutionCredentialDraft = { ...current };
  const fields: Array<"authority_private_key" | "authority" | "swap_api_url" | "tx_api_url"> = [];
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
  const swapApiUrl = firstStringByKeys(parsed, ["swap_api_url", "swapApiUrl", "api_url", "apiUrl"]) || "";
  if (swapApiUrl.trim()) {
    next.swap_api_url = swapApiUrl.trim();
    fields.push("swap_api_url");
  }
  const txApiUrl = firstStringByKeys(parsed, ["tx_api_url", "txApiUrl"]) || "";
  if (txApiUrl.trim()) {
    next.tx_api_url = txApiUrl.trim();
    fields.push("tx_api_url");
  }
  return { draft: next, fields: Array.from(new Set(fields)) };
}

export async function buildSolanaSwapExecutionVaultBundle(
  options: BuildSolanaSwapExecutionVaultBundleOptions,
): Promise<BuildSolanaSwapExecutionVaultBundleResult> {
  const validationErrors = validateSolanaSwapExecutionCredentialDraft(options.credential);
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
  const associatedData = solanaSwapVaultAssociatedData({
    accountCommitment: options.accountCommitment,
    recipientId: recipient.recipient_id,
    executionMode,
    venueId: "jupiter",
    network: "mainnet",
  });
  const sealedPlaintext = {
    version: 1,
    kind: "ghola_solana_swap_execution_vault",
    venue_id: "jupiter",
    network: "mainnet",
    execution_mode: executionMode,
    authority,
    wallet_private_key: options.credential.authority_private_key.trim(),
    swap_api_url: options.credential.swap_api_url?.trim() || null,
    tx_api_url: options.credential.tx_api_url?.trim() || null,
    allowed_operations: ["read", "preview_order", "swap", "reconcile"],
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

export function solanaSwapVaultAssociatedData(input: {
  accountCommitment: string;
  recipientId: string;
  executionMode: SolanaSwapExecutionMode;
  venueId: SolanaSwapVenueId;
  network: "mainnet";
}) {
  return [
    "ghola/solana-swap-execution-vault-v1",
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
  if (!keypair) throw new Error("Paste a Jupiter swap authority secret key.");
  return keypair;
}

function tryKeypairFromSecret(value: string | undefined): Keypair | null {
  const text = value?.trim();
  if (!text) return null;
  try {
    if (text.startsWith("[")) {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return Keypair.fromSecretKey(Uint8Array.from(parsed.map((item) => Number(item))));
    }
    const cleanHex = text.startsWith("0x") ? text.slice(2) : text;
    if (/^[0-9a-fA-F]{64}$/.test(cleanHex)) return Keypair.fromSeed(Uint8Array.from(Buffer.from(cleanHex, "hex")));
    if (/^[0-9a-fA-F]{128}$/.test(cleanHex)) return Keypair.fromSecretKey(Uint8Array.from(Buffer.from(cleanHex, "hex")));
    const decoded = bs58.decode(text);
    if (decoded.length === 32) return Keypair.fromSeed(decoded);
    if (decoded.length === 64) return Keypair.fromSecretKey(decoded);
    return null;
  } catch {
    return null;
  }
}

function parseImportValue(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function firstSecretByKeys(value: unknown, keys: string[]): string {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const found = record[key];
    if (typeof found === "string" && found.trim()) return found;
    if (Array.isArray(found)) return JSON.stringify(found);
  }
  return "";
}

function firstStringByKeys(value: unknown, keys: string[]): string {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const found = record[key];
    if (typeof found === "string" && found.trim()) return found;
  }
  return "";
}

function looksLikeSecret(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.startsWith("[") ||
    /^[1-9A-HJ-NP-Za-km-z]{80,100}$/.test(trimmed) ||
    /^(0x)?[0-9a-fA-F]{64}$/.test(trimmed) ||
    /^(0x)?[0-9a-fA-F]{128}$/.test(trimmed)
  ) {
    return trimmed;
  }
  return "";
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
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2 !== 0) throw new Error("invalid hex");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToBase64(bytes: Uint8Array) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
