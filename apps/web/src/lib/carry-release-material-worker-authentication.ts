import { createHash } from "node:crypto";
import {
  canonicalCarryCommitmentJson,
  carryReleaseMaterialAuthenticationMessage,
} from "@ghola/execution-core";
import { ed25519 } from "@noble/curves/ed25519";

const PROOF_LIFETIME_MS = 30_000;

type VerificationInput = {
  route_path: string;
  body: Record<string, unknown>;
  response: unknown;
  now_ms?: number;
  env?: Record<string, string | undefined>;
};

export type CarryReleaseMaterialWorkerAuthenticationResult =
  | { ok: true }
  | { ok: false; error: "carry_release_material_worker_authentication_invalid" };

export function verifyCarryReleaseMaterialWorkerAuthentication({
  route_path: routePath,
  body,
  response,
  now_ms: nowMs = Date.now(),
  env = process.env,
}: VerificationInput): CarryReleaseMaterialWorkerAuthenticationResult {
  const result = record(response);
  const material = record(result.material);
  const position = record(material.position);
  const authentication = record(result.worker_authentication);
  const context = record(authentication.context);
  const checkedAtMs = integer(context.checked_at_ms);
  const expiresAtMs = integer(context.expires_at_ms);
  const signatureB64 = string(authentication.signature_b64);
  const signerPublicKeyB64 = string(authentication.signer_public_key_b64);
  const materialCommitment = `carry:release-response:${createHash("sha256")
    .update(canonicalCarryCommitmentJson(material))
    .digest("hex")}`;
  if (result.ok !== true || checkedAtMs === null || expiresAtMs === null
    || !Number.isSafeInteger(nowMs) || checkedAtMs > nowMs + 1_000
    || expiresAtMs !== checkedAtMs + PROOF_LIFETIME_MS || expiresAtMs <= nowMs
    || authentication.version !== 1 || authentication.algorithm !== "ed25519"
    || authentication.attestation_bound !== true || authentication.request_bound !== true
    || authentication.material_replay_bound !== true
    || context.route_path !== routePath
    || context.owner_commitment !== body.owner_commitment
    || context.position_id !== body.position_id
    || position.position_id !== body.position_id
    || context.material_commitment !== materialCommitment
    || !/^carry:release:material:[0-9a-f]{64}$/.test(string(material.worker_material_commitment))
    || !signerAllowed(signerPublicKeyB64, env)) return invalid();
  const message = carryReleaseMaterialAuthenticationMessage(context);
  return attestedSignatureValid(signatureB64, signerPublicKeyB64, message)
    ? { ok: true }
    : invalid();
}

function invalid(): CarryReleaseMaterialWorkerAuthenticationResult {
  return { ok: false, error: "carry_release_material_worker_authentication_invalid" };
}

function signerAllowed(signerPublicKeyB64: string, env: Record<string, string | undefined>) {
  const pins = new Set((env.GHOLA_FUNDING_WORKER_SIGNER_KEYS_B64 || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean));
  if (pins.size > 0) return pins.has(signerPublicKeyB64);
  return env.NODE_ENV === "test"
    || env.GHOLA_CONNECTOR_MODE === "local_test"
    || env.GHOLA_SHIELDED_POOL_MODE === "local_test";
}

function attestedSignatureValid(signatureB64: string, signerPublicKeyB64: string, message: string) {
  try {
    const signature = Uint8Array.from(Buffer.from(signatureB64, "base64"));
    const spki = Uint8Array.from(Buffer.from(signerPublicKeyB64, "base64"));
    return signature.length === 64 && spki.length >= 32 && ed25519.verify(
      signature,
      new TextEncoder().encode(message),
      spki.subarray(spki.length - 32),
    );
  } catch {
    return false;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function integer(value: unknown): number | null {
  return Number.isSafeInteger(value) ? Number(value) : null;
}
