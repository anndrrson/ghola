import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { recoverMessageAddress, type Hex } from "viem";
import {
  lighterOwnerRecoveryReadinessMessage,
  type LighterOwnerRecoveryReadinessPayload,
} from "./lighter-owner-recovery";
import { lighterAccountIndex, lighterOwnerAddress } from "./lighter-agent-association";

export const LIGHTER_OWNER_RECOVERY_READINESS_TTL_MS = 2 * 60_000;
const AUDIENCE = "ghola_lighter_owner_recovery_readiness" as const;
const TOKEN_DOMAIN = "ghola-lighter-owner-recovery-readiness-v1";
const OWNER_COMMITMENT = /^owner_[0-9a-f]{48}$/;
const NONCE = /^[0-9a-f]{64}$/;
const PLAN = /^0x[0-9a-f]{64}$/;
const SIGNATURE = /^0x[0-9a-f]{130}$/i;
const TOKEN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const PAYLOAD_KEYS = [
  "account_index",
  "audience",
  "expires_at_ms",
  "issued_at_ms",
  "nonce",
  "owner_address",
  "owner_commitment",
  "plan_commitment",
  "version",
] as const;

export interface LighterOwnerRecoveryReadinessAuthorization {
  challenge_token: string;
  message: string;
  payload: LighterOwnerRecoveryReadinessPayload;
}

export function issueLighterOwnerRecoveryReadiness(input: {
  ownerCommitment: string;
  ownerAddress: string;
  accountIndex: number;
  planCommitment: string;
  secret: string;
  nowMs?: number;
  nonceHex?: string;
}): LighterOwnerRecoveryReadinessAuthorization {
  const now = validTime(input.nowMs ?? Date.now());
  const payload = Object.freeze({
    version: 1 as const,
    audience: AUDIENCE,
    owner_commitment: validOwnerCommitment(input.ownerCommitment),
    owner_address: lighterOwnerAddress(input.ownerAddress),
    account_index: lighterAccountIndex(input.accountIndex),
    plan_commitment: validPlan(input.planCommitment),
    nonce: validNonce(input.nonceHex ?? randomBytes(32).toString("hex")),
    issued_at_ms: now,
    expires_at_ms: now + LIGHTER_OWNER_RECOVERY_READINESS_TTL_MS,
  });
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return Object.freeze({
    challenge_token: `${encoded}.${mac(encoded, validSecret(input.secret))}`,
    message: lighterOwnerRecoveryReadinessMessage(payload),
    payload,
  });
}

export function verifyLighterOwnerRecoveryReadinessToken(input: {
  challengeToken: string;
  ownerCommitment: string;
  ownerAddress: string;
  accountIndex: number;
  planCommitment: string;
  secret: string;
  nowMs?: number;
}): LighterOwnerRecoveryReadinessAuthorization {
  const secret = validSecret(input.secret);
  const token = input.challengeToken;
  if (typeof token !== "string" || token.length > 2_048 || !TOKEN.test(token)) fail("invalid", 403);
  const [encoded, provided] = token.split(".");
  if (!safeEqual(provided, mac(encoded, secret))) fail("invalid", 403);
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    fail("invalid", 403);
  }
  const payload = validPayload(decoded);
  if (
    payload.owner_commitment !== validOwnerCommitment(input.ownerCommitment) ||
    payload.owner_address !== lighterOwnerAddress(input.ownerAddress) ||
    payload.account_index !== lighterAccountIndex(input.accountIndex) ||
    payload.plan_commitment !== validPlan(input.planCommitment)
  ) fail("binding_mismatch", 403);
  const now = validTime(input.nowMs ?? Date.now());
  if (payload.issued_at_ms > now + 5_000) fail("invalid", 403);
  if (payload.expires_at_ms <= now) fail("expired", 403);
  return Object.freeze({
    challenge_token: token,
    message: lighterOwnerRecoveryReadinessMessage(payload),
    payload,
  });
}

export async function verifyLighterOwnerRecoveryReadinessSignature(input: {
  authorization: LighterOwnerRecoveryReadinessAuthorization;
  signature: string;
}) {
  if (typeof input.signature !== "string" || !SIGNATURE.test(input.signature)) fail("signature_invalid", 403);
  let recovered: `0x${string}`;
  try {
    recovered = await recoverMessageAddress({
      message: input.authorization.message,
      signature: input.signature as Hex,
    });
  } catch {
    fail("signature_invalid", 403);
  }
  if (recovered.toLowerCase() !== input.authorization.payload.owner_address) fail("signature_mismatch", 403);
  return recovered.toLowerCase() as `0x${string}`;
}

function validPayload(value: unknown): LighterOwnerRecoveryReadinessPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid", 403);
  const payload = value as Record<string, unknown>;
  if (
    Object.keys(payload).sort().join("\n") !== [...PAYLOAD_KEYS].sort().join("\n") ||
    payload.version !== 1 || payload.audience !== AUDIENCE ||
    !Number.isSafeInteger(payload.issued_at_ms) || !Number.isSafeInteger(payload.expires_at_ms) ||
    Number(payload.expires_at_ms) !== Number(payload.issued_at_ms) + LIGHTER_OWNER_RECOVERY_READINESS_TTL_MS
  ) fail("invalid", 403);
  return Object.freeze({
    version: 1,
    audience: AUDIENCE,
    owner_commitment: validOwnerCommitment(payload.owner_commitment),
    owner_address: lighterOwnerAddress(String(payload.owner_address)),
    account_index: lighterAccountIndex(Number(payload.account_index)),
    plan_commitment: validPlan(payload.plan_commitment),
    nonce: validNonce(payload.nonce),
    issued_at_ms: Number(payload.issued_at_ms),
    expires_at_ms: Number(payload.expires_at_ms),
  });
}

function validOwnerCommitment(value: unknown) {
  if (typeof value !== "string" || !OWNER_COMMITMENT.test(value)) fail("session_invalid", 403);
  return value;
}

function validPlan(value: unknown): Hex {
  if (typeof value !== "string" || !PLAN.test(value)) fail("plan_invalid", 403);
  return value.toLowerCase() as Hex;
}

function validNonce(value: unknown) {
  if (typeof value !== "string" || !NONCE.test(value)) fail("nonce_invalid", 403);
  return value;
}

function validTime(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0) fail("time_invalid", 500);
  return value;
}

function validSecret(value: string) {
  const secret = typeof value === "string" ? value.trim() : "";
  const lowered = secret.toLowerCase();
  if (secret.length < 32 || ["changeme", "example", "placeholder", "default"].some((word) => lowered.includes(word))) {
    fail("unconfigured", 503);
  }
  return secret;
}

function mac(payload: string, secret: string) {
  return createHmac("sha256", secret).update(`${TOKEN_DOMAIN}\n${payload}`).digest("base64url");
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function fail(suffix: string, status: number): never {
  throw Object.assign(new Error(`lighter_recovery_readiness_${suffix}`), {
    code: `lighter_recovery_readiness_${suffix}`,
    status,
  });
}
