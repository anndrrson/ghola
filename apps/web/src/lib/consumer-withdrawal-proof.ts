import { randomUUID } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";

const PREFIX = "ghola_consumer_withdrawal_v1";
const MAX_SKEW_MS = 5 * 60_000;

export type ConsumerWithdrawalAction = "create" | "cancel";

export function buildConsumerWithdrawalChallenge(input: {
  owner_commitment: string;
  wallet_pubkey: string;
  action: ConsumerWithdrawalAction;
  withdrawal_id?: string | null;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const nonce = randomUUID();
  const withdrawalId = input.action === "cancel" ? input.withdrawal_id?.trim() || "" : "new";
  if (input.action === "cancel" && !validWithdrawalId(withdrawalId)) throw new Error("withdrawal_id_invalid");
  const fields = {
    owner_commitment: input.owner_commitment,
    wallet_pubkey: input.wallet_pubkey,
    action: input.action,
    withdrawal_id: withdrawalId,
    timestamp_ms: now.getTime(),
    nonce,
  };
  return {
    version: 1 as const,
    ...fields,
    message: withdrawalMessage(fields),
    expires_at: new Date(now.getTime() + MAX_SKEW_MS).toISOString(),
  };
}

export function verifyConsumerWithdrawalProof(input: Record<string, unknown>, expected: {
  owner_commitment: string;
  wallet_pubkey: string;
  action: ConsumerWithdrawalAction;
  withdrawal_id?: string | null;
  now_ms?: number;
}): { ok: true; nonce: string; expires_at_ms: number } | { ok: false } {
  const message = typeof input.message === "string" ? input.message.trim() : "";
  const signatureB64 = typeof input.signature_b64 === "string" ? input.signature_b64.trim() : "";
  const parsed = parseWithdrawalMessage(message);
  const expectedWithdrawalId = expected.action === "cancel" ? expected.withdrawal_id?.trim() || "" : "new";
  if (!parsed || parsed.owner_commitment !== expected.owner_commitment || parsed.wallet_pubkey !== expected.wallet_pubkey ||
    parsed.action !== expected.action || parsed.withdrawal_id !== expectedWithdrawalId ||
    Math.abs((expected.now_ms ?? Date.now()) - parsed.timestamp_ms) > MAX_SKEW_MS) return { ok: false };
  try {
    const publicKey = Uint8Array.from(bs58.decode(parsed.wallet_pubkey));
    const signature = Uint8Array.from(Buffer.from(signatureB64, "base64"));
    if (publicKey.length !== 32 || signature.length !== 64 || !ed25519.verify(signature, new TextEncoder().encode(message), publicKey)) return { ok: false };
  } catch {
    return { ok: false };
  }
  return { ok: true, nonce: parsed.nonce, expires_at_ms: parsed.timestamp_ms + MAX_SKEW_MS };
}

function withdrawalMessage(input: {
  owner_commitment: string;
  wallet_pubkey: string;
  action: ConsumerWithdrawalAction;
  withdrawal_id: string;
  timestamp_ms: number;
  nonce: string;
}) {
  return [
    PREFIX,
    `owner_commitment:${input.owner_commitment}`,
    `wallet:${input.wallet_pubkey}`,
    `action:${input.action}`,
    `withdrawal_id:${input.withdrawal_id}`,
    `timestamp_ms:${input.timestamp_ms}`,
    `nonce:${input.nonce}`,
    "purpose:consumer_usdc_withdrawal",
  ].join("\n");
}

function parseWithdrawalMessage(message: string) {
  const lines = message.split("\n");
  if (lines.length !== 8 || lines[0] !== PREFIX || lines[7] !== "purpose:consumer_usdc_withdrawal") return null;
  const ownerCommitment = field(lines[1], "owner_commitment");
  const walletPubkey = field(lines[2], "wallet");
  const action = field(lines[3], "action");
  const withdrawalId = field(lines[4], "withdrawal_id");
  const timestamp = Number(field(lines[5], "timestamp_ms"));
  const nonce = field(lines[6], "nonce");
  if (!ownerCommitment || !validWallet(walletPubkey) || (action !== "create" && action !== "cancel") ||
    (action === "create" ? withdrawalId !== "new" : !validWithdrawalId(withdrawalId)) ||
    !Number.isSafeInteger(timestamp) || !/^[A-Za-z0-9-]{16,80}$/.test(nonce)) return null;
  const parsed = { owner_commitment: ownerCommitment, wallet_pubkey: walletPubkey, action, withdrawal_id: withdrawalId, timestamp_ms: timestamp, nonce } as const;
  return withdrawalMessage(parsed) === message ? parsed : null;
}

function field(line: string, name: string) {
  const prefix = `${name}:`;
  return line.startsWith(prefix) ? line.slice(prefix.length).trim() : "";
}

function validWallet(value: string) {
  try { return bs58.decode(value).length === 32; } catch { return false; }
}

function validWithdrawalId(value: string) {
  return /^[A-Za-z0-9._:-]{8,180}$/.test(value);
}
