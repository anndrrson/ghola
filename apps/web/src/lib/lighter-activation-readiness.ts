export type LighterActivationBlocker =
  | "lighter_base_usdc_below_minimum"
  | "lighter_base_gas_required"
  | "lighter_ethereum_association_gas_required"
  | "lighter_owner_account_required";

export interface LighterActivationReadiness {
  version: 2;
  owner_address: `0x${string}`;
  lighter_account_index: number | null;
  base_usdc_microunits: string;
  base_eth_wei: string;
  ethereum_eth_wei: string;
  estimated_base_gas_wei: string;
  estimated_ethereum_association_gas_wei: string;
  base_deposit_ready: boolean;
  ethereum_association_gas_ready: boolean;
  lighter_owner_account_ready: boolean;
  ready: boolean;
  blockers: readonly LighterActivationBlocker[];
  checked_at: string;
}

const DECIMAL_INTEGER = /^(?:0|[1-9][0-9]*)$/;
const EVM_ADDRESS = /^0x[0-9a-f]{40}$/i;
const MINIMUM_BASE_USDC_MICROUNITS = BigInt(3_000_000);
export const LIGHTER_ACTIVATION_READINESS_MAX_AGE_MS = 30_000;

export async function fetchLighterActivationReadiness(
  ownerAddress: string,
  fetchImpl: typeof fetch = fetch,
  nowMs = Date.now(),
): Promise<LighterActivationReadiness> {
  const response = await fetchImpl(
    `/api/carry/lighter-readiness?owner_address=${encodeURIComponent(ownerAddress)}`,
    { cache: "no-store" },
  );
  const body = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    const error = record(body).error;
    throw new Error(typeof error === "string" && error ? error : "Lighter readiness could not be checked.");
  }
  return validateLighterActivationReadiness(body, ownerAddress, nowMs);
}

export function validateLighterActivationReadiness(
  value: unknown,
  ownerAddress: string,
  nowMs = Date.now(),
): LighterActivationReadiness {
  const body = record(value);
  const responseOwner = string(body.owner_address);
  const checkedAt = Date.parse(string(body.checked_at));
  const decimalFields = [
    body.base_usdc_microunits,
    body.base_eth_wei,
    body.ethereum_eth_wei,
    body.estimated_base_gas_wei,
    body.estimated_ethereum_association_gas_wei,
  ];
  if (
    body.version !== 2 ||
    !EVM_ADDRESS.test(ownerAddress) ||
    !EVM_ADDRESS.test(responseOwner) ||
    responseOwner.toLowerCase() !== ownerAddress.toLowerCase() ||
    decimalFields.some((field) => !DECIMAL_INTEGER.test(string(field))) ||
    !Number.isFinite(checkedAt) ||
    checkedAt > nowMs + 5_000 ||
    nowMs - checkedAt > LIGHTER_ACTIVATION_READINESS_MAX_AGE_MS
  ) throw new Error("Lighter readiness evidence is invalid or stale.");

  const baseUsdc = BigInt(string(body.base_usdc_microunits));
  const baseEth = BigInt(string(body.base_eth_wei));
  const ethereumEth = BigInt(string(body.ethereum_eth_wei));
  const estimatedBaseGas = BigInt(string(body.estimated_base_gas_wei));
  const estimatedEthereumGas = BigInt(string(body.estimated_ethereum_association_gas_wei));
  const lighterOwnerAccountReady = body.lighter_owner_account_ready === true;
  const lighterAccountIndex = body.lighter_account_index;
  if (
    (lighterOwnerAccountReady && (!Number.isSafeInteger(lighterAccountIndex) || Number(lighterAccountIndex) < 0)) ||
    (!lighterOwnerAccountReady && lighterAccountIndex !== null)
  ) throw new Error("Lighter readiness evidence is inconsistent.");
  const baseDepositReady = baseUsdc >= MINIMUM_BASE_USDC_MICROUNITS && baseEth >= estimatedBaseGas;
  const ethereumAssociationGasReady = ethereumEth >= estimatedEthereumGas;
  const expectedBlockers: LighterActivationBlocker[] = [];
  if (!lighterOwnerAccountReady) {
    if (baseUsdc < MINIMUM_BASE_USDC_MICROUNITS) expectedBlockers.push("lighter_base_usdc_below_minimum");
    if (baseEth < estimatedBaseGas) expectedBlockers.push("lighter_base_gas_required");
    expectedBlockers.push("lighter_owner_account_required");
  }
  if (!ethereumAssociationGasReady) expectedBlockers.push("lighter_ethereum_association_gas_required");
  const blockers = Array.isArray(body.blockers) ? body.blockers.map(string) : [];
  if (
    body.base_deposit_ready !== baseDepositReady ||
    body.ethereum_association_gas_ready !== ethereumAssociationGasReady ||
    body.ready !== (lighterOwnerAccountReady && ethereumAssociationGasReady) ||
    blockers.length !== expectedBlockers.length ||
    blockers.some((blocker, index) => blocker !== expectedBlockers[index])
  ) throw new Error("Lighter readiness evidence is inconsistent.");

  return Object.freeze({
    version: 2,
    owner_address: responseOwner as `0x${string}`,
    lighter_account_index: lighterOwnerAccountReady ? Number(lighterAccountIndex) : null,
    base_usdc_microunits: baseUsdc.toString(),
    base_eth_wei: baseEth.toString(),
    ethereum_eth_wei: ethereumEth.toString(),
    estimated_base_gas_wei: estimatedBaseGas.toString(),
    estimated_ethereum_association_gas_wei: estimatedEthereumGas.toString(),
    base_deposit_ready: baseDepositReady,
    ethereum_association_gas_ready: ethereumAssociationGasReady,
    lighter_owner_account_ready: lighterOwnerAccountReady,
    ready: lighterOwnerAccountReady && ethereumAssociationGasReady,
    blockers: Object.freeze([...expectedBlockers]),
    checked_at: new Date(checkedAt).toISOString(),
  });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}
