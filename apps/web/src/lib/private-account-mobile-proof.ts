import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";

const MOBILE_PROOF_VERSION = "1";
const MOBILE_PROOF_PURPOSE = "private_account_autopilot";

export interface MobileProofVerificationOk {
  ok: true;
  wallet: string;
  nonce: string;
  timestampMs: number;
}

export interface MobileProofVerificationError {
  ok: false;
  error: "mobile_proof_invalid" | "mobile_proof_stale";
  status: number;
}

export function hasPrivateAccountMobileProofHeaders(req: Request): boolean {
  return [
    "x-ghola-mobile-proof-version",
    "x-ghola-mobile-wallet",
    "x-ghola-mobile-proof-timestamp",
    "x-ghola-mobile-proof-nonce",
    "x-ghola-mobile-proof-signature-b64",
  ].some((name) => Boolean(req.headers.get(name)?.trim()));
}

export function verifyPrivateAccountMobileProof(input: {
  req: Request;
  body: unknown;
  maxSkewMs: number;
  nowMs?: number;
}): MobileProofVerificationOk | MobileProofVerificationError {
  const version = input.req.headers.get("x-ghola-mobile-proof-version")?.trim() ?? "";
  const wallet = input.req.headers.get("x-ghola-mobile-wallet")?.trim() ?? "";
  const timestamp = input.req.headers.get("x-ghola-mobile-proof-timestamp")?.trim() ?? "";
  const nonce = input.req.headers.get("x-ghola-mobile-proof-nonce")?.trim() ?? "";
  const signatureB64 = input.req.headers.get("x-ghola-mobile-proof-signature-b64")?.trim() ?? "";
  if (
    version !== MOBILE_PROOF_VERSION ||
    !wallet ||
    !timestamp ||
    !nonce ||
    !signatureB64 ||
    !/^[A-Za-z0-9._:-]{8,128}$/.test(nonce)
  ) {
    return { ok: false, error: "mobile_proof_invalid", status: 403 };
  }

  const timestampMs = Number.parseInt(timestamp, 10);
  if (
    !Number.isFinite(timestampMs) ||
    Math.abs((input.nowMs ?? Date.now()) - timestampMs) > input.maxSkewMs
  ) {
    return { ok: false, error: "mobile_proof_stale", status: 403 };
  }

  let publicKey: Uint8Array;
  let signature: Uint8Array;
  try {
    publicKey = Uint8Array.from(bs58.decode(wallet));
    signature = Uint8Array.from(Buffer.from(signatureB64, "base64"));
  } catch {
    return { ok: false, error: "mobile_proof_invalid", status: 403 };
  }
  if (publicKey.length !== 32 || signature.length !== 64) {
    return { ok: false, error: "mobile_proof_invalid", status: 403 };
  }

  const pathname = new URL(input.req.url).pathname;
  const bodyHash = createHash("sha256").update(stableJson(input.body)).digest("hex");
  const message = privateAccountMobileProofMessage({
    method: input.req.method,
    path: pathname,
    timestamp,
    nonce,
    bodyHash,
    wallet,
  });
  const ok = ed25519.verify(signature, new TextEncoder().encode(message), publicKey);
  return ok
    ? { ok: true, wallet, nonce, timestampMs }
    : { ok: false, error: "mobile_proof_invalid", status: 403 };
}

export function privateAccountMobileProofMessage(input: {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  bodyHash: string;
  wallet: string;
}) {
  return [
    "ghola_mobile_live_proof_v1",
    `method:${input.method.toUpperCase()}`,
    `path:${input.path}`,
    `timestamp_ms:${input.timestamp}`,
    `nonce:${input.nonce}`,
    `body_sha256:${input.bodyHash}`,
    `wallet:${input.wallet}`,
    `purpose:${MOBILE_PROOF_PURPOSE}`,
  ].join("\n");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}
