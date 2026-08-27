export type LighterActivationBlocker =
  | "lighter_base_usdc_below_minimum"
  | "lighter_base_gas_required"
  | "lighter_ethereum_association_gas_required";

export interface LighterActivationReadiness {
  version: 1;
  owner_address: `0x${string}`;
  base_usdc_microunits: string;
  base_eth_wei: string;
  ethereum_eth_wei: string;
  estimated_base_gas_wei: string;
  estimated_ethereum_association_gas_wei: string;
  base_deposit_ready: boolean;
  ethereum_association_ready: boolean;
  ready: boolean;
  blockers: readonly LighterActivationBlocker[];
  checked_at: string;
}

export async function fetchLighterActivationReadiness(
  ownerAddress: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LighterActivationReadiness> {
  const response = await fetchImpl(
    `/api/carry/lighter-readiness?owner_address=${encodeURIComponent(ownerAddress)}`,
    { cache: "no-store" },
  );
  const body = await response.json().catch(() => null) as (LighterActivationReadiness & { error?: string }) | null;
  if (!response.ok || !body || body.version !== 1) {
    throw new Error(body?.error || "Lighter readiness could not be checked.");
  }
  return body;
}
