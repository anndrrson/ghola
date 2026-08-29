import { describe, expect, it } from "vitest";
import {
  describeLighterActivationNextStep,
  validateLighterActivationReadiness,
} from "./lighter-activation-readiness";

const OWNER = "0xa0582521e11effdf12ff00b50087802c3346e7ef";
const NOW = Date.parse("2026-08-27T18:00:00.000Z");

describe("Lighter activation readiness evidence", () => {
  it("accepts only owner-bound fresh balances whose blockers reconcile", () => {
    expect(validateLighterActivationReadiness(readiness(), OWNER, NOW)).toMatchObject({
      owner_address: OWNER,
      base_deposit_ready: false,
      ethereum_association_gas_ready: false,
      lighter_owner_account_ready: false,
      ready: false,
      blockers: [
        "lighter_base_usdc_below_minimum",
        "lighter_base_gas_required",
        "lighter_owner_account_required",
        "lighter_ethereum_association_gas_required",
      ],
    });
  });

  it("rejects another owner and stale evidence", () => {
    expect(() => validateLighterActivationReadiness(readiness(), `0x${"11".repeat(20)}`, NOW))
      .toThrow("invalid or stale");
    expect(() => validateLighterActivationReadiness({
      ...readiness(),
      checked_at: "2026-08-27T17:59:00.000Z",
    }, OWNER, NOW)).toThrow("invalid or stale");
  });

  it("rejects flags or blockers that contradict the exact balance math", () => {
    expect(() => validateLighterActivationReadiness({
      ...readiness(),
      ready: true,
    }, OWNER, NOW)).toThrow("inconsistent");
    expect(() => validateLighterActivationReadiness({
      ...readiness(),
      blockers: [],
    }, OWNER, NOW)).toThrow("inconsistent");
  });

  it("never equates enough Ethereum gas with a verified Lighter owner account", () => {
    expect(() => validateLighterActivationReadiness({
      ...readiness(),
      ethereum_eth_wei: "1500000",
      ethereum_association_gas_ready: true,
      ready: true,
      blockers: [
        "lighter_base_usdc_below_minimum",
        "lighter_base_gas_required",
        "lighter_owner_account_required",
      ],
    }, OWNER, NOW)).toThrow("inconsistent");
  });

  it("does not request another deposit when Base collateral is already present", () => {
    const value = validateLighterActivationReadiness({
      ...readiness(),
      base_usdc_microunits: "3000000",
      blockers: [
        "lighter_base_gas_required",
        "lighter_owner_account_required",
        "lighter_ethereum_association_gas_required",
      ],
    }, OWNER, NOW);

    const instruction = describeLighterActivationNextStep(value);
    expect(instruction).toContain("ETH gas on Base and ETH gas on Ethereum");
    expect(instruction).not.toContain("3 USDC");
  });
});

function readiness() {
  return {
    version: 2,
    owner_address: OWNER,
    lighter_account_index: null,
    base_usdc_microunits: "0",
    base_eth_wei: "0",
    ethereum_eth_wei: "0",
    estimated_base_gas_wei: "500000",
    estimated_ethereum_association_gas_wei: "1500000",
    base_deposit_ready: false,
    ethereum_association_gas_ready: false,
    lighter_owner_account_ready: false,
    ready: false,
    blockers: [
      "lighter_base_usdc_below_minimum",
      "lighter_base_gas_required",
      "lighter_owner_account_required",
      "lighter_ethereum_association_gas_required",
    ],
    checked_at: "2026-08-27T18:00:00.000Z",
  };
}
