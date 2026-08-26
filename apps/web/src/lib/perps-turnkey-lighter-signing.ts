import { createAccountWithAddress } from "@turnkey/viem";
import {
  decodeFunctionData,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type TransactionSerializedEIP1559,
} from "viem";
import {
  LIGHTER_CHANGE_PUB_KEY_ABI,
  LIGHTER_MAINNET_CHAIN_ID,
  LIGHTER_MAINNET_PROXY_ADDRESS,
  lighterAccountIndex,
  lighterApiKeyIndex,
  lighterOwnerAddress,
  lighterPublicKey,
  type LighterChangePubKeyTransactionPlan,
} from "./lighter-agent-association";
import { TURNKEY_PERPS_OWNER_PATH } from "./perps-turnkey-aster-signing";

type TurnkeyViemClient = Parameters<typeof createAccountWithAddress>[0]["client"];
const LIGHTER_MAX_ASSOCIATION_GAS = BigInt(600_000);
const LIGHTER_MAX_FEE_PER_GAS = BigInt(500_000_000_000);
const LIGHTER_MAX_PRIORITY_FEE_PER_GAS = BigInt(50_000_000_000);

export async function signLighterChangePubKeyWithTurnkey(input: {
  client: TurnkeyViemClient;
  organizationId: string;
  owner: { address: string; path?: string | null; organizationId?: string | null };
  transactionPlan: LighterChangePubKeyTransactionPlan;
}) {
  if (!input.organizationId.trim()) throw new Error("Turnkey organization is unavailable.");
  if (input.owner.path !== TURNKEY_PERPS_OWNER_PATH) {
    throw new Error("Turnkey Lighter authorization requires the Ghola perps owner account.");
  }
  const signerOrganizationId = input.owner.organizationId?.trim() || input.organizationId.trim();
  const turnkeyOwnerAddress = input.owner.address.trim();
  if (!/^0x[0-9a-f]{40}$/i.test(turnkeyOwnerAddress)) {
    throw new Error("Turnkey Lighter owner address is invalid.");
  }
  const ownerAddress = lighterOwnerAddress(turnkeyOwnerAddress);
  const transaction = validatedTransaction(input.transactionPlan, ownerAddress);
  const account = createAccountWithAddress({
    client: input.client,
    organizationId: signerOrganizationId,
    signWith: turnkeyOwnerAddress,
    ethereumAddress: turnkeyOwnerAddress as `0x${string}`,
  });
  const rawTransaction = normalizedRawTransaction(await account.signTransaction(transaction));
  return verifyLighterChangePubKeyTransaction({
    ownerAddress,
    transactionPlan: input.transactionPlan,
    rawTransaction,
  });
}

export async function verifyLighterChangePubKeyTransaction(input: {
  ownerAddress: string;
  transactionPlan: LighterChangePubKeyTransactionPlan;
  rawTransaction: unknown;
}) {
  const ownerAddress = lighterOwnerAddress(input.ownerAddress);
  const transaction = validatedTransaction(input.transactionPlan, ownerAddress);
  const rawTransaction = normalizedRawTransaction(input.rawTransaction);
  const recovered = await recoverTransactionAddress({ serializedTransaction: rawTransaction });
  if (recovered.toLowerCase() !== ownerAddress) {
    throw new Error("Turnkey Lighter association was signed by the wrong wallet.");
  }
  assertSignedTransaction(rawTransaction, transaction);
  return {
    raw_transaction: rawTransaction,
    transaction_hash: keccak256(rawTransaction),
  } as const;
}

function validatedTransaction(plan: LighterChangePubKeyTransactionPlan, ownerAddress: `0x${string}`) {
  if (
    plan.chain_id !== LIGHTER_MAINNET_CHAIN_ID ||
    plan.from.toLowerCase() !== ownerAddress ||
    plan.to.toLowerCase() !== LIGHTER_MAINNET_PROXY_ADDRESS.toLowerCase() ||
    plan.value !== "0x0" ||
    plan.function !== "changePubKey(uint48,uint8,bytes)" ||
    plan.transaction_signed !== false ||
    plan.transaction_broadcast !== false ||
    plan.simulation_required_before_signing !== true ||
    plan.simulation?.performed !== true || plan.simulation.succeeded !== true ||
    plan.simulation.chain_id_verified !== true || plan.simulation.exact_sender_verified !== true ||
    plan.simulation.exact_contract_verified !== true
  ) throw new Error("Lighter association transaction plan is not approved for signing.");
  const decoded = decodeFunctionData({ abi: LIGHTER_CHANGE_PUB_KEY_ABI, data: plan.data });
  if (decoded.functionName !== "changePubKey" || !decoded.args) {
    throw new Error("Lighter association calldata is invalid.");
  }
  const accountIndex = lighterAccountIndex(Number(decoded.args[0]));
  const apiKeyIndex = lighterApiKeyIndex(Number(decoded.args[1]));
  const publicKey = lighterPublicKey(String(decoded.args[2]));
  if (
    accountIndex !== plan.account_index || apiKeyIndex !== plan.api_key_index ||
    publicKey !== lighterPublicKey(plan.public_key)
  ) throw new Error("Lighter association calldata does not match its preparation.");
  const nonce = safeNumber(plan.nonce, "nonce");
  const gas = positiveBigInt(plan.gas, "gas");
  const maxFeePerGas = positiveBigInt(plan.max_fee_per_gas, "maximum fee");
  const maxPriorityFeePerGas = positiveBigInt(plan.max_priority_fee_per_gas, "priority fee");
  if (
    gas > LIGHTER_MAX_ASSOCIATION_GAS || maxFeePerGas > LIGHTER_MAX_FEE_PER_GAS ||
    maxPriorityFeePerGas > LIGHTER_MAX_PRIORITY_FEE_PER_GAS || maxPriorityFeePerGas > maxFeePerGas
  ) {
    throw new Error("Lighter association fee bounds are invalid.");
  }
  return {
    type: "eip1559" as const,
    chainId: LIGHTER_MAINNET_CHAIN_ID,
    nonce,
    gas,
    maxFeePerGas,
    maxPriorityFeePerGas,
    to: LIGHTER_MAINNET_PROXY_ADDRESS,
    value: BigInt(0),
    data: plan.data,
  };
}

function assertSignedTransaction(
  rawTransaction: TransactionSerializedEIP1559,
  expected: ReturnType<typeof validatedTransaction>,
) {
  const signed = parseTransaction(rawTransaction);
  const mismatch = [
    signed.type !== "eip1559" && "type",
    signed.chainId !== expected.chainId && "chain",
    signed.nonce !== expected.nonce && "nonce",
    signed.gas !== expected.gas && "gas",
    signed.maxFeePerGas !== expected.maxFeePerGas && "maximum fee",
    signed.maxPriorityFeePerGas !== expected.maxPriorityFeePerGas && "priority fee",
    (signed.accessList?.length ?? 0) !== 0 && "access list",
    signed.to?.toLowerCase() !== expected.to.toLowerCase() && "destination",
    (signed.value ?? BigInt(0)) !== expected.value && "value",
    (signed.data ?? "0x").toLowerCase() !== expected.data.toLowerCase() && "calldata",
  ].find(Boolean);
  if (mismatch) {
    throw new Error(`Turnkey altered the prepared Lighter association transaction (${mismatch}).`);
  }
}

function normalizedRawTransaction(value: unknown): TransactionSerializedEIP1559 {
  if (typeof value !== "string" || !/^0x02[0-9a-f]+$/i.test(value)) {
    throw new Error("Turnkey returned an invalid Lighter transaction.");
  }
  return value.toLowerCase() as TransactionSerializedEIP1559;
}

function positiveBigInt(value: unknown, label: string) {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) {
    throw new Error(`Lighter association ${label} is invalid.`);
  }
  const parsed = BigInt(value);
  if (parsed <= BigInt(0)) throw new Error(`Lighter association ${label} is invalid.`);
  return parsed;
}

function safeNumber(value: unknown, label: string) {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) {
    throw new Error(`Lighter association ${label} is invalid.`);
  }
  const parsed = Number(BigInt(value));
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Lighter association ${label} is invalid.`);
  return parsed;
}
