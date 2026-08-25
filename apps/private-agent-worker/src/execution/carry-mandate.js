import {
  carryRiskMandateMessage,
  createCarryPosition,
} from "@ghola/execution-core";
import { hashMessage, recoverMessageAddress } from "viem";

export async function verifyCarryRiskMandateAuthorization({
  owner_commitment: ownerCommitment,
  position_input: positionInput,
  now_ms: nowMs = Date.now(),
}) {
  try {
    const position = createCarryPosition({ ...positionInput, version: 1, now_ms: nowMs });
    const authorization = position.mandate_authorization;
    const signed = authorization.signed_mandate;
    if (signed.owner_commitment !== ownerCommitment) return denied("carry_mandate_owner_mismatch");
    const message = carryRiskMandateMessage(signed);
    if (authorization.mandate_commitment !== hashMessage(message)) {
      return denied("carry_mandate_commitment_mismatch");
    }
    const recovered = await recoverMessageAddress({ message, signature: authorization.signature });
    if (recovered.toLowerCase() !== signed.owner_wallet_address) {
      return denied("carry_mandate_signature_mismatch");
    }
    return { ok: true, position, authorization };
  } catch (error) {
    const code = typeof error?.code === "string" ? error.code : "carry_mandate_authorization_invalid";
    return denied(/^[a-z0-9_:-]{3,120}$/.test(code) ? code : "carry_mandate_authorization_invalid");
  }
}

function denied(error) {
  return { ok: false, error };
}
