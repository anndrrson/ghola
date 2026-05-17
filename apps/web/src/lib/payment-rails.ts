export type PaymentRailKind =
  | "solana_public_stablecoin"
  | "solana_public_usdc"
  | "shielded_stablecoin"
  | "aleo_usdcx_shielded";

export type PublicStablecoinSymbol = "USDC" | "USDT";
export type ShieldedStablecoinSymbol = "USDCx";
export type StablecoinSymbol = PublicStablecoinSymbol | ShieldedStablecoinSymbol;
export type ShieldedProvider = "railgun" | "aleo";

export interface PublicStablecoinRail {
  kind: "solana_public_stablecoin" | "solana_public_usdc";
  network: "solana:mainnet" | "solana:devnet";
  asset: PublicStablecoinSymbol;
  assetMint: string;
  destination: string;
  privacy: "public_payer_provider_amount_timing";
}

export interface ShieldedStablecoinRail {
  kind: "shielded_stablecoin" | "aleo_usdcx_shielded";
  provider: ShieldedProvider;
  network: string;
  asset: ShieldedStablecoinSymbol;
  destination: string;
  adapterConfigured: boolean;
  privacy: "shielded_subject_to_timing_bridge_and_liquidity_correlation";
}

export type PaymentRail = PublicStablecoinRail | ShieldedStablecoinRail;

export type PaymentRailValidationCode =
  | "adapter_unconfigured"
  | "invalid_network"
  | "invalid_asset"
  | "missing_destination";

export interface PaymentRailValidationResult {
  ok: boolean;
  code?: PaymentRailValidationCode;
  message?: string;
}

export const PUBLIC_STABLECOIN_DISCLOSURE =
  "Public Solana settlement reveals payer, provider, amount, asset, and timing on-chain.";

export const SHIELDED_STABLECOIN_DISCLOSURE =
  "Private USDCx settlement on Aleo is designed to hide sender, receiver, and amount from public chain observers, subject to timing, bridge/xReserve, liquidity, recipient-disclosure, and adapter availability.";

function isShieldedStablecoinRail(
  rail: PaymentRail
): rail is ShieldedStablecoinRail {
  return rail.kind === "shielded_stablecoin" || rail.kind === "aleo_usdcx_shielded";
}

function isPublicStablecoinRail(rail: PaymentRail): rail is PublicStablecoinRail {
  return rail.kind === "solana_public_stablecoin" || rail.kind === "solana_public_usdc";
}

export function privacyDisclosureForRail(rail: PaymentRail): string {
  return isShieldedStablecoinRail(rail)
    ? SHIELDED_STABLECOIN_DISCLOSURE
    : PUBLIC_STABLECOIN_DISCLOSURE;
}

export function validatePaymentRail(
  rail: PaymentRail
): PaymentRailValidationResult {
  if (
    isShieldedStablecoinRail(rail) && rail.asset !== "USDCx"
  ) {
    return {
      ok: false,
      code: "invalid_asset",
      message: "Private Aleo settlement must use USDCx.",
    };
  }
  if (
    isPublicStablecoinRail(rail) &&
    rail.asset !== "USDC" &&
    rail.asset !== "USDT"
  ) {
    return {
      ok: false,
      code: "invalid_asset",
      message: "Public Solana settlement must use USDC or USDT.",
    };
  }
  if (!rail.destination.trim()) {
    return {
      ok: false,
      code: "missing_destination",
      message: "Payment rail destination is required.",
    };
  }
  if (isPublicStablecoinRail(rail)) {
    if (rail.network !== "solana:mainnet" && rail.network !== "solana:devnet") {
      return {
        ok: false,
        code: "invalid_network",
        message: "Public stablecoin rail must use a Solana network.",
      };
    }
    return { ok: true };
  }
  if (!rail.adapterConfigured) {
    return {
      ok: false,
      code: "adapter_unconfigured",
      message:
        "Shielded stablecoin settlement requires a configured verifier adapter. Ghola will not fall back to public USDC.",
    };
  }
  return { ok: true };
}

export function requestedPaymentRailHeader(kind: PaymentRailKind) {
  return {
    "x-ghola-payment-rail": kind,
  };
}
