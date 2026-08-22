import { RecipientKind, seal } from "./envelope";
import type { ConfidentialComputeProviderStatus } from "./private-agent-runtime";

export interface KrakenCredentialDraft {
  api_key: string;
  api_secret_base64: string;
}

export async function buildKrakenExecutionVaultBundle(input: {
  accountCommitment: string;
  ownerDid: string;
  provider: ConfidentialComputeProviderStatus;
  credential: KrakenCredentialDraft;
  signBytes: (bytes: Uint8Array) => Promise<Uint8Array>;
  now?: Date;
}) {
  if (input.credential.api_key.trim().length < 8) throw new Error("Kraken API key is required.");
  if (input.credential.api_secret_base64.trim().length < 16) {
    throw new Error("Kraken API secret is required.");
  }
  const recipient = input.provider.sealed_recipient;
  if (!recipient) throw new Error("Attested private-agent recipient is unavailable.");
  const recipientX25519 = hexToBytes(recipient.x25519_pub_hex);
  if (recipientX25519.length !== 32) throw new Error("Attested recipient key is invalid.");
  const aad = [
    "ghola/kraken-spot-execution-vault-v1",
    `account:${input.accountCommitment}`,
    `recipient:${recipient.recipient_id}`,
  ].join("|");
  const plaintext = {
    version: 1,
    kind: "ghola_kraken_spot_execution_vault",
    api_key: input.credential.api_key.trim(),
    api_secret_base64: input.credential.api_secret_base64.trim(),
    allowed_operations: [
      "query-funds",
      "query-open-trades",
      "query-closed-trades",
      "modify-trades",
      "close-trades",
      "create-ws-token",
    ],
    blocked_operations: [
      "add-funds",
      "withdraw-funds",
      "earn-funds",
      "add-withdraw-address",
      "update-withdraw-address",
    ],
    created_at: (input.now || new Date()).toISOString(),
  };
  const ciphertext = await seal({
    senderDid: input.ownerDid,
    recipientId: recipient.recipient_id,
    recipientX25519,
    kind: RecipientKind.ModelBridge,
    associatedData: new TextEncoder().encode(aad),
    plaintext: new TextEncoder().encode(JSON.stringify(plaintext)),
    signBody: input.signBytes,
  });
  return {
    encrypted_execution_vault: {
      alg: "sealed-provider-v1" as const,
      ciphertext: bytesToBase64(ciphertext),
      recipient: recipient.recipient_id,
      aad,
    },
    recipient,
  };
}

function hexToBytes(value: string): Uint8Array {
  const clean = value.startsWith("0x") ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) throw new Error("Invalid X25519 recipient key.");
  return Uint8Array.from({ length: 32 }, (_, index) =>
    Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16)
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
