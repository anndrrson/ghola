import { createHash } from "node:crypto";
import {
  carryCollateralReviewMessage,
  carryRiskMandateMessage,
  normalizeCarryRiskMandateAuthorization,
  normalizeCarryRiskMandatePayload,
  venueAdapterCapability,
} from "@ghola/execution-core";
import { hashMessage } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const OWNER = privateKeyToAccount(`0x${"44".repeat(32)}`);

export const TEST_CARRY_OWNER_WALLET_ADDRESS = OWNER.address.toLowerCase();

export function carryOpportunityInputEvidence(longVenue, shortVenue) {
  return {
    version: 1,
    legs: [
      carryOpportunityInputLeg(longVenue, "buy"),
      carryOpportunityInputLeg(shortVenue, "sell"),
    ],
  };
}

function carryOpportunityInputLeg(venueId, side) {
  const shadow = venueAdapterCapability(venueId, "perp_shadow");
  const digest = createHash("sha256").update(`carry:test:shadow:${venueId}`).digest("hex");
  const accountDigest = createHash("sha256").update(`carry:test:account:${venueId}`).digest("hex").slice(0, 40);
  return {
    venue_id: venueId,
    side,
    shadow_snapshot_commitment: `carry:shadow:snapshot:${digest}`,
    initial_margin_bps: 1_000,
    maintenance_margin_bps: 500,
    liquidation_fee_bps: 0,
    margin_model: shadow.margin_model,
    liquidation_model: shadow.liquidation_model,
    work_order_commitment: `carry:work-order:${venueId}:0001`,
    verification_commitment: `carry:verification:${venueId}:0001`,
    account_commitment: `carry:account:${venueId}:0001`,
    account_state_commitment: `carry:account-state:${accountDigest}`,
  };
}

export async function signedCarryCollateralReviewAuthorization(review) {
  const message = carryCollateralReviewMessage(review);
  return {
    version: 1,
    signed_review: review,
    signature: await OWNER.signMessage({ message }),
    review_commitment: hashMessage(message),
  };
}

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
    ...(input.opportunity_evidence_commitment ? {
      opportunity_evidence_commitment: input.opportunity_evidence_commitment,
    } : {}),
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
