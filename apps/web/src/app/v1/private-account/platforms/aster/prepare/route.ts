import { createHash } from "node:crypto";
import {
  createOrGetStoredPrivateAccount,
  json,
  privateAccountLiveGuard,
} from "../../../_lib";
import {
  ASTER_V3_AGENT_MAX_LIFETIME_MS,
  buildAsterV3AgentOnboardingContract,
} from "@/lib/aster-agent-onboarding";
import {
  workerAuthorizationHeader,
  workerCapabilityExpectedFromBody,
} from "@/lib/private-agent-capability";
import { resolvePrivateAgentWorkerUrl } from "@/lib/private-account-worker-routing";

export const dynamic = "force-dynamic";

const WORKER_PATH = "/venues/aster/credentials/prepare";
const ASTER_TIME_URL = "https://fapi.asterdex.com/fapi/v3/time";
const EVM_ADDRESS = /^0x[0-9a-f]{40}$/i;
const SAFE_AGENT_NAME = /^[A-Za-z0-9._:-]{1,32}$/;

export async function POST(req: Request) {
  const guarded = await privateAccountLiveGuard(req);
  if (!guarded.ok) return guarded.response;
  const input = record(guarded.body);
  const ownerAddress = string(input.owner_address).toLowerCase();
  const agentName = string(input.agent_name) || "ghola-perps";
  const ipWhitelist = strings(input.ip_whitelist);
  if (!EVM_ADDRESS.test(ownerAddress)) return json({ error: "aster_owner_address_invalid" }, 400);
  if (!SAFE_AGENT_NAME.test(agentName)) return json({ error: "aster_agent_name_invalid" }, 400);
  if (!ipWhitelist) return json({ error: "aster_ip_whitelist_invalid" }, 400);

  const worker = workerConfig(process.env);
  if (!worker.url) return json({ error: "private_worker_unavailable" }, 503);
  const account = await createOrGetStoredPrivateAccount(guarded.owner);
  const payload = {
    version: 1,
    venue_id: "aster",
    platform_class: "hyperliquid_style_market",
    execution_mode: "worker_generated_agent",
    operation_class: "credential_provision",
    owner_commitment: guarded.owner.owner_commitment,
    account_commitment: account.account_commitment,
    owner_address: ownerAddress,
    agent_name: agentName,
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

  const [timeResponse, workerResponse] = await Promise.all([
    fetch(ASTER_TIME_URL, {
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    }).catch(() => null),
    fetch(new URL(WORKER_PATH, worker.url), {
      method: "POST",
      cache: "no-store",
      headers: {
        authorization,
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(12_000),
    }).catch(() => null),
  ]);
  if (!timeResponse?.ok) return json({ error: "aster_clock_unavailable" }, 503);
  if (!workerResponse) return json({ error: "private_worker_unavailable" }, 503);
  const workerBody = record(await workerResponse.json().catch(() => null));
  if (!workerResponse.ok) {
    return json({
      error: string(workerBody.error_code) || string(workerBody.error) || "aster_credential_prepare_failed",
    }, workerResponse.status);
  }
  const timeBody = record(await timeResponse.json().catch(() => null));
  const serverTimeMs = positiveSafeInteger(timeBody.serverTime);
  const prepared = validatePreparedCredential(workerBody, ownerAddress, account.account_commitment);
  if (!serverTimeMs) return json({ error: "aster_clock_invalid" }, 503);
  if (!prepared) return json({ error: "aster_worker_response_invalid" }, 502);

  const contract = buildAsterV3AgentOnboardingContract({
    ownerAddress,
    agentName,
    attestedSigner: {
      publicAddress: prepared.signerAddress,
      provider: prepared.provider,
      workerId: prepared.workerId,
      attestationSha256: prepared.attestationSha256,
    },
    nonceMicros: serverTimeMs * 1_000,
    nowMs: serverTimeMs,
    expiresAtMs: serverTimeMs + ASTER_V3_AGENT_MAX_LIFETIME_MS,
    ipWhitelist,
    mayPlaceTradeDuringSetup: false,
  });
  const preparationId = `aster_prepare_${createHash("sha256").update(JSON.stringify({
    account_commitment: account.account_commitment,
    owner_address: ownerAddress,
    signer_address: prepared.signerAddress,
    nonce: contract.approval.parametersWithoutSignature.nonce,
  })).digest("hex")}`;

  return json({
    version: 1,
    preparation_id: preparationId,
    owner_commitment: guarded.owner.owner_commitment,
    account_commitment: account.account_commitment,
    venue_id: "aster",
    credential_provisioning_mode: "programmatic_generated",
    owner_approval_required: true,
    authorization_expires_at: new Date(contract.approval.parametersWithoutSignature.expired).toISOString(),
    contract,
    encrypted_execution_vault: prepared.encryptedVault,
    permissions: prepared.permissions,
    setup: {
      may_place_trade: false,
      transaction_broadcast: false,
      credential_registered: false,
    },
  }, 201);
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
      env.PRIVATE_AGENT_WORKER_TOKEN?.trim() ||
      "",
  };
}

function validatePreparedCredential(
  body: Record<string, unknown>,
  ownerAddress: string,
  accountCommitment: string,
) {
  const attested = record(body.attested_signer);
  const permissions = record(body.permissions);
  const setup = record(body.setup);
  const encryptedVault = record(body.encrypted_execution_vault);
  const signerAddress = string(body.signer_address).toLowerCase();
  const workerId = string(attested.worker_id);
  const vaultRecipient = string(encryptedVault.recipient);
  const expectedAad = [
    "ghola/aster-execution-vault-v1",
    `account:${accountCommitment}`,
    `recipient:${vaultRecipient}`,
    "network:mainnet",
  ].join("|");
  if (
    body.version !== 1 || body.venue_id !== "aster" || body.network !== "mainnet" ||
    string(body.owner_address).toLowerCase() !== ownerAddress ||
    !EVM_ADDRESS.test(signerAddress) || signerAddress === ownerAddress ||
    string(attested.public_address).toLowerCase() !== signerAddress ||
    workerId !== vaultRecipient ||
    attested.private_key_exposed !== false ||
    permissions.can_read !== true || permissions.can_trade !== true ||
    permissions.can_perp_trade !== true || permissions.can_spot_trade !== false ||
    permissions.can_withdraw !== false || permissions.can_transfer !== false ||
    permissions.can_manage_credentials !== false || permissions.can_export_secret !== false ||
    !Array.isArray(permissions.unknown_scopes) || permissions.unknown_scopes.length !== 0 ||
    setup.may_place_trade !== false || setup.transaction_broadcast !== false ||
    encryptedVault.alg !== "sealed-provider-v1" || !string(encryptedVault.ciphertext) ||
    !vaultRecipient || encryptedVault.aad !== expectedAad
  ) return null;
  const provider = string(attested.provider);
  const attestationSha256 = string(attested.attestation_sha256);
  if (!provider || !workerId || !/^sha256:[0-9a-f]{64}$/i.test(attestationSha256)) return null;
  return {
    signerAddress,
    provider,
    workerId,
    attestationSha256,
    encryptedVault,
    permissions,
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
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return null;
  return value.map((item) => item.trim()).filter(Boolean);
}

function positiveSafeInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
