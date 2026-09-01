import { afterEach, describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { gholaCommitment } from "./private-account";
import {
  claimPrivateLighterUdaAttempt,
  getPrivateLighterUdaAttempt,
  reconcilePrivateLighterUdaAttempt,
  resetPrivateAccountStoreForTests,
  settlePrivateLighterUdaAttempt,
} from "./private-account-store";

const OWNER = getAddress("0xa0582521e11effdf12ff00b50087802c3346e7ef");
const DEPOSIT = getAddress("0x2222222222222222222222222222222222222222");
const OWNER_COMMITMENT = gholaCommitment("owner", "user-1");
const WALLET_COMMITMENT = gholaCommitment("wallet", OWNER.toLowerCase());
const ATTEMPT_ID = gholaCommitment("lighter_uda_attempt", {
  owner_commitment: OWNER_COMMITMENT,
  wallet_commitment: WALLET_COMMITMENT,
});
const CLAIM_TOKEN = "ab".repeat(32);

describe("reconcilePrivateLighterUdaAttempt", () => {
  afterEach(resetPrivateAccountStoreForTests);

  it.each(["pending", "ambiguous"] as const)("atomically verifies an exact %s attempt", async (status) => {
    const claim = await seed();
    if (status === "ambiguous") {
      await settlePrivateLighterUdaAttempt({
        owner_commitment: OWNER_COMMITMENT,
        wallet_commitment: WALLET_COMMITMENT,
        owner_address: OWNER,
        claim_token: CLAIM_TOKEN,
        status: "ambiguous",
        destination: null,
        failure_code: "lighter_uda_create_unavailable",
        now: new Date("2026-08-31T00:00:01.000Z"),
      });
    }
    const reconciled = await reconcilePrivateLighterUdaAttempt({
      attempt_id: claim.record.attempt_id,
      owner_commitment: OWNER_COMMITMENT,
      wallet_commitment: WALLET_COMMITMENT,
      owner_address: OWNER,
      claim_token: CLAIM_TOKEN,
      destination: destination(),
      now: new Date("2026-08-31T00:00:02.000Z"),
    });
    expect(reconciled).toMatchObject({ status: "verified", failure_code: null, destination: destination() });
    expect(await getPrivateLighterUdaAttempt({
      owner_commitment: OWNER_COMMITMENT,
      wallet_commitment: WALLET_COMMITMENT,
    })).toEqual(reconciled);
  });

  it("is idempotent only for the exact attempt, claim, and destination", async () => {
    const claim = await seed();
    const input = {
      attempt_id: claim.record.attempt_id,
      owner_commitment: OWNER_COMMITMENT,
      wallet_commitment: WALLET_COMMITMENT,
      owner_address: OWNER,
      claim_token: CLAIM_TOKEN,
      destination: destination(),
      now: new Date("2026-08-31T00:00:02.000Z"),
    };
    const first = await reconcilePrivateLighterUdaAttempt(input);
    expect(await reconcilePrivateLighterUdaAttempt(input)).toEqual(first);
    await expect(reconcilePrivateLighterUdaAttempt({ ...input, claim_token: "cd".repeat(32) }))
      .rejects.toMatchObject({ code: "lighter_uda_reconciliation_settlement_conflict", status: 409 });
    await expect(reconcilePrivateLighterUdaAttempt({
      ...input,
      destination: { ...destination(), deposit_address: getAddress("0x3333333333333333333333333333333333333333") },
    })).rejects.toMatchObject({ code: "lighter_uda_reconciliation_settlement_conflict", status: 409 });
  });
});

async function seed() {
  return claimPrivateLighterUdaAttempt({
    attempt_id: ATTEMPT_ID,
    owner_commitment: OWNER_COMMITMENT,
    wallet_commitment: WALLET_COMMITMENT,
    owner_address: OWNER,
    claim_token: CLAIM_TOKEN,
    now: new Date("2026-08-31T00:00:00.000Z"),
  });
}

function destination() {
  return {
    owner_address: OWNER,
    deposit_address: DEPOSIT,
    market: "perps" as const,
    asset: "USDC" as const,
    blocked: false as const,
    action_type: "LIGHTER_PERPS" as const,
    to_chain_id: "3586256" as const,
    to_token_address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as const,
    recipient_address: OWNER,
    recipient_binding: "owner_address" as const,
    owner_account_index: null,
    resolved_user_id: OWNER,
  };
}
