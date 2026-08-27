import { getAddress, isAddress } from "viem";
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
  const [baseEth, baseUsdc, baseGasPrice, ethereumEth, ethereumGasPrice] = await Promise.all([
    rpcHex(baseRpcUrl, "eth_getBalance", [owner, "latest"], fetchImpl),
    rpcHex(baseRpcUrl, "eth_call", [{ to: BASE_USDC, data: balanceOfData }, "latest"], fetchImpl),
    rpcHex(baseRpcUrl, "eth_gasPrice", [], fetchImpl),
    rpcHex(ethereumRpcUrl, "eth_getBalance", [owner, "latest"], fetchImpl),
    rpcHex(ethereumRpcUrl, "eth_gasPrice", [], fetchImpl),
  ]);
  const estimatedBaseGas = baseGasPrice * BASE_ACTIVATION_GAS_UNITS_WITH_BUFFER;
  const estimatedEthereumGas = ethereumGasPrice * ETHEREUM_ASSOCIATION_GAS_UNITS_WITH_BUFFER;
  const baseDepositReady = baseUsdc >= LIGHTER_MINIMUM_USDC && baseEth >= estimatedBaseGas;
  const ethereumAssociationReady = ethereumEth >= estimatedEthereumGas;
  const blockers: LighterActivationBlocker[] = [];
  if (baseUsdc < LIGHTER_MINIMUM_USDC) blockers.push("lighter_base_usdc_below_minimum");
  if (baseEth < estimatedBaseGas) blockers.push("lighter_base_gas_required");
  if (!ethereumAssociationReady) blockers.push("lighter_ethereum_association_gas_required");
  return Object.freeze({
    version: 1,
    owner_address: owner,
    base_usdc_microunits: baseUsdc.toString(),
    base_eth_wei: baseEth.toString(),
    ethereum_eth_wei: ethereumEth.toString(),
    estimated_base_gas_wei: estimatedBaseGas.toString(),
    estimated_ethereum_association_gas_wei: estimatedEthereumGas.toString(),
    base_deposit_ready: baseDepositReady,
    ethereum_association_ready: ethereumAssociationReady,
    ready: baseDepositReady && ethereumAssociationReady,
    blockers: Object.freeze(blockers),
    checked_at: now().toISOString(),
  });
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
