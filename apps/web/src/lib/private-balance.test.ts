import { describe, expect, it } from "vitest";
import { formatMicroUsd, summarizePrivateBalance } from "./private-balance";

describe("private balance", () => {
  it("uses a neutral pre-fetch state before payment health loads", () => {
    const summary = summarizePrivateBalance(null);

    expect(summary.status).toBe("checking");
    expect(summary.privateSpendReady).toBe(false);
    expect(summary.label).toBe("Checking rails");
  });

  it("shows private ready only when the shielded rail is configured and ready", () => {
    const summary = summarizePrivateBalance({
      rails: {
        solana_public_stablecoin: { configured: true },
        shielded_stablecoin: {
          configured: true,
          ready: true,
          asset: "USDC",
          network: "aleo:mainnet",
          fallback_allowed: false,
        },
      },
    });

    expect(summary.status).toBe("private_ready");
    expect(summary.privateSpendReady).toBe(true);
    expect(summary.fallbackAllowed).toBe(false);
    expect(summary.asset).toBe("USDC");
    expect(summary.railLabel).toBe("Aleo USDCx");
    expect(summary.readyShieldedRailCount).toBe(1);
  });

  it("treats Railgun/EVM as an independent ready shielded rail", () => {
    const summary = summarizePrivateBalance({
      rails: {
        solana_public_stablecoin: { configured: true },
        railgun_evm_shielded: {
          configured: true,
          ready: true,
          adapter_configured: true,
          broadcaster_configured: true,
          proof_of_innocence_required: true,
          proof_of_innocence_configured: true,
          asset: "USDC",
          network: "arbitrum",
          fallback_allowed: false,
        },
      },
    });

    expect(summary.status).toBe("private_ready");
    expect(summary.privateSpendReady).toBe(true);
    expect(summary.railLabel).toBe("Railgun/EVM");
    expect(summary.readyShieldedRailCount).toBe(1);
  });

  it("treats the Solana shielded pool as an independent ready shielded rail", () => {
    const summary = summarizePrivateBalance({
      rails: {
        solana_public_stablecoin: { configured: true },
        solana_shielded_pool: {
          configured: true,
          ready: true,
          adapter_configured: true,
          verifier_ready: true,
          asset: "USDCx",
          network: "solana:devnet",
          fallback_allowed: false,
        },
      },
    });

    expect(summary.status).toBe("private_ready");
    expect(summary.privateSpendReady).toBe(true);
    expect(summary.railLabel).toBe("Solana shielded pool");
    expect(summary.readyShieldedRailCount).toBe(1);
  });

  it("shows multiple shielded rails when Aleo and Railgun are both ready", () => {
    const summary = summarizePrivateBalance({
      rails: {
        solana_public_stablecoin: { configured: true },
        shielded_stablecoin: {
          configured: true,
          ready: true,
          asset: "USDCx",
          network: "aleo:mainnet",
          fallback_allowed: false,
        },
        railgun_evm_shielded: {
          configured: true,
          ready: true,
          adapter_configured: true,
          broadcaster_configured: true,
          proof_of_innocence_required: true,
          proof_of_innocence_configured: true,
          asset: "USDC",
          network: "polygon",
          fallback_allowed: false,
        },
      },
    });

    expect(summary.status).toBe("private_ready");
    expect(summary.railLabel).toBe("Aleo USDCx + Railgun/EVM");
    expect(summary.readyShieldedRailCount).toBe(2);
  });

  it("keeps private balance gated when fallback or verifier readiness is unsafe", () => {
    const fallbackSummary = summarizePrivateBalance({
      rails: {
        solana_public_stablecoin: { configured: true },
        shielded_stablecoin: {
          configured: true,
          ready: true,
          asset: "USDCx",
          network: "aleo:mainnet",
          fallback_allowed: true,
        },
      },
    });
    expect(fallbackSummary.status).toBe("setup_required");
    expect(fallbackSummary.privateSpendReady).toBe(false);

    const verifierSummary = summarizePrivateBalance({
      rails: {
        solana_public_stablecoin: { configured: true },
        shielded_stablecoin: {
          configured: true,
          verifier_ready: false,
          adapter_signature_required: true,
          adapter_signature_configured: true,
          asset: "USDCx",
          network: "aleo:mainnet",
          fallback_allowed: false,
        },
      },
    });
    expect(verifierSummary.status).toBe("setup_required");
    expect(verifierSummary.privateSpendReady).toBe(false);
  });

  it("keeps private balance gated when only public USDC is configured", () => {
    const summary = summarizePrivateBalance({
      rails: {
        solana_public_stablecoin: { configured: true },
        shielded_stablecoin: {
          configured: false,
          asset: "USDC",
          network: "aleo:mainnet",
          fallback_allowed: false,
          unavailable_reason: "shielded stablecoin adapter is not configured",
        },
      },
    });

    expect(summary.status).toBe("setup_required");
    expect(summary.privateSpendReady).toBe(false);
    expect(summary.publicFundingReady).toBe(true);
    expect(summary.detail).toContain("adapter is not configured");
  });

  it("formats micro-USDC as dollars", () => {
    expect(formatMicroUsd(12_400_000)).toBe("$12.40");
    expect(formatMicroUsd(null)).toBe("$0.00");
  });
});
