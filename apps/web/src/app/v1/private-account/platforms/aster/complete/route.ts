import { createHash } from "node:crypto";
import {
  createOrGetStoredPrivateAccount,
  json,
  privateAccountLiveGuard,
} from "../../../_lib";
import {
  authorizeAsterV3AgentRegistration,
  buildAsterV3AgentOnboardingContract,
} from "@/lib/aster-agent-onboarding";
import { linkAgentPlatformFromBody } from "@/lib/private-agent-passport";
import {
  workerAuthorizationHeader,
  workerCapabilityExpectedFromBody,
} from "@/lib/private-agent-capability";
import { resolvePrivateAgentWorkerUrl } from "@/lib/private-account-worker-routing";

export const dynamic = "force-dynamic";

const WORKER_AUTHORIZE_PATH = "/venues/aster/credentials/authorize";
const WORKER_RECEIPT_PATH = "/venues/aster/credentials/receipt";
const EVM_ADDRESS = /^0x[0-9a-f]{40}$/i;
const SIGNATURE = /^0x[0-9a-f]{130}$/i;
const NON_RETRYABLE_REGISTRATION_ERRORS = new Set([
  "aster_registration_ambiguous",
  "aster_registration_not_retryable",
  "aster_registration_rejected",
]);

export async function POST(req: Request) {
  const guarded = await privateAccountLiveGuard(req);
  if (!guarded.ok) return guarded.response;
  const input = record(guarded.body);
  const account = await createOrGetStoredPrivateAccount(guarded.owner);
  const ownerAddress = string(input.owner_address).toLowerCase();
  const signerAddress = string(input.signer_address).toLowerCase();
  const agentName = string(input.agent_name);
  const preparationId = string(input.preparation_id);
  const signature = string(input.signature);
  const nonce = positiveSafeInteger(input.nonce);
  const expired = positiveSafeInteger(input.expired);
  const ipWhitelist = strings(input.ip_whitelist);
  const attested = record(input.attested_signer);
  const encryptedVault = record(input.encrypted_execution_vault);
  const linkRecovery = input.link_recovery === true;
  const expectedRegistrationReceipt = record(input.registration_receipt);
  if (!EVM_ADDRESS.test(ownerAddress) || !EVM_ADDRESS.test(signerAddress) || ownerAddress === signerAddress) {
    return json({ error: "aster_authorization_address_invalid" }, 400);
  }
  if (!agentName || !nonce || !expired || !SIGNATURE.test(signature) || !ipWhitelist) {
    return json({ error: "aster_authorization_request_invalid" }, 400);
  }
  const expectedPreparationId = `aster_prepare_${createHash("sha256").update(JSON.stringify({
    account_commitment: account.account_commitment,
    owner_address: ownerAddress,
    signer_address: signerAddress,
    nonce,
  })).digest("hex")}`;
  if (preparationId !== expectedPreparationId) {
    return json({ error: "aster_preparation_binding_invalid" }, 409);
  }

  if (linkRecovery && expired <= Date.now()) {
    return json({ error: "aster_authorization_expired", reprepare_allowed: true }, 409);
  }
  let contract;
  try {
    contract = buildAsterV3AgentOnboardingContract({
      ownerAddress,
      agentName,
      attestedSigner: {
        publicAddress: signerAddress,
        provider: string(attested.provider),
        workerId: string(attested.worker_id),
        attestationSha256: string(attested.attestation_sha256),
      },
      nonceMicros: nonce,
      nowMs: linkRecovery ? Math.floor(nonce / 1_000) : Date.now(),
      expiresAtMs: expired,
      ipWhitelist,
      mayPlaceTradeDuringSetup: false,
    });
    await authorizeAsterV3AgentRegistration(contract, signature);
  } catch (error) {
    const errorCode = code(error) || "aster_owner_authorization_invalid";
    return json({
      error: errorCode,
      reprepare_allowed: errorCode === "nonce_outside_aster_window" || errorCode === "aster_authorization_stale",
    }, 403);
  }

  const worker = workerConfig(process.env);
  if (!worker.url) return json({ error: "private_worker_unavailable" }, 503);
  const authorizationPayload = {
    version: 1,
    venue_id: "aster",
    platform_class: "hyperliquid_style_market",
    execution_mode: "worker_generated_agent",
    operation_class: "credential_authorize",
    owner_commitment: guarded.owner.owner_commitment,
    account_commitment: account.account_commitment,
    owner_address: ownerAddress,
    signer_address: signerAddress,
    preparation_id: preparationId,
    agent_name: agentName,
    nonce,
    expired,
    ip_whitelist: ipWhitelist,
    signature,
    encrypted_execution_vault: encryptedVault,
  } as const;
  const signatureCommitment = `sha256:${createHash("sha256").update(signature).digest("hex")}`;
  const workerPath = linkRecovery ? WORKER_RECEIPT_PATH : WORKER_AUTHORIZE_PATH;
  const workerPayload = linkRecovery ? {
    version: 1,
    venue_id: "aster",
    platform_class: "hyperliquid_style_market",
    execution_mode: "worker_generated_agent",
    operation_class: "credential_receipt",
    owner_commitment: guarded.owner.owner_commitment,
    account_commitment: account.account_commitment,
    owner_address: ownerAddress,
    signer_address: signerAddress,
    preparation_id: preparationId,
    nonce,
    signature_commitment: signatureCommitment,
  } as const : authorizationPayload;
  if (linkRecovery && !validPublicRegistrationReceipt(
    expectedRegistrationReceipt,
    authorizationPayload,
    signatureCommitment,
  )) {
    return json({ error: "aster_registration_recovery_receipt_invalid" }, 409);
  }
  const authorization = workerAuthorizationHeader({
    fallbackToken: worker.token,
    method: "POST",
    path: workerPath,
    scope: linkRecovery ? "credential:verify" : "credential:authorize",
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
      ...(!linkRecovery ? {
        "x-ghola-credential-authorization-required": "true",
        "x-ghola-sealed-execution-required": "true",
      } : {}),
    },
    body: JSON.stringify(workerPayload),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!response) {
    return json({
      error: "aster_registration_outcome_ambiguous",
      retry_allowed: false,
    }, 502);
  }
  const receipt = record(await response.json().catch(() => null));
  if (!response.ok) {
    const errorCode = string(receipt.error_code) || string(receipt.error) || "aster_registration_failed";
    return json({
      error: errorCode,
      retry_allowed: !NON_RETRYABLE_REGISTRATION_ERRORS.has(errorCode),
    }, response.status);
  }
  if (!validRegistrationReceipt(receipt, authorizationPayload)) {
    return json({ error: "aster_registration_receipt_invalid" }, 502);
  }
  const registrationReceipt = publicRegistrationReceipt(receipt, authorizationPayload, signatureCommitment);
  if (linkRecovery && JSON.stringify(registrationReceipt) !== JSON.stringify(expectedRegistrationReceipt)) {
    return json({ error: "aster_registration_recovery_receipt_mismatch" }, 409);
  }

  const linked = await linkAgentPlatformFromBody({
    venue_id: "aster",
    platform_class: "hyperliquid_style_market",
    execution_mode: "byo_api_key",
    provisioning_mode: "programmatic_generated",
    turnkey_role: "none",
    owner_authorization_source: "external_owner_signature",
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
      registration_receipt: registrationReceipt,
    }, 502);
  }
  return json({
    version: 1,
    venue_id: "aster",
    status: "ready",
    preparation_id: preparationId,
    credential_registered: true,
    authorization_expires_at: new Date(expired).toISOString(),
    registration_receipt: registrationReceipt,
    setup: {
      may_place_trade: false,
      transaction_broadcast: false,
    },
    platform_link: linked,
  }, 201);
}

function validRegistrationReceipt(receipt: Record<string, unknown>, payload: Record<string, unknown>) {
  const permissions = record(receipt.permissions);
  const setup = record(receipt.setup);
  return receipt.version === 1 && receipt.venue_id === "aster" && receipt.status === "registered" &&
    receipt.preparation_id === payload.preparation_id &&
    string(receipt.owner_address).toLowerCase() === payload.owner_address &&
    string(receipt.signer_address).toLowerCase() === payload.signer_address &&
    permissions.can_read === true && permissions.can_trade === true &&
    permissions.can_spot_trade === false && permissions.can_perp_trade === true &&
    permissions.can_withdraw === false && permissions.can_transfer === false &&
    permissions.can_manage_credentials === false && permissions.can_export_secret === false &&
    Array.isArray(permissions.unknown_scopes) && permissions.unknown_scopes.length === 0 &&
    setup.may_place_trade === false && setup.transaction_broadcast === false &&
    setup.credential_registered === true &&
    JSON.stringify(receipt.encrypted_execution_vault) === JSON.stringify(payload.encrypted_execution_vault);
}

function publicRegistrationReceipt(
  receipt: Record<string, unknown>,
  payload: Record<string, unknown>,
  signatureCommitment: string,
) {
  return {
    version: 1,
    venue_id: "aster",
    status: "registered",
    preparation_id: string(receipt.preparation_id),
    owner_address: string(receipt.owner_address).toLowerCase(),
    signer_address: string(receipt.signer_address).toLowerCase(),
    signature_commitment: signatureCommitment,
    authorization_expires_at: new Date(Number(payload.expired)).toISOString(),
    permissions: record(receipt.permissions),
    setup: record(receipt.setup),
    registered_at: string(receipt.registered_at) || null,
  } as const;
}

function validPublicRegistrationReceipt(
  receipt: Record<string, unknown>,
  payload: Record<string, unknown>,
  signatureCommitment: string,
) {
  const permissions = record(receipt.permissions);
  const setup = record(receipt.setup);
  return receipt.version === 1 && receipt.venue_id === "aster" && receipt.status === "registered" &&
    receipt.preparation_id === payload.preparation_id &&
    string(receipt.owner_address).toLowerCase() === payload.owner_address &&
    string(receipt.signer_address).toLowerCase() === payload.signer_address &&
    receipt.signature_commitment === signatureCommitment &&
    receipt.authorization_expires_at === new Date(Number(payload.expired)).toISOString() &&
    permissions.can_read === true && permissions.can_trade === true &&
    permissions.can_spot_trade === false && permissions.can_perp_trade === true &&
    permissions.can_withdraw === false && permissions.can_transfer === false &&
    permissions.can_manage_credentials === false && permissions.can_export_secret === false &&
    Array.isArray(permissions.unknown_scopes) && permissions.unknown_scopes.length === 0 &&
    setup.may_place_trade === false && setup.transaction_broadcast === false &&
    setup.credential_registered === true;
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

function strings(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return null;
  return value.map((item) => item.trim()).filter(Boolean);
}

function positiveSafeInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function code(error: unknown): string {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : "";
}
