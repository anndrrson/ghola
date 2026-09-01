import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getAddress, isAddress, recoverMessageAddress, type Hex } from "viem";

export const LIGHTER_DEPOSIT_AUTHORIZATION_TTL_MS = 2 * 60_000;
export const LIGHTER_DEPOSIT_SOURCE_CHAIN_ID = 8453;
export const LIGHTER_DEPOSIT_SOURCE_CHAIN = "base";
export const LIGHTER_DEPOSIT_SOURCE_ASSET = "USDC";
export const LIGHTER_DEPOSIT_DESTINATION_MARKET = "perps";
export const LIGHTER_DEPOSIT_AUTHORIZATION_AUDIENCE = "ghola_lighter_uda_create";

const TOKEN_DOMAIN = "ghola-lighter-uda-authorization-v1";
const FUTURE_CLOCK_TOLERANCE_MS = 5_000;
const NONCE_PATTERN = /^[0-9a-f]{64}$/;
const OWNER_COMMITMENT_PATTERN = /^owner_[0-9a-f]{48}$/;
const SIGNATURE_PATTERN = /^0x[0-9a-fA-F]{130}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

const PAYLOAD_KEYS = [
  "audience",
  "destination_market",
  "expires_at_ms",
  "issued_at_ms",
  "nonce",
  "owner_address",
  "owner_commitment",
  "source_asset",
  "source_chain_id",
  "version",
] as const;

export type LighterDepositAuthorizationPayload = Readonly<{
  version: 1;
  audience: typeof LIGHTER_DEPOSIT_AUTHORIZATION_AUDIENCE;
  owner_commitment: string;
  owner_address: `0x${string}`;
  nonce: string;
  issued_at_ms: number;
  expires_at_ms: number;
  source_chain_id: typeof LIGHTER_DEPOSIT_SOURCE_CHAIN_ID;
  source_asset: typeof LIGHTER_DEPOSIT_SOURCE_ASSET;
  destination_market: typeof LIGHTER_DEPOSIT_DESTINATION_MARKET;
}>;

export type LighterDepositAuthorization = Readonly<{
  challenge_token: string;
  message: string;
  payload: LighterDepositAuthorizationPayload;
}>;

export function issueLighterDepositAuthorization(input: {
  ownerAddress: string;
  ownerCommitment: string;
  secret: string;
  nowMs?: number;
  nonceHex?: string;
}): LighterDepositAuthorization {
  const secret = validatedSecret(input.secret);
  const nowMs = validatedTime(input.nowMs ?? Date.now());
  const ownerAddress = validatedOwnerAddress(input.ownerAddress);
  const ownerCommitment = validatedOwnerCommitment(input.ownerCommitment);
  const nonce = input.nonceHex ?? randomBytes(32).toString("hex");
  if (!NONCE_PATTERN.test(nonce)) {
    throw lighterDepositAuthorizationError("lighter_uda_authorization_nonce_invalid", 500);
  }
  const payload = Object.freeze({
    version: 1 as const,
    audience: LIGHTER_DEPOSIT_AUTHORIZATION_AUDIENCE,
    owner_commitment: ownerCommitment,
    owner_address: ownerAddress,
    nonce,
    issued_at_ms: nowMs,
    expires_at_ms: nowMs + LIGHTER_DEPOSIT_AUTHORIZATION_TTL_MS,
    source_chain_id: LIGHTER_DEPOSIT_SOURCE_CHAIN_ID,
    source_asset: LIGHTER_DEPOSIT_SOURCE_ASSET,
    destination_market: LIGHTER_DEPOSIT_DESTINATION_MARKET,
  });
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return Object.freeze({
    challenge_token: `${encoded}.${tokenMac(encoded, secret)}`,
    message: lighterDepositAuthorizationMessage(payload),
    payload,
  });
}

export function verifyLighterDepositAuthorizationToken(input: {
  challengeToken: string;
  ownerCommitment: string;
  secret: string;
  nowMs?: number;
}): LighterDepositAuthorization {
  const secret = validatedSecret(input.secret);
  const ownerCommitment = validatedOwnerCommitment(input.ownerCommitment);
  const nowMs = validatedTime(input.nowMs ?? Date.now());
  const token = input.challengeToken;
  if (typeof token !== "string" || token.length < 80 || token.length > 4_096 || !TOKEN_PATTERN.test(token)) {
    throw lighterDepositAuthorizationError("lighter_uda_authorization_invalid", 403);
  }
  const [encoded, providedMac] = token.split(".");
  const expectedMac = tokenMac(encoded, secret);
  if (!safeEqual(providedMac, expectedMac)) {
    throw lighterDepositAuthorizationError("lighter_uda_authorization_invalid", 403);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw lighterDepositAuthorizationError("lighter_uda_authorization_invalid", 403);
  }
  const payload = validatedPayload(raw);
  if (payload.owner_commitment !== ownerCommitment) {
    throw lighterDepositAuthorizationError("lighter_uda_authorization_session_mismatch", 403);
  }
  if (payload.issued_at_ms > nowMs + FUTURE_CLOCK_TOLERANCE_MS) {
    throw lighterDepositAuthorizationError("lighter_uda_authorization_invalid", 403);
  }
  if (payload.expires_at_ms <= nowMs) {
    throw lighterDepositAuthorizationError("lighter_uda_authorization_expired", 403);
  }
  return Object.freeze({
    challenge_token: token,
    message: lighterDepositAuthorizationMessage(payload),
    payload,
  });
}

export async function verifyLighterDepositAuthorizationSignature(input: {
  authorization: LighterDepositAuthorization;
  signature: string;
}) {
  if (typeof input.signature !== "string" || !SIGNATURE_PATTERN.test(input.signature)) {
    throw lighterDepositAuthorizationError("lighter_uda_owner_signature_invalid", 403);
  }
  let recovered: `0x${string}`;
  try {
    recovered = await recoverMessageAddress({
      message: input.authorization.message,
      signature: input.signature as Hex,
    });
  } catch {
    throw lighterDepositAuthorizationError("lighter_uda_owner_signature_invalid", 403);
  }
  if (recovered.toLowerCase() !== input.authorization.payload.owner_address.toLowerCase()) {
    throw lighterDepositAuthorizationError("lighter_uda_owner_signature_mismatch", 403);
  }
  return input.authorization.payload.owner_address;
}

export function lighterDepositAuthorizationMessage(payload: LighterDepositAuthorizationPayload) {
  return [
    "Ghola Lighter deposit address authorization",
    "Version: 1",
    "Action: create_lighter_uda",
    `Ghola owner: ${payload.owner_commitment}`,
    `Owner wallet: ${payload.owner_address}`,
    "Network: mainnet",
    `Source chain: Base (${LIGHTER_DEPOSIT_SOURCE_CHAIN_ID})`,
    `Source asset: ${LIGHTER_DEPOSIT_SOURCE_ASSET}`,
    "Destination: Lighter perps",
    `Nonce: ${payload.nonce}`,
    `Issued at: ${new Date(payload.issued_at_ms).toISOString()}`,
    `Expires at: ${new Date(payload.expires_at_ms).toISOString()}`,
    "This authorizes address generation only.",
    "It does not authorize a transfer, withdrawal, or trade.",
  ].join("\n");
}

function validatedPayload(value: unknown): LighterDepositAuthorizationPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw lighterDepositAuthorizationError("lighter_uda_authorization_invalid", 403);
  }
  const payload = value as Record<string, unknown>;
  if (
    Object.keys(payload).sort().join("\n") !== [...PAYLOAD_KEYS].sort().join("\n") ||
    payload.version !== 1 ||
    payload.audience !== LIGHTER_DEPOSIT_AUTHORIZATION_AUDIENCE ||
    payload.source_chain_id !== LIGHTER_DEPOSIT_SOURCE_CHAIN_ID ||
    payload.source_asset !== LIGHTER_DEPOSIT_SOURCE_ASSET ||
    payload.destination_market !== LIGHTER_DEPOSIT_DESTINATION_MARKET ||
    !NONCE_PATTERN.test(String(payload.nonce)) ||
    !Number.isSafeInteger(payload.issued_at_ms) ||
    !Number.isSafeInteger(payload.expires_at_ms) ||
    (payload.expires_at_ms as number) !== (payload.issued_at_ms as number) + LIGHTER_DEPOSIT_AUTHORIZATION_TTL_MS
  ) {
    throw lighterDepositAuthorizationError("lighter_uda_authorization_invalid", 403);
  }
  return Object.freeze({
    version: 1,
    audience: LIGHTER_DEPOSIT_AUTHORIZATION_AUDIENCE,
    owner_commitment: validatedOwnerCommitment(payload.owner_commitment),
    owner_address: validatedOwnerAddress(payload.owner_address),
    nonce: payload.nonce as string,
    issued_at_ms: payload.issued_at_ms as number,
    expires_at_ms: payload.expires_at_ms as number,
    source_chain_id: LIGHTER_DEPOSIT_SOURCE_CHAIN_ID,
    source_asset: LIGHTER_DEPOSIT_SOURCE_ASSET,
    destination_market: LIGHTER_DEPOSIT_DESTINATION_MARKET,
  });
}

function validatedOwnerAddress(value: unknown): `0x${string}` {
  if (typeof value !== "string" || !isAddress(value, { strict: true })) {
    throw lighterDepositAuthorizationError("lighter_uda_owner_address_invalid", 400);
  }
  return getAddress(value);
}

function validatedOwnerCommitment(value: unknown) {
  if (typeof value !== "string" || !OWNER_COMMITMENT_PATTERN.test(value)) {
    throw lighterDepositAuthorizationError("lighter_uda_owner_commitment_invalid", 403);
  }
  return value;
}

function validatedTime(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw lighterDepositAuthorizationError("lighter_uda_authorization_time_invalid", 500);
  }
  return value;
}

function validatedSecret(value: string) {
  const secret = typeof value === "string" ? value.trim() : "";
  const lowered = secret.toLowerCase();
  if (
    secret.length < 32 ||
    ["changeme", "example", "placeholder", "default"].some((marker) => lowered.includes(marker))
  ) {
    throw lighterDepositAuthorizationError("lighter_uda_authorization_unconfigured", 503);
  }
  return secret;
}

function tokenMac(encodedPayload: string, secret: string) {
  return createHmac("sha256", secret)
    .update(`${TOKEN_DOMAIN}\n${encodedPayload}`)
    .digest("base64url");
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

// The token is stateless, but the destination route consumes its scope through a
// durable one-shot owner ledger. Replays can only return the original verified
// destination or remain locked; they cannot dispatch another provider request.
export function lighterDepositAuthorizationError(code: string, status: number) {
  return Object.assign(new Error(code), { code, status });
}
