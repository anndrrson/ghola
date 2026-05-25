import { createHash, sign, verify } from "node:crypto";

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

/// Canonical message that an amount-attestor signs to bind a paid amount to a
/// specific shielded transfer. The receipt_ref (nullifier/tx hash) prevents an
/// attestation minted for one transfer from being replayed against another.
export function amountAttestationPayload({
  provider,
  network,
  asset,
  destination,
  amount,
  receiptRef
}) {
  return [
    "ghola-railgun-amount-attestation-v1",
    `provider:${provider}`,
    `network:${network}`,
    `asset:${asset}`,
    `destination:${destination}`,
    `amount:${amount}`,
    `receipt_ref:${receiptRef}`
  ].join("\n");
}

/// Verify an amount attestation's signature against the attestor public key.
/// Returns true iff the signature covers exactly the supplied fields.
export function verifyAmountAttestation(publicKey, fields, signatureB64) {
  if (!publicKey || typeof signatureB64 !== "string" || signatureB64.length === 0) {
    return false;
  }
  let signature;
  try {
    signature = Buffer.from(signatureB64, "base64");
  } catch {
    return false;
  }
  if (signature.length === 0) return false;
  const payload = Buffer.from(amountAttestationPayload(fields));
  try {
    return verify(null, payload, publicKey, signature);
  } catch {
    return false;
  }
}

export function canonicalProofDigest(proof) {
  const txSignature = JSON.stringify(proof.tx_signature ?? null);
  const receiptId = JSON.stringify(proof.shielded_receipt_id ?? null);
  const proofB64 = JSON.stringify(proof.proof_b64 ?? null);
  const nullifierHex = JSON.stringify(proof.nullifier_hex ?? null);
  return sha256Hex(
    `{"tx_signature":${txSignature},"shielded_receipt_id":${receiptId},"proof_b64":${proofB64},"nullifier_hex":${nullifierHex}}`
  );
}

export function signedRailgunReceiptPayload({
  provider,
  network,
  asset,
  destination,
  requiredAmount,
  paidAmount,
  receiptRef,
  proofDigest,
  requestHash,
  relayOnly,
  observedAtUnix,
  expiresAtUnix,
  confirmations,
  proofOfInnocenceRequired,
  proofOfInnocenceConfigured
}) {
  return [
    "ghola-railgun-evm-v1",
    `provider:${provider}`,
    `network:${network}`,
    `asset:${asset}`,
    `destination:${destination}`,
    `required_amount:${requiredAmount}`,
    `paid_amount:${paidAmount}`,
    `receipt_ref:${receiptRef}`,
    `proof_digest:${proofDigest}`,
    `request_hash:${requestHash || ""}`,
    `relay_only:${relayOnly === true}`,
    `observed_at_unix:${observedAtUnix}`,
    `expires_at_unix:${expiresAtUnix}`,
    `confirmations:${confirmations}`,
    "broadcaster_ready:true",
    `proof_of_innocence_required:${proofOfInnocenceRequired}`,
    `proof_of_innocence_configured:${proofOfInnocenceConfigured}`,
    "settled:true"
  ].join("\n");
}

export function signReceipt(privateKey, payload) {
  return sign(null, Buffer.from(payload), privateKey).toString("base64");
}
