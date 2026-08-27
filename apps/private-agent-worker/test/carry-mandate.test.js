import assert from "node:assert/strict";
import test from "node:test";
import { verifyCarryRiskMandateAuthorization } from "../src/execution/carry-mandate.js";
import { signedCarryPositionInput } from "./carry-mandate-fixture.js";

const OWNER = "owner:carry:worker:mandate:0001";
const NOW = 1_800_000_000_000;

test("worker independently verifies the exact owner-signed Carry mandate", async () => {
  const input = await signedCarryPositionInput(positionInput("carry:position:worker:mandate:0001"), {
    ownerCommitment: OWNER,
    nowMs: NOW,
  });
  const verified = await verifyCarryRiskMandateAuthorization({
    owner_commitment: OWNER,
    position_input: input,
    now_ms: NOW,
  });
  assert.equal(verified.ok, true);
});

test("worker rejects mandate mutation, owner replay, and expiry", async () => {
  const input = await signedCarryPositionInput(positionInput("carry:position:worker:mandate:0002"), {
    ownerCommitment: OWNER,
    nowMs: NOW,
  });
  const changed = await verifyCarryRiskMandateAuthorization({
    owner_commitment: OWNER,
    position_input: {
      ...input,
      risk_mandate: { ...input.risk_mandate, max_hedge_error_micro_usdc: 1_000_000 },
    },
    now_ms: NOW,
  });
  assert.equal(changed.error, "carry_mandate_position_mismatch");
  const replayed = await verifyCarryRiskMandateAuthorization({
    owner_commitment: "owner:carry:worker:other:0001",
    position_input: input,
    now_ms: NOW,
  });
  assert.equal(replayed.error, "carry_mandate_owner_mismatch");
  const expired = await verifyCarryRiskMandateAuthorization({
    owner_commitment: OWNER,
    position_input: input,
    now_ms: NOW + 31 * 86_400_000,
  });
  assert.equal(expired.error, "carry_mandate_expired");
});

function positionInput(positionId) {
  return {
    version: 1,
    position_id: positionId,
    mandate_id: positionId.replace("position", "mandate"),
    asset: "BTC",
    long_venue_id: "hyperliquid",
    short_venue_id: "lighter",
    target_notional_micro_usdc: 11_000_000,
    risk_mandate: {
      min_expected_net_benefit_bps: 5,
      exit_net_value_bps: 0,
      exit_after_consecutive_observations: 2,
      min_margin_runway_ms: 21_600_000,
      max_hedge_error_micro_usdc: 10_000,
      max_data_age_ms: 60_000,
      max_contract_data_skew_ms: 2_000,
      max_index_price_divergence_bps: 25,
      max_mark_price_divergence_bps: 50,
      allow_migration: false,
    },
  };
}
