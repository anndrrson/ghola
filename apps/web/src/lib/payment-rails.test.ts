import { describe, expect, it } from "vitest";
import {
  privacyDisclosureForRail,
  requestedPaymentRailHeader,
  validatePaymentRail,
  type PaymentRail,
} from "./payment-rails";

describe("payment rails", () => {
  it("keeps shielded stablecoin settlement fail-closed until an adapter is configured", () => {
    const rail: PaymentRail = {
      kind: "aleo_usdcx_shielded",
      provider: "aleo",
      network: "aleo:mainnet",
      asset: "USDCx",
      destination: "aleo1recipient",
      adapterConfigured: false,
      privacy: "shielded_subject_to_timing_bridge_and_liquidity_correlation",
    };

    expect(validatePaymentRail(rail)).toMatchObject({
      ok: false,
      code: "adapter_unconfigured",
    });
  });

  it("does not describe public Solana settlement as shielded", () => {
    const rail: PaymentRail = {
      kind: "solana_public_stablecoin",
      network: "solana:mainnet",
      asset: "USDC",
      assetMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      destination: "platform-wallet",
      privacy: "public_payer_provider_amount_timing",
    };

    expect(validatePaymentRail(rail).ok).toBe(true);
    expect(privacyDisclosureForRail(rail)).toContain("reveals payer");
  });

  it("uses an explicit request header for shielded-only agent calls", () => {
    expect(requestedPaymentRailHeader("aleo_usdcx_shielded")).toEqual({
      "x-ghola-payment-rail": "aleo_usdcx_shielded",
    });
    expect(requestedPaymentRailHeader("railgun_evm_shielded")).toEqual({
      "x-ghola-payment-rail": "railgun_evm_shielded",
    });
    expect(requestedPaymentRailHeader("private_shielded_auto")).toEqual({
      "x-ghola-payment-rail": "private_shielded_auto",
    });
  });

  it("rejects public USDC on the private Aleo rail", () => {
    const rail = {
      kind: "aleo_usdcx_shielded",
      provider: "aleo",
      network: "aleo:mainnet",
      asset: "USDC",
      destination: "aleo1recipient",
      adapterConfigured: true,
      privacy: "shielded_subject_to_timing_bridge_and_liquidity_correlation",
    } as unknown as PaymentRail;

    expect(validatePaymentRail(rail)).toMatchObject({
      ok: false,
      code: "invalid_asset",
    });
  });

  it("models Railgun/EVM as a separate fail-closed shielded rail", () => {
    const rail: PaymentRail = {
      kind: "railgun_evm_shielded",
      provider: "railgun",
      network: "arbitrum",
      asset: "USDC",
      destination: "0zkrecipient",
      adapterConfigured: true,
      broadcasterConfigured: false,
      proofOfInnocenceRequired: true,
      proofOfInnocenceConfigured: true,
      privacy: "shielded_subject_to_relayer_pool_and_timing_correlation",
    };

    expect(validatePaymentRail(rail)).toMatchObject({
      ok: false,
      code: "broadcaster_unconfigured",
    });
    expect(privacyDisclosureForRail(rail)).toContain("Railgun/EVM");
  });

  it("accepts Railgun/EVM only when adapter, broadcaster, and proof policy are configured", () => {
    const rail: PaymentRail = {
      kind: "railgun_evm_shielded",
      provider: "railgun",
      network: "polygon",
      asset: "USDT",
      destination: "0zkrecipient",
      adapterConfigured: true,
      broadcasterConfigured: true,
      proofOfInnocenceRequired: true,
      proofOfInnocenceConfigured: true,
      privacy: "shielded_subject_to_relayer_pool_and_timing_correlation",
    };

    expect(validatePaymentRail(rail)).toEqual({ ok: true });
  });

  it("accepts Solana shielded pool only when relayer and verifier are ready", () => {
    const rail: PaymentRail = {
      kind: "solana_shielded_pool",
      provider: "solana_shielded_pool",
      network: "solana:devnet",
      asset: "USDCx",
      destination: "shld1recipient",
      adapterConfigured: true,
      verifierReady: true,
      privacy: "shielded_subject_to_deposit_withdraw_relayer_and_timing_correlation",
    };

    expect(validatePaymentRail(rail)).toEqual({ ok: true });
    expect(privacyDisclosureForRail(rail)).toContain("Solana-native");
  });
});
