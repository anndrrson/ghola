import { createHash } from "node:crypto";
import {
  createOrGetStoredPrivateAccount,
  json,
  privateAccountLiveGuard,
} from "../../../_lib";
import {
  LIGHTER_MAINNET_CHAIN_ID,
  LIGHTER_MAINNET_PROXY_ADDRESS,
  buildLighterChangePubKeyIntent,
  lighterAccountIndex,
  lighterApiKeyIndex,
  lighterOwnerAddress,
  lighterPublicKey,
  type LighterChangePubKeyTransactionPlan,
} from "@/lib/lighter-agent-association";
import { verifyLighterChangePubKeyTransaction } from "@/lib/perps-turnkey-lighter-signing";
import { linkAgentPlatformFromBody } from "@/lib/private-agent-passport";
import {
  workerAuthorizationHeader,
  workerCapabilityExpectedFromBody,
} from "@/lib/private-agent-capability";
import { resolvePrivateAgentWorkerUrl } from "@/lib/private-account-worker-routing";

export const dynamic = "force-dynamic";

const WORKER_AUTHORIZE_PATH = "/venues/lighter/credentials/authorize";
const WORKER_RECEIPT_PATH = "/venues/lighter/credentials/receipt";

export async function POST(req: Request) {
  const guarded = await privateAccountLiveGuard(req, { allowSerializedOwnerTransaction: true });
  if (!guarded.ok) return guarded.response;
  const input = record(guarded.body);
  const account = await createOrGetStoredPrivateAccount(guarded.owner);
  const preparationId = string(input.preparation_id);
  const transactionPlan = record(input.transaction_plan) as unknown as LighterChangePubKeyTransactionPlan;
  const rawTransaction = string(input.raw_transaction);
  const suppliedHash = string(input.transaction_hash).toLowerCase();
  const encryptedVault = record(input.encrypted_execution_vault);
  const externalBroadcast = input.external_broadcast === true;
  const reconcileOnly = input.reconcile_only === true || externalBroadcast;
  let ownerAddress: `0x${string}`;
  let accountIndex: number;
  let apiKeyIndex: number;
  let publicKey: string;
  let verified: { transaction_hash: `0x${string}`; raw_transaction?: `0x02${string}` };
  try {
    ownerAddress = lighterOwnerAddress(string(input.owner_address));
    accountIndex = lighterAccountIndex(Number(input.account_index));
    apiKeyIndex = lighterApiKeyIndex(Number(input.api_key_index));
    publicKey = lighterPublicKey(string(input.public_key));
  } catch (error) {
    return json({ error: "lighter_owner_authorization_invalid", message: message(error) }, 403);
  }
  if (
    transactionPlan.account_index !== accountIndex || transactionPlan.api_key_index !== apiKeyIndex ||
    transactionPlan.public_key !== publicKey || !/^0x[0-9a-f]+$/i.test(string(transactionPlan.data))
  ) return json({ error: "lighter_owner_authorization_binding_invalid" }, 409);
  const expectedPreparationId = `lighter_prepare_${createHash("sha256").update(JSON.stringify({
    account_commitment: account.account_commitment,
    owner_address: ownerAddress,
    account_index: accountIndex,
    api_key_index: apiKeyIndex,
    public_key: publicKey,
    data: transactionPlan.data.toLowerCase(),
  })).digest("hex")}`;
  if (preparationId !== expectedPreparationId) {
    return json({ error: "lighter_preparation_binding_invalid" }, 409);
  }
  try {
    verified = externalBroadcast
      ? await verifyExternalLighterChangePubKeyTransaction({
        rpcUrl: lighterEthereumRpcUrl(process.env),
        ownerAddress,
        transactionPlan,
        transactionHash: suppliedHash,
      })
      : await verifyLighterChangePubKeyTransaction({
        ownerAddress,
        transactionPlan,
        rawTransaction,
      });
  } catch (error) {
    if (error instanceof ExternalTransactionPendingError) {
      return json({
        version: 1,
        venue_id: "lighter",
        status: "submitted",
        transaction_hash: suppliedHash,
        retry_allowed: false,
        reconcile_only: true,
      }, 202);
    }
    if (error instanceof ExternalTransactionRpcError) {
      return json({ error: "lighter_ethereum_verification_unavailable", retry_allowed: false }, 503);
    }
    return json({ error: "lighter_owner_authorization_invalid", message: message(error) }, 403);
  }
  if (verified.transaction_hash !== suppliedHash) {
    return json({ error: "lighter_owner_authorization_binding_invalid" }, 409);
  }

  const worker = workerConfig(process.env);
  if (!worker.url) return json({ error: "private_worker_unavailable" }, 503);
  const common = {
    version: 1,
    venue_id: "lighter",
    platform_class: "hyperliquid_style_market",
    execution_mode: "worker_generated_api_key",
    owner_commitment: guarded.owner.owner_commitment,
    account_commitment: account.account_commitment,
    owner_address: ownerAddress,
    account_index: accountIndex,
    api_key_index: apiKeyIndex,
    public_key: publicKey,
    preparation_id: preparationId,
    encrypted_execution_vault: encryptedVault,
  } as const;
  const workerPath = reconcileOnly ? WORKER_RECEIPT_PATH : WORKER_AUTHORIZE_PATH;
  const workerPayload = reconcileOnly ? {
    ...common,
    operation_class: "credential_receipt",
    transaction_hash: verified.transaction_hash,
  } as const : {
    ...common,
    operation_class: "credential_authorize",
    raw_transaction: verified.raw_transaction,
  } as const;
  const authorization = workerAuthorizationHeader({
    fallbackToken: worker.token,
    method: "POST",
    path: workerPath,
    scope: reconcileOnly ? "credential:verify" : "credential:authorize",
    body: workerPayload,
    expected: workerCapabilityExpectedFromBody(workerPayload),
  });
  if (!authorization) return json({ error: "private_worker_authorization_unavailable" }, 503);
  const response = await fetch(new URL(workerPath, worker.url), {
    method: "POST",
    cache: "no-store",
    headers: {
      authorization,
      "content-type": "application/json",
      ...(!reconcileOnly ? {
        "x-ghola-credential-authorization-required": "true",
        "x-ghola-sealed-execution-required": "true",
      } : {}),
    },
    body: JSON.stringify(workerPayload),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!response) {
    return json({
      error: "lighter_association_outcome_ambiguous",
      transaction_hash: verified.transaction_hash,
      retry_allowed: false,
      reconcile_only: true,
    }, 502);
  }
  const receipt = record(await response.json().catch(() => null));
  if (!response.ok) {
    const errorCode = string(receipt.error_code) || string(receipt.error) || "lighter_association_failed";
    return json({
      error: errorCode,
      transaction_hash: verified.transaction_hash,
      retry_allowed: false,
      reconcile_only: true,
    }, response.status);
  }
  if (receipt.status !== "ready") {
    if (!validPendingReceipt(receipt, common, verified.transaction_hash)) {
      return json({ error: "lighter_association_receipt_invalid" }, 502);
    }
    return json({
      version: 1,
      venue_id: "lighter",
      status: receipt.status,
      preparation_id: preparationId,
      transaction_hash: verified.transaction_hash,
      retry_allowed: false,
      reconcile_only: true,
      setup: record(receipt.setup),
    }, 202);
  }
  if (!validReadyReceipt(receipt, common, verified.transaction_hash)) {
    return json({ error: "lighter_association_receipt_invalid" }, 502);
  }

  const linked = await linkAgentPlatformFromBody({
    venue_id: "lighter",
    platform_class: "hyperliquid_style_market",
    execution_mode: "byo_api_key",
    provisioning_mode: "programmatic_generated",
    turnkey_role: externalBroadcast ? "none" : "venue_owner",
    owner_authorization_source: externalBroadcast ? "external_owner_signature" : "turnkey_venue_owner",
    explicit_owner_authorization: true,
    owner_binding_verified: true,
    secret_handling: "direct_to_attested_runtime",
    silent_provisioning: false,
    permission_attestation: receipt.permissions,
    encrypted_execution_vault: receipt.encrypted_execution_vault,
  }, guarded.owner);
  if ("error" in linked) {
    return json({
      error: linked.error,
      credential_registered: true,
      needs_link_retry: true,
      preparation_id: preparationId,
      transaction_hash: verified.transaction_hash,
    }, 502);
  }
  return json({
    version: 1,
    venue_id: "lighter",
    status: "ready",
    preparation_id: preparationId,
    transaction_hash: verified.transaction_hash,
    credential_registered: true,
    setup: record(receipt.setup),
    platform_link: linked,
  }, 201);
}

async function verifyExternalLighterChangePubKeyTransaction(input: {
  rpcUrl: string;
  ownerAddress: `0x${string}`;
  transactionPlan: LighterChangePubKeyTransactionPlan;
  transactionHash: string;
}): Promise<{ transaction_hash: `0x${string}` }> {
  if (!/^0x[0-9a-f]{64}$/i.test(input.transactionHash)) {
    throw new Error("Lighter association transaction hash is invalid.");
  }
  const plan = input.transactionPlan;
  const expected = buildLighterChangePubKeyIntent({
    ownerAddress: input.ownerAddress,
    accountIndex: plan.account_index,
    apiKeyIndex: plan.api_key_index,
    publicKey: plan.public_key,
  });
  if (
    plan.chain_id !== LIGHTER_MAINNET_CHAIN_ID ||
    plan.from.toLowerCase() !== input.ownerAddress ||
    plan.to.toLowerCase() !== LIGHTER_MAINNET_PROXY_ADDRESS.toLowerCase() ||
    plan.data.toLowerCase() !== expected.data.toLowerCase() ||
    plan.value !== "0x0" || plan.transaction_signed !== false ||
    plan.transaction_broadcast !== false || plan.simulation_required_before_signing !== true ||
    plan.simulation?.performed !== true || plan.simulation.succeeded !== true ||
    plan.simulation.chain_id_verified !== true || plan.simulation.exact_sender_verified !== true ||
    plan.simulation.exact_contract_verified !== true
  ) throw new Error("Lighter association transaction plan is invalid.");
  const transaction = await ethereumRpc(input.rpcUrl, "eth_getTransactionByHash", [input.transactionHash]);
  if (transaction === null) throw new ExternalTransactionPendingError();
  if (transaction === undefined) throw new ExternalTransactionRpcError();
  const actual = record(transaction);
  if (
    string(actual.hash).toLowerCase() !== input.transactionHash ||
    string(actual.from).toLowerCase() !== input.ownerAddress ||
    string(actual.to).toLowerCase() !== LIGHTER_MAINNET_PROXY_ADDRESS.toLowerCase() ||
    string(actual.input).toLowerCase() !== plan.data.toLowerCase() ||
    !sameQuantity(actual.value, plan.value) || !sameQuantity(actual.nonce, plan.nonce) ||
    !sameQuantity(actual.gas, plan.gas) || !sameQuantity(actual.maxFeePerGas, plan.max_fee_per_gas) ||
    !sameQuantity(actual.maxPriorityFeePerGas, plan.max_priority_fee_per_gas) ||
    !sameQuantity(actual.type, "0x2")
  ) throw new Error("The submitted Lighter association does not match its approved preparation.");
  return { transaction_hash: input.transactionHash.toLowerCase() as `0x${string}` };
}

async function ethereumRpc(url: string, method: string, params: unknown[]) {
  const response = await fetch(url, {
    method: "POST",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
    signal: AbortSignal.timeout(8_000),
  }).catch(() => null);
  if (!response?.ok) return undefined;
  const body = record(await response.json().catch(() => null));
  if (body.error) return undefined;
  return body.result;
}

function lighterEthereumRpcUrl(env: Record<string, string | undefined>) {
  const url = env.GHOLA_LIGHTER_ETHEREUM_RPC_URL?.trim() || "";
  if (!/^https:\/\//i.test(url)) throw new ExternalTransactionRpcError();
  return url;
}

function sameQuantity(left: unknown, right: unknown) {
  try {
    return typeof left === "string" && typeof right === "string" &&
      /^0x[0-9a-f]+$/i.test(left) && /^0x[0-9a-f]+$/i.test(right) &&
      BigInt(left) === BigInt(right);
  } catch {
    return false;
  }
}

class ExternalTransactionPendingError extends Error {}
class ExternalTransactionRpcError extends Error {}

function validPendingReceipt(
  receipt: Record<string, unknown>,
  binding: Record<string, unknown>,
  transactionHash: string,
) {
  const setup = record(receipt.setup);
  return receipt.version === 1 && receipt.venue_id === "lighter" &&
    ["submitted", "ambiguous", "confirmed_pending_index"].includes(string(receipt.status)) &&
    receipt.preparation_id === binding.preparation_id &&
    string(receipt.owner_address).toLowerCase() === binding.owner_address &&
    Number(receipt.account_index) === binding.account_index &&
    Number(receipt.api_key_index) === binding.api_key_index &&
    receipt.public_key === binding.public_key && receipt.transaction_hash === transactionHash &&
    setup.may_place_trade === false && setup.credential_registered === false &&
    setup.owner_association_verified === false;
}

function validReadyReceipt(
  receipt: Record<string, unknown>,
  binding: Record<string, unknown>,
  transactionHash: string,
) {
  const permissions = record(receipt.permissions);
  const setup = record(receipt.setup);
  const vault = record(receipt.encrypted_execution_vault);
  const expectedAad = [
    "ghola/lighter-execution-vault-v1",
    `account:${binding.account_commitment}`,
    `recipient:${string(vault.recipient)}`,
    "network:mainnet",
  ].join("|");
  return validPendingReceipt({
    ...receipt,
    status: "submitted",
    setup: { ...setup, credential_registered: false, owner_association_verified: false },
  }, binding, transactionHash) && receipt.status === "ready" &&
    permissions.can_read === true && permissions.can_trade === true &&
    permissions.can_withdraw === false && permissions.can_transfer === false &&
    permissions.can_manage_credentials === false && permissions.can_export_secret === false &&
    Array.isArray(permissions.unknown_scopes) && permissions.unknown_scopes.length === 0 &&
    setup.transaction_broadcast === true && setup.credential_registered === true &&
    setup.owner_association_verified === true &&
    vault.alg === "sealed-provider-v1" && Boolean(string(vault.ciphertext)) &&
    Boolean(string(vault.recipient)) && vault.aad === expectedAad;
}

function workerConfig(env: Record<string, string | undefined>) {
  return {
    url: resolvePrivateAgentWorkerUrl({
      connector_url: env.GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_URL,
      execution_url: env.GHOLA_PRIVATE_AGENT_EXECUTION_URL || env.PRIVATE_AGENT_EXECUTION_URL,
      worker_url: env.GHOLA_PRIVATE_AGENT_WORKER_URL || env.PRIVATE_AGENT_WORKER_URL,
      phala_endpoint: env.PHALA_AGENT_ENDPOINT,
    }),
    token: env.GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_TOKEN?.trim() ||
      env.GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN?.trim() ||
      env.PRIVATE_AGENT_EXECUTION_TOKEN?.trim() ||
      env.PRIVATE_AGENT_WORKER_TOKEN?.trim() || "",
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function string(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "";
}
