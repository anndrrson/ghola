import "server-only";

import { getAddress, isAddress, zeroAddress } from "viem";
import {
  LIGHTER_UDA_BASE_CHAIN_ID,
  LIGHTER_UDA_BASE_URL,
  LIGHTER_UDA_BASE_USDC_TOKEN_ADDRESS,
  LIGHTER_UDA_CHAIN_ID,
  LIGHTER_UDA_MINIMUM_USDC_MICROUNITS,
  LIGHTER_UDA_USDC_TOKEN_ADDRESS,
  lighterUdaError,
} from "./lighter-universal-deposit-address.server";

const MAX_PRE_ATTEMPT_EVIDENCE_AGE_MS = 15 * 60_000;
const MAX_FUTURE_EVIDENCE_SKEW_MS = 60_000;
const REQUEST_TIMEOUT_MS = 5_000;
const DECIMAL_INTEGER = /^(?:0|[1-9][0-9]*)$/;
const TRANSACTION_HASH = /^0x[0-9a-f]{64}$/i;

export type LighterUdaAttemptReconciliationEvidence = Readonly<{
  owner_address: `0x${string}`;
  current_funding_destination_proven: false;
  historical_activity_observed: boolean;
  historical_destination_count: number;
  provider_transaction_count: number;
  qualifying_transaction_count: number;
  evidence_source: "provider_owner_status_get";
}>;

export async function readLighterUdaAttemptReconciliationEvidence(input: {
  ownerAddress: string;
  attemptCreatedAt: string;
  checkedAtMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<LighterUdaAttemptReconciliationEvidence> {
  const owner = address(input.ownerAddress, "lighter_uda_owner_address_invalid", 400);
  const attemptCreatedAtMs = Date.parse(input.attemptCreatedAt);
  const checkedAtMs = input.checkedAtMs ?? Date.now();
  if (!Number.isFinite(attemptCreatedAtMs) || !Number.isSafeInteger(checkedAtMs) || checkedAtMs <= 0) {
    throw lighterUdaError("lighter_uda_reconciliation_attempt_time_invalid", 500);
  }
  const builderKey = process.env.GHOLA_LIGHTER_BUILDER_KEY?.trim();
  if (!builderKey) throw lighterUdaError("lighter_uda_builder_key_unconfigured", 503);
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(
      `${LIGHTER_UDA_BASE_URL}/v1/uda/status/${encodeURIComponent(owner)}`,
      {
        method: "GET",
        headers: { "x-api-key": builderKey },
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
  } catch {
    throw lighterUdaError("lighter_uda_reconciliation_status_unavailable", 503);
  }
  if (!response.ok) {
    throw lighterUdaError(
      response.status === 403
        ? "lighter_uda_reconciliation_status_permission_denied"
        : "lighter_uda_reconciliation_status_unavailable",
      response.status === 502 ? 503 : 502,
    );
  }
  const body = object(await response.json().catch(() => null));
  if (!body || !Array.isArray(body.transactions)) {
    throw lighterUdaError("lighter_uda_reconciliation_status_response_invalid", 502);
  }
  if (body.walletAddress !== undefined &&
    address(body.walletAddress, "lighter_uda_reconciliation_owner_binding_mismatch", 502).toLowerCase() !== owner.toLowerCase()) {
    throw lighterUdaError("lighter_uda_reconciliation_owner_binding_mismatch", 502);
  }
  const transactions = body.transactions.map((value) => providerTransaction(value, owner));
  const deposits = new Map<string, `0x${string}`>();
  for (const transaction of transactions) {
    deposits.set(transaction.deposit_address.toLowerCase(), transaction.deposit_address);
  }
  const qualifying = transactions.filter((transaction) =>
    transaction.created_time_ms >= attemptCreatedAtMs - MAX_PRE_ATTEMPT_EVIDENCE_AGE_MS &&
    transaction.created_time_ms <= checkedAtMs + MAX_FUTURE_EVIDENCE_SKEW_MS
  );
  return Object.freeze({
    owner_address: owner,
    // The documented status endpoint contains historical transactions only. It
    // does not prove the UDA's current blocked flag or resolved recipient.
    current_funding_destination_proven: false,
    historical_activity_observed: qualifying.length > 0,
    historical_destination_count: deposits.size,
    provider_transaction_count: transactions.length,
    qualifying_transaction_count: qualifying.length,
    evidence_source: "provider_owner_status_get",
  });
}

function providerTransaction(value: unknown, owner: `0x${string}`) {
  const transaction = object(value);
  if (!transaction) throw lighterUdaError("lighter_uda_reconciliation_status_response_invalid", 502);
  const depositAddress = address(transaction.depositAddr, "lighter_uda_reconciliation_status_response_invalid", 502);
  const fromToken = address(transaction.fromTokenAddress, "lighter_uda_reconciliation_status_response_invalid", 502);
  const toToken = address(transaction.toTokenAddress, "lighter_uda_reconciliation_status_response_invalid", 502);
  const fromChain = chainId(transaction.fromChainId);
  const toChain = chainId(transaction.toChainId);
  const amount = typeof transaction.fromAmountBaseUnit === "string" ? transaction.fromAmountBaseUnit : "";
  const hash = typeof transaction.txHash === "string" ? transaction.txHash : "";
  const createdTimeMs = transaction.createdTimeMs;
  if (
    depositAddress.toLowerCase() === zeroAddress ||
    depositAddress.toLowerCase() === owner.toLowerCase() ||
    fromChain !== LIGHTER_UDA_BASE_CHAIN_ID || toChain !== LIGHTER_UDA_CHAIN_ID ||
    fromToken.toLowerCase() !== LIGHTER_UDA_BASE_USDC_TOKEN_ADDRESS.toLowerCase() ||
    toToken.toLowerCase() !== LIGHTER_UDA_USDC_TOKEN_ADDRESS.toLowerCase() ||
    !DECIMAL_INTEGER.test(amount) || BigInt(amount) < LIGHTER_UDA_MINIMUM_USDC_MICROUNITS ||
    !TRANSACTION_HASH.test(hash) ||
    typeof createdTimeMs !== "number" || !Number.isSafeInteger(createdTimeMs) || createdTimeMs <= 0 ||
    (transaction.status !== "PROCESSING" && transaction.status !== "COMPLETED")
  ) throw lighterUdaError("lighter_uda_reconciliation_status_response_invalid", 502);
  return { deposit_address: depositAddress, created_time_ms: createdTimeMs } as const;
}

function address(value: unknown, code: string, status: number): `0x${string}` {
  if (typeof value !== "string" || !isAddress(value, { strict: true })) throw lighterUdaError(code, status);
  return getAddress(value);
}

function chainId(value: unknown) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return typeof value === "string" && DECIMAL_INTEGER.test(value) ? value : null;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
