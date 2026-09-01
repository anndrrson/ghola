import "server-only";

import { getAddress, isAddress, zeroAddress } from "viem";

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

export type LighterUniversalDepositAddress = Readonly<{
  owner_address: `0x${string}`;
  deposit_address: `0x${string}`;
  market: typeof LIGHTER_UDA_MARKET;
  asset: typeof LIGHTER_UDA_ASSET;
  blocked: false;
  action_type: typeof LIGHTER_UDA_ACTION_TYPE;
  to_chain_id: typeof LIGHTER_UDA_CHAIN_ID;
  to_token_address: typeof LIGHTER_UDA_USDC_TOKEN_ADDRESS;
  recipient_address: `0x${string}`;
  resolved_user_id: `0x${string}`;
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

export async function createLighterUniversalDepositAddress({
  ownerAddress,
  fetchImpl = fetch,
}: {
  ownerAddress: string;
  fetchImpl?: typeof fetch;
}): Promise<LighterUniversalDepositAddress> {
  const owner = validatedAddress(ownerAddress, "lighter_uda_owner_address_invalid");
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
    resolved.actionType !== LIGHTER_UDA_ACTION_TYPE ||
    normalizeChainId(resolved.toChainId) !== LIGHTER_UDA_CHAIN_ID
  ) {
    throw lighterUdaError("lighter_uda_create_response_invalid", 502);
  }
  const responseOwner = validatedResponseAddress(resolved.userId);
  const depositAddress = validatedResponseAddress(body.depositAddr);
  const toTokenAddress = validatedResponseAddress(resolved.toTokenAddress);
  const recipientAddress = validatedRecipient(resolved.recipientAddr, owner);
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
    resolved_user_id: responseOwner,
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

function validatedRecipient(value: unknown, owner: `0x${string}`) {
  if (typeof value !== "string" || !isAddress(value, { strict: true })) {
    throw lighterUdaError("lighter_uda_create_response_invalid", 502);
  }
  const recipient = getAddress(value);
  if (recipient.toLowerCase() !== owner.toLowerCase()) {
    throw lighterUdaError("lighter_uda_create_response_invalid", 502);
  }
  return recipient;
}

function responseAddressOrNull(value: unknown): `0x${string}` | null {
  return typeof value === "string" && isAddress(value, { strict: true })
    ? getAddress(value)
    : null;
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
