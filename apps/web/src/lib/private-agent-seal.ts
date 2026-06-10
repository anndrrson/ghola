import { seal, RecipientKind } from "./envelope";
import {
  hashTradingStrategyValue,
  type TradingStrategyRecord,
} from "./trading-strategy";
import type {
  ConfidentialComputeProviderId,
  ConfidentialComputeProviderStatus,
} from "./private-agent-runtime";
import type { PrivateAgentSessionRequestV1 } from "./private-agent-session";

export interface BuildPrivateAgentSessionRequestOptions {
  record: TradingStrategyRecord;
  ownerDid: string;
  provider: ConfidentialComputeProviderStatus;
  signBytes: (bytes: Uint8Array) => Promise<Uint8Array>;
}

export interface BuildPrivateAgentSessionRequestResult {
  request: PrivateAgentSessionRequestV1;
  sealed_request_b64: string;
  associated_data: string;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2 !== 0) {
    throw new Error("sealed recipient X25519 key must be even-length hex");
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

function providerIdForRequest(
  id: ConfidentialComputeProviderId,
): ConfidentialComputeProviderId {
  return id;
}

export function privateAgentAssociatedData(input: {
  strategyId: string;
  policyHash: string;
  providerId: ConfidentialComputeProviderId;
  recipientId: string;
}): string {
  return [
    "ghola-private-agent-session-v1",
    `strategy:${input.strategyId}`,
    `policy:${input.policyHash}`,
    `provider:${input.providerId}`,
    `recipient:${input.recipientId}`,
  ].join("|");
}

export async function buildPrivateAgentSessionRequest(
  options: BuildPrivateAgentSessionRequestOptions,
): Promise<BuildPrivateAgentSessionRequestResult> {
  const sealedRecipient = options.provider.sealed_recipient;
  if (!sealedRecipient) {
    throw new Error("Selected provider did not publish a sealed recipient.");
  }
  if (options.record.policy.mode !== "capped_session_key") {
    throw new Error("Private agent sessions require a capped session-key policy.");
  }

  const recipientX25519 = hexToBytes(sealedRecipient.x25519_pub_hex);
  if (recipientX25519.length !== 32) {
    throw new Error("Sealed recipient X25519 key must be 32 bytes.");
  }

  const providerId = providerIdForRequest(options.provider.id);
  const policyHash = hashTradingStrategyValue(options.record.policy);
  const associatedData = privateAgentAssociatedData({
    strategyId: options.record.id,
    policyHash,
    providerId,
    recipientId: sealedRecipient.recipient_id,
  });
  const sealedPlaintext = {
    version: 1,
    kind: "ghola_private_agent_strategy",
    strategy_id: options.record.id,
    source: options.record.source,
    policy: options.record.policy,
    review_summary: options.record.review_summary,
    created_at: new Date().toISOString(),
  };

  const sealedBytes = await seal({
    senderDid: options.ownerDid,
    recipientId: sealedRecipient.recipient_id,
    recipientX25519,
    kind: RecipientKind.ModelBridge,
    associatedData: new TextEncoder().encode(associatedData),
    plaintext: new TextEncoder().encode(JSON.stringify(sealedPlaintext)),
    signBody: options.signBytes,
  });
  const sealedB64 = bytesToBase64(sealedBytes);

  return {
    sealed_request_b64: sealedB64,
    associated_data: associatedData,
    request: {
      version: 1,
      strategy_id: options.record.id,
      policy_hash: policyHash,
      owner_did: options.ownerDid,
      mode: "capped_session_key",
      requested_provider: providerId,
      encrypted_strategy_bundle: {
        alg: "sealed-provider-v1",
        ciphertext: sealedB64,
        recipient: sealedRecipient.recipient_id,
        aad: associatedData,
      },
    },
  };
}
