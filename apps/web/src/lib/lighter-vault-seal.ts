import bs58 from "bs58";
import { didKeyFromVerifying, RecipientKind, seal } from "./envelope";
import {
  chooseConfidentialComputeProvider,
  providerReadyForPrivateAgents,
  type ConfidentialComputeProviderStatus,
  type PrivateAgentRuntimeStatus,
} from "./private-agent-runtime";
import { fetchPrivateAgentRuntimeStatus } from "./hyperliquid-vault-seal";

export interface LighterExecutionCredentialDraft {
  account_index: string;
  api_key_index: string;
  api_private_key: string;
}

export interface LighterEncryptedExecutionVaultBundle {
  alg: "sealed-provider-v1";
  ciphertext: string;
  recipient: string;
  aad: string;
}

export interface BuildLighterExecutionVaultBundleOptions {
  accountCommitment: string;
  sealingWalletAddress: string;
  credential: LighterExecutionCredentialDraft;
  signBytes: (bytes: Uint8Array) => Promise<Uint8Array>;
  runtimeStatus?: PrivateAgentRuntimeStatus;
  fetchRuntimeStatus?: () => Promise<PrivateAgentRuntimeStatus>;
  now?: Date;
}

export function validateLighterExecutionCredentialDraft(draft: LighterExecutionCredentialDraft): string[] {
  const errors: string[] = [];
  if (!nonnegativeInteger(draft.account_index)) errors.push("Enter your Lighter account index.");
  if (!nonnegativeInteger(draft.api_key_index)) errors.push("Enter the Lighter API key index.");
  if (!/^(?:0x)?[0-9a-fA-F]{64}$/.test(draft.api_private_key.trim())) errors.push("Enter the 32-byte Lighter API private key.");
  return errors;
}

export async function buildLighterExecutionVaultBundle(options: BuildLighterExecutionVaultBundleOptions): Promise<{
  encrypted_execution_vault: LighterEncryptedExecutionVaultBundle;
  recipient: ConfidentialComputeProviderStatus["sealed_recipient"];
  associated_data: string;
}> {
  const errors = validateLighterExecutionCredentialDraft(options.credential);
  if (errors.length) throw new Error(errors[0]);
  if (!options.accountCommitment.trim()) throw new Error("Private account commitment is unavailable.");
  const runtime = options.runtimeStatus ?? await (options.fetchRuntimeStatus ?? fetchPrivateAgentRuntimeStatus)();
  const provider = selectedReadyProvider(runtime);
  const recipient = provider?.sealed_recipient;
  if (!recipient) throw new Error("Attested private-agent recipient is unavailable.");
  const recipientX25519 = hexToBytes(recipient.x25519_pub_hex);
  if (recipientX25519.length !== 32) throw new Error("Attested private-agent recipient key is invalid.");
  const senderDid = solanaAddressToDid(options.sealingWalletAddress);
  if (!senderDid) throw new Error("Turnkey sealing identity is unavailable.");
  const associatedData = lighterVaultAssociatedData({
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
      kind: "ghola_lighter_execution_vault",
      network: "mainnet",
      account_index: Number(options.credential.account_index),
      api_key_index: Number(options.credential.api_key_index),
      api_private_key: options.credential.api_private_key.trim().replace(/^0x/, "").toLowerCase(),
      permissions: {
        can_read: true,
        can_trade: true,
        can_withdraw: false,
        can_transfer: false,
      },
      allowed_operations: ["read", "limit_order", "cancel", "reconcile"],
      owner_only_operations: ["withdraw", "transfer", "leverage", "margin", "account_config", "api_key_rotation"],
      venue_native_trade_only: false,
      created_at: (options.now ?? new Date()).toISOString(),
    })),
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

export function lighterVaultAssociatedData(input: { accountCommitment: string; recipientId: string }) {
  return [
    "ghola/lighter-execution-vault-v1",
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

function nonnegativeInteger(value: string): boolean {
  return /^\d+$/.test(value.trim()) && Number.isSafeInteger(Number(value)) && Number(value) >= 0;
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
