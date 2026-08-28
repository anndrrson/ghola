import { getAddress, isAddress } from "viem";
import {
  LIGHTER_MAINNET_API_URL,
  selectLighterOwnerAccount,
} from "./lighter-agent-association";
import type {
  LighterActivationBlocker,
  LighterActivationReadiness,
} from "./lighter-activation-readiness";

const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bdA02913";
const LIGHTER_MINIMUM_USDC = BigInt(3_000_000);
const BASE_ACTIVATION_GAS_UNITS_WITH_BUFFER = BigInt(500_000);
const ETHEREUM_ASSOCIATION_GAS_UNITS_WITH_BUFFER = BigInt(750_000);

export async function readLighterActivationReadiness({
  ownerAddress,
  fetchImpl = fetch,
  baseRpcUrl = process.env.GHOLA_BASE_RPC_URL || "https://mainnet.base.org",
  ethereumRpcUrl = process.env.GHOLA_ETHEREUM_RPC_URL || "https://ethereum-rpc.publicnode.com",
  now = () => new Date(),
}: {
  ownerAddress: string;
  fetchImpl?: typeof fetch;
  baseRpcUrl?: string;
  ethereumRpcUrl?: string;
  now?: () => Date;
}): Promise<LighterActivationReadiness> {
  if (!isAddress(ownerAddress, { strict: true })) throw readinessError("lighter_owner_address_invalid", 400);
  const owner = getAddress(ownerAddress);
  const balanceOfData = `0x70a08231${owner.slice(2).toLowerCase().padStart(64, "0")}`;
  const [baseEth, baseUsdc, baseGasPrice, ethereumEth, ethereumGasPrice, lighterAccountIndex] = await Promise.all([
    rpcHex(baseRpcUrl, "eth_getBalance", [owner, "latest"], fetchImpl),
    rpcHex(baseRpcUrl, "eth_call", [{ to: BASE_USDC, data: balanceOfData }, "latest"], fetchImpl),
    rpcHex(baseRpcUrl, "eth_gasPrice", [], fetchImpl),
    rpcHex(ethereumRpcUrl, "eth_getBalance", [owner, "latest"], fetchImpl),
    rpcHex(ethereumRpcUrl, "eth_gasPrice", [], fetchImpl),
    readLighterOwnerAccountIndex(owner, fetchImpl),
  ]);
  const estimatedBaseGas = baseGasPrice * BASE_ACTIVATION_GAS_UNITS_WITH_BUFFER;
  const estimatedEthereumGas = ethereumGasPrice * ETHEREUM_ASSOCIATION_GAS_UNITS_WITH_BUFFER;
  const baseDepositReady = baseUsdc >= LIGHTER_MINIMUM_USDC && baseEth >= estimatedBaseGas;
  const ethereumAssociationGasReady = ethereumEth >= estimatedEthereumGas;
  const lighterOwnerAccountReady = lighterAccountIndex !== null;
  const blockers: LighterActivationBlocker[] = [];
  if (!lighterOwnerAccountReady) {
    if (baseUsdc < LIGHTER_MINIMUM_USDC) blockers.push("lighter_base_usdc_below_minimum");
    if (baseEth < estimatedBaseGas) blockers.push("lighter_base_gas_required");
    blockers.push("lighter_owner_account_required");
  }
  if (!ethereumAssociationGasReady) blockers.push("lighter_ethereum_association_gas_required");
  return Object.freeze({
    version: 2,
    owner_address: owner,
    lighter_account_index: lighterAccountIndex,
    base_usdc_microunits: baseUsdc.toString(),
    base_eth_wei: baseEth.toString(),
    ethereum_eth_wei: ethereumEth.toString(),
    estimated_base_gas_wei: estimatedBaseGas.toString(),
    estimated_ethereum_association_gas_wei: estimatedEthereumGas.toString(),
    base_deposit_ready: baseDepositReady,
    ethereum_association_gas_ready: ethereumAssociationGasReady,
    lighter_owner_account_ready: lighterOwnerAccountReady,
    ready: lighterOwnerAccountReady && ethereumAssociationGasReady,
    blockers: Object.freeze(blockers),
    checked_at: now().toISOString(),
  });
}

async function readLighterOwnerAccountIndex(owner: `0x${string}`, fetchImpl: typeof fetch): Promise<number | null> {
  let response: Response;
  try {
    response = await fetchImpl(
      `${LIGHTER_MAINNET_API_URL}/api/v1/accountsByL1Address?l1_address=${encodeURIComponent(owner)}`,
      { cache: "no-store", signal: AbortSignal.timeout(5_000) },
    );
  } catch {
    throw readinessError("lighter_account_lookup_unavailable", 503);
  }
  const body = await response.json().catch(() => null);
  const lighterError = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  if (
    response.status === 400 &&
    (Number(lighterError.code) === 21100 || /account not found/i.test(String(lighterError.message || "")))
  ) return null;
  if (!response.ok) throw readinessError("lighter_account_lookup_unavailable", 503);
  try {
    return selectLighterOwnerAccount({ response: body, ownerAddress: owner }).account_index;
  } catch {
    throw readinessError("lighter_account_lookup_invalid", 502);
  }
}

async function rpcHex(url: string, method: string, params: unknown[], fetchImpl: typeof fetch) {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw readinessError("lighter_readiness_rpc_unavailable", 503);
  }
  const body = await response.json().catch(() => null) as { result?: unknown; error?: unknown } | null;
  if (!response.ok || !body || typeof body.result !== "string" || !/^0x[0-9a-f]+$/i.test(body.result)) {
    throw readinessError("lighter_readiness_rpc_invalid", 502);
  }
  return BigInt(body.result);
}

export function readinessError(code: string, status: number) {
  return Object.assign(new Error(code), { code, status });
}
