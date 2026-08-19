import { workerAuthorizationHeader, workerCapabilityExpectedFromBody } from "./private-agent-capability";
import { autopilotWorkerConfig, probeLiveTradingWorkerReadiness } from "./private-agent-worker-readiness";
import { privateAgentTransportAllowed } from "./private-agent-spend-policy";
import { currentLiveTradingReleaseIdentity } from "./live-trading-release.server";
import { configuredLiveTradingCapabilities } from "./live-trading-contract";
import { gholaCommitment } from "./private-account";
import {
  HyperliquidAgentAuthorizationError,
  assertHyperliquidAgentVaultBinding,
  type VerifiedHyperliquidAgentAuthorization,
} from "./hyperliquid-agent-wallet.server";
import type { HyperliquidAgentAuthorizationRequest } from "./hyperliquid-agent-wallet";
import { parseHyperliquidVaultAssociatedData } from "./hyperliquid-vault-seal";

const WORKER_PATH = "/hyperliquid/verify";
const MAX_WORKER_RESPONSE_BYTES = 64 * 1_024;

export interface HyperliquidAgentWalletWorkerDependencies {
  fetchImpl: typeof fetch;
  env: Record<string, string | undefined>;
  currentRelease: typeof currentLiveTradingReleaseIdentity;
  probeWorker: typeof probeLiveTradingWorkerReadiness;
  transportAllowed: typeof privateAgentTransportAllowed;
  workerConfig: typeof autopilotWorkerConfig;
  authorizationHeader: typeof workerAuthorizationHeader;
}

const DEFAULT_DEPENDENCIES: HyperliquidAgentWalletWorkerDependencies = {
  fetchImpl: fetch,
  env: process.env,
  currentRelease: currentLiveTradingReleaseIdentity,
  probeWorker: probeLiveTradingWorkerReadiness,
  transportAllowed: privateAgentTransportAllowed,
  workerConfig: autopilotWorkerConfig,
  authorizationHeader: workerAuthorizationHeader,
};

export async function verifyHyperliquidAgentVaultWithWorker(input: {
  request: HyperliquidAgentAuthorizationRequest;
  accountCommitment: string;
  authorization: VerifiedHyperliquidAgentAuthorization;
  dependencies?: Partial<HyperliquidAgentWalletWorkerDependencies>;
}) {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...input.dependencies };
  const scope = assertHyperliquidAgentVaultBinding({
    aad: input.request.encrypted_execution_vault.aad,
    recipient: input.request.encrypted_execution_vault.recipient,
    accountCommitment: input.accountCommitment,
    masterAddress: input.authorization.account_address,
    agentAddress: input.authorization.agent_address,
  });
  const vaultBundleCommitment = gholaCommitment(
    "hyperliquid_agent_onboarding_bundle",
    input.request.encrypted_execution_vault,
  );
  const body = {
    version: 1,
    venue_id: "hyperliquid",
    platform_class: "hyperliquid_style_market",
    execution_mode: "byo_api_key",
    operation_class: "agent_wallet_onboarding_verify",
    account_commitment: input.accountCommitment,
    vault_bundle_commitment: vaultBundleCommitment,
    encrypted_execution_vault: input.request.encrypted_execution_vault,
    expected_authorization: {
      venue_account_commitment: scope.venue_account_commitment!,
      agent_wallet_commitment: scope.agent_wallet_commitment!,
      agent_base_name: input.authorization.agent_base_name,
      agent_name: input.request.action.agentName,
      valid_until_ms: input.authorization.valid_until_ms,
    },
  };

  const release = dependencies.currentRelease(dependencies.env);
  if (!release.valid || !release.worker_git_sha || !release.worker_image_digest || !release.config_fingerprint) {
    unknownWorkerState();
  }
  if (!dependencies.transportAllowed("execute", dependencies.env, dependencies.fetchImpl)) {
    unknownWorkerState();
  }
  const config = dependencies.workerConfig(dependencies.env);
  if (!config.url || !config.authConfigured) unknownWorkerState();
  const readiness = await dependencies.probeWorker({
    env: dependencies.env,
    fetchImpl: dependencies.fetchImpl,
    expectedRelease: release,
    requiredCapabilities: configuredLiveTradingCapabilities(dependencies.env),
  }).catch(() => null);
  if (!readiness?.ready) unknownWorkerState();

  const authorization = dependencies.authorizationHeader({
    env: dependencies.env,
    fallbackToken: config.token,
    method: "POST",
    path: WORKER_PATH,
    scope: "order:verify",
    body,
    expected: workerCapabilityExpectedFromBody(body, {
      venue_id: "hyperliquid",
      platform_class: "hyperliquid_style_market",
      operation_class: "agent_wallet_onboarding_verify",
    }),
  });
  if (!authorization) unknownWorkerState();
  const response = await dependencies.fetchImpl(new URL(WORKER_PATH, config.url), {
    method: "POST",
    cache: "no-store",
    redirect: "error",
    headers: {
      authorization,
      "content-type": "application/json",
      accept: "application/json",
      "x-ghola-sealed-execution-required": "true",
      "x-ghola-no-submit-verify": "true",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  }).catch(() => null);
  if (!response) unknownWorkerState();
  const raw = await boundedJson(response);
  if (!response.ok) {
    const error = record(raw);
    const code = stringValue(error.error_code) || stringValue(error.error);
    if (response.status === 409 && (
      code === "hyperliquid_agent_vault_unreadable" ||
      code === "hyperliquid_agent_vault_recipient_mismatch" ||
      code === "hyperliquid_agent_vault_identity_mismatch"
    )) {
      throw new HyperliquidAgentAuthorizationError(code, 409);
    }
    unknownWorkerState();
  }
  const proof = record(raw);
  const workerRelease = record(proof.worker_release);
  const exact = proof.version === 1 &&
    proof.proof_kind === "hyperliquid_agent_wallet_onboarding_verification_v1" &&
    proof.status === "verified" && proof.network === "mainnet" && proof.no_submit === true &&
    proof.decrypted === true && proof.derived_agent_address_verified === true &&
    proof.venue_authorization_verified === true &&
    proof.account_commitment === input.accountCommitment &&
    proof.vault_bundle_commitment === vaultBundleCommitment &&
    proof.recipient_commitment === gholaCommitment("sealed_recipient", input.request.encrypted_execution_vault.recipient) &&
    proof.venue_account_commitment === scope.venue_account_commitment &&
    proof.agent_wallet_commitment === scope.agent_wallet_commitment &&
    proof.agent_base_name === input.authorization.agent_base_name &&
    proof.valid_until_ms === input.authorization.valid_until_ms &&
    typeof proof.verification_commitment === "string" &&
    /^hyperliquid_agent_onboarding_verification_[0-9a-f]{48}$/.test(proof.verification_commitment) &&
    validRecentIsoTime(proof.checked_at) &&
    workerRelease.contract_version === release.contract_version &&
    workerRelease.worker_git_sha === release.worker_git_sha &&
    workerRelease.worker_image_digest === release.worker_image_digest &&
    workerRelease.config_fingerprint === release.config_fingerprint;
  if (!exact) unknownWorkerState();
  return {
    verification_commitment: proof.verification_commitment as string,
    checked_at: proof.checked_at as string,
    worker_contract_version: release.contract_version,
    worker_git_sha: release.worker_git_sha,
    worker_image_digest: release.worker_image_digest,
    config_fingerprint: release.config_fingerprint,
  };
}

export async function verifyLegacyHyperliquidAgentRevokedWithWorker(input: {
  accountCommitment: string;
  encryptedExecutionVault: {
    alg: string;
    ciphertext: string;
    recipient: string;
    aad: string;
  };
  dependencies?: Partial<HyperliquidAgentWalletWorkerDependencies>;
}) {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...input.dependencies };
  const bundle = input.encryptedExecutionVault;
  const scope = parseHyperliquidVaultAssociatedData(bundle.aad);
  if (bundle.alg !== "sealed-provider-v1" || !bundle.ciphertext || !bundle.recipient ||
      scope?.version !== 1 || scope.network !== "mainnet" ||
      scope.account_commitment !== input.accountCommitment || scope.recipient !== bundle.recipient) {
    throw new HyperliquidAgentAuthorizationError("hyperliquid_agent_vault_identity_mismatch", 409);
  }
  const vaultBundleCommitment = gholaCommitment(
    "hyperliquid_agent_legacy_removal_bundle",
    bundle,
  );
  const body = {
    version: 1,
    venue_id: "hyperliquid",
    platform_class: "hyperliquid_style_market",
    execution_mode: "byo_api_key",
    operation_class: "agent_wallet_legacy_revocation_verify",
    account_commitment: input.accountCommitment,
    vault_bundle_commitment: vaultBundleCommitment,
    encrypted_execution_vault: bundle,
  };

  const release = dependencies.currentRelease(dependencies.env);
  if (!release.valid || !release.worker_git_sha || !release.worker_image_digest || !release.config_fingerprint) {
    unknownWorkerState();
  }
  if (!dependencies.transportAllowed("execute", dependencies.env, dependencies.fetchImpl)) {
    unknownWorkerState();
  }
  const config = dependencies.workerConfig(dependencies.env);
  if (!config.url || !config.authConfigured) unknownWorkerState();
  const readiness = await dependencies.probeWorker({
    env: dependencies.env,
    fetchImpl: dependencies.fetchImpl,
    expectedRelease: release,
    requiredCapabilities: configuredLiveTradingCapabilities(dependencies.env),
  }).catch(() => null);
  if (!readiness?.ready) unknownWorkerState();

  const authorization = dependencies.authorizationHeader({
    env: dependencies.env,
    fallbackToken: config.token,
    method: "POST",
    path: WORKER_PATH,
    scope: "order:verify",
    body,
    expected: workerCapabilityExpectedFromBody(body, {
      venue_id: "hyperliquid",
      platform_class: "hyperliquid_style_market",
      operation_class: "agent_wallet_legacy_revocation_verify",
    }),
  });
  if (!authorization) unknownWorkerState();
  const response = await dependencies.fetchImpl(new URL(WORKER_PATH, config.url), {
    method: "POST",
    cache: "no-store",
    redirect: "error",
    headers: {
      authorization,
      "content-type": "application/json",
      accept: "application/json",
      "x-ghola-sealed-execution-required": "true",
      "x-ghola-no-submit-verify": "true",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  }).catch(() => null);
  if (!response) unknownWorkerState();
  const raw = await boundedJson(response);
  if (!response.ok) {
    const error = record(raw);
    const code = stringValue(error.error_code) || stringValue(error.error);
    if (response.status === 409 && [
      "legacy_hyperliquid_agent_still_authorized",
      "hyperliquid_agent_vault_unreadable",
      "hyperliquid_agent_vault_recipient_mismatch",
      "hyperliquid_agent_vault_identity_mismatch",
    ].includes(code)) {
      throw new HyperliquidAgentAuthorizationError(code, 409);
    }
    if (response.status === 503 && code === "hyperliquid_agent_authorization_state_unknown") {
      throw new HyperliquidAgentAuthorizationError(code, 503);
    }
    unknownWorkerState();
  }
  const proof = record(raw);
  const workerRelease = record(proof.worker_release);
  const exact = proof.version === 1 &&
    proof.proof_kind === "hyperliquid_legacy_agent_revocation_verification_v1" &&
    proof.status === "revoked" && proof.network === "mainnet" && proof.no_submit === true &&
    proof.decrypted === true && proof.derived_agent_address_verified === true &&
    proof.venue_authorization_absent === true &&
    proof.account_commitment === input.accountCommitment &&
    proof.vault_bundle_commitment === vaultBundleCommitment &&
    proof.recipient_commitment === gholaCommitment("sealed_recipient", bundle.recipient) &&
    typeof proof.venue_account_commitment === "string" &&
    /^hyperliquid_venue_account_[0-9a-f]{48}$/.test(proof.venue_account_commitment) &&
    typeof proof.agent_wallet_commitment === "string" &&
    /^hyperliquid_agent_wallet_[0-9a-f]{48}$/.test(proof.agent_wallet_commitment) &&
    proof.venue_account_commitment !== proof.agent_wallet_commitment &&
    typeof proof.verification_commitment === "string" &&
    /^hyperliquid_agent_legacy_removal_verification_[0-9a-f]{48}$/.test(proof.verification_commitment) &&
    validRecentIsoTime(proof.checked_at) &&
    workerRelease.contract_version === release.contract_version &&
    workerRelease.worker_git_sha === release.worker_git_sha &&
    workerRelease.worker_image_digest === release.worker_image_digest &&
    workerRelease.config_fingerprint === release.config_fingerprint;
  if (!exact) unknownWorkerState();
  return {
    verification_commitment: proof.verification_commitment as string,
    checked_at: proof.checked_at as string,
  };
}

async function boundedJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > MAX_WORKER_RESPONSE_BYTES) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function validRecentIsoTime(value: unknown) {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && Math.abs(Date.now() - timestamp) <= 5 * 60_000;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function unknownWorkerState(): never {
  throw new HyperliquidAgentAuthorizationError(
    "hyperliquid_agent_vault_worker_verification_unknown",
    503,
  );
}
