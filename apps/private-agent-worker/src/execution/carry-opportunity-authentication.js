import {
  createHash,
  createPublicKey,
  verify as verifyEd25519,
} from "node:crypto";
import { carryCreationOpportunityAuthenticationMessage } from "@ghola/execution-core";
import {
  fundingSigningIdentity,
  signAttestedWorkerMessage,
} from "../venues/shielded_funding_attestation.js";

const PROOF_LIFETIME_MS = 60_000;

export function authenticateCarryCreationOpportunity({
  owner_commitment: ownerCommitment,
  opportunity,
  sign_attested_message: signAttestedMessage = signAttestedWorkerMessage,
}) {
  const unsigned = unsignedOpportunity(opportunity);
  const checkedAtMs = unsigned?.checked_at_ms;
  const expiresAtMs = Number.isSafeInteger(checkedAtMs) ? checkedAtMs + PROOF_LIFETIME_MS : null;
  const message = carryCreationOpportunityAuthenticationMessage({
    owner_commitment: ownerCommitment,
    opportunity: unsigned,
    checked_at_ms: checkedAtMs,
    expires_at_ms: expiresAtMs,
  });
  const signature = signAttestedMessage(Buffer.from(message, "utf8"));
  return Object.freeze({
    version: 1,
    algorithm: "ed25519",
    attestation_bound: true,
    deterministic_only: true,
    checked_at_ms: checkedAtMs,
    expires_at_ms: expiresAtMs,
    evidence_commitment: evidenceCommitment(message),
    signature_b64: signature.signature_b64,
    signer_public_key_b64: signature.signer_public_key_b64,
  });
}

export function verifyCarryCreationOpportunityAuthentication({
  owner_commitment: ownerCommitment,
  opportunity,
  now_ms: nowMs = Date.now(),
  expected_signer_public_key_b64: expectedSignerPublicKeyB64 = fundingSigningIdentity().public_key_b64,
}) {
  const authentication = opportunity?.worker_authentication;
  if (!authentication || typeof authentication !== "object" || Array.isArray(authentication)) {
    return denied("carry_opportunity_worker_authentication_missing");
  }
  const unsigned = unsignedOpportunity(opportunity);
  const checkedAtMs = unsigned?.checked_at_ms;
  const expiresAtMs = checkedAtMs + PROOF_LIFETIME_MS;
  if (authentication.version !== 1
    || authentication.algorithm !== "ed25519"
    || authentication.attestation_bound !== true
    || authentication.deterministic_only !== true
    || authentication.checked_at_ms !== checkedAtMs
    || authentication.expires_at_ms !== expiresAtMs
    || !Number.isSafeInteger(nowMs)
    || !Number.isSafeInteger(checkedAtMs)
    || checkedAtMs > nowMs + 5_000
    || !Number.isSafeInteger(expiresAtMs)
    || expiresAtMs <= nowMs) {
    return denied("carry_opportunity_worker_authentication_invalid");
  }
  if (authentication.signer_public_key_b64 !== expectedSignerPublicKeyB64) {
    return denied("carry_opportunity_worker_signer_mismatch");
  }
  const message = carryCreationOpportunityAuthenticationMessage({
    owner_commitment: ownerCommitment,
    opportunity: unsigned,
    checked_at_ms: checkedAtMs,
    expires_at_ms: expiresAtMs,
  });
  if (authentication.evidence_commitment !== evidenceCommitment(message)) {
    return denied("carry_opportunity_worker_authentication_invalid");
  }
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(authentication.signer_public_key_b64, "base64"),
      format: "der",
      type: "spki",
    });
    const valid = verifyEd25519(
      null,
      Buffer.from(message, "utf8"),
      publicKey,
      Buffer.from(String(authentication.signature_b64 || ""), "base64"),
    );
    return valid
      ? { ok: true, authentication: Object.freeze({ ...authentication }) }
      : denied("carry_opportunity_worker_authentication_invalid");
  } catch {
    return denied("carry_opportunity_worker_authentication_invalid");
  }
}

function unsignedOpportunity(opportunity) {
  if (!opportunity || typeof opportunity !== "object" || Array.isArray(opportunity)) return opportunity;
  const { worker_authentication: _authentication, ...unsigned } = opportunity;
  return unsigned;
}

function evidenceCommitment(message) {
  return `carry:creation-opportunity:evidence:${createHash("sha256").update(message).digest("hex")}`;
}

function denied(error) {
  return { ok: false, error };
}
