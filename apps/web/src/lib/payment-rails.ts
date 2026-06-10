export type PaymentRailKind =
  | "solana_public_stablecoin"
  | "solana_public_usdc"
  | "shielded_stablecoin"
  | "aleo_usdcx_shielded"
  | "railgun_evm_shielded"
  | "solana_shielded_pool"
  | "private_shielded_auto";

export type PublicStablecoinSymbol = "USDC" | "USDT";
export type ShieldedStablecoinSymbol = "USDCx";
export type StablecoinSymbol = PublicStablecoinSymbol | ShieldedStablecoinSymbol;
export type ShieldedProvider = "railgun" | "aleo";
export type SolanaPaymentNetwork =
  | "solana:mainnet"
  | "solana:devnet"
  | "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
  | "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";

export interface PublicStablecoinRail {
  kind: "solana_public_stablecoin" | "solana_public_usdc";
  network: SolanaPaymentNetwork;
  asset: PublicStablecoinSymbol;
  assetMint: string;
  destination: string;
  privacy: "public_payer_provider_amount_timing";
}

export interface ShieldedStablecoinRail {
  kind: "shielded_stablecoin" | "aleo_usdcx_shielded";
  provider: "aleo";
  network: string;
  asset: ShieldedStablecoinSymbol;
  destination: string;
  adapterConfigured: boolean;
  privacy: "shielded_subject_to_timing_bridge_and_liquidity_correlation";
}

export interface RailgunEvmShieldedRail {
  kind: "railgun_evm_shielded";
  provider: "railgun";
  network: "ethereum" | "polygon" | "arbitrum" | "bsc";
  asset: PublicStablecoinSymbol;
  destination: string;
  adapterConfigured: boolean;
  broadcasterConfigured: boolean;
  proofOfInnocenceRequired: boolean;
  proofOfInnocenceConfigured: boolean;
  privacy: "shielded_subject_to_relayer_pool_and_timing_correlation";
}

export interface SolanaShieldedPoolRail {
  kind: "solana_shielded_pool";
  provider: "solana_shielded_pool";
  network: SolanaPaymentNetwork;
  asset: ShieldedStablecoinSymbol;
  destination: string;
  adapterConfigured: boolean;
  verifierReady: boolean;
  privacy: "shielded_subject_to_deposit_withdraw_relayer_and_timing_correlation";
}

export type PaymentRail =
  | PublicStablecoinRail
  | ShieldedStablecoinRail
  | RailgunEvmShieldedRail
  | SolanaShieldedPoolRail;

export type PaymentRailValidationCode =
  | "adapter_unconfigured"
  | "broadcaster_unconfigured"
  | "proof_policy_unconfigured"
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

export const RAILGUN_EVM_DISCLOSURE =
  "Railgun/EVM settlement is designed to hide sender, receiver, token, and amount inside the shielded pool, subject to broadcaster, pool-size, proof-policy, gas, timing, and unshielding correlation.";

export const SOLANA_SHIELDED_POOL_DISCLOSURE =
  "Solana-native shielded-pool settlement is designed to hide sender, receiver, and amount inside note commitments/nullifiers, subject to deposit/withdraw timing, relayer, liquidity, and recipient-disclosure correlation.";

function isShieldedStablecoinRail(
  rail: PaymentRail
): rail is ShieldedStablecoinRail {
  return rail.kind === "shielded_stablecoin" || rail.kind === "aleo_usdcx_shielded";
}

function isRailgunEvmShieldedRail(
  rail: PaymentRail
): rail is RailgunEvmShieldedRail {
  return rail.kind === "railgun_evm_shielded";
}

function isSolanaShieldedPoolRail(
  rail: PaymentRail
): rail is SolanaShieldedPoolRail {
  return rail.kind === "solana_shielded_pool";
}

function isPublicStablecoinRail(rail: PaymentRail): rail is PublicStablecoinRail {
  return rail.kind === "solana_public_stablecoin" || rail.kind === "solana_public_usdc";
}

export function privacyDisclosureForRail(rail: PaymentRail): string {
  if (isRailgunEvmShieldedRail(rail)) return RAILGUN_EVM_DISCLOSURE;
  if (isSolanaShieldedPoolRail(rail)) return SOLANA_SHIELDED_POOL_DISCLOSURE;
  if (isShieldedStablecoinRail(rail)) return SHIELDED_STABLECOIN_DISCLOSURE;
  return PUBLIC_STABLECOIN_DISCLOSURE;
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
    if (
      rail.network !== "solana:mainnet" &&
      rail.network !== "solana:devnet" &&
      rail.network !== "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" &&
      rail.network !== "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"
    ) {
      return {
        ok: false,
        code: "invalid_network",
        message: "Public stablecoin rail must use a Solana network.",
      };
    }
    return { ok: true };
  }
  if (isRailgunEvmShieldedRail(rail)) {
    if (rail.asset !== "USDC" && rail.asset !== "USDT") {
      return {
        ok: false,
        code: "invalid_asset",
        message: "Railgun/EVM shielded settlement must use USDC or USDT.",
      };
    }
    if (
      rail.network !== "ethereum" &&
      rail.network !== "polygon" &&
      rail.network !== "arbitrum" &&
      rail.network !== "bsc"
    ) {
      return {
        ok: false,
        code: "invalid_network",
        message: "Railgun/EVM shielded settlement must use a supported EVM network.",
      };
    }
    if (!rail.adapterConfigured) {
      return {
        ok: false,
        code: "adapter_unconfigured",
        message:
          "Railgun settlement requires a configured adapter. Ghola will not fall back to public settlement.",
      };
    }
    if (!rail.broadcasterConfigured) {
      return {
        ok: false,
        code: "broadcaster_unconfigured",
        message:
          "Railgun settlement requires a configured broadcaster path. Ghola will not fall back to public settlement.",
      };
    }
    if (rail.proofOfInnocenceRequired && !rail.proofOfInnocenceConfigured) {
      return {
        ok: false,
        code: "proof_policy_unconfigured",
        message:
          "Railgun settlement requires a configured proof policy. Ghola will not fall back to public settlement.",
      };
    }
    return { ok: true };
  }
  if (isSolanaShieldedPoolRail(rail)) {
    if (rail.asset !== "USDCx") {
      return {
        ok: false,
        code: "invalid_asset",
        message: "Solana shielded-pool settlement must use USDCx.",
      };
    }
    if (
      rail.network !== "solana:mainnet" &&
      rail.network !== "solana:devnet" &&
      rail.network !== "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" &&
      rail.network !== "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"
    ) {
      return {
        ok: false,
        code: "invalid_network",
        message: "Solana shielded-pool settlement must use a Solana network.",
      };
    }
    if (!rail.adapterConfigured) {
      return {
        ok: false,
        code: "adapter_unconfigured",
        message:
          "Solana shielded-pool settlement requires a configured relayer. Ghola will not fall back to public settlement.",
      };
    }
    if (!rail.verifierReady) {
      return {
        ok: false,
        code: "adapter_unconfigured",
        message:
          "Solana shielded-pool settlement requires a configured prover/verifier. Ghola will not fall back to public settlement.",
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
