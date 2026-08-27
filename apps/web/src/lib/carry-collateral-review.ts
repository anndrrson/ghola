import {
  carryCollateralReviewMessage,
  normalizeCarryCollateralReviewAuthorization,
  normalizeCarryCollateralReviewPayload,
} from "@ghola/execution-core";
import { hashMessage } from "viem";

export type CarryCollateralReview = Readonly<Record<string, unknown>>;

export function carryCollateralReviewCommitment(review: CarryCollateralReview): `0x${string}` {
  return hashMessage(carryCollateralReviewMessage(review));
}

export function buildCarryCollateralReviewAuthorization(input: {
  signed_review: CarryCollateralReview;
  signature: `0x${string}`;
}) {
  const signedReview = normalizeCarryCollateralReviewPayload(input.signed_review);
  return normalizeCarryCollateralReviewAuthorization({
    version: 1,
    signed_review: signedReview,
    signature: input.signature,
    review_commitment: carryCollateralReviewCommitment(signedReview),
  });
}
