import { describe, expect, it } from "vitest";
import { hyperliquidMainnetVaultAuthError } from "./vault-auth";

describe("hyperliquidMainnetVaultAuthError", () => {
  it("accepts testnet and body-bound mobile wallet authorization", () => {
    expect(hyperliquidMainnetVaultAuthError({
      testnetVault: true,
      emailVerified: false,
      mobileWalletProofVerified: false,
      consumerStepUpVerified: false,
    })).toBeNull();
    expect(hyperliquidMainnetVaultAuthError({
      testnetVault: false,
      emailVerified: false,
      mobileWalletProofVerified: true,
      consumerStepUpVerified: false,
    })).toBeNull();
  });

  it("preserves verified-email and step-up requirements without mobile proof", () => {
    expect(hyperliquidMainnetVaultAuthError({
      testnetVault: false,
      emailVerified: false,
      mobileWalletProofVerified: false,
      consumerStepUpVerified: true,
    })).toBe("verified_email_required");
    expect(hyperliquidMainnetVaultAuthError({
      testnetVault: false,
      emailVerified: true,
      mobileWalletProofVerified: false,
      consumerStepUpVerified: false,
    })).toBe("step_up_authentication_required");
    expect(hyperliquidMainnetVaultAuthError({
      testnetVault: false,
      emailVerified: true,
      mobileWalletProofVerified: false,
      consumerStepUpVerified: true,
    })).toBeNull();
  });
});
