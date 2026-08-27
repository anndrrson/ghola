import { recoverTypedDataAddress } from "viem";
import {
  asterApprovalSigningDefinition,
  type AsterV3AgentApprovalTypedData,
} from "./aster-agent-onboarding";
import type { InjectedEvmProvider } from "./hyperliquid-owner-authorization";
import {
  LIGHTER_MAINNET_CHAIN_ID,
  LIGHTER_MAINNET_PROXY_ADDRESS,
  buildLighterChangePubKeyIntent,
  lighterOwnerAddress,
  type LighterChangePubKeyTransactionPlan,
} from "./lighter-agent-association";

const EVM_SIGNATURE = /^0x[0-9a-f]{130}$/i;
const TRANSACTION_HASH = /^0x[0-9a-f]{64}$/i;
const LIGHTER_MAX_ASSOCIATION_GAS = BigInt(600_000);
const LIGHTER_MAX_FEE_PER_GAS = BigInt(500_000_000_000);
const LIGHTER_MAX_PRIORITY_FEE_PER_GAS = BigInt(50_000_000_000);

export async function signAsterAgentApprovalWithInjectedOwner(input: {
  provider: InjectedEvmProvider;
  ownerAddress: `0x${string}`;
  typedData: AsterV3AgentApprovalTypedData;
}): Promise<`0x${string}`> {
  const ownerAddress = normalizedAddress(input.ownerAddress);
  const signature = normalizedSignature(await input.provider.request({
    method: "eth_signTypedData_v4",
    params: [ownerAddress, JSON.stringify(input.typedData)],
  }));
  const recovered = await recoverTypedDataAddress({
    ...asterApprovalSigningDefinition(input.typedData),
    signature,
  }).catch(() => null);
  if (recovered?.toLowerCase() !== ownerAddress) {
    throw new Error("Aster approval was signed by the wrong wallet.");
  }
  return signature;
}

export async function sendLighterKeyAssociationWithInjectedOwner(input: {
  provider: InjectedEvmProvider;
  ownerAddress: `0x${string}`;
  transactionPlan: LighterChangePubKeyTransactionPlan;
}) {
  const ownerAddress = lighterOwnerAddress(input.ownerAddress);
  const chainId = normalizedChainId(await input.provider.request({ method: "eth_chainId", params: [] }));
  if (chainId !== LIGHTER_MAINNET_CHAIN_ID) {
    throw new Error("Switch the connected wallet to Ethereum Mainnet, then continue once.");
  }
  const transaction = validatedWalletTransaction(input.transactionPlan, ownerAddress);
  const transactionHash = await input.provider.request({
    method: "eth_sendTransaction",
    params: [transaction],
  });
  if (typeof transactionHash !== "string" || !TRANSACTION_HASH.test(transactionHash.trim())) {
    throw new Error("The wallet did not return a Lighter association transaction hash.");
  }
  return {
    external_broadcast: true as const,
    transaction_hash: transactionHash.trim().toLowerCase() as `0x${string}`,
  };
}

function validatedWalletTransaction(
  plan: LighterChangePubKeyTransactionPlan,
  ownerAddress: `0x${string}`,
) {
  const expected = buildLighterChangePubKeyIntent({
    ownerAddress,
    accountIndex: plan.account_index,
    apiKeyIndex: plan.api_key_index,
    publicKey: plan.public_key,
  });
  const gas = positiveQuantity(plan.gas, "gas");
  const maxFeePerGas = positiveQuantity(plan.max_fee_per_gas, "maximum fee");
  const maxPriorityFeePerGas = positiveQuantity(plan.max_priority_fee_per_gas, "priority fee");
  if (
    plan.chain_id !== LIGHTER_MAINNET_CHAIN_ID || plan.from.toLowerCase() !== ownerAddress ||
    plan.to.toLowerCase() !== LIGHTER_MAINNET_PROXY_ADDRESS.toLowerCase() || plan.value !== "0x0" ||
    plan.data.toLowerCase() !== expected.data.toLowerCase() ||
    plan.function !== expected.function || plan.transaction_signed !== false ||
    plan.transaction_broadcast !== false || plan.simulation_required_before_signing !== true ||
    plan.simulation?.performed !== true || plan.simulation.succeeded !== true ||
    plan.simulation.chain_id_verified !== true || plan.simulation.exact_sender_verified !== true ||
    plan.simulation.exact_contract_verified !== true || gas > LIGHTER_MAX_ASSOCIATION_GAS ||
    maxFeePerGas > LIGHTER_MAX_FEE_PER_GAS || maxPriorityFeePerGas > LIGHTER_MAX_PRIORITY_FEE_PER_GAS ||
    maxPriorityFeePerGas > maxFeePerGas
  ) {
    throw new Error("Lighter association transaction plan is not approved for submission.");
  }
  normalizedQuantity(plan.nonce, true);
  return {
    from: ownerAddress,
    to: LIGHTER_MAINNET_PROXY_ADDRESS,
    value: "0x0",
    data: plan.data,
    nonce: plan.nonce,
    gas: plan.gas,
    maxFeePerGas: plan.max_fee_per_gas,
    maxPriorityFeePerGas: plan.max_priority_fee_per_gas,
    type: "0x2",
  } as const;
}

function normalizedAddress(value: string): `0x${string}` {
  const address = value.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) throw new Error("Injected owner address is invalid.");
  return address as `0x${string}`;
}

function normalizedSignature(value: unknown): `0x${string}` {
  if (typeof value !== "string" || !EVM_SIGNATURE.test(value.trim())) {
    throw new Error("The wallet returned an invalid Aster owner signature.");
  }
  return value.trim().toLowerCase() as `0x${string}`;
}

function normalizedChainId(value: unknown): number {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) return -1;
  const parsed = Number(BigInt(value));
  return Number.isSafeInteger(parsed) ? parsed : -1;
}

function positiveQuantity(value: unknown, label: string): bigint {
  const parsed = normalizedQuantity(value, false);
  if (parsed <= BigInt(0)) throw new Error(`Lighter association ${label} is invalid.`);
  return parsed;
}

function normalizedQuantity(value: unknown, allowZero: boolean): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) {
    throw new Error("Lighter association transaction quantity is invalid.");
  }
  const parsed = BigInt(value);
  if (parsed < BigInt(0) || (!allowZero && parsed === BigInt(0))) {
    throw new Error("Lighter association transaction quantity is invalid.");
  }
  return parsed;
}
