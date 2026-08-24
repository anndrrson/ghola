import bs58 from "bs58";
import { privateKeyToAccount } from "viem/accounts";
import { didKeyFromVerifying, RecipientKind, seal } from "./envelope";
import {
  chooseConfidentialComputeProvider,
  providerReadyForPrivateAgents,
  type ConfidentialComputeProviderStatus,
  type PrivateAgentRuntimeStatus,
} from "./private-agent-runtime";
import { fetchPrivateAgentRuntimeStatus } from "./hyperliquid-vault-seal";

export interface AsterExecutionCredentialDraft {
  user_address: string;
  api_wallet_private_key: string;
  signer_address?: string;
  label?: string;
}

export interface AsterEncryptedExecutionVaultBundle {
  alg: "sealed-provider-v1";
  ciphertext: string;
  recipient: string;
  aad: string;
}

export interface BuildAsterExecutionVaultBundleOptions {
  accountCommitment: string;
  sealingWalletAddress: string;
  credential: AsterExecutionCredentialDraft;
  signBytes: (bytes: Uint8Array) => Promise<Uint8Array>;
  runtimeStatus?: PrivateAgentRuntimeStatus;
  fetchRuntimeStatus?: () => Promise<PrivateAgentRuntimeStatus>;
  now?: Date;
}

export interface BuildAsterExecutionVaultBundleResult {
  encrypted_execution_vault: AsterEncryptedExecutionVaultBundle;
  recipient: ConfidentialComputeProviderStatus["sealed_recipient"];
  associated_data: string;
  signer_address: string;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;
const LABEL = /^[A-Za-z0-9_.:-]{1,64}$/;

export function validateAsterExecutionCredentialDraft(draft: AsterExecutionCredentialDraft): string[] {
  const errors: string[] = [];
  const user = draft.user_address.trim();
  const key = draft.api_wallet_private_key.trim();
  if (!ADDRESS.test(user)) errors.push("Enter the Aster account that holds collateral.");
  if (/\s/.test(key) || !PRIVATE_KEY.test(key)) errors.push("Enter the trade-only Aster API wallet private key.");
  if (draft.signer_address?.trim() && !ADDRESS.test(draft.signer_address.trim())) {
    errors.push("Enter a valid Aster API wallet address.");
  }
  if (draft.label?.trim() && !LABEL.test(draft.label.trim())) errors.push("Aster label is invalid.");
  if (PRIVATE_KEY.test(key) && draft.signer_address?.trim() && ADDRESS.test(draft.signer_address.trim())) {
    try {
      if (privateKeyToAccount(key as `0x${string}`).address.toLowerCase() !== draft.signer_address.trim().toLowerCase()) {
        errors.push("The Aster API wallet address does not match its private key.");
      }
    } catch {
      errors.push("Enter the trade-only Aster API wallet private key.");
    }
  }
  return Array.from(new Set(errors));
}

export async function buildAsterExecutionVaultBundle(
  options: BuildAsterExecutionVaultBundleOptions,
): Promise<BuildAsterExecutionVaultBundleResult> {
  const errors = validateAsterExecutionCredentialDraft(options.credential);
  if (errors.length) throw new Error(errors[0]);
  if (!options.accountCommitment.trim()) throw new Error("Private account commitment is unavailable.");
  const privateKey = options.credential.api_wallet_private_key.trim().toLowerCase() as `0x${string}`;
  const signerAddress = privateKeyToAccount(privateKey).address.toLowerCase();
  const runtime = options.runtimeStatus ?? await (options.fetchRuntimeStatus ?? fetchPrivateAgentRuntimeStatus)();
  const provider = selectedReadyProvider(runtime);
  const recipient = provider?.sealed_recipient;
  if (!recipient) throw new Error("Attested private-agent recipient is unavailable.");
  const recipientX25519 = hexToBytes(recipient.x25519_pub_hex);
  if (recipientX25519.length !== 32) throw new Error("Attested private-agent recipient key is invalid.");
  const senderDid = solanaAddressToDid(options.sealingWalletAddress);
  if (!senderDid) throw new Error("Turnkey sealing identity is unavailable.");
  const associatedData = asterVaultAssociatedData({
    accountCommitment: options.accountCommitment,
    recipientId: recipient.recipient_id,
  });
  const sealedBytes = await seal({
    senderDid,
    recipientId: recipient.recipient_id,
    recipientX25519,
    kind: RecipientKind.ModelBridge,
    associatedData: new TextEncoder().encode(associatedData),
    plaintext: new TextEncoder().encode(JSON.stringify({
      version: 1,
      kind: "ghola_aster_execution_vault",
      network: "mainnet",
      user_address: options.credential.user_address.trim().toLowerCase(),
      signer_address: signerAddress,
      api_wallet_private_key: privateKey,
      label: options.credential.label?.trim() || null,
      allowed_operations: ["read", "limit_order", "cancel", "reconcile"],
      blocked_operations: ["withdraw", "vault_transfer", "leverage_escalation"],
      created_at: (options.now ?? new Date()).toISOString(),
    })),
    signBody: options.signBytes,
  });
  return {
    recipient,
    associated_data: associatedData,
    signer_address: signerAddress,
    encrypted_execution_vault: {
      alg: "sealed-provider-v1",
      ciphertext: bytesToBase64(sealedBytes),
      recipient: recipient.recipient_id,
      aad: associatedData,
    },
  };
}

export function asterVaultAssociatedData(input: { accountCommitment: string; recipientId: string }) {
  return [
    "ghola/aster-execution-vault-v1",
    `account:${input.accountCommitment}`,
    `recipient:${input.recipientId}`,
    "network:mainnet",
  ].join("|");
}

function selectedReadyProvider(runtime: PrivateAgentRuntimeStatus): ConfidentialComputeProviderStatus | null {
  const selected = runtime.selected_provider
    ? runtime.providers.find((provider) => provider.id === runtime.selected_provider && providerReadyForPrivateAgents(provider)) ?? null
    : null;
  return selected ?? chooseConfidentialComputeProvider(runtime.providers, runtime.preferred_provider);
}

function solanaAddressToDid(address: string): string | null {
  try {
    const publicKey = bs58.decode(address);
    return publicKey.length === 32 ? didKeyFromVerifying(publicKey) : null;
  } catch {
    return null;
  }
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2) throw new Error("invalid hex");
  return Uint8Array.from({ length: clean.length / 2 }, (_, index) => Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16));
}

function bytesToBase64(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}
