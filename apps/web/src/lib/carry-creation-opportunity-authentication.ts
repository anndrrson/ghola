import { createHash } from "node:crypto";
import { carryCreationOpportunityAuthenticationMessage } from "@ghola/execution-core";
import { ed25519 } from "@noble/curves/ed25519";

const PROOF_LIFETIME_MS = 60_000;

type VerificationInput = {
  owner_commitment: string;
  opportunity: unknown;
  now_ms?: number;
  env?: Record<string, string | undefined>;
};

export type CarryCreationOpportunityAuthenticationResult =
  | { ok: true }
  | { ok: false; error: "carry_creation_opportunity_worker_authentication_invalid" };

export function verifyCarryCreationOpportunityWorkerAuthentication({
  owner_commitment: ownerCommitment,
  opportunity,
  now_ms: nowMs = Date.now(),
  env = process.env,
}: VerificationInput): CarryCreationOpportunityAuthenticationResult {
  const authenticated = record(opportunity);
  const authentication = record(authenticated.worker_authentication);
  const unsigned = { ...authenticated };
  delete unsigned.worker_authentication;
  const checkedAtMs = integer(unsigned.checked_at_ms);
  const expiresAtMs = checkedAtMs === null ? null : checkedAtMs + PROOF_LIFETIME_MS;
  const signatureB64 = string(authentication.signature_b64);
  const signerPublicKeyB64 = string(authentication.signer_public_key_b64);
  if (!ownerCommitment || checkedAtMs === null || expiresAtMs === null ||
      !Number.isSafeInteger(nowMs) || checkedAtMs > nowMs + 5_000 || expiresAtMs <= nowMs ||
      authentication.version !== 1 || authentication.algorithm !== "ed25519" ||
      authentication.attestation_bound !== true || authentication.deterministic_only !== true ||
      authentication.checked_at_ms !== checkedAtMs || authentication.expires_at_ms !== expiresAtMs ||
      !signerAllowed(signerPublicKeyB64, env)) {
    return invalid();
  }
  const message = carryCreationOpportunityAuthenticationMessage({
    owner_commitment: ownerCommitment,
    opportunity: unsigned,
    checked_at_ms: checkedAtMs,
    expires_at_ms: expiresAtMs,
  });
  const evidenceCommitment = `carry:creation-opportunity:evidence:${createHash("sha256").update(message).digest("hex")}`;
  return authentication.evidence_commitment === evidenceCommitment &&
    attestedSignatureValid(signatureB64, signerPublicKeyB64, message)
    ? { ok: true }
    : invalid();
}

function invalid(): CarryCreationOpportunityAuthenticationResult {
  return { ok: false, error: "carry_creation_opportunity_worker_authentication_invalid" };
}

function signerAllowed(signerPublicKeyB64: string, env: Record<string, string | undefined>) {
  const pins = new Set((env.GHOLA_FUNDING_WORKER_SIGNER_KEYS_B64 || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean));
  if (pins.size > 0) return pins.has(signerPublicKeyB64);
  return env.NODE_ENV === "test" ||
    env.GHOLA_CONNECTOR_MODE === "local_test" ||
    env.GHOLA_SHIELDED_POOL_MODE === "local_test";
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
