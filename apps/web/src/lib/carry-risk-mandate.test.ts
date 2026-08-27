import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { carryRiskMandateMessage } from "@ghola/execution-core";
import {
  buildCarryRiskMandatePayload,
  carryRiskMandateAuthorization,
  verifyCarryRiskMandateAuthorization,
} from "./carry-risk-mandate";

const OWNER = privateKeyToAccount(`0x${"11".repeat(32)}`);
const OWNER_COMMITMENT = "owner:carry:test:0001";
const NOW = 1_800_000_000_000;

describe("Carry signed risk mandate", () => {
  it("binds the authenticated owner, exact position, limits, and expiry", async () => {
    const position = positionInput("carry:position:signed:0001");
    const authorization = await signedAuthorization(position);
    await expect(verifyCarryRiskMandateAuthorization({
      owner_commitment: OWNER_COMMITMENT,
      position_input: position,
      mandate_authorization: authorization,
      now_ms: NOW,
    })).resolves.toMatchObject({ ok: true });
  });

  it("rejects a changed limit after owner approval", async () => {
    const position = positionInput("carry:position:signed:0002");
    const authorization = await signedAuthorization(position);
    await expect(verifyCarryRiskMandateAuthorization({
      owner_commitment: OWNER_COMMITMENT,
      position_input: {
        ...position,
        risk_mandate: { ...position.risk_mandate as object, min_margin_runway_ms: 0 },
      },
      mandate_authorization: authorization,
      now_ms: NOW,
    })).resolves.toMatchObject({ ok: false, error: "carry_mandate_position_mismatch" });
  });

  it("rejects wrong-owner, expired, and cross-position replay", async () => {
    const position = positionInput("carry:position:signed:0003");
    const authorization = await signedAuthorization(position);
    await expect(verifyCarryRiskMandateAuthorization({
      owner_commitment: "owner:carry:other:0001",
      position_input: position,
      mandate_authorization: authorization,
      now_ms: NOW,
    })).resolves.toMatchObject({ ok: false, error: "carry_mandate_owner_mismatch" });
    await expect(verifyCarryRiskMandateAuthorization({
      owner_commitment: OWNER_COMMITMENT,
      position_input: position,
      mandate_authorization: authorization,
      now_ms: NOW + 31 * 86_400_000,
    })).resolves.toMatchObject({ ok: false, error: "carry_mandate_expired" });
    await expect(verifyCarryRiskMandateAuthorization({
      owner_commitment: OWNER_COMMITMENT,
      position_input: {
        ...position,
        position_id: "carry:position:signed:replay",
        mandate_id: "carry:mandate:signed:replay",
      },
      mandate_authorization: authorization,
      now_ms: NOW,
    })).resolves.toMatchObject({ ok: false, error: "carry_mandate_position_mismatch" });
  });
});

async function signedAuthorization(position: ReturnType<typeof positionInput>) {
  const payload = buildCarryRiskMandatePayload({
    network: "mainnet",
    owner_commitment: OWNER_COMMITMENT,
    owner_wallet_address: OWNER.address.toLowerCase() as `0x${string}`,
    position_id: position.position_id,
    mandate_id: position.mandate_id,
    asset: position.asset,
    long_venue_id: position.long_venue_id,
    short_venue_id: position.short_venue_id,
    target_notional_micro_usdc: position.target_notional_micro_usdc,
    risk_mandate: position.risk_mandate,
    issued_at_ms: NOW - 1_000,
    expires_at_ms: NOW + 30 * 86_400_000,
  });
  return carryRiskMandateAuthorization({
    signed_mandate: payload,
    signature: await OWNER.signMessage({ message: carryRiskMandateMessage(payload) }),
  });
}

function positionInput(positionId: string) {
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
