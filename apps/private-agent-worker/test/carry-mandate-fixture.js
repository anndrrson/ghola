import {
  carryRiskMandateMessage,
  normalizeCarryRiskMandateAuthorization,
  normalizeCarryRiskMandatePayload,
} from "@ghola/execution-core";
import { hashMessage } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const OWNER = privateKeyToAccount(`0x${"44".repeat(32)}`);

export async function signedCarryPositionInput(input, {
  ownerCommitment,
  nowMs,
  expiresAtMs = nowMs + 30 * 86_400_000,
} = {}) {
  const signedMandate = normalizeCarryRiskMandatePayload({
    version: 1,
    kind: "ghola_carry_risk_mandate",
    strategy_id: "delta_neutral_carry_v1",
    network: "mainnet",
    owner_commitment: ownerCommitment,
    owner_wallet_address: OWNER.address.toLowerCase(),
    position_id: input.position_id,
    mandate_id: input.mandate_id,
    asset: input.asset,
    long_venue_id: input.long_venue_id,
    short_venue_id: input.short_venue_id,
    target_notional_micro_usdc: input.target_notional_micro_usdc,
    risk_mandate: input.risk_mandate,
    ...(input.migration_parent_position_id ? {
      migration_parent_position_id: input.migration_parent_position_id,
      migration_candidate_id: input.migration_candidate_id,
    } : {}),
    issued_at_ms: nowMs - 1_000,
    expires_at_ms: expiresAtMs,
  });
  const message = carryRiskMandateMessage(signedMandate);
  return {
    ...input,
    mandate_authorization: normalizeCarryRiskMandateAuthorization({
      version: 1,
      signed_mandate: signedMandate,
      signature: await OWNER.signMessage({ message }),
      mandate_commitment: hashMessage(message),
    }),
  };
}
