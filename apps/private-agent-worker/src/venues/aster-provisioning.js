import { createHash, sign as edSign } from "node:crypto";
import { recoverTypedDataAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  bytesToBase64,
  didKeyFromVerifying,
  hexToBytes,
  openSealedBundle,
  sealEnvelope,
} from "../crypto/envelope.js";
import { fundingSigningIdentity } from "./shielded_funding_attestation.js";

const ADDRESS = /^0x[0-9a-f]{40}$/i;
const SAFE_COMMITMENT = /^[A-Za-z0-9_.:-]{8,240}$/;
const SAFE_AGENT_NAME = /^[A-Za-z0-9._:-]{1,32}$/;
const SIGNATURE = /^0x[0-9a-f]{130}$/i;
const PREPARATION_ID = /^aster_prepare_[0-9a-f]{64}$/;
const MAX_NONCE_SKEW_MS = 10_000;
const ASTER_REGISTER_PATH = "/fapi/v3/registerAndApproveAgent";

export class AsterProvisioningError extends Error {
  constructor(message, code, status = 400, { providerCode = null, providerMessage = null } = {}) {
    super(message);
    this.name = "AsterProvisioningError";
    this.code = code;
    this.status = status;
    this.providerCode = providerCode;
    this.providerMessage = providerMessage;
  }
}

/**
 * Generates an Aster agent inside the attested worker and immediately seals it
 * back to that worker. Only the public signer and ciphertext cross the runtime
 * boundary. This function never contacts Aster and cannot place an order.
 */
export async function prepareAsterCredential({
  ownerAddress,
  accountCommitment,
  agentName = "ghola-perps",
  recipient,
  provider = "phala",
  attestationEvidence = {},
  now = () => new Date(),
  generateSignerPrivateKey = generatePrivateKey,
  sealingIdentity = fundingSigningIdentity,
}) {
  const owner = String(ownerAddress || "").trim().toLowerCase();
  const account = String(accountCommitment || "").trim();
  const label = String(agentName || "").trim();
  if (!ADDRESS.test(owner)) {
    throw new AsterProvisioningError("Aster owner address is invalid.", "owner_address_invalid");
  }
  if (!SAFE_COMMITMENT.test(account)) {
    throw new AsterProvisioningError("Private account commitment is invalid.", "account_commitment_invalid");
  }
  if (!SAFE_AGENT_NAME.test(label)) {
    throw new AsterProvisioningError("Aster agent name is invalid.", "agent_name_invalid");
  }
  if (!recipient?.recipient_id || !/^[0-9a-f]{64}$/i.test(String(recipient.x25519_pub_hex || ""))) {
    throw new AsterProvisioningError("Attested worker recipient is unavailable.", "recipient_unavailable", 503);
  }

  let privateKey;
  let signerAddress;
  try {
    privateKey = await generateSignerPrivateKey();
    signerAddress = privateKeyToAccount(privateKey).address.toLowerCase();
  } catch {
    throw new AsterProvisioningError("Aster signer generation failed.", "signer_generation_failed", 503);
  }
  if (signerAddress === owner) {
    throw new AsterProvisioningError("Aster signer must differ from its owner.", "owner_signer_collision", 503);
  }

  const createdAt = now();
  if (!(createdAt instanceof Date) || !Number.isFinite(createdAt.getTime())) {
    throw new AsterProvisioningError("Worker time is unavailable.", "worker_time_invalid", 503);
  }
  const associatedData = [
    "ghola/aster-execution-vault-v1",
    `account:${account}`,
    `recipient:${recipient.recipient_id}`,
    "network:mainnet",
  ].join("|");
  const identity = sealingIdentity();
  const publicDer = identity?.publicKey?.export?.({ format: "der", type: "spki" });
  const publicBytes = publicDer ? new Uint8Array(Buffer.from(publicDer).subarray(-32)) : new Uint8Array();
  if (publicBytes.length !== 32 || !identity?.privateKey) {
    throw new AsterProvisioningError("Worker sealing identity is unavailable.", "sealing_identity_unavailable", 503);
  }

  let ciphertext;
  try {
    ciphertext = await sealEnvelope({
      recipientId: recipient.recipient_id,
      recipientX25519: hexToBytes(recipient.x25519_pub_hex),
      senderDid: didKeyFromVerifying(publicBytes),
      associatedData,
      plaintext: {
        version: 1,
        kind: "ghola_aster_execution_vault",
        network: "mainnet",
        user_address: owner,
        signer_address: signerAddress,
        api_wallet_private_key: privateKey,
        label,
        allowed_operations: ["read", "limit_order", "cancel", "reconcile"],
        blocked_operations: ["withdraw", "vault_transfer", "leverage_escalation"],
        created_at: createdAt.toISOString(),
      },
      signBody: async (digest) => new Uint8Array(edSign(null, Buffer.from(digest), identity.privateKey)),
    });
  } catch {
    throw new AsterProvisioningError("Aster signer sealing failed.", "signer_sealing_failed", 503);
  }

  const attestationSha256 = `sha256:${createHash("sha256").update(JSON.stringify({
    recipient_id: recipient.recipient_id,
    signer_address: signerAddress,
    evidence: attestationEvidence,
  })).digest("hex")}`;
  const result = {
    version: 1,
    venue_id: "aster",
    network: "mainnet",
    owner_address: owner,
    agent_name: label,
    signer_address: signerAddress,
    encrypted_execution_vault: {
      alg: "sealed-provider-v1",
      ciphertext: bytesToBase64(ciphertext),
      recipient: recipient.recipient_id,
      aad: associatedData,
    },
    attested_signer: {
      public_address: signerAddress,
      provider: String(provider || "phala").toLowerCase(),
      worker_id: recipient.recipient_id,
      attestation_sha256: attestationSha256,
      private_key_exposed: false,
    },
    permissions: {
      can_read: true,
      can_trade: true,
      can_spot_trade: false,
      can_perp_trade: true,
      can_withdraw: false,
      can_transfer: false,
      can_manage_credentials: false,
      can_export_secret: false,
      unknown_scopes: [],
    },
    owner_authorization: {
      required: true,
      status: "signature_required",
    },
    setup: {
      may_place_trade: false,
      transaction_broadcast: false,
    },
    created_at: createdAt.toISOString(),
  };
  if (JSON.stringify(result).toLowerCase().includes(String(privateKey).toLowerCase())) {
    throw new AsterProvisioningError("Aster signer escaped its sealed boundary.", "signer_exposure_detected", 503);
  }
  return result;
}

/**
 * Reissues the owner-authorization envelope around an existing sealed signer.
 * This never generates a second signer and never contacts Aster. A prior
 * ambiguous, pending, or successful registration permanently blocks refresh.
 */
export async function refreshAsterCredential({
  body,
  recipient,
  state,
  provider = "phala",
  attestationEvidence = {},
  sealingIdentity = fundingSigningIdentity,
}) {
  const owner = String(body.owner_address || "").trim().toLowerCase();
  const signer = String(body.signer_address || "").trim().toLowerCase();
  const accountCommitment = String(body.account_commitment || "").trim();
  const agentName = String(body.agent_name || "").trim();
  const priorPreparationId = String(body.prior_preparation_id || "").trim();
  const priorNonce = Number(body.prior_nonce);
  if (!ADDRESS.test(owner) || !ADDRESS.test(signer) || owner === signer) {
    throw new AsterProvisioningError("Aster refresh binding is invalid.", "aster_refresh_binding_invalid");
  }
  if (!SAFE_COMMITMENT.test(accountCommitment) || !SAFE_AGENT_NAME.test(agentName) ||
      !PREPARATION_ID.test(priorPreparationId) || !Number.isSafeInteger(priorNonce)) {
    throw new AsterProvisioningError("Aster refresh proof is invalid.", "aster_refresh_proof_invalid");
  }
  if (priorPreparationId !== asterPreparationId({
    accountCommitment,
    ownerAddress: owner,
    signerAddress: signer,
    nonce: priorNonce,
  })) {
    throw new AsterProvisioningError("Aster refresh preparation binding is invalid.", "aster_refresh_binding_invalid", 409);
  }
  if ((await state.getIdempotency(priorPreparationId))?.receipt) {
    throw new AsterProvisioningError("Aster signer is already registered.", "aster_refresh_registered", 409);
  }
  const prior = await state.getExecutionAttempt(priorPreparationId);
  if (prior && prior.status !== "rejected") {
    throw new AsterProvisioningError(
      "Aster registration is not safely refreshable; reconcile the existing attempt.",
      prior.status === "ambiguous" ? "aster_registration_ambiguous" : "aster_refresh_not_allowed",
      409,
    );
  }
  if (prior && (
    prior.owner_address !== owner ||
    prior.signer_address !== signer ||
    prior.operation_class !== "credential_authorize"
  )) {
    throw new AsterProvisioningError("Aster rejected-attempt binding is invalid.", "aster_refresh_binding_invalid", 409);
  }
  const opened = await validateSealedAsterCredential({
    encryptedExecutionVault: body.encrypted_execution_vault,
    recipient,
    accountCommitment,
    owner,
    signer,
    agentName,
    sealingIdentity,
  });
  const attestationSha256 = `sha256:${createHash("sha256").update(JSON.stringify({
    recipient_id: recipient.recipient_id,
    signer_address: signer,
    evidence: attestationEvidence,
  })).digest("hex")}`;
  return {
    version: 1,
    venue_id: "aster",
    network: "mainnet",
    owner_address: owner,
    agent_name: agentName,
    signer_address: signer,
    encrypted_execution_vault: body.encrypted_execution_vault,
    attested_signer: {
      public_address: signer,
      provider: String(provider || "phala").toLowerCase(),
      worker_id: recipient.recipient_id,
      attestation_sha256: attestationSha256,
      private_key_exposed: false,
    },
    permissions: {
      can_read: true,
      can_trade: true,
      can_spot_trade: false,
      can_perp_trade: true,
      can_withdraw: false,
      can_transfer: false,
      can_manage_credentials: false,
      can_export_secret: false,
      unknown_scopes: [],
    },
    owner_authorization: {
      required: true,
      status: "signature_required",
    },
    setup: {
      may_place_trade: false,
      transaction_broadcast: false,
    },
    refreshed_from_preparation_id: priorPreparationId,
    created_at: String(opened.json.created_at || ""),
  };
}

/**
 * Verifies the exact owner signature, persists a pending attempt, then makes
 * at most one Aster registration request. Any ambiguous outcome is frozen for
 * reconciliation and is never retried with the same preparation.
 */
export async function authorizeAsterCredential({
  body,
  recipient,
  state,
  fetchImpl = fetch,
  nowMs = Date.now(),
  baseUrl = process.env.PRIVATE_AGENT_ASTER_API_URL || "https://fapi.asterdex.com",
  sealingIdentity = fundingSigningIdentity,
}) {
  const owner = String(body.owner_address || "").trim().toLowerCase();
  const signer = String(body.signer_address || "").trim().toLowerCase();
  const accountCommitment = String(body.account_commitment || "").trim();
  const agentName = String(body.agent_name || "").trim();
  const preparationId = String(body.preparation_id || "").trim();
  const nonce = Number(body.nonce);
  const expired = Number(body.expired);
  const signature = String(body.signature || "").trim();
  const ipWhitelist = Array.isArray(body.ip_whitelist)
    ? body.ip_whitelist.map((entry) => String(entry).trim()).filter(Boolean)
    : [];
  if (!ADDRESS.test(owner) || !ADDRESS.test(signer) || owner === signer) {
    throw new AsterProvisioningError("Aster owner or signer is invalid.", "aster_authorization_address_invalid");
  }
  if (!SAFE_COMMITMENT.test(accountCommitment) || !SAFE_AGENT_NAME.test(agentName)) {
    throw new AsterProvisioningError("Aster authorization metadata is invalid.", "aster_authorization_metadata_invalid");
  }
  if (!PREPARATION_ID.test(preparationId) || !SIGNATURE.test(signature)) {
    throw new AsterProvisioningError("Aster authorization proof is invalid.", "aster_authorization_proof_invalid");
  }
  if (!Number.isSafeInteger(nonce) || !Number.isSafeInteger(expired)) {
    throw new AsterProvisioningError("Aster authorization timestamps are invalid.", "aster_authorization_stale", 409);
  }
  const expectedPreparationId = asterPreparationId({
    accountCommitment,
    ownerAddress: owner,
    signerAddress: signer,
    nonce,
  });
  if (preparationId !== expectedPreparationId) {
    throw new AsterProvisioningError("Aster preparation binding is invalid.", "aster_preparation_binding_invalid");
  }
  const signatureCommitment = `sha256:${createHash("sha256").update(signature).digest("hex")}`;
  const parameters = asterRegistrationParameters({
    owner,
    nonce,
    agentName,
    signer,
    expired,
    ipWhitelist,
  });
  const typedData = asterRegistrationTypedData(parameters);
  let recovered;
  try {
    recovered = await recoverTypedDataAddress({
      domain: typedData.domain,
      types: { Message: typedData.types.Message },
      primaryType: typedData.primaryType,
      message: typedData.message,
      signature,
    });
  } catch {
    throw new AsterProvisioningError("Aster owner signature is invalid.", "aster_owner_signature_invalid");
  }
  if (recovered.toLowerCase() !== owner) {
    throw new AsterProvisioningError("Aster owner signature does not match.", "aster_owner_signature_mismatch", 403);
  }
  const cached = await state.getIdempotency(preparationId);
  if (cached?.receipt) {
    if (
      cached.receipt.owner_address !== owner ||
      cached.receipt.signer_address !== signer ||
      cached.receipt.owner_authorization?.signature_commitment !== signatureCommitment
    ) {
      throw new AsterProvisioningError("Aster cached authorization binding is invalid.", "aster_cached_binding_invalid", 409);
    }
    return cached.receipt;
  }
  const prior = await state.getExecutionAttempt(preparationId);
  if (prior) {
    throw new AsterProvisioningError(
      "Aster registration already has an outcome; reconcile it instead of retrying.",
      prior.status === "ambiguous" ? "aster_registration_ambiguous" : "aster_registration_not_retryable",
      409,
    );
  }
  if (Math.abs(nonce / 1_000 - nowMs) > MAX_NONCE_SKEW_MS || expired <= nowMs) {
    throw new AsterProvisioningError("Aster authorization timestamps are stale.", "aster_authorization_stale", 409);
  }

  await validateSealedAsterCredential({
    encryptedExecutionVault: body.encrypted_execution_vault,
    recipient,
    accountCommitment,
    owner,
    signer,
    agentName,
    sealingIdentity,
  });

  const claim = await state.claimExecutionAttempt(preparationId, {
    status: "pending",
    venue_id: "aster",
    operation_class: "credential_authorize",
    owner_address: owner,
    signer_address: signer,
    signature_commitment: signatureCommitment,
    submitted_at: new Date(nowMs).toISOString(),
  });
  if (!claim?.ok) {
    throw new AsterProvisioningError(
      "Aster registration already has an outcome; reconcile it instead of retrying.",
      claim?.existing?.status === "ambiguous" ? "aster_registration_ambiguous" : "aster_registration_not_retryable",
      409,
    );
  }

  let response;
  try {
    response = await fetchImpl(new URL(ASTER_REGISTER_PATH, baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": "Ghola-Private-Agent/1.0",
      },
      body: asterRegistrationFormBody(parameters, signature),
    });
  } catch {
    await state.putExecutionAttempt(preparationId, {
      status: "ambiguous",
      venue_id: "aster",
      operation_class: "credential_authorize",
      owner_address: owner,
      signer_address: signer,
      signature_commitment: signatureCommitment,
      ambiguous_at: new Date().toISOString(),
      reason: "network_outcome_unknown",
    });
    throw new AsterProvisioningError("Aster registration outcome is ambiguous.", "aster_registration_ambiguous", 502);
  }
  const responseBody = await response.json().catch(() => null);
  if (response.status === 503 || response.status >= 500 || !responseBody) {
    await state.putExecutionAttempt(preparationId, {
      status: "ambiguous",
      venue_id: "aster",
      operation_class: "credential_authorize",
      owner_address: owner,
      signer_address: signer,
      signature_commitment: signatureCommitment,
      provider_status: response.status,
      ambiguous_at: new Date().toISOString(),
      reason: "provider_outcome_unknown",
    });
    throw new AsterProvisioningError("Aster registration outcome is ambiguous.", "aster_registration_ambiguous", 502);
  }
  if (!response.ok || Number(responseBody.code) !== 200) {
    const providerCode = sanitizedProviderCode(responseBody.code);
    const providerMessage = sanitizedProviderMessage(responseBody.msg ?? responseBody.message);
    await state.putExecutionAttempt(preparationId, {
      status: "rejected",
      venue_id: "aster",
      operation_class: "credential_authorize",
      owner_address: owner,
      signer_address: signer,
      signature_commitment: signatureCommitment,
      provider_status: response.status,
      provider_code: providerCode,
      provider_message: providerMessage,
      rejected_at: new Date().toISOString(),
    });
    throw new AsterProvisioningError(
      "Aster rejected credential registration.",
      "aster_registration_rejected",
      400,
      { providerCode, providerMessage },
    );
  }

  const receipt = {
    version: 1,
    venue_id: "aster",
    status: "registered",
    preparation_id: preparationId,
    owner_address: owner,
    signer_address: signer,
    owner_authorization: {
      required: true,
      status: "signature_verified",
      signature_commitment: signatureCommitment,
    },
    permissions: {
      can_read: true,
      can_trade: true,
      can_spot_trade: false,
      can_perp_trade: true,
      can_withdraw: false,
      can_transfer: false,
      can_manage_credentials: false,
      can_export_secret: false,
      unknown_scopes: [],
    },
    encrypted_execution_vault: body.encrypted_execution_vault,
    setup: {
      may_place_trade: false,
      transaction_broadcast: false,
      credential_registered: true,
    },
    registered_at: new Date().toISOString(),
  };
  await state.putExecutionAttempt(preparationId, {
    status: "succeeded",
    venue_id: "aster",
    operation_class: "credential_authorize",
    owner_address: owner,
    signer_address: signer,
    signature_commitment: signatureCommitment,
    succeeded_at: receipt.registered_at,
  });
  await state.putIdempotency(preparationId, receipt);
  return receipt;
}

/**
 * Returns only an already-persisted successful registration receipt. This is
 * the link-recovery boundary: it never contacts Aster and cannot turn a
 * missing or ambiguous registration into a new provider request.
 */
export async function recoverAsterCredentialRegistration({ body, state }) {
  const owner = String(body.owner_address || "").trim().toLowerCase();
  const signer = String(body.signer_address || "").trim().toLowerCase();
  const accountCommitment = String(body.account_commitment || "").trim();
  const preparationId = String(body.preparation_id || "").trim();
  const signatureCommitment = String(body.signature_commitment || "").trim().toLowerCase();
  const nonce = Number(body.nonce);
  if (!ADDRESS.test(owner) || !ADDRESS.test(signer) || owner === signer) {
    throw new AsterProvisioningError("Aster recovery binding is invalid.", "aster_recovery_binding_invalid");
  }
  if (!SAFE_COMMITMENT.test(accountCommitment) || !PREPARATION_ID.test(preparationId) ||
      !/^sha256:[0-9a-f]{64}$/.test(signatureCommitment) || !Number.isSafeInteger(nonce)) {
    throw new AsterProvisioningError("Aster recovery proof is invalid.", "aster_recovery_proof_invalid");
  }
  if (preparationId !== asterPreparationId({
    accountCommitment,
    ownerAddress: owner,
    signerAddress: signer,
    nonce,
  })) {
    throw new AsterProvisioningError("Aster recovery preparation binding is invalid.", "aster_recovery_binding_invalid", 409);
  }
  const cached = await state.getIdempotency(preparationId);
  const receipt = cached?.receipt;
  if (!receipt) {
    const prior = await state.getExecutionAttempt(preparationId);
    if (prior?.status === "ambiguous") {
      throw new AsterProvisioningError(
        "Aster registration outcome is ambiguous; reconcile it instead of retrying.",
        "aster_registration_ambiguous",
        409,
      );
    }
    throw new AsterProvisioningError(
      "No successful Aster registration receipt exists for this preparation.",
      "aster_registration_receipt_not_found",
      404,
    );
  }
  if (
    receipt.owner_address !== owner ||
    receipt.signer_address !== signer ||
    receipt.owner_authorization?.signature_commitment !== signatureCommitment
  ) {
    throw new AsterProvisioningError("Aster recovery receipt binding is invalid.", "aster_recovery_binding_invalid", 409);
  }
  return receipt;
}

export function asterPreparationId({ accountCommitment, ownerAddress, signerAddress, nonce }) {
  return `aster_prepare_${createHash("sha256").update(JSON.stringify({
    account_commitment: accountCommitment,
    owner_address: ownerAddress.toLowerCase(),
    signer_address: signerAddress.toLowerCase(),
    nonce,
  })).digest("hex")}`;
}

export function asterRegistrationParameters({ owner, nonce, agentName, signer, expired, ipWhitelist = [] }) {
  return {
    agentName,
    agentAddress: signer.toLowerCase(),
    ipWhitelist: [...new Set(ipWhitelist)].sort().join(" "),
    expired,
    signatureChainId: 56,
    canSpotTrade: false,
    canPerpTrade: true,
    canWithdraw: false,
    user: owner.toLowerCase(),
    nonce,
  };
}

export function asterRegistrationTypedData(parameters) {
  const message = asterRegistrationEntries(parameters)
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  return {
    types: {
      Message: [{ name: "msg", type: "string" }],
    },
    primaryType: "Message",
    domain: {
      name: "AsterSignTransaction",
      version: "1",
      chainId: 56,
      verifyingContract: "0x0000000000000000000000000000000000000000",
    },
    message: { msg: message },
  };
}

export function asterRegistrationFormBody(parameters, signature) {
  return new URLSearchParams([
    ...asterRegistrationEntries(parameters),
    ["signature", signature],
  ]);
}

function asterRegistrationEntries(parameters) {
  return [
    ["user", parameters.user],
    ["nonce", String(parameters.nonce)],
    ["agentName", parameters.agentName],
    ["agentAddress", parameters.agentAddress],
    ["expired", String(parameters.expired)],
    ["signatureChainId", String(parameters.signatureChainId)],
    ["canSpotTrade", String(parameters.canSpotTrade)],
    ["canPerpTrade", String(parameters.canPerpTrade)],
    ["canWithdraw", String(parameters.canWithdraw)],
    ["ipWhitelist", parameters.ipWhitelist],
  ];
}

function sanitizedProviderCode(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = typeof value === "string" ? value.trim() : "";
  return /^-?[0-9]{1,12}$/.test(text) ? Number(text) : null;
}

function sanitizedProviderMessage(value) {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 240) : null;
}

async function validateSealedAsterCredential({
  encryptedExecutionVault,
  recipient,
  accountCommitment,
  owner,
  signer,
  agentName,
  sealingIdentity,
}) {
  const expectedAad = [
    "ghola/aster-execution-vault-v1",
    `account:${accountCommitment}`,
    `recipient:${recipient.recipient_id}`,
    "network:mainnet",
  ].join("|");
  const opened = await openSealedBundle(encryptedExecutionVault, recipient, {
    expectedKind: "ghola_aster_execution_vault",
    expectedAad,
  });
  const identity = sealingIdentity();
  const publicDer = identity?.publicKey?.export?.({ format: "der", type: "spki" });
  const publicBytes = publicDer ? new Uint8Array(Buffer.from(publicDer).subarray(-32)) : new Uint8Array();
  if (publicBytes.length !== 32) {
    throw new AsterProvisioningError("Worker sealing identity is unavailable.", "sealing_identity_unavailable", 503);
  }
  let sealedSignerAddress;
  try {
    sealedSignerAddress = privateKeyToAccount(String(opened.json.api_wallet_private_key || "")).address.toLowerCase();
  } catch {
    throw new AsterProvisioningError("Aster sealed signer key is invalid.", "aster_sealed_binding_invalid");
  }
  if (
    opened.senderDid !== didKeyFromVerifying(publicBytes) ||
    String(opened.json.user_address || "").toLowerCase() !== owner ||
    String(opened.json.signer_address || "").toLowerCase() !== signer ||
    sealedSignerAddress !== signer ||
    opened.json.label !== agentName ||
    opened.json.network !== "mainnet" ||
    !sameStringSet(opened.json.allowed_operations, ["read", "limit_order", "cancel", "reconcile"]) ||
    !sameStringSet(opened.json.blocked_operations, ["withdraw", "vault_transfer", "leverage_escalation"])
  ) {
    throw new AsterProvisioningError("Aster sealed signer binding is invalid.", "aster_sealed_binding_invalid");
  }
  return opened;
}

function sameStringSet(value, expected) {
  return Array.isArray(value) && value.length === expected.length &&
    [...new Set(value)].sort().join("\0") === [...expected].sort().join("\0");
}
