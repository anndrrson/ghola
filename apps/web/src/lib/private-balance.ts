export interface PublicStablecoinHealth {
  configured: boolean;
  fallback_allowed?: boolean;
  privacy_disclosure?: string;
}

export interface ShieldedStablecoinHealth {
  rail?: "shielded_stablecoin" | "aleo_usdcx_shielded";
  canonical_rail?: "aleo_usdcx_shielded";
  provider?: string;
  network?: string;
  asset?: string;
  configured: boolean;
  adapter_configured?: boolean;
  destination_configured?: boolean;
  adapter_signature_required?: boolean;
  adapter_signature_configured?: boolean;
  recipient?: string | null;
  verifier_ready?: boolean;
  fallback_allowed?: boolean;
  privacy_disclosure?: string;
  unavailable_reason?: string;
}

export interface PaymentHealth {
  default_rail?: string;
  rails?: {
    solana_public_usdc?: PublicStablecoinHealth;
    solana_public_stablecoin?: PublicStablecoinHealth;
    aleo_usdcx_shielded?: ShieldedStablecoinHealth;
    shielded_stablecoin?: ShieldedStablecoinHealth;
  };
}

export type PrivateBalanceStatus =
  | "checking"
  | "private_ready"
  | "setup_required"
  | "payments_unavailable";

export interface PrivateBalanceSummary {
  status: PrivateBalanceStatus;
  label: string;
  headline: string;
  detail: string;
  privateSpendReady: boolean;
  publicFundingReady: boolean;
  fallbackAllowed: boolean;
  asset: string;
  network: string;
}

export function formatMicroUsd(microUsd: number | null | undefined): string {
  const safe = Number.isFinite(microUsd) ? Number(microUsd) : 0;
  return `$${(safe / 1_000_000).toFixed(2)}`;
}

export function summarizePrivateBalance(
  health: PaymentHealth | null | undefined,
): PrivateBalanceSummary {
  if (!health) {
    return {
      status: "checking",
      label: "Checking rails",
      headline: "Checking private rail status.",
      detail:
        "Ghola is verifying whether private stablecoin settlement is available before enabling Private Balance.",
      privateSpendReady: false,
      publicFundingReady: false,
      fallbackAllowed: false,
      asset: "USDCx",
      network: "shielded",
    };
  }

  const publicRail =
    health?.rails?.solana_public_usdc || health?.rails?.solana_public_stablecoin;
  const shieldedRail =
    health?.rails?.aleo_usdcx_shielded || health?.rails?.shielded_stablecoin;
  const publicFundingReady = publicRail?.configured === true;
  const privateSpendReady = shieldedRail?.configured === true;
  const fallbackAllowed = shieldedRail?.fallback_allowed === true;
  const asset = shieldedRail?.asset || "USDCx";
  const network = shieldedRail?.network || "shielded";

  if (privateSpendReady) {
    return {
      status: "private_ready",
      label: "Private ready",
      headline: "Private Balance is active.",
      detail:
        "Top ups can fund USDC-backed private settlement. Private mode will not downgrade to public settlement.",
      privateSpendReady,
      publicFundingReady,
      fallbackAllowed,
      asset,
      network,
    };
  }

  if (publicFundingReady) {
    return {
      status: "setup_required",
      label: "Private setup queued",
      headline: "Public balance works. Private settlement is gated.",
      detail:
        shieldedRail?.unavailable_reason ||
        "The shielded verifier is not configured yet. Ghola will not use public USDC when Private Balance is requested.",
      privateSpendReady,
      publicFundingReady,
      fallbackAllowed,
      asset,
      network,
    };
  }

  return {
    status: "payments_unavailable",
    label: "Payments offline",
    headline: "Payment rails are unavailable.",
    detail:
      "Ghola cannot confirm a usable public or private stablecoin rail right now.",
    privateSpendReady,
    publicFundingReady,
    fallbackAllowed,
    asset,
    network,
  };
}
