import { createHash, randomUUID } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import { gholaCommitment } from "@/lib/private-account";
import {
  workerAuthorizationHeader,
  workerCapabilityExpectedFromBody,
} from "@/lib/private-agent-capability";

const PUBLIC_LIVE_PREFIX = "ghola_public_live_v1";
const PUBLIC_LIVE_PURPOSE = "phoenix_pooled_live_trade";
const PUBLIC_LIVE_MAX_SKEW_MS = 5 * 60_000;
const PUBLIC_LIVE_MAX_ORDER_COUNT = 3;
const PUBLIC_LIVE_MAX_NOTIONAL_BUCKET = "5";

const publicLiveNonces = new Map<string, number>();

export interface PublicLivePhoenixChallenge {
  version: 1;
  venue_id: "phoenix";
  platform_class: "solana_perps_market";
  execution_mode: "ghola_pooled";
  wallet_pubkey: string;
  wallet_commitment: string;
  owner_commitment: string;
  message: string;
  timestamp_ms: string;
  nonce: string;
  expires_at: string;
}

export type PublicLiveWalletProofInput = {
  wallet_pubkey?: unknown;
  message?: unknown;
  signature_b64?: unknown;
};

export interface PublicLiveWalletProofOk {
  wallet_pubkey: string;
  wallet_commitment: string;
  owner_commitment: string;
  proof_commitment: string;
  timestamp_ms: number;
  nonce: string;
}

export interface PublicLivePhoenixSubmitInput extends PublicLiveWalletProofInput {
  work_order_commitment?: unknown;
  encrypted_execution_instruction_bundle?: unknown;
  allocation_commitment?: unknown;
  policy_commitment?: unknown;
  ack_live_order?: unknown;
}

export function normalizePublicLiveWalletPubkey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const wallet = value.trim();
  if (!wallet) return null;
  try {
    return bs58.decode(wallet).length === 32 ? wallet : null;
  } catch {
    return null;
  }
}

export function publicLiveWalletCommitment(walletPubkey: string): string {
  return gholaCommitment("public_live_wallet", walletPubkey);
}

export function publicLiveOwnerCommitment(walletPubkey: string): string {
  return gholaCommitment("public_live_owner", {
    venue_id: "phoenix",
    wallet_commitment: publicLiveWalletCommitment(walletPubkey),
  });
}

export function buildPublicLivePhoenixChallenge(input: {
  wallet_pubkey: string;
  now?: Date;
  nonce?: string;
  ttl_ms?: number;
}): PublicLivePhoenixChallenge | { error: "wallet_pubkey_invalid" } {
  const wallet = normalizePublicLiveWalletPubkey(input.wallet_pubkey);
  if (!wallet) return { error: "wallet_pubkey_invalid" };
  const now = input.now ?? new Date();
  const timestamp = String(now.getTime());
  const ttlMs = input.ttl_ms ?? PUBLIC_LIVE_MAX_SKEW_MS;
  const nonce = input.nonce ?? randomUUID();
  const ownerCommitment = publicLiveOwnerCommitment(wallet);
  return {
    version: 1,
    venue_id: "phoenix",
    platform_class: "solana_perps_market",
    execution_mode: "ghola_pooled",
    wallet_pubkey: wallet,
    wallet_commitment: publicLiveWalletCommitment(wallet),
    owner_commitment: ownerCommitment,
    timestamp_ms: timestamp,
    nonce,
    expires_at: new Date(now.getTime() + ttlMs).toISOString(),
    message: publicLivePhoenixMessage({
      wallet_pubkey: wallet,
      owner_commitment: ownerCommitment,
      timestamp_ms: timestamp,
      nonce,
    }),
  };
}

export function verifyPublicLiveWalletProof(
  input: PublicLiveWalletProofInput,
  options: { nowMs?: number; consumeNonce?: boolean } = {},
):
  | { ok: true; proof: PublicLiveWalletProofOk }
  | {
      ok: false;
      error:
        | "public_live_wallet_invalid"
        | "public_live_wallet_proof_invalid"
        | "public_live_wallet_proof_stale"
        | "public_live_wallet_proof_replayed";
      status: number;
    } {
  const wallet = normalizePublicLiveWalletPubkey(input.wallet_pubkey);
  const message = typeof input.message === "string" ? input.message.trim() : "";
  const signatureB64 = typeof input.signature_b64 === "string" ? input.signature_b64.trim() : "";
  if (!wallet) return { ok: false, error: "public_live_wallet_invalid", status: 400 };
  if (!message || !signatureB64) {
    return { ok: false, error: "public_live_wallet_proof_invalid", status: 403 };
  }
  const parsed = parsePublicLivePhoenixMessage(message);
  if (
    !parsed ||
    parsed.wallet_pubkey !== wallet ||
    parsed.owner_commitment !== publicLiveOwnerCommitment(wallet) ||
    parsed.message !== message
  ) {
    return { ok: false, error: "public_live_wallet_proof_invalid", status: 403 };
  }
  if (
    !Number.isFinite(parsed.timestampMs) ||
    Math.abs((options.nowMs ?? Date.now()) - parsed.timestampMs) > PUBLIC_LIVE_MAX_SKEW_MS
  ) {
    return { ok: false, error: "public_live_wallet_proof_stale", status: 403 };
  }

  let publicKey: Uint8Array;
  let signature: Uint8Array;
  try {
    publicKey = Uint8Array.from(bs58.decode(wallet));
    signature = Uint8Array.from(Buffer.from(signatureB64, "base64"));
  } catch {
    return { ok: false, error: "public_live_wallet_proof_invalid", status: 403 };
  }
  if (publicKey.length !== 32 || signature.length !== 64) {
    return { ok: false, error: "public_live_wallet_proof_invalid", status: 403 };
  }
  const verified = ed25519.verify(signature, new TextEncoder().encode(message), publicKey);
  if (!verified) return { ok: false, error: "public_live_wallet_proof_invalid", status: 403 };

  const nonceKey = `${wallet}:${parsed.nonce}`;
  prunePublicLiveNonces();
  if (options.consumeNonce !== false) {
    if (publicLiveNonces.has(nonceKey)) {
      return { ok: false, error: "public_live_wallet_proof_replayed", status: 403 };
    }
    publicLiveNonces.set(nonceKey, parsed.timestampMs + PUBLIC_LIVE_MAX_SKEW_MS);
  }

  return {
    ok: true,
    proof: {
      wallet_pubkey: wallet,
      wallet_commitment: publicLiveWalletCommitment(wallet),
      owner_commitment: publicLiveOwnerCommitment(wallet),
      proof_commitment: gholaCommitment("public_live_wallet_proof", {
        message_sha256: createHash("sha256").update(message).digest("hex"),
        signature_sha256: createHash("sha256").update(signatureB64).digest("hex"),
      }),
      timestamp_ms: parsed.timestampMs,
      nonce: parsed.nonce,
    },
  };
}

export function publicLivePhoenixSessionPolicy(input: {
  policy_commitment?: string | null;
  market_allowlist?: string[];
  max_notional_bucket?: string;
  max_order_count?: number;
}) {
  const policy = {
    market_allowlist: input.market_allowlist?.length ? input.market_allowlist : ["SOL", "SOL-PERP"],
    max_notional_bucket: input.max_notional_bucket || PUBLIC_LIVE_MAX_NOTIONAL_BUCKET,
    max_order_count: input.max_order_count ?? PUBLIC_LIVE_MAX_ORDER_COUNT,
    kill_switch: false,
  };
  return {
    ...policy,
    policy_commitment: input.policy_commitment || gholaCommitment("public_live_phoenix_session_policy", policy),
  };
}

export async function submitPublicLivePhoenixOrder(input: {
  body: PublicLivePhoenixSubmitInput;
  allocation_commitment: string;
  policy_commitment?: string | null;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}) {
  const value = input.body;
  if (value.ack_live_order !== true) return { error: "live_order_ack_required" as const, status: 400 };
  const workOrderCommitment = stringValue(value.work_order_commitment);
  if (!workOrderCommitment) return { error: "work_order_commitment_required" as const, status: 400 };
  if (!isPublicSafeCommitment(workOrderCommitment)) {
    return { error: "work_order_commitment_invalid" as const, status: 400 };
  }
  const encryptedInstruction = value.encrypted_execution_instruction_bundle;
  if (!isSealedExecutionInstructionBundle(encryptedInstruction)) {
    return { error: "encrypted_execution_instruction_required" as const, status: 400 };
  }
  const cfg = publicLiveWorkerConfig(input.env ?? process.env);
  if (!cfg.url) return { error: "private_agent_worker_endpoint_missing" as const, status: 503 };

  const sessionPolicy = publicLivePhoenixSessionPolicy({
    policy_commitment: input.policy_commitment ?? null,
  });
  const workerPath = "/venues/solana-perps/orders";
  const payload = {
    version: 1,
    platform_class: "solana_perps_market",
    venue_id: "phoenix",
    execution_mode: "ghola_pooled",
    work_order_commitment: workOrderCommitment,
    operation_class: "perp_limit_order",
    policy_commitment: sessionPolicy.policy_commitment,
    allocation_commitment: input.allocation_commitment,
    encrypted_execution_instruction_bundle: encryptedInstruction,
    session_policy: sessionPolicy,
  };
  const authorization = workerAuthorizationHeader({
    env: input.env ?? process.env,
    fallbackToken: cfg.token,
    method: "POST",
    path: workerPath,
    scope: "order:submit",
    body: payload,
    expected: workerCapabilityExpectedFromBody(payload, {
      venue_id: "phoenix",
      platform_class: "solana_perps_market",
      operation_class: "perp_limit_order",
    }),
  });
  if (!authorization) return { error: "private_agent_worker_auth_missing" as const, status: 503 };

  const response = await (input.fetchImpl ?? fetch)(new URL(workerPath, cfg.url), {
    method: "POST",
    cache: "no-store",
    headers: {
      "content-type": "application/json",
      "x-ghola-sealed-execution-required": "true",
      authorization,
    },
    body: JSON.stringify(payload),
  }).catch(() => null);
  if (!response) return { error: "private_agent_worker_unreachable" as const, status: 503 };
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || typeof body !== "object" || Array.isArray(body)) {
    return {
      error: workerError(body) || "private_agent_worker_submit_failed" as const,
      status: response.status >= 400 ? response.status : 502,
      worker_body: publicWorkerFailure(body),
    };
  }
  return {
    version: 1,
    status: "submitted" as const,
    venue_id: "phoenix" as const,
    execution_mode: "ghola_pooled" as const,
    work_order_commitment: workOrderCommitment,
    policy_commitment: sessionPolicy.policy_commitment,
    allocation_commitment: input.allocation_commitment,
    worker_receipt: body,
  };
}

export function publicLivePhoenixMessage(input: {
  wallet_pubkey: string;
  owner_commitment: string;
  timestamp_ms: string;
  nonce: string;
}) {
  return [
    PUBLIC_LIVE_PREFIX,
    "venue:phoenix",
    "platform_class:solana_perps_market",
    "execution_mode:ghola_pooled",
    `owner_commitment:${input.owner_commitment}`,
    `wallet:${input.wallet_pubkey}`,
    `timestamp_ms:${input.timestamp_ms}`,
    `nonce:${input.nonce}`,
    `purpose:${PUBLIC_LIVE_PURPOSE}`,
  ].join("\n");
}

function parsePublicLivePhoenixMessage(message: string): {
  wallet_pubkey: string;
  owner_commitment: string;
  timestampMs: number;
  nonce: string;
  message: string;
} | null {
  const lines = message.split("\n");
  if (lines.length !== 9 || lines[0] !== PUBLIC_LIVE_PREFIX) return null;
  if (lines[1] !== "venue:phoenix") return null;
  if (lines[2] !== "platform_class:solana_perps_market") return null;
  if (lines[3] !== "execution_mode:ghola_pooled") return null;
  const ownerCommitment = field(lines[4], "owner_commitment");
  const wallet = normalizePublicLiveWalletPubkey(field(lines[5], "wallet"));
  const timestamp = field(lines[6], "timestamp_ms");
  const nonce = field(lines[7], "nonce");
  const purpose = field(lines[8], "purpose");
  if (!ownerCommitment || !wallet || !timestamp || !nonce || purpose !== PUBLIC_LIVE_PURPOSE) {
    return null;
  }
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(nonce)) return null;
  const canonical = publicLivePhoenixMessage({
    wallet_pubkey: wallet,
    owner_commitment: ownerCommitment,
    timestamp_ms: timestamp,
    nonce,
  });
  if (canonical !== message) return null;
  return {
    wallet_pubkey: wallet,
    owner_commitment: ownerCommitment,
    timestampMs: Number.parseInt(timestamp, 10),
    nonce,
    message,
  };
}

function publicLiveWorkerConfig(env: Record<string, string | undefined>) {
  const url = firstEnv(env, [
    "GHOLA_PRIVATE_AGENT_EXECUTION_URL",
    "GHOLA_PRIVATE_AGENT_WORKER_URL",
    "GHOLA_CONNECTOR_SOLANA_PERPS_MARKET_URL",
  ]);
  const token = firstEnv(env, [
    "GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN",
    "PRIVATE_AGENT_EXECUTION_TOKEN",
    "GHOLA_CONNECTOR_SOLANA_PERPS_MARKET_TOKEN",
  ]);
  return { url, token };
}

function firstEnv(env: Record<string, string | undefined>, names: string[]) {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return "";
}

function isSealedExecutionInstructionBundle(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.alg === "sealed-provider-v1" || record.alg === "hpke-x25519-aes256gcm") &&
    typeof record.ciphertext === "string" &&
    record.ciphertext.length > 20 &&
    typeof record.recipient === "string" &&
    record.recipient.length > 3 &&
    typeof record.aad === "string" &&
    record.aad.includes("venue:phoenix")
  );
}

function isPublicSafeCommitment(value: string) {
  return /^[A-Za-z0-9_:-]{8,180}$/.test(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function field(line: string, key: string): string {
  return line.startsWith(`${key}:`) ? line.slice(key.length + 1) : "";
}

function prunePublicLiveNonces(now = Date.now()) {
  if (publicLiveNonces.size < 1_000) return;
  for (const [key, expiresAt] of publicLiveNonces) {
    if (expiresAt <= now) publicLiveNonces.delete(key);
  }
}

function workerError(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const error = (body as Record<string, unknown>).error;
  return typeof error === "string" && error ? error : null;
}

function publicWorkerFailure(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  return {
    error: typeof record.error === "string" ? record.error : "worker_error",
    details: Array.isArray(record.details) ? record.details.map(String).slice(0, 5) : undefined,
    missing: Array.isArray(record.missing) ? record.missing.map(String).slice(0, 10) : undefined,
  };
}
