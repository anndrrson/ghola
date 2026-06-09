import { createHash, randomUUID } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import { gholaCommitment } from "./private-account";
import type { PrivateMobileWalletBindingRecordV1 } from "./private-account-store";

const WALLET_BINDING_PURPOSE = "private_account_live_agent_wallet_binding";
const WALLET_BINDING_PREFIX = "ghola_private_account_wallet_binding_v1";

export interface PrivateMobileWalletBindingChallenge {
  version: 1;
  wallet_pubkey: string;
  message: string;
  timestamp_ms: string;
  nonce: string;
  expires_at: string;
}

export function normalizeMobileWalletPubkey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const wallet = value.trim();
  if (!wallet) return null;
  try {
    return bs58.decode(wallet).length === 32 ? wallet : null;
  } catch {
    return null;
  }
}

export function mobileWalletCommitment(walletPubkey: string): string {
  return gholaCommitment("mobile_wallet", walletPubkey);
}

export function privateMobileWalletBindingChallenge(input: {
  owner_commitment: string;
  wallet_pubkey: string;
  now?: Date;
  ttl_ms?: number;
  nonce?: string;
}): PrivateMobileWalletBindingChallenge {
  const now = input.now ?? new Date();
  const timestamp = String(now.getTime());
  const nonce = input.nonce ?? randomUUID();
  const ttlMs = input.ttl_ms ?? 5 * 60_000;
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  return {
    version: 1,
    wallet_pubkey: input.wallet_pubkey,
    message: privateMobileWalletBindingMessage({
      owner_commitment: input.owner_commitment,
      wallet_pubkey: input.wallet_pubkey,
      timestamp,
      nonce,
    }),
    timestamp_ms: timestamp,
    nonce,
    expires_at: expiresAt,
  };
}

export function privateMobileWalletBindingMessage(input: {
  owner_commitment: string;
  wallet_pubkey: string;
  timestamp: string;
  nonce: string;
}) {
  return [
    WALLET_BINDING_PREFIX,
    `owner_commitment:${input.owner_commitment}`,
    `wallet:${input.wallet_pubkey}`,
    `timestamp_ms:${input.timestamp}`,
    `nonce:${input.nonce}`,
    `purpose:${WALLET_BINDING_PURPOSE}`,
  ].join("\n");
}

export function verifyPrivateMobileWalletBindingProof(input: {
  owner_commitment: string;
  wallet_pubkey: string;
  message: string;
  signature_b64: string;
  max_skew_ms: number;
  now_ms?: number;
}):
  | { ok: true; timestampMs: number; nonce: string; proof_commitment: string }
  | { ok: false; error: "mobile_wallet_binding_invalid" | "mobile_wallet_binding_stale"; status: number } {
  const wallet = normalizeMobileWalletPubkey(input.wallet_pubkey);
  if (!wallet || typeof input.message !== "string" || !input.message || !input.signature_b64) {
    return { ok: false, error: "mobile_wallet_binding_invalid", status: 403 };
  }
  const parsed = parseBindingMessage(input.message);
  if (
    !parsed ||
    parsed.owner_commitment !== input.owner_commitment ||
    parsed.wallet_pubkey !== wallet ||
    parsed.message !== input.message
  ) {
    return { ok: false, error: "mobile_wallet_binding_invalid", status: 403 };
  }
  if (
    !Number.isFinite(parsed.timestampMs) ||
    Math.abs((input.now_ms ?? Date.now()) - parsed.timestampMs) > input.max_skew_ms
  ) {
    return { ok: false, error: "mobile_wallet_binding_stale", status: 403 };
  }

  let signature: Uint8Array;
  let publicKey: Uint8Array;
  try {
    publicKey = Uint8Array.from(bs58.decode(wallet));
    signature = Uint8Array.from(Buffer.from(input.signature_b64, "base64"));
  } catch {
    return { ok: false, error: "mobile_wallet_binding_invalid", status: 403 };
  }
  if (publicKey.length !== 32 || signature.length !== 64) {
    return { ok: false, error: "mobile_wallet_binding_invalid", status: 403 };
  }
  const verified = ed25519.verify(signature, new TextEncoder().encode(input.message), publicKey);
  if (!verified) return { ok: false, error: "mobile_wallet_binding_invalid", status: 403 };
  return {
    ok: true,
    timestampMs: parsed.timestampMs,
    nonce: parsed.nonce,
    proof_commitment: gholaCommitment("mobile_wallet_binding_proof", {
      message_hash: createHash("sha256").update(input.message).digest("hex"),
      signature_hash: createHash("sha256").update(input.signature_b64).digest("hex"),
    }),
  };
}

export function privateMobileWalletBindingRecord(input: {
  owner_commitment: string;
  wallet_pubkey: string;
  proof_commitment: string;
  now?: Date;
}): PrivateMobileWalletBindingRecordV1 {
  const now = (input.now ?? new Date()).toISOString();
  const wallet_commitment = mobileWalletCommitment(input.wallet_pubkey);
  return {
    version: 1,
    owner_commitment: input.owner_commitment,
    binding_commitment: gholaCommitment("mobile_wallet_binding", {
      owner_commitment: input.owner_commitment,
      wallet_commitment,
    }),
    wallet_commitment,
    status: "active",
    proof_commitment: input.proof_commitment,
    created_at: now,
    updated_at: now,
  };
}

function parseBindingMessage(message: string): {
  owner_commitment: string;
  wallet_pubkey: string;
  timestampMs: number;
  nonce: string;
  message: string;
} | null {
  const lines = message.split("\n");
  if (lines.length !== 6 || lines[0] !== WALLET_BINDING_PREFIX) return null;
  const owner = field(lines[1], "owner_commitment");
  const wallet = field(lines[2], "wallet");
  const timestamp = field(lines[3], "timestamp_ms");
  const nonce = field(lines[4], "nonce");
  const purpose = field(lines[5], "purpose");
  if (
    !owner ||
    !wallet ||
    !timestamp ||
    !nonce ||
    purpose !== WALLET_BINDING_PURPOSE ||
    !/^[A-Za-z0-9._:-]{8,128}$/.test(nonce)
  ) {
    return null;
  }
  const normalizedWallet = normalizeMobileWalletPubkey(wallet);
  if (!normalizedWallet) return null;
  const canonical = privateMobileWalletBindingMessage({
    owner_commitment: owner,
    wallet_pubkey: normalizedWallet,
    timestamp,
    nonce,
  });
  if (canonical !== message) return null;
  return {
    owner_commitment: owner,
    wallet_pubkey: normalizedWallet,
    timestampMs: Number.parseInt(timestamp, 10),
    nonce,
    message,
  };
}

function field(line: string, key: string): string | null {
  const prefix = `${key}:`;
  return line.startsWith(prefix) ? line.slice(prefix.length).trim() : null;
}
