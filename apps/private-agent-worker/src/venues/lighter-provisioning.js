import { createHash, sign as edSign } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bytesToBase64,
  didKeyFromVerifying,
  hexToBytes,
  openSealedBundle,
  sealEnvelope,
} from "../crypto/envelope.js";
import { fundingSigningIdentity } from "./shielded_funding_attestation.js";
import {
  encodeFunctionData,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
} from "viem";

const PRIVATE_KEY = /^(?:0x)?[0-9a-f]{64}$/i;
const PUBLIC_KEY = /^(?:0x)?[0-9a-f]{80}$/i;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const SAFE_COMMITMENT = /^[A-Za-z0-9_.:-]{8,240}$/;
const MIN_API_KEY_INDEX = 2;
const MAX_API_KEY_INDEX = 254;
const MAX_ACCOUNT_INDEX = 281_474_976_710_655;
const GOLDILOCKS_MODULUS = 0xffffffff00000001n;
const LIGHTER_MAINNET_CHAIN_ID = 1;
const LIGHTER_MAINNET_PROXY_ADDRESS = "0x3b4d794a66304f130a4db8f2551b0070dfcf5ca7";
const LIGHTER_MAINNET_API_URL = "https://mainnet.zklighter.elliot.ai";
const PREPARATION_ID = /^lighter_prepare_[0-9a-f]{64}$/;
const TRANSACTION_HASH = /^0x[0-9a-f]{64}$/i;
const SERIALIZED_EIP1559 = /^0x02[0-9a-f]+$/i;
const LIGHTER_MAX_ASSOCIATION_GAS = 600_000n;
const LIGHTER_MAX_FEE_PER_GAS = 500_000_000_000n;
const LIGHTER_MAX_PRIORITY_FEE_PER_GAS = 50_000_000_000n;
const LIGHTER_CHANGE_PUB_KEY_ABI = [{
  type: "function",
  name: "changePubKey",
  stateMutability: "nonpayable",
  inputs: [
    { name: "accountIndex", type: "uint48" },
    { name: "apiKeyIndex", type: "uint8" },
    { name: "pubKey", type: "bytes" },
  ],
  outputs: [],
}];

export class LighterProvisioningError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.name = "LighterProvisioningError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Creates and seals a pending Lighter credential without associating it or
 * enabling any venue operation. The caller must complete owner association in
 * a separate, explicitly authorized step.
 */
export async function prepareLighterCredentialProvisioning({
  network,
  accountIndex,
  apiKeyIndex,
  generateApiKey,
  sealVault,
}) {
  const normalizedNetwork = lighterNetwork(network);
  const normalizedAccountIndex = lighterIndex(accountIndex, "account_index", MAX_ACCOUNT_INDEX);
  const normalizedApiKeyIndex = lighterApiKeyIndex(apiKeyIndex);
  if (typeof generateApiKey !== "function") {
    throw new LighterProvisioningError("Lighter SDK key generation is unavailable.", "key_generator_required");
  }
  if (typeof sealVault !== "function") {
    throw new LighterProvisioningError("Lighter vault sealing is unavailable.", "vault_sealer_required");
  }

  let generated;
  try {
    generated = await generateApiKey();
  } catch {
    throw new LighterProvisioningError("Lighter SDK key generation failed.", "key_generation_failed");
  }
  const { privateKey, publicKey } = lighterGeneratedKeyPair(generated);

  const pendingVault = {
    version: 1,
    kind: "ghola_lighter_pending_execution_vault",
    network: normalizedNetwork,
    account_index: normalizedAccountIndex,
    api_key_index: normalizedApiKeyIndex,
    api_private_key: privateKey,
    api_public_key: publicKey,
    provisioning_status: "pending_owner_association",
    permissions: {
      can_read: false,
      can_trade: false,
      can_withdraw: false,
      can_transfer: false,
    },
    allowed_operations: [],
    blocked_operations: ["read", "limit_order", "cancel", "reconcile", "withdraw", "transfer"],
  };

  let sealed;
  try {
    sealed = await sealVault(pendingVault);
  } catch {
    throw new LighterProvisioningError("Lighter credential sealing failed.", "vault_sealing_failed");
  }
  const sealedVault = lighterSealedVault(sealed, privateKey);

  return {
    enrollment_payload: {
      version: 1,
      venue_id: "lighter",
      network: normalizedNetwork,
      account_index: normalizedAccountIndex,
      api_key_index: normalizedApiKeyIndex,
      public_key: publicKey,
      owner_association: {
        status: "pending",
        method: "change_pub_key",
        explicit_owner_authorization_required: true,
        credential_ready: false,
        transaction_broadcast: false,
      },
      setup_permissions: {
        can_trade: false,
        can_withdraw: false,
        can_transfer: false,
      },
    },
    sealed_vault: sealedVault,
  };
}

/**
 * Generates a Lighter API key inside the attested worker and seals the private
 * half back to that worker. No Ethereum transaction is signed or broadcast.
 */
export async function prepareLighterCredential({
  ownerAddress,
  accountCommitment,
  accountIndex,
  apiKeyIndex,
  recipient,
  provider = "phala",
  attestationEvidence = {},
  now = () => new Date(),
  generateApiKey = runLighterKeygen,
  sealingIdentity = fundingSigningIdentity,
}) {
  const owner = String(ownerAddress || "").trim().toLowerCase();
  const account = String(accountCommitment || "").trim();
  if (!ADDRESS.test(owner)) {
    throw new LighterProvisioningError("Lighter owner address is invalid.", "owner_address_invalid");
  }
  if (!SAFE_COMMITMENT.test(account)) {
    throw new LighterProvisioningError("Private account commitment is invalid.", "account_commitment_invalid");
  }
  if (!recipient?.recipient_id || !/^[0-9a-f]{64}$/i.test(String(recipient.x25519_pub_hex || ""))) {
    throw new LighterProvisioningError("Attested worker recipient is unavailable.", "recipient_unavailable");
  }
  const createdAt = now();
  if (!(createdAt instanceof Date) || !Number.isFinite(createdAt.getTime())) {
    throw new LighterProvisioningError("Worker time is unavailable.", "worker_time_invalid");
  }
  const identity = sealingIdentity();
  const publicDer = identity?.publicKey?.export?.({ format: "der", type: "spki" });
  const publicBytes = publicDer ? new Uint8Array(Buffer.from(publicDer).subarray(-32)) : new Uint8Array();
  if (publicBytes.length !== 32 || !identity?.privateKey) {
    throw new LighterProvisioningError("Worker sealing identity is unavailable.", "sealing_identity_unavailable");
  }
  const associatedData = [
    "ghola/lighter-pending-execution-vault-v1",
    `account:${account}`,
    `recipient:${recipient.recipient_id}`,
    "network:mainnet",
  ].join("|");
  const prepared = await prepareLighterCredentialProvisioning({
    network: "mainnet",
    accountIndex,
    apiKeyIndex,
    generateApiKey,
    sealVault: async (pendingVault) => {
      const ciphertext = await sealEnvelope({
        recipientId: recipient.recipient_id,
        recipientX25519: hexToBytes(recipient.x25519_pub_hex),
        senderDid: didKeyFromVerifying(publicBytes),
        associatedData,
        plaintext: {
          ...pendingVault,
          account_commitment: account,
          owner_address: owner,
          owner_only_operations: ["withdraw", "transfer", "leverage", "margin", "account_config", "api_key_rotation"],
          venue_native_trade_only: false,
          created_at: createdAt.toISOString(),
        },
        signBody: async (digest) => new Uint8Array(edSign(null, Buffer.from(digest), identity.privateKey)),
      });
      return {
        alg: "sealed-provider-v1",
        ciphertext: bytesToBase64(ciphertext),
        recipient: recipient.recipient_id,
        aad: associatedData,
      };
    },
  });
  const publicKey = prepared.enrollment_payload.public_key;
  const attestationSha256 = `sha256:${createHash("sha256").update(JSON.stringify({
    recipient_id: recipient.recipient_id,
    owner_address: owner,
    account_index: prepared.enrollment_payload.account_index,
    api_key_index: prepared.enrollment_payload.api_key_index,
    public_key: publicKey,
    evidence: attestationEvidence,
  })).digest("hex")}`;
  return {
    version: 1,
    venue_id: "lighter",
    network: "mainnet",
    owner_address: owner,
    account_index: prepared.enrollment_payload.account_index,
    api_key_index: prepared.enrollment_payload.api_key_index,
    public_key: publicKey,
    encrypted_execution_vault: prepared.sealed_vault,
    attested_signer: {
      provider: String(provider || "phala").toLowerCase(),
      worker_id: recipient.recipient_id,
      attestation_sha256: attestationSha256,
      private_key_exposed: false,
    },
    owner_association: prepared.enrollment_payload.owner_association,
    authority_boundary: {
      venue_native_trade_only: false,
      enforced_by: "attested_worker_policy_after_association",
      owner_only: ["withdraw", "transfer", "leverage", "margin", "account_config", "api_key_rotation"],
    },
    setup: {
      may_place_trade: false,
      transaction_signed: false,
      transaction_broadcast: false,
      credential_ready: false,
    },
    created_at: createdAt.toISOString(),
  };
}

/**
 * Validates the exact owner-signed ChangePubKey transaction and submits it at
 * most once. A prior attempt is reconciled and is never rebroadcast.
 */
export async function authorizeLighterCredential({
  body,
  recipient,
  state,
  ethereumRpcUrl = process.env.PRIVATE_AGENT_LIGHTER_ETHEREUM_RPC_URL || "",
  ethereumRpcFetch = fetch,
  lighterApiBaseUrl = process.env.PRIVATE_AGENT_LIGHTER_API_URL || LIGHTER_MAINNET_API_URL,
  lighterFetch = fetch,
  sealingIdentity = fundingSigningIdentity,
}) {
  const binding = await validateLighterAuthorization(body, recipient);
  const rawTransaction = String(body.raw_transaction || "").trim().toLowerCase();
  if (!SERIALIZED_EIP1559.test(rawTransaction)) {
    throw new LighterProvisioningError("Lighter owner transaction is invalid.", "lighter_transaction_invalid");
  }
  let transactionHash;
  let signed;
  let recovered;
  try {
    transactionHash = keccak256(rawTransaction);
    signed = parseTransaction(rawTransaction);
    recovered = await recoverTransactionAddress({ serializedTransaction: rawTransaction });
  } catch {
    throw new LighterProvisioningError("Lighter owner transaction signature is invalid.", "lighter_transaction_signature_invalid", 403);
  }
  const expectedData = lighterChangePubKeyData(binding);
  if (
    recovered.toLowerCase() !== binding.ownerAddress || signed.type !== "eip1559" ||
    signed.chainId !== LIGHTER_MAINNET_CHAIN_ID ||
    signed.to?.toLowerCase() !== LIGHTER_MAINNET_PROXY_ADDRESS ||
    (signed.value ?? 0n) !== 0n || (signed.data ?? "0x").toLowerCase() !== expectedData ||
    !signed.gas || signed.gas > LIGHTER_MAX_ASSOCIATION_GAS ||
    !signed.maxFeePerGas || signed.maxFeePerGas > LIGHTER_MAX_FEE_PER_GAS ||
    !signed.maxPriorityFeePerGas || signed.maxPriorityFeePerGas > LIGHTER_MAX_PRIORITY_FEE_PER_GAS ||
    signed.maxPriorityFeePerGas > signed.maxFeePerGas || (signed.accessList?.length ?? 0) !== 0
  ) {
    throw new LighterProvisioningError("Lighter owner transaction does not match its preparation.", "lighter_transaction_binding_invalid", 403);
  }
  if (binding.preparationId !== lighterPreparationId({
    accountCommitment: binding.accountCommitment,
    ownerAddress: binding.ownerAddress,
    accountIndex: binding.accountIndex,
    apiKeyIndex: binding.apiKeyIndex,
    publicKey: binding.publicKey,
    data: expectedData,
  })) {
    throw new LighterProvisioningError("Lighter preparation binding is invalid.", "lighter_preparation_binding_invalid", 409);
  }

  const cached = await state.getIdempotency(binding.preparationId);
  if (cached?.receipt) {
    if (cached.receipt.transaction_hash !== transactionHash || !sameLighterBinding(cached.receipt, binding)) {
      throw new LighterProvisioningError("Lighter cached authorization binding is invalid.", "lighter_cached_binding_invalid", 409);
    }
    return cached.receipt;
  }
  const prior = await state.getExecutionAttempt(binding.preparationId);
  if (prior) {
    if (prior.transaction_hash !== transactionHash || !sameLighterBinding(prior, binding)) {
      throw new LighterProvisioningError("Lighter authorization transaction changed after submission.", "lighter_transaction_changed", 409);
    }
    throw new LighterProvisioningError(
      "Lighter association already has an outcome; use reconcile-only recovery.",
      prior.status === "ambiguous" ? "lighter_association_ambiguous" : "lighter_association_not_retryable",
      409,
    );
  }

  await openAndValidatePendingVault(body.encrypted_execution_vault, recipient, binding, sealingIdentity);
  if (!/^https:\/\//i.test(String(ethereumRpcUrl))) {
    throw new LighterProvisioningError("Lighter Ethereum RPC is unavailable.", "lighter_ethereum_rpc_unavailable", 503);
  }
  await verifyLighterPreBroadcastBinding({ binding, lighterApiBaseUrl, lighterFetch });
  const claim = await state.claimExecutionAttempt(binding.preparationId, {
    // The durable claim is the at-most-once boundary. A crash after this write
    // cannot prove whether submission happened, so it must freeze as ambiguous.
    status: "ambiguous",
    venue_id: "lighter",
    operation_class: "credential_authorize",
    ...publicLighterBinding(binding),
    transaction_hash: transactionHash,
    account_binding_verified: true,
    api_key_slot_vacant_verified: true,
    reason: "ethereum_submission_outcome_unconfirmed",
    authorization_frozen_at: new Date().toISOString(),
  });
  if (!claim?.ok) {
    throw new LighterProvisioningError(
      "Lighter association already has an outcome; use reconcile-only recovery.",
      claim?.existing?.status === "ambiguous" ? "lighter_association_ambiguous" : "lighter_association_not_retryable",
      409,
    );
  }

  let sent;
  try {
    sent = await ethereumRpc(ethereumRpcFetch, ethereumRpcUrl, "eth_sendRawTransaction", [rawTransaction]);
  } catch {
    sent = null;
  }
  if (!sent?.ok || String(sent.result || "").toLowerCase() !== transactionHash) {
    await state.putExecutionAttempt(binding.preparationId, {
      status: "ambiguous",
      venue_id: "lighter",
      operation_class: "credential_authorize",
      ...publicLighterBinding(binding),
      transaction_hash: transactionHash,
      account_binding_verified: true,
      api_key_slot_vacant_verified: true,
      reason: "ethereum_submission_outcome_unknown",
      ambiguous_at: new Date().toISOString(),
    });
    throw new LighterProvisioningError(
      "Lighter association outcome is ambiguous; reconcile it without resubmitting.",
      "lighter_association_ambiguous",
      502,
    );
  }
  await state.putExecutionAttempt(binding.preparationId, {
    status: "submitted",
    venue_id: "lighter",
    operation_class: "credential_authorize",
    ...publicLighterBinding(binding),
    transaction_hash: transactionHash,
    account_binding_verified: true,
    api_key_slot_vacant_verified: true,
    submitted_at: new Date().toISOString(),
  });
  return reconcileLighterCredential({
    body: { ...body, transaction_hash: transactionHash },
    recipient,
    state,
    ethereumRpcUrl,
    ethereumRpcFetch,
    lighterApiBaseUrl,
    lighterFetch,
    sealingIdentity,
  });
}

/** Reconciles only. This function cannot broadcast a transaction. */
export async function reconcileLighterCredential({
  body,
  recipient,
  state,
  ethereumRpcUrl = process.env.PRIVATE_AGENT_LIGHTER_ETHEREUM_RPC_URL || "",
  ethereumRpcFetch = fetch,
  lighterApiBaseUrl = process.env.PRIVATE_AGENT_LIGHTER_API_URL || LIGHTER_MAINNET_API_URL,
  lighterFetch = fetch,
  sealingIdentity = fundingSigningIdentity,
}) {
  const binding = await validateLighterAuthorization(body, recipient, { rawTransactionRequired: false });
  const transactionHash = String(body.transaction_hash || "").trim().toLowerCase();
  if (!TRANSACTION_HASH.test(transactionHash) || !PREPARATION_ID.test(binding.preparationId)) {
    throw new LighterProvisioningError("Lighter reconciliation proof is invalid.", "lighter_reconciliation_invalid");
  }
  const expectedData = lighterChangePubKeyData(binding);
  if (binding.preparationId !== lighterPreparationId({
    accountCommitment: binding.accountCommitment,
    ownerAddress: binding.ownerAddress,
    accountIndex: binding.accountIndex,
    apiKeyIndex: binding.apiKeyIndex,
    publicKey: binding.publicKey,
    data: expectedData,
  })) {
    throw new LighterProvisioningError("Lighter reconciliation binding is invalid.", "lighter_reconciliation_binding_invalid", 409);
  }
  const cached = await state.getIdempotency(binding.preparationId);
  if (cached?.receipt) {
    if (cached.receipt.transaction_hash !== transactionHash || !sameLighterBinding(cached.receipt, binding)) {
      throw new LighterProvisioningError("Lighter cached receipt binding is invalid.", "lighter_cached_binding_invalid", 409);
    }
    return cached.receipt;
  }
  const prior = await state.getExecutionAttempt(binding.preparationId);
  if (
    !prior || prior.transaction_hash !== transactionHash || !sameLighterBinding(prior, binding) ||
    prior.account_binding_verified !== true || prior.api_key_slot_vacant_verified !== true
  ) {
    throw new LighterProvisioningError("No matching Lighter association attempt exists.", "lighter_association_attempt_missing", 404);
  }
  if (!/^https:\/\//i.test(String(ethereumRpcUrl))) {
    throw new LighterProvisioningError("Lighter Ethereum RPC is unavailable.", "lighter_ethereum_rpc_unavailable", 503);
  }
  const receiptResult = await ethereumRpc(ethereumRpcFetch, ethereumRpcUrl, "eth_getTransactionReceipt", [transactionHash]);
  if (!receiptResult?.ok || !receiptResult.result) {
    return pendingLighterReceipt(binding, transactionHash, prior.status);
  }
  const chainReceipt = receiptResult.result;
  if (
    String(chainReceipt.transactionHash || "").toLowerCase() !== transactionHash ||
    String(chainReceipt.from || "").toLowerCase() !== binding.ownerAddress ||
    String(chainReceipt.to || "").toLowerCase() !== LIGHTER_MAINNET_PROXY_ADDRESS
  ) {
    throw new LighterProvisioningError("Lighter chain receipt binding is invalid.", "lighter_chain_receipt_invalid", 409);
  }
  if (String(chainReceipt.status || "").toLowerCase() === "0x0") {
    await state.putExecutionAttempt(binding.preparationId, {
      ...prior,
      status: "failed",
      reason: "ethereum_transaction_reverted",
      failed_at: new Date().toISOString(),
    });
    throw new LighterProvisioningError("Lighter rejected the owner association transaction.", "lighter_association_reverted", 409);
  }
  if (String(chainReceipt.status || "").toLowerCase() !== "0x1") {
    return pendingLighterReceipt(binding, transactionHash, "ambiguous");
  }

  const keyResponse = await lighterFetch(new URL(
    `/api/v1/apikeys?account_index=${binding.accountIndex}&api_key_index=${binding.apiKeyIndex}`,
    lighterApiBaseUrl,
  ), { headers: { "user-agent": "Ghola-Private-Agent/1.0" } }).catch(() => null);
  const keyBody = keyResponse?.ok ? await keyResponse.json().catch(() => null) : null;
  if (!lighterAssociationObserved(keyBody, binding)) {
    await state.putExecutionAttempt(binding.preparationId, {
      ...prior,
      status: "confirmed_pending_index",
      confirmed_at: new Date().toISOString(),
    });
    return pendingLighterReceipt(binding, transactionHash, "confirmed_pending_index");
  }

  const pending = await openAndValidatePendingVault(body.encrypted_execution_vault, recipient, binding, sealingIdentity);
  const encryptedExecutionVault = await sealActiveLighterVault({ pending, recipient, binding, sealingIdentity });
  const readyAt = new Date().toISOString();
  const receipt = {
    version: 1,
    venue_id: "lighter",
    status: "ready",
    preparation_id: binding.preparationId,
    ...publicLighterBinding(binding),
    transaction_hash: transactionHash,
    permissions: lighterExecutionPermissions(),
    encrypted_execution_vault: encryptedExecutionVault,
    setup: {
      may_place_trade: false,
      transaction_broadcast: true,
      credential_registered: true,
      owner_association_verified: true,
    },
    ready_at: readyAt,
  };
  await state.putExecutionAttempt(binding.preparationId, {
    ...prior,
    status: "succeeded",
    ready_at: readyAt,
  });
  await state.putIdempotency(binding.preparationId, receipt);
  return receipt;
}

export function lighterPreparationId({
  accountCommitment,
  ownerAddress,
  accountIndex,
  apiKeyIndex,
  publicKey,
  data,
}) {
  return `lighter_prepare_${createHash("sha256").update(JSON.stringify({
    account_commitment: String(accountCommitment),
    owner_address: String(ownerAddress).toLowerCase(),
    account_index: Number(accountIndex),
    api_key_index: Number(apiKeyIndex),
    public_key: lighterPublicKey(publicKey),
    data: String(data).toLowerCase(),
  })).digest("hex")}`;
}

function lighterChangePubKeyData(binding) {
  return encodeFunctionData({
    abi: LIGHTER_CHANGE_PUB_KEY_ABI,
    functionName: "changePubKey",
    args: [binding.accountIndex, binding.apiKeyIndex, `0x${binding.publicKey}`],
  }).toLowerCase();
}

async function validateLighterAuthorization(body, recipient, { rawTransactionRequired = true } = {}) {
  const ownerAddress = String(body.owner_address || "").trim().toLowerCase();
  const accountCommitment = String(body.account_commitment || "").trim();
  const preparationId = String(body.preparation_id || "").trim();
  const accountIndex = lighterIndex(body.account_index, "account_index", MAX_ACCOUNT_INDEX);
  const apiKeyIndex = lighterApiKeyIndex(body.api_key_index);
  const publicKey = lighterPublicKey(body.public_key);
  if (!ADDRESS.test(ownerAddress) || !SAFE_COMMITMENT.test(accountCommitment) || !PREPARATION_ID.test(preparationId)) {
    throw new LighterProvisioningError("Lighter authorization binding is invalid.", "lighter_authorization_binding_invalid");
  }
  if (rawTransactionRequired && !SERIALIZED_EIP1559.test(String(body.raw_transaction || ""))) {
    throw new LighterProvisioningError("Lighter owner transaction is required.", "lighter_transaction_required");
  }
  if (!recipient?.recipient_id) {
    throw new LighterProvisioningError("Attested worker recipient is unavailable.", "recipient_unavailable", 503);
  }
  return { ownerAddress, accountCommitment, preparationId, accountIndex, apiKeyIndex, publicKey };
}

async function openAndValidatePendingVault(bundle, recipient, binding, sealingIdentity) {
  const expectedAad = [
    "ghola/lighter-pending-execution-vault-v1",
    `account:${binding.accountCommitment}`,
    `recipient:${recipient.recipient_id}`,
    "network:mainnet",
  ].join("|");
  const opened = await openSealedBundle(bundle, recipient, {
    expectedKind: "ghola_lighter_pending_execution_vault",
    expectedAad,
  });
  if (opened.senderDid !== lighterSealingSenderDid(sealingIdentity)) {
    throw new LighterProvisioningError("Lighter sealed credential signer is invalid.", "lighter_sealed_signer_invalid", 409);
  }
  if (
    String(opened.json.account_commitment || "") !== binding.accountCommitment ||
    String(opened.json.owner_address || "").toLowerCase() !== binding.ownerAddress ||
    Number(opened.json.account_index) !== binding.accountIndex ||
    Number(opened.json.api_key_index) !== binding.apiKeyIndex ||
    lighterPublicKey(opened.json.api_public_key) !== binding.publicKey ||
    opened.json.provisioning_status !== "pending_owner_association" ||
    !Array.isArray(opened.json.allowed_operations) || opened.json.allowed_operations.length !== 0
  ) {
    throw new LighterProvisioningError("Lighter sealed credential binding is invalid.", "lighter_sealed_binding_invalid", 409);
  }
  lighterGeneratedKeyPair({
    private_key: opened.json.api_private_key,
    public_key: opened.json.api_public_key,
  });
  return opened.json;
}

async function verifyLighterPreBroadcastBinding({ binding, lighterApiBaseUrl, lighterFetch }) {
  let ownerResponse;
  let keyResponse;
  try {
    [ownerResponse, keyResponse] = await Promise.all([
      lighterFetch(new URL(
        `/api/v1/accountsByL1Address?l1_address=${encodeURIComponent(binding.ownerAddress)}`,
        lighterApiBaseUrl,
      ), { headers: { "user-agent": "Ghola-Private-Agent/1.0" } }),
      lighterFetch(new URL(
        `/api/v1/apikeys?account_index=${binding.accountIndex}&api_key_index=255`,
        lighterApiBaseUrl,
      ), { headers: { "user-agent": "Ghola-Private-Agent/1.0" } }),
    ]);
  } catch {
    throw new LighterProvisioningError(
      "Lighter account binding is unavailable.",
      "lighter_account_binding_unavailable",
      503,
    );
  }
  const [ownerBody, keyBody] = await Promise.all([
    ownerResponse?.ok ? ownerResponse.json().catch(() => null) : null,
    keyResponse?.ok ? keyResponse.json().catch(() => null) : null,
  ]);
  if (
    !ownerResponse?.ok || !keyResponse?.ok || Number(ownerBody?.code) !== 200 ||
    !Array.isArray(ownerBody?.sub_accounts) || Number(keyBody?.code) !== 200 ||
    !Array.isArray(keyBody?.api_keys)
  ) {
    throw new LighterProvisioningError(
      "Lighter account binding is unavailable.",
      "lighter_account_binding_unavailable",
      503,
    );
  }
  const ownerBound = String(ownerBody.l1_address || "").toLowerCase() === binding.ownerAddress &&
    ownerBody.sub_accounts.some((entry) =>
      Number(entry?.index) === binding.accountIndex &&
      String(entry?.l1_address || "").toLowerCase() === binding.ownerAddress
    );
  if (!ownerBound) {
    throw new LighterProvisioningError(
      "The Lighter account is not owned by the authorizing wallet.",
      "lighter_account_binding_invalid",
      409,
    );
  }
  const occupied = keyBody.api_keys.some((entry) => {
    const publicKey = String(entry?.public_key || "").replace(/^0x/i, "");
    return Number(entry?.account_index) === binding.accountIndex &&
      Number(entry?.api_key_index) === binding.apiKeyIndex &&
      /^[0-9a-f]{80}$/i.test(publicKey) && !/^0{80}$/.test(publicKey);
  });
  if (occupied) {
    throw new LighterProvisioningError(
      "The Lighter API-key slot is already occupied.",
      "lighter_api_key_slot_occupied",
      409,
    );
  }
}

function lighterSealingSenderDid(sealingIdentity) {
  const identity = sealingIdentity();
  const publicDer = identity?.publicKey?.export?.({ format: "der", type: "spki" });
  const publicBytes = publicDer ? new Uint8Array(Buffer.from(publicDer).subarray(-32)) : new Uint8Array();
  if (publicBytes.length !== 32 || !identity?.privateKey) {
    throw new LighterProvisioningError("Worker sealing identity is unavailable.", "sealing_identity_unavailable", 503);
  }
  return didKeyFromVerifying(publicBytes);
}

async function sealActiveLighterVault({ pending, recipient, binding, sealingIdentity }) {
  const identity = sealingIdentity();
  const publicDer = identity?.publicKey?.export?.({ format: "der", type: "spki" });
  const publicBytes = publicDer ? new Uint8Array(Buffer.from(publicDer).subarray(-32)) : new Uint8Array();
  if (publicBytes.length !== 32 || !identity?.privateKey) {
    throw new LighterProvisioningError("Worker sealing identity is unavailable.", "sealing_identity_unavailable", 503);
  }
  const associatedData = [
    "ghola/lighter-execution-vault-v1",
    `account:${binding.accountCommitment}`,
    `recipient:${recipient.recipient_id}`,
    "network:mainnet",
  ].join("|");
  const ciphertext = await sealEnvelope({
    recipientId: recipient.recipient_id,
    recipientX25519: hexToBytes(recipient.x25519_pub_hex),
    senderDid: didKeyFromVerifying(publicBytes),
    associatedData,
    plaintext: {
      ...pending,
      kind: "ghola_lighter_execution_vault",
      provisioning_status: "owner_association_verified",
      permissions: { can_read: true, can_trade: true, can_withdraw: false, can_transfer: false },
      allowed_operations: ["read", "limit_order", "cancel", "reconcile"],
      blocked_operations: ["withdraw", "transfer", "leverage", "margin", "account_config", "api_key_rotation"],
      activated_at: new Date().toISOString(),
    },
    signBody: async (digest) => new Uint8Array(edSign(null, Buffer.from(digest), identity.privateKey)),
  });
  return {
    alg: "sealed-provider-v1",
    ciphertext: bytesToBase64(ciphertext),
    recipient: recipient.recipient_id,
    aad: associatedData,
  };
}

function lighterExecutionPermissions() {
  return {
    can_read: true,
    can_trade: true,
    can_withdraw: false,
    can_transfer: false,
    can_manage_credentials: false,
    can_export_secret: false,
    unknown_scopes: [],
  };
}

function publicLighterBinding(binding) {
  return {
    owner_address: binding.ownerAddress,
    account_index: binding.accountIndex,
    api_key_index: binding.apiKeyIndex,
    public_key: binding.publicKey,
  };
}

function sameLighterBinding(value, binding) {
  return String(value?.owner_address || "").toLowerCase() === binding.ownerAddress &&
    Number(value?.account_index) === binding.accountIndex &&
    Number(value?.api_key_index) === binding.apiKeyIndex &&
    String(value?.public_key || "").toLowerCase() === binding.publicKey;
}

function pendingLighterReceipt(binding, transactionHash, status) {
  return {
    version: 1,
    venue_id: "lighter",
    status: ["ambiguous", "confirmed_pending_index"].includes(status) ? status : "submitted",
    preparation_id: binding.preparationId,
    ...publicLighterBinding(binding),
    transaction_hash: transactionHash,
    setup: {
      may_place_trade: false,
      transaction_broadcast: status === "ambiguous" ? null : true,
      credential_registered: false,
      owner_association_verified: false,
    },
  };
}

async function ethereumRpc(fetchImpl, url, method, params) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
  });
  if (!response?.ok) return null;
  const body = await response.json().catch(() => null);
  if (!body || body.error) return { ok: false, error: body?.error || null };
  return { ok: true, result: body.result };
}

function lighterAssociationObserved(body, binding) {
  return Number(body?.code) === 200 && Array.isArray(body?.api_keys) && body.api_keys.some((entry) =>
    Number(entry?.account_index) === binding.accountIndex &&
    Number(entry?.api_key_index) === binding.apiKeyIndex &&
    String(entry?.public_key || "").replace(/^0x/i, "").toLowerCase() === binding.publicKey
  );
}

function lighterGeneratedKeyPair(generated) {
  const tuple = Array.isArray(generated) ? generated : null;
  const error = tuple ? tuple[2] : generated?.error ?? generated?.err;
  if (error) {
    throw new LighterProvisioningError("Lighter SDK key generation failed.", "key_generation_failed");
  }
  const rawPrivateKey = tuple ? tuple[0] : generated?.private_key ?? generated?.privateKey;
  const rawPublicKey = tuple ? tuple[1] : generated?.public_key ?? generated?.publicKey;
  const privateKey = lighterKey(rawPrivateKey, PRIVATE_KEY, "private");
  const publicKey = lighterPublicKey(rawPublicKey);
  return { privateKey, publicKey };
}

export function lighterApiKeyIndex(value) {
  const index = lighterIndex(value, "api_key_index", MAX_API_KEY_INDEX);
  if (index < MIN_API_KEY_INDEX) {
    throw new LighterProvisioningError(
      "Lighter API key indexes 0 and 1 are reserved for the venue's desktop and mobile wallets.",
      "api_key_index_reserved",
    );
  }
  return index;
}

export function lighterPublicKey(value) {
  const key = lighterKey(value, PUBLIC_KEY, "public");
  const bytes = Buffer.from(key, "hex");
  let nonzero = false;
  for (let offset = 0; offset < bytes.length; offset += 8) {
    let limb = 0n;
    for (let index = 7; index >= 0; index -= 1) {
      limb = (limb << 8n) | BigInt(bytes[offset + index]);
    }
    if (limb >= GOLDILOCKS_MODULUS) {
      throw new LighterProvisioningError("Lighter SDK public key is non-canonical.", "public_key_noncanonical");
    }
    if (limb !== 0n) nonzero = true;
  }
  if (!nonzero) {
    throw new LighterProvisioningError("Lighter SDK public key is invalid.", "public_key_invalid");
  }
  return key;
}

function lighterNetwork(value) {
  if (value !== "mainnet" && value !== "testnet") {
    throw new LighterProvisioningError("Lighter network is invalid.", "network_invalid");
  }
  return value;
}

function lighterIndex(value, field, maximum = Number.MAX_SAFE_INTEGER) {
  const text = typeof value === "string" ? value.trim() : value;
  if (
    (typeof text === "string" && !/^\d+$/.test(text)) ||
    (typeof text !== "string" && typeof text !== "number")
  ) {
    throw new LighterProvisioningError(`Lighter ${field} is invalid.`, `${field}_invalid`);
  }
  const index = Number(text);
  if (!Number.isSafeInteger(index) || index < 0 || index > maximum) {
    throw new LighterProvisioningError(`Lighter ${field} is invalid.`, `${field}_invalid`);
  }
  return index;
}

function lighterKey(value, pattern, kind) {
  const key = typeof value === "string" ? value.trim() : "";
  if (!pattern.test(key)) {
    throw new LighterProvisioningError(`Lighter SDK ${kind} key is invalid.`, `${kind}_key_invalid`);
  }
  const normalized = key.replace(/^0x/i, "").toLowerCase();
  if (/^0{64}$/.test(normalized)) {
    throw new LighterProvisioningError(`Lighter SDK ${kind} key is invalid.`, `${kind}_key_invalid`);
  }
  return normalized;
}

function lighterSealedVault(value, privateKey) {
  const candidate = value?.encrypted_execution_vault ?? value;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new LighterProvisioningError("Lighter sealed vault is invalid.", "sealed_vault_invalid");
  }
  const sealed = {
    alg: requiredText(candidate.alg),
    ciphertext: requiredText(candidate.ciphertext),
    recipient: requiredText(candidate.recipient),
    aad: requiredText(candidate.aad),
  };
  if (!sealed.alg || !sealed.ciphertext || !sealed.recipient || !sealed.aad) {
    throw new LighterProvisioningError("Lighter sealed vault is invalid.", "sealed_vault_invalid");
  }
  const serialized = JSON.stringify(sealed).toLowerCase();
  if (serialized.includes(privateKey) || serialized.includes(`0x${privateKey}`)) {
    throw new LighterProvisioningError("Lighter sealed vault exposed credential material.", "sealed_vault_exposed_key");
  }
  return sealed;
}

function requiredText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function runLighterKeygen() {
  const runnerPath = join(dirname(fileURLToPath(import.meta.url)), "lighter_runner.py");
  const python = process.env.PRIVATE_AGENT_PYTHON || "python3";
  return new Promise((resolve, reject) => {
    const child = spawn(python, [runnerPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });
    const stdout = [];
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new LighterProvisioningError("Lighter SDK key generation timed out.", "key_generation_failed"));
    }, 12_000);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.on("error", () => {
      clearTimeout(timeout);
      reject(new LighterProvisioningError("Lighter SDK key generation is unavailable.", "key_generation_failed"));
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      let body;
      try {
        body = JSON.parse(Buffer.concat(stdout).toString("utf8") || "{}");
      } catch {
        body = null;
      }
      if (code !== 0 || !body || body.error) {
        reject(new LighterProvisioningError("Lighter SDK key generation failed.", "key_generation_failed"));
      } else {
        resolve(body);
      }
    });
    child.stdin.end(JSON.stringify({ action: "generate_api_key" }));
  });
}
