import { createHash } from "node:crypto";
import { toHex } from "viem";
import {
  createOrGetStoredPrivateAccount,
  json,
  privateAccountLiveGuard,
} from "../../../_lib";
import {
  LIGHTER_MAINNET_API_URL,
  LIGHTER_MAINNET_PROXY_ADDRESS,
  buildLighterChangePubKeyIntent,
  lighterOwnerAddress,
  lighterPublicKey,
  selectLighterApiKeyIndex,
  selectLighterOwnerAccount,
} from "@/lib/lighter-agent-association";
import {
  workerAuthorizationHeader,
  workerCapabilityExpectedFromBody,
} from "@/lib/private-agent-capability";
import { resolvePrivateAgentWorkerUrl } from "@/lib/private-account-worker-routing";

export const dynamic = "force-dynamic";

const WORKER_PATH = "/venues/lighter/credentials/prepare";

export async function POST(req: Request) {
  const guarded = await privateAccountLiveGuard(req);
  if (!guarded.ok) return guarded.response;
  const input = record(guarded.body);
  let ownerAddress: `0x${string}`;
  let requestedAccountIndex: number | null = null;
  let requestedApiKeyIndex: number | null = null;
  try {
    ownerAddress = lighterOwnerAddress(string(input.owner_address));
    if (input.account_index !== undefined) requestedAccountIndex = exactNonnegativeInteger(input.account_index);
    if (input.api_key_index !== undefined) requestedApiKeyIndex = exactNonnegativeInteger(input.api_key_index);
  } catch (error) {
    return json({ error: message(error) || "lighter_prepare_request_invalid" }, 400);
  }

  const worker = workerConfig(process.env);
  if (!worker.url) return json({ error: "private_worker_unavailable" }, 503);
  const [accountsResponse, infoResponse] = await Promise.all([
    publicLighterFetch(`/api/v1/accountsByL1Address?l1_address=${encodeURIComponent(ownerAddress)}`),
    publicLighterFetch("/info"),
  ]);
  if (!accountsResponse || !infoResponse) {
    return json({ error: "lighter_public_preflight_unavailable" }, 503);
  }
  const [accountsBody, infoBody] = await Promise.all([
    accountsResponse.json().catch(() => null),
    infoResponse.json().catch(() => null),
  ]);
  if (!accountsResponse.ok) {
    const lighterError = record(accountsBody);
    if (
      accountsResponse.status === 400 &&
      (Number(lighterError.code) === 21100 || /account not found/i.test(string(lighterError.message)))
    ) {
      return json({
        error: "lighter_owner_account_not_found",
        message: "Lighter has no account for this Ghola owner. Activate this exact address on Lighter first; no key or transaction was created.",
        owner_address: ownerAddress,
        activation_url: "https://app.lighter.xyz/",
        account_activation_required: true,
        retry_allowed_after_activation: true,
      }, 409);
    }
    return json({ error: "lighter_account_lookup_unavailable" }, 503);
  }
  if (!infoResponse.ok) {
    return json({ error: "lighter_public_preflight_unavailable" }, 503);
  }
  let accountIndex: number;
  try {
    accountIndex = selectLighterOwnerAccount({
      response: accountsBody,
      ownerAddress,
      requestedAccountIndex,
    }).account_index;
    if (string(record(infoBody).contract_address).toLowerCase() !== LIGHTER_MAINNET_PROXY_ADDRESS.toLowerCase()) {
      throw new Error("Lighter contract identity could not be verified.");
    }
  } catch (error) {
    return json({ error: message(error) || "lighter_public_preflight_failed" }, 409);
  }
  const apiKeysResponse = await publicLighterFetch(`/api/v1/apikeys?account_index=${accountIndex}&api_key_index=255`);
  if (!apiKeysResponse?.ok) return json({ error: "lighter_public_preflight_unavailable" }, 503);
  const apiKeysBody = await apiKeysResponse.json().catch(() => null);
  let apiKeyIndex: number;
  try {
    apiKeyIndex = selectLighterApiKeyIndex({
      response: apiKeysBody,
      accountIndex,
      requestedApiKeyIndex,
    });
  } catch (error) {
    return json({ error: message(error) || "lighter_public_preflight_failed" }, 409);
  }

  const account = await createOrGetStoredPrivateAccount(guarded.owner);
  const payload = {
    version: 1,
    venue_id: "lighter",
    platform_class: "hyperliquid_style_market",
    execution_mode: "worker_generated_api_key",
    operation_class: "credential_provision",
    owner_commitment: guarded.owner.owner_commitment,
    account_commitment: account.account_commitment,
    owner_address: ownerAddress,
    account_index: accountIndex,
    api_key_index: apiKeyIndex,
  } as const;
  const authorization = workerAuthorizationHeader({
    fallbackToken: worker.token,
    method: "POST",
    path: WORKER_PATH,
    scope: "credential:provision",
    body: payload,
    expected: workerCapabilityExpectedFromBody(payload),
  });
  if (!authorization) return json({ error: "private_worker_authorization_unavailable" }, 503);
  const workerResponse = await fetch(new URL(WORKER_PATH, worker.url), {
    method: "POST",
    cache: "no-store",
    headers: {
      authorization,
      "content-type": "application/json",
      "x-ghola-sealed-execution-required": "true",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(12_000),
  }).catch(() => null);
  if (!workerResponse) return json({ error: "private_worker_unavailable" }, 503);
  const workerBody = record(await workerResponse.json().catch(() => null));
  if (!workerResponse.ok) {
    return json({
      error: string(workerBody.error_code) || string(workerBody.error) || "lighter_credential_prepare_failed",
    }, workerResponse.status);
  }
  const prepared = validatePreparedCredential(workerBody, payload);
  if (!prepared) return json({ error: "lighter_worker_response_invalid" }, 502);
  const transactionIntent = buildLighterChangePubKeyIntent({
    ownerAddress,
    accountIndex,
    apiKeyIndex,
    publicKey: prepared.publicKey,
  });
  const transactionPlan = await buildEthereumTransactionPlan(transactionIntent, process.env);
  if (!transactionPlan) return json({ error: "lighter_ethereum_simulation_unavailable" }, 503);
  const preparationId = `lighter_prepare_${createHash("sha256").update(JSON.stringify({
    account_commitment: account.account_commitment,
    owner_address: ownerAddress,
    account_index: accountIndex,
    api_key_index: apiKeyIndex,
    public_key: prepared.publicKey,
    data: transactionIntent.data,
  })).digest("hex")}`;
  return json({
    version: 1,
    preparation_id: preparationId,
    owner_commitment: guarded.owner.owner_commitment,
    account_commitment: account.account_commitment,
    venue_id: "lighter",
    credential_provisioning_mode: "programmatic_generated",
    owner_approval_required: true,
    owner_association: {
      method: "ethereum_change_pub_key",
      status: "transaction_prepared",
      ethereum_gas_required: true,
    },
    transaction_plan: transactionPlan,
    encrypted_execution_vault: prepared.encryptedVault,
    attested_signer: prepared.attestedSigner,
    authority_boundary: prepared.authorityBoundary,
    setup: {
      may_place_trade: false,
      transaction_signed: false,
      transaction_broadcast: false,
      credential_ready: false,
    },
  }, 201);
}

async function publicLighterFetch(path: string) {
  return fetch(new URL(path, LIGHTER_MAINNET_API_URL), {
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  }).catch(() => null);
}

async function buildEthereumTransactionPlan(
  intent: ReturnType<typeof buildLighterChangePubKeyIntent>,
  env: Record<string, string | undefined>,
) {
  const rpcUrl = env.GHOLA_LIGHTER_ETHEREUM_RPC_URL?.trim();
  if (!rpcUrl || !/^https:\/\//i.test(rpcUrl)) return null;
  const transaction = {
    from: intent.from,
    to: intent.to,
    value: intent.value,
    data: intent.data,
  };
  const [chainId, callResult, nonce, gasEstimate, priorityFee, latestBlock] = await Promise.all([
    ethereumRpc(rpcUrl, "eth_chainId", []),
    ethereumRpc(rpcUrl, "eth_call", [transaction, "latest"]),
    ethereumRpc(rpcUrl, "eth_getTransactionCount", [intent.from, "pending"]),
    ethereumRpc(rpcUrl, "eth_estimateGas", [transaction]),
    ethereumRpc(rpcUrl, "eth_maxPriorityFeePerGas", []),
    ethereumRpc(rpcUrl, "eth_getBlockByNumber", ["latest", false]),
  ]);
  const gas = hexQuantity(gasEstimate);
  const priority = hexQuantity(priorityFee);
  const baseFee = hexQuantity(record(latestBlock).baseFeePerGas);
  if (
    chainId !== "0x1" || callResult !== "0x" ||
    hexQuantity(nonce, true) == null || !gas || gas > BigInt(500_000) || !priority || !baseFee
  ) return null;
  return {
    ...intent,
    nonce: normalizedHexQuantity(nonce),
    gas: toHex(gas * BigInt(12) / BigInt(10)),
    max_priority_fee_per_gas: toHex(priority),
    max_fee_per_gas: toHex(baseFee * BigInt(2) + priority),
    simulation: {
      performed: true as const,
      succeeded: true as const,
      chain_id_verified: true as const,
      exact_sender_verified: true as const,
      exact_contract_verified: true as const,
    },
  };
}

async function ethereumRpc(url: string, method: string, params: unknown[]) {
  const response = await fetch(url, {
    method: "POST",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
    signal: AbortSignal.timeout(8_000),
  }).catch(() => null);
  if (!response?.ok) return null;
  const body = record(await response.json().catch(() => null));
  return body.error ? null : body.result;
}

function hexQuantity(value: unknown, allowZero = false): bigint | null {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) return null;
  try {
    const parsed = BigInt(value);
    return parsed > BigInt(0) || (allowZero && parsed === BigInt(0)) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizedHexQuantity(value: unknown): `0x${string}` {
  const parsed = hexQuantity(value, true);
  if (parsed == null) throw new Error("Ethereum quantity is invalid.");
  return toHex(parsed);
}

function validatePreparedCredential(body: Record<string, unknown>, request: {
  account_commitment: string;
  owner_address: string;
  account_index: number;
  api_key_index: number;
}) {
  const encryptedVault = record(body.encrypted_execution_vault);
  const attestedSigner = record(body.attested_signer);
  const authorityBoundary = record(body.authority_boundary);
  const setup = record(body.setup);
  let publicKey: string;
  try {
    publicKey = lighterPublicKey(string(body.public_key));
  } catch {
    return null;
  }
  const expectedAad = [
    "ghola/lighter-pending-execution-vault-v1",
    `account:${request.account_commitment}`,
    `recipient:${string(encryptedVault.recipient)}`,
    "network:mainnet",
  ].join("|");
  if (
    body.version !== 1 || body.venue_id !== "lighter" || body.network !== "mainnet" ||
    string(body.owner_address).toLowerCase() !== request.owner_address ||
    Number(body.account_index) !== request.account_index || Number(body.api_key_index) !== request.api_key_index ||
    encryptedVault.alg !== "sealed-provider-v1" || !string(encryptedVault.ciphertext) ||
    !string(encryptedVault.recipient) || encryptedVault.aad !== expectedAad ||
    attestedSigner.private_key_exposed !== false || !string(attestedSigner.worker_id) ||
    !/^sha256:[0-9a-f]{64}$/i.test(string(attestedSigner.attestation_sha256)) ||
    authorityBoundary.venue_native_trade_only !== false ||
    setup.may_place_trade !== false || setup.transaction_signed !== false ||
    setup.transaction_broadcast !== false || setup.credential_ready !== false
  ) return null;
  return { publicKey, encryptedVault, attestedSigner, authorityBoundary };
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

function exactNonnegativeInteger(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || String(value).trim() === "") {
    throw new Error("Lighter account or API-key index is invalid.");
  }
  return parsed;
}
