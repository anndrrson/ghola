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
  ready?: boolean;
  adapter_configured?: boolean;
  adapter_auth_configured?: boolean;
  destination_configured?: boolean;
  adapter_signature_required?: boolean;
  adapter_signature_configured?: boolean;
  recipient_configured?: boolean;
  recipient_preview?: string | null;
  recipient?: string | null;
  arbitrary_recipient_proofs_enabled?: boolean;
  recipient_receipts_enabled?: boolean;
  verifier_ready?: boolean;
  fallback_allowed?: boolean;
  privacy_disclosure?: string;
  unavailable_reason?: string;
}

export interface RailgunEvmShieldedHealth {
  rail?: "railgun_evm_shielded";
  provider?: "railgun";
  network?: "ethereum" | "polygon" | "arbitrum" | "bsc" | string;
  asset?: "USDC" | "USDT" | string;
  configured: boolean;
  ready?: boolean;
  adapter_configured?: boolean;
  broadcaster_configured?: boolean;
  proof_of_innocence_required?: boolean;
  proof_of_innocence_configured?: boolean;
  fallback_allowed?: boolean;
  privacy_disclosure?: string;
  unavailable_reason?: string;
}

export interface SolanaShieldedPoolHealth {
  rail?: "solana_shielded_pool";
  canonical_rail?: "solana_shielded_pool";
  provider?: "solana_shielded_pool" | string;
  network?: string;
  asset?: string;
  configured: boolean;
  ready?: boolean;
  adapter_configured?: boolean;
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
    railgun_evm_shielded?: RailgunEvmShieldedHealth;
    solana_shielded_pool?: SolanaShieldedPoolHealth;
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
  railLabel: string;
  readyShieldedRailCount: number;
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
      railLabel: "Shielded rails",
      readyShieldedRailCount: 0,
    };
  }

  const publicRail =
    health?.rails?.solana_public_usdc || health?.rails?.solana_public_stablecoin;
  const shieldedRail =
    health?.rails?.aleo_usdcx_shielded || health?.rails?.shielded_stablecoin;
  const railgunRail = health?.rails?.railgun_evm_shielded;
  const solanaShieldedRail = health?.rails?.solana_shielded_pool;
  const publicFundingReady = publicRail?.configured === true;
  const fallbackAllowed =
    shieldedRail?.fallback_allowed === true ||
    railgunRail?.fallback_allowed === true ||
    solanaShieldedRail?.fallback_allowed === true;
  const signatureReady =
    shieldedRail?.adapter_signature_required === true
      ? shieldedRail?.adapter_signature_configured === true
      : true;
  const verifierReady =
    shieldedRail?.ready === true ||
    (shieldedRail?.configured === true &&
      shieldedRail?.verifier_ready === true &&
      signatureReady);
  const privateSpendReady =
    shieldedRail?.configured === true &&
    verifierReady &&
    !fallbackAllowed;
  const railgunProofReady =
    railgunRail?.proof_of_innocence_required === true
      ? railgunRail?.proof_of_innocence_configured === true
      : true;
  const railgunReady =
    railgunRail?.configured === true &&
    railgunRail.ready === true &&
    railgunRail.adapter_configured === true &&
    railgunRail.broadcaster_configured === true &&
    railgunProofReady &&
    railgunRail.fallback_allowed !== true;
  const solanaShieldedReady =
    solanaShieldedRail?.configured === true &&
    solanaShieldedRail.ready === true &&
    solanaShieldedRail.adapter_configured === true &&
    solanaShieldedRail.verifier_ready === true &&
    solanaShieldedRail.fallback_allowed !== true;
  const readyShieldedRailCount =
    (privateSpendReady ? 1 : 0) +
    (railgunReady ? 1 : 0) +
    (solanaShieldedReady ? 1 : 0);
  const anyPrivateSpendReady = readyShieldedRailCount > 0;
  const asset =
    shieldedRail?.asset || railgunRail?.asset || solanaShieldedRail?.asset || "USDCx";
  const network =
    shieldedRail?.network || railgunRail?.network || solanaShieldedRail?.network || "shielded";
  const readyRailLabels = [
    privateSpendReady ? "Aleo USDCx" : null,
    railgunReady ? "Railgun/EVM" : null,
    solanaShieldedReady ? "Solana shielded pool" : null,
  ].filter((label): label is string => Boolean(label));
  const railLabel =
    readyRailLabels.length > 0 ? readyRailLabels.join(" + ") : "Shielded rails";

  if (anyPrivateSpendReady) {
    return {
      status: "private_ready",
      label: "Private ready",
      headline: "Private Balance is active.",
      detail:
        readyShieldedRailCount > 1
          ? "Multiple shielded rails are ready. Private mode will not downgrade to public settlement."
          : "A shielded rail is ready. Private mode will not downgrade to public settlement.",
      privateSpendReady: anyPrivateSpendReady,
      publicFundingReady,
      fallbackAllowed,
      asset,
      network,
      railLabel,
      readyShieldedRailCount,
    };
  }

  if (publicFundingReady) {
    return {
      status: "setup_required",
      label: "Private setup queued",
      headline: "Public balance works. Private settlement is gated.",
      detail:
        shieldedRail?.unavailable_reason ||
        railgunRail?.unavailable_reason ||
        solanaShieldedRail?.unavailable_reason ||
        "No shielded rail is fully configured yet. Ghola will not use public USDC when Private Balance is requested.",
      privateSpendReady: false,
      publicFundingReady,
      fallbackAllowed,
      asset,
      network,
      railLabel,
      readyShieldedRailCount,
    };
  }

  return {
    status: "payments_unavailable",
    label: "Payments offline",
    headline: "Payment rails are unavailable.",
    detail:
      "Ghola cannot confirm a usable public or private stablecoin rail right now.",
    privateSpendReady: false,
    publicFundingReady,
    fallbackAllowed,
    asset,
    network,
    railLabel,
    readyShieldedRailCount,
  };
}
