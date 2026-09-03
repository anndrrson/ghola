import "server-only";

import { getAddress, isAddress, zeroAddress } from "viem";
import {
  LIGHTER_MAINNET_API_URL,
  lighterAccountIndex,
} from "./lighter-agent-association";

export const LIGHTER_UDA_BASE_URL = "https://bridge.lighter.xyz";
export const LIGHTER_UDA_CHAIN_ID = "3586256";
export const LIGHTER_UDA_ACTION_TYPE = "LIGHTER_PERPS";
export const LIGHTER_UDA_MARKET = "perps";
export const LIGHTER_UDA_ASSET = "USDC";
export const LIGHTER_UDA_USDC_TOKEN_ADDRESS = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
export const LIGHTER_UDA_BASE_CHAIN_ID = "8453";
export const LIGHTER_UDA_BASE_USDC_TOKEN_ADDRESS = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
export const LIGHTER_UDA_MINIMUM_USDC_MICROUNITS = BigInt(5_000_000);

const REQUEST_TIMEOUT_MS = 5_000;
const DECIMAL_INTEGER = /^(?:0|[1-9][0-9]*)$/;
const EVM_TRANSACTION_HASH = /^0x[0-9a-fA-F]{64}$/;
const MAX_UINT256 = (BigInt(1) << BigInt(256)) - BigInt(1);
const MAX_UINT256_DECIMAL_DIGITS = MAX_UINT256.toString().length;

export type LighterUniversalDepositAddress = Readonly<{
  owner_address: `0x${string}`;
  deposit_address: `0x${string}`;
  market: typeof LIGHTER_UDA_MARKET;
  asset: typeof LIGHTER_UDA_ASSET;
  blocked: false;
  action_type: typeof LIGHTER_UDA_ACTION_TYPE;
  to_chain_id: typeof LIGHTER_UDA_CHAIN_ID;
  to_token_address: typeof LIGHTER_UDA_USDC_TOKEN_ADDRESS;
  recipient_address: string;
  recipient_binding: "owner_address" | "lighter_account_index";
  owner_account_index: number | null;
  resolved_user_id: `0x${string}`;
}>;

export type LighterUdaOwnerAccountBinding = Readonly<{
  owner_address: `0x${string}`;
  account_state: "new_account" | "existing_account";
  account_index: number | null;
}>;

export type LighterUniversalDepositTransaction = Readonly<{
  deposit_address: `0x${string}`;
  from_chain_id: string;
  from_token_address: string;
  from_amount_base_unit: string;
  to_chain_id: typeof LIGHTER_UDA_CHAIN_ID;
  to_token_address: string;
  transaction_hash: string;
  created_time_ms: number;
  status: "PROCESSING" | "COMPLETED";
}>;

export type LighterUniversalDepositStatus = Readonly<{
  owner_address: `0x${string}`;
  deposit_address: `0x${string}`;
  transactions: readonly LighterUniversalDepositTransaction[];
  completed: boolean;
}>;

export type ExactLighterUniversalDepositStatus = Readonly<{
  owner_address: `0x${string}`;
  deposit_address: `0x${string}`;
  transaction_hash: `0x${string}`;
  expected_amount_base_unit: string;
  observed: boolean;
  transaction: LighterUniversalDepositTransaction | null;
}>;

export async function createLighterUniversalDepositAddress({
  ownerAddress,
  ownerAccountBinding,
  fetchImpl = fetch,
}: {
  ownerAddress: string;
  ownerAccountBinding: LighterUdaOwnerAccountBinding;
  fetchImpl?: typeof fetch;
}): Promise<LighterUniversalDepositAddress> {
  const owner = validatedAddress(ownerAddress, "lighter_uda_owner_address_invalid");
  const binding = validatedOwnerAccountBinding(ownerAccountBinding, owner);
  assertLighterUdaCreateConfigured();
  const response = await lighterUdaFetch(
    `${LIGHTER_UDA_BASE_URL}/v1/uda`,
    {
      method: "POST",
      headers: lighterHeaders(true),
      body: JSON.stringify({
        walletAddress: owner,
        market: LIGHTER_UDA_MARKET,
        asset: LIGHTER_UDA_ASSET,
      }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
    fetchImpl,
    "create",
  );
  const body = await jsonObject(response, "lighter_uda_create_response_invalid");
  const resolved = object(body.resolved);
  if (
    body.blocked !== false ||
    !resolved ||
    resolved.actionType !== LIGHTER_UDA_ACTION_TYPE
  ) {
    throw lighterUdaError("lighter_uda_create_response_invalid", 502);
  }
  if (normalizeChainId(resolved.toChainId) !== LIGHTER_UDA_CHAIN_ID) {
    throw lighterUdaError("lighter_uda_create_destination_chain_mismatch", 502);
  }
  const responseOwner = validatedResponseAddress(resolved.userId);
  const depositAddress = validatedResponseAddress(body.depositAddr);
  const toTokenAddress = validatedResponseAddress(resolved.toTokenAddress);
  const recipientAddress = validatedRecipient(resolved.recipientAddr, binding);
  if (
    responseOwner.toLowerCase() !== owner.toLowerCase() ||
    depositAddress.toLowerCase() === owner.toLowerCase() ||
    depositAddress.toLowerCase() === zeroAddress ||
    toTokenAddress.toLowerCase() !== LIGHTER_UDA_USDC_TOKEN_ADDRESS.toLowerCase()
  ) {
    throw lighterUdaError("lighter_uda_create_response_invalid", 502);
  }
  return Object.freeze({
    owner_address: owner,
    deposit_address: depositAddress,
    market: LIGHTER_UDA_MARKET,
    asset: LIGHTER_UDA_ASSET,
    blocked: false,
    action_type: LIGHTER_UDA_ACTION_TYPE,
    to_chain_id: LIGHTER_UDA_CHAIN_ID,
    to_token_address: LIGHTER_UDA_USDC_TOKEN_ADDRESS,
    recipient_address: recipientAddress,
    recipient_binding: binding.account_index === null ? "owner_address" : "lighter_account_index",
    owner_account_index: binding.account_index,
    resolved_user_id: responseOwner,
  });
}

export async function readLighterUdaOwnerAccountBinding({
  ownerAddress,
  fetchImpl = fetch,
}: {
  ownerAddress: string;
  fetchImpl?: typeof fetch;
}): Promise<LighterUdaOwnerAccountBinding> {
  const owner = validatedAddress(ownerAddress, "lighter_uda_owner_address_invalid");
  let response: Response;
  try {
    response = await fetchImpl(
      `${LIGHTER_MAINNET_API_URL}/api/v1/accountsByL1Address?l1_address=${encodeURIComponent(owner)}`,
      {
        method: "GET",
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
  } catch {
    throw lighterUdaError("lighter_uda_owner_account_lookup_unavailable", 503);
  }
  const body = object(await response.json().catch(() => null));
  if (!body) throw lighterUdaError("lighter_uda_owner_account_lookup_invalid", 502);
  if (response.status === 400 && Number(body.code) === 21100) {
    return Object.freeze({
      owner_address: owner,
      account_state: "new_account",
      account_index: null,
    });
  }
  if (!response.ok) throw lighterUdaError("lighter_uda_owner_account_lookup_unavailable", 503);
  const accountIndex = exactOwnerAccountIndex(body, owner);
  return Object.freeze({
    owner_address: owner,
    account_state: "existing_account",
    account_index: accountIndex,
  });
}

export async function readLighterUniversalDepositStatus({
  ownerAddress,
  depositAddress,
  fetchImpl = fetch,
}: {
  ownerAddress: string;
  depositAddress: string;
  fetchImpl?: typeof fetch;
}): Promise<LighterUniversalDepositStatus> {
  const owner = validatedAddress(ownerAddress, "lighter_uda_owner_address_invalid");
  const expectedDepositAddress = validatedAddress(depositAddress, "lighter_uda_deposit_address_invalid");
  if (
    expectedDepositAddress.toLowerCase() === owner.toLowerCase() ||
    expectedDepositAddress.toLowerCase() === zeroAddress
  ) {
    throw lighterUdaError("lighter_uda_deposit_address_invalid", 400);
  }
  const response = await lighterUdaFetch(
    `${LIGHTER_UDA_BASE_URL}/v1/uda/status/${encodeURIComponent(owner)}`,
    {
      method: "GET",
      headers: lighterHeaders(false),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
    fetchImpl,
    "status",
  );
  const body = await jsonObject(response, "lighter_uda_status_response_invalid");
  if (!Array.isArray(body.transactions)) {
    throw lighterUdaError("lighter_uda_status_response_invalid", 502);
  }
  const transactions = body.transactions.map((value) => validateTransaction(value, expectedDepositAddress));
  return Object.freeze({
    owner_address: owner,
    deposit_address: expectedDepositAddress,
    transactions: Object.freeze(transactions),
    completed: transactions.some((transaction) => transaction.status === "COMPLETED"),
  });
}

export async function readExactLighterUniversalDepositStatus({
  ownerAddress,
  depositAddress,
  transactionHash,
  expectedAmountBaseUnit,
  fetchImpl = fetch,
}: {
  ownerAddress: string;
  depositAddress: string;
  transactionHash: string;
  expectedAmountBaseUnit: string;
  fetchImpl?: typeof fetch;
}): Promise<ExactLighterUniversalDepositStatus> {
  const owner = validatedAddress(ownerAddress, "lighter_uda_owner_address_invalid");
  const expectedDepositAddress = validatedAddress(depositAddress, "lighter_uda_deposit_address_invalid");
  const expectedTransactionHash = validatedTransactionHash(transactionHash);
  const expectedAmount = validatedExpectedAmount(expectedAmountBaseUnit);
  if (
    expectedDepositAddress.toLowerCase() === owner.toLowerCase() ||
    expectedDepositAddress.toLowerCase() === zeroAddress
  ) {
    throw lighterUdaError("lighter_uda_deposit_address_invalid", 400);
  }
  const response = await fetchLighterUdaStatus(owner, fetchImpl);
  const body = await jsonObject(response, "lighter_uda_status_response_invalid");
  if (!Array.isArray(body.transactions)) {
    throw lighterUdaError("lighter_uda_status_response_invalid", 502);
  }
  const exactCandidates = body.transactions.filter((value) => {
    const transaction = object(value);
    if (!transaction || !string(transaction.txHash)) {
      throw lighterUdaError("lighter_uda_status_response_invalid", 502);
    }
    return String(transaction.txHash).toLowerCase() === expectedTransactionHash.toLowerCase();
  });
  if (exactCandidates.length > 1) {
    throw lighterUdaError("lighter_uda_status_response_ambiguous", 502);
  }
  if (exactCandidates.length === 0) {
    return Object.freeze({
      owner_address: owner,
      deposit_address: expectedDepositAddress,
      transaction_hash: expectedTransactionHash,
      expected_amount_base_unit: expectedAmount,
      observed: false,
      transaction: null,
    });
  }
  const transaction = validateTransaction(exactCandidates[0], expectedDepositAddress);
  if (
    transaction.transaction_hash.toLowerCase() !== expectedTransactionHash.toLowerCase() ||
    transaction.from_amount_base_unit !== expectedAmount
  ) {
    throw lighterUdaError("lighter_uda_status_binding_mismatch", 502);
  }
  return Object.freeze({
    owner_address: owner,
    deposit_address: expectedDepositAddress,
    transaction_hash: expectedTransactionHash,
    expected_amount_base_unit: expectedAmount,
    observed: true,
    transaction,
  });
}

export function validatedLighterDepositExpectation({
  transactionHash,
  expectedAmountBaseUnit,
}: {
  transactionHash: unknown;
  expectedAmountBaseUnit: unknown;
}) {
  return Object.freeze({
    transaction_hash: validatedTransactionHash(transactionHash),
    expected_amount_base_unit: validatedExpectedAmount(expectedAmountBaseUnit),
  });
}

function validateTransaction(value: unknown, expectedDepositAddress: `0x${string}`): LighterUniversalDepositTransaction {
  const transaction = object(value);
  if (!transaction) throw lighterUdaError("lighter_uda_status_response_invalid", 502);
  const depositAddress = validatedResponseAddress(transaction.depositAddr);
  const fromChainId = normalizeChainId(transaction.fromChainId);
  const toChainId = normalizeChainId(transaction.toChainId);
  const fromAmountBaseUnit = string(transaction.fromAmountBaseUnit);
  const fromTokenAddress = responseAddressOrNull(transaction.fromTokenAddress);
  const toTokenAddress = responseAddressOrNull(transaction.toTokenAddress);
  const transactionHash = string(transaction.txHash);
  const createdTimeMs = transaction.createdTimeMs;
  const status = transaction.status;
  if (
    depositAddress.toLowerCase() !== expectedDepositAddress.toLowerCase() ||
    fromChainId !== LIGHTER_UDA_BASE_CHAIN_ID ||
    toChainId !== LIGHTER_UDA_CHAIN_ID ||
    !fromAmountBaseUnit ||
    !DECIMAL_INTEGER.test(fromAmountBaseUnit) ||
    BigInt(fromAmountBaseUnit) < LIGHTER_UDA_MINIMUM_USDC_MICROUNITS ||
    !fromTokenAddress ||
    fromTokenAddress.toLowerCase() !== LIGHTER_UDA_BASE_USDC_TOKEN_ADDRESS.toLowerCase() ||
    !toTokenAddress ||
    toTokenAddress.toLowerCase() !== LIGHTER_UDA_USDC_TOKEN_ADDRESS.toLowerCase() ||
    !transactionHash ||
    typeof createdTimeMs !== "number" ||
    !Number.isSafeInteger(createdTimeMs) ||
    createdTimeMs <= 0 ||
    (status !== "PROCESSING" && status !== "COMPLETED")
  ) {
    throw lighterUdaError("lighter_uda_status_response_invalid", 502);
  }
  return Object.freeze({
    deposit_address: depositAddress,
    from_chain_id: fromChainId,
    from_token_address: fromTokenAddress,
    from_amount_base_unit: fromAmountBaseUnit,
    to_chain_id: LIGHTER_UDA_CHAIN_ID,
    to_token_address: toTokenAddress,
    transaction_hash: transactionHash,
    created_time_ms: createdTimeMs,
    status,
  });
}

async function lighterUdaFetch(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
  operation: "create" | "status",
) {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch {
    throw lighterUdaError(`lighter_uda_${operation}_unavailable`, 503);
  }
  if (!response.ok) {
    if (response.status === 400) throw lighterUdaError(`lighter_uda_${operation}_rejected`, 502);
    if (response.status === 403) throw lighterUdaError(`lighter_uda_${operation}_permission_denied`, 502);
    if (response.status === 502) throw lighterUdaError(`lighter_uda_${operation}_dependency_unavailable`, 503);
    throw lighterUdaError(`lighter_uda_${operation}_unavailable`, 503);
  }
  return response;
}

function fetchLighterUdaStatus(owner: `0x${string}`, fetchImpl: typeof fetch) {
  return lighterUdaFetch(
    `${LIGHTER_UDA_BASE_URL}/v1/uda/status/${encodeURIComponent(owner)}`,
    {
      method: "GET",
      headers: lighterHeaders(false),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
    fetchImpl,
    "status",
  );
}

function lighterHeaders(json: boolean): HeadersInit {
  const builderKey = lighterBuilderKey();
  return json
    ? { "content-type": "application/json", "x-api-key": builderKey }
    : { "x-api-key": builderKey };
}

export function assertLighterUdaCreateConfigured() {
  void lighterBuilderKey();
}

function lighterBuilderKey() {
  const builderKey = process.env.GHOLA_LIGHTER_BUILDER_KEY?.trim();
  if (!builderKey) throw lighterUdaError("lighter_uda_builder_key_unconfigured", 503);
  return builderKey;
}

async function jsonObject(response: Response, errorCode: string) {
  const body = await response.json().catch(() => null);
  const value = object(body);
  if (!value) throw lighterUdaError(errorCode, 502);
  return value;
}

function validatedAddress(value: unknown, errorCode: string): `0x${string}` {
  if (typeof value !== "string" || !isAddress(value, { strict: true })) {
    throw lighterUdaError(errorCode, 400);
  }
  return getAddress(value);
}

function validatedResponseAddress(value: unknown): `0x${string}` {
  try {
    return validatedAddress(value, "lighter_uda_response_address_invalid");
  } catch {
    throw lighterUdaError("lighter_uda_response_address_invalid", 502);
  }
}

function normalizeChainId(value: unknown) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === "string" && DECIMAL_INTEGER.test(value)) return value;
  return null;
}

function validatedRecipient(value: unknown, binding: LighterUdaOwnerAccountBinding) {
  if (binding.account_index !== null) {
    const expected = String(binding.account_index);
    if (typeof value !== "string" || value !== expected || !DECIMAL_INTEGER.test(value)) {
      throw lighterUdaError("lighter_uda_create_response_invalid", 502);
    }
    return expected;
  }
  if (typeof value !== "string" || !isAddress(value, { strict: true })) {
    throw lighterUdaError("lighter_uda_create_response_invalid", 502);
  }
  const recipient = getAddress(value);
  if (recipient.toLowerCase() !== binding.owner_address.toLowerCase()) {
    throw lighterUdaError("lighter_uda_create_response_invalid", 502);
  }
  return recipient;
}

function validatedOwnerAccountBinding(
  value: LighterUdaOwnerAccountBinding,
  owner: `0x${string}`,
): LighterUdaOwnerAccountBinding {
  if (
    !value ||
    typeof value.owner_address !== "string" ||
    value.owner_address.toLowerCase() !== owner.toLowerCase() ||
    (value.account_state !== "new_account" && value.account_state !== "existing_account") ||
    (value.account_state === "new_account" && value.account_index !== null) ||
    (value.account_state === "existing_account" && value.account_index === null)
  ) throw lighterUdaError("lighter_uda_owner_account_binding_invalid", 500);
  if (value.account_index !== null) {
    try {
      lighterAccountIndex(value.account_index);
    } catch {
      throw lighterUdaError("lighter_uda_owner_account_binding_invalid", 500);
    }
  }
  return value;
}

function exactOwnerAccountIndex(body: Record<string, unknown>, owner: `0x${string}`): number {
  const responseOwner = responseAddressOrNull(body.l1_address);
  if (Number(body.code) !== 200 || !responseOwner || responseOwner.toLowerCase() !== owner.toLowerCase() || !Array.isArray(body.sub_accounts)) {
    throw lighterUdaError("lighter_uda_owner_account_lookup_invalid", 502);
  }
  const owned: Array<{ account_index: number; account_type: number }> = [];
  for (const value of body.sub_accounts) {
    const row = object(value);
    if (!row) throw lighterUdaError("lighter_uda_owner_account_lookup_invalid", 502);
    const rowOwner = responseAddressOrNull(row.l1_address);
    if (!rowOwner) throw lighterUdaError("lighter_uda_owner_account_lookup_invalid", 502);
    if (rowOwner.toLowerCase() !== owner.toLowerCase()) continue;
    const accountType = exactDecimalInteger(row.account_type);
    const candidateIndex = exactDecimalInteger(row.index);
    let accountIndex: number;
    try {
      if (candidateIndex === null) throw new Error("invalid account index");
      accountIndex = lighterAccountIndex(candidateIndex);
    } catch {
      throw lighterUdaError("lighter_uda_owner_account_lookup_invalid", 502);
    }
    if (accountType === null) {
      throw lighterUdaError("lighter_uda_owner_account_lookup_invalid", 502);
    }
    owned.push({ account_index: accountIndex, account_type: accountType });
  }
  if (owned.length === 0 || new Set(owned.map((row) => row.account_index)).size !== owned.length) {
    throw lighterUdaError("lighter_uda_owner_account_lookup_invalid", 502);
  }
  const masterAccounts = owned.filter((row) => row.account_type === 0);
  if (masterAccounts.length === 1) return masterAccounts[0].account_index;
  if (masterAccounts.length === 0 && owned.length === 1) return owned[0].account_index;
  throw lighterUdaError("lighter_uda_owner_account_lookup_ambiguous", 409);
}

function exactDecimalInteger(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== "string" || !DECIMAL_INTEGER.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && String(parsed) === value ? parsed : null;
}

function responseAddressOrNull(value: unknown): `0x${string}` | null {
  return typeof value === "string" && isAddress(value, { strict: true })
    ? getAddress(value)
    : null;
}

function validatedTransactionHash(value: unknown): `0x${string}` {
  if (typeof value !== "string" || !EVM_TRANSACTION_HASH.test(value)) {
    throw lighterUdaError("lighter_uda_transaction_hash_invalid", 400);
  }
  return value.toLowerCase() as `0x${string}`;
}

function validatedExpectedAmount(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > MAX_UINT256_DECIMAL_DIGITS ||
    !DECIMAL_INTEGER.test(value) ||
    BigInt(value) < LIGHTER_UDA_MINIMUM_USDC_MICROUNITS ||
    BigInt(value) > MAX_UINT256
  ) {
    throw lighterUdaError("lighter_uda_expected_amount_invalid", 400);
  }
  return value;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function string(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function lighterUdaError(code: string, status: number) {
  return Object.assign(new Error(code), { code, status });
}
