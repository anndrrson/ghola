import { createHash } from "node:crypto";
import {
  canonicalCarryCommitmentJson,
  carryReleaseMaterialAuthenticationMessage,
} from "@ghola/execution-core";
import { signAttestedWorkerMessage } from "../venues/shielded_funding_attestation.js";

const PROOF_LIFETIME_MS = 30_000;

export function authenticateCarryReleaseMaterial({
  route_path: routePath,
  body,
  material,
  checked_at_ms: checkedAtMs = Date.now(),
  sign_attested_message: signAttestedMessage = signAttestedWorkerMessage,
}) {
  if (!Number.isSafeInteger(checkedAtMs)) throw new Error("carry_release_material_authentication_timestamp_invalid");
  const expiresAtMs = checkedAtMs + PROOF_LIFETIME_MS;
  const materialCommitment = carryReleaseMaterialResponseCommitment(material);
  const context = Object.freeze({
    route_path: routePath,
    owner_commitment: body?.owner_commitment,
    position_id: body?.position_id,
    material_commitment: materialCommitment,
    checked_at_ms: checkedAtMs,
    expires_at_ms: expiresAtMs,
  });
  const signature = signAttestedMessage(Buffer.from(
    carryReleaseMaterialAuthenticationMessage(context),
    "utf8",
  ));
  return Object.freeze({
    version: 1,
    algorithm: "ed25519",
    attestation_bound: true,
    request_bound: true,
    material_replay_bound: true,
    signature_b64: signature.signature_b64,
    signer_public_key_b64: signature.signer_public_key_b64,
    context,
  });
}

export function carryReleaseMaterialResponseCommitment(material) {
  return `carry:release-response:${createHash("sha256")
    .update(canonicalCarryCommitmentJson(material))
    .digest("hex")}`;
}
