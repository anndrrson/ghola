import { describe, expect, it } from "vitest";
import { decodeFunctionData } from "viem";
import {
  LIGHTER_MAINNET_PROXY_ADDRESS,
} from "./lighter-agent-association";
import {
  LIGHTER_OWNER_RECOVERY_ABI,
  LIGHTER_RECOVERY_USDC_ADDRESS,
  assertLighterOwnerRecoveryIntent,
  assertLighterRecoveryUsdcAsset,
  buildLighterOwnerRecoveryIntent,
  lighterOwnerRecoveryPlanCommitment,
  selectLighterRecoveryMasterAccount,
} from "./lighter-owner-recovery";

const OWNER = "0x3333333333333333333333333333333333333333";

describe("Lighter owner-only recovery", () => {
  it("builds the fixed one-USDC no-redirect, no-submit calldata", () => {
    const plan = buildLighterOwnerRecoveryIntent({ ownerAddress: OWNER, accountIndex: 123 });
    expect(plan).toMatchObject({
      chain_id: 1,
      from: OWNER,
      to: LIGHTER_MAINNET_PROXY_ADDRESS,
      value: "0x0",
      function: "withdraw(uint48,uint16,uint8,uint64)",
      account_index: 123,
      asset_index: 3,
      asset_address: LIGHTER_RECOVERY_USDC_ADDRESS,
      route_type: 0,
      base_amount: "1000000",
      recipient_address: OWNER,
      recipient_parameter_present: false,
      redirect_possible: false,
      transaction_signed: false,
      transaction_broadcast: false,
      submission_available: false,
    });
    expect(decodeFunctionData({ abi: LIGHTER_OWNER_RECOVERY_ABI, data: plan.data }))
      .toEqual({ functionName: "withdraw", args: [123, 3, 0, BigInt(1_000_000)] });
    expect(lighterOwnerRecoveryPlanCommitment(plan)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("rejects any destination, amount, or submission mutation", () => {
    const plan = buildLighterOwnerRecoveryIntent({ ownerAddress: OWNER, accountIndex: 123 });
    for (const altered of [
      { ...plan, recipient_address: "0x4444444444444444444444444444444444444444" },
      { ...plan, base_amount: "2000000" },
      { ...plan, submission_available: true },
    ]) {
      expect(() => assertLighterOwnerRecoveryIntent(altered, { ownerAddress: OWNER, accountIndex: 123 }))
        .toThrow("fixed no-submit plan");
    }
  });

  it("requires one exact master account and canonical L1 USDC", () => {
    expect(selectLighterRecoveryMasterAccount({
      response: {
        code: 200,
        l1_address: OWNER,
        sub_accounts: [
          { index: 123, account_type: 0, l1_address: OWNER },
          { index: 124, account_type: 1, l1_address: OWNER },
        ],
      },
      ownerAddress: OWNER,
    }).account_index).toBe(123);
    expect(assertLighterRecoveryUsdcAsset({
      code: 200,
      asset_details: [{
        asset_id: 3,
        symbol: "USDC",
        l1_decimals: 6,
        decimals: 6,
        min_withdrawal_amount: "1.000000",
        margin_mode: "enabled",
        l1_address: LIGHTER_RECOVERY_USDC_ADDRESS,
      }],
    }).minimum_withdrawal_base_amount).toBe("1000000");
    expect(() => selectLighterRecoveryMasterAccount({
      response: { code: 200, l1_address: OWNER, sub_accounts: [{ index: 124, account_type: 1, l1_address: OWNER }] },
      ownerAddress: OWNER,
    })).toThrow("master account");
  });
});
