import {
  LIVE_TRADING_RISK_DISCLOSURE_VERSION,
  LIVE_TRADING_TERMS_VERSION,
  canonicalLiveTradingCaps,
  configuredLiveTradingCapabilities,
  type LiveTradingCapabilityId,
  type LiveTradingCapabilityStatus,
  type LiveTradingReleaseIdentity,
} from "./live-trading-contract";
import {
  currentLiveTradingReleaseIdentity,
  liveTradingControlBindingFailures,
} from "./live-trading-release.server";
import {
  evaluateLiveTradingCapability,
  getActiveLiveTradingAccountGraduation,
  getLiveTradingLaunchControl,
  type LiveTradingLaunchControl,
} from "./live-trading-store";
import {
  getHyperliquidExecutionVaultByAccount,
  getLatestVenueEligibilityByAccount,
  getPrivateAccountByOwner,
} from "./private-account-store";
import {
  probeLiveTradingWorkerReadiness,
  type LiveTradingWorkerReadiness,
} from "./private-agent-worker-readiness";
import { evaluateInvestorAccess } from "./investor-access";
import type { ThumperBillingStatusResponse } from "./thumper-types";
import { parseHyperliquidVaultAssociatedData } from "./hyperliquid-vault-seal";
import { isCurrentHyperliquidVaultAuthorization } from "./hyperliquid-vault-scope";

type AccessDenial = { ok: false; error: string; status: number; reason_codes: string[] };

export interface LiveTradingOpeningAccessInspection {
  ready: boolean;
  access_mode: "public" | "account_canary" | null;
  launch_state: LiveTradingLaunchControl["state"];
  launch_revision: number;
  release_identity: LiveTradingReleaseIdentity;
  live_worker_readiness: LiveTradingWorkerReadiness | null;
  effective_caps: ReturnType<typeof canonicalLiveTradingCaps>;
  configured_capabilities: LiveTradingCapabilityId[];
  required_capabilities: LiveTradingCapabilityId[];
  authorized_capabilities: LiveTradingCapabilityId[];
  account_ready: boolean;
  vault_ready: boolean;
  eligibility_ready: boolean;
  entitlement_ready: boolean;
  graduation_ready: boolean;
  graduation_completed_at: string | null;
  reason_codes: string[];
  denial: AccessDenial | null;
  account_commitment: string | null;
  vault_commitment: string | null;
}

export interface LiveTradingOpeningAccessDependencies {
  currentRelease: typeof currentLiveTradingReleaseIdentity;
  getAccount: typeof getPrivateAccountByOwner;
  getVault: typeof getHyperliquidExecutionVaultByAccount;
  getEligibility: typeof getLatestVenueEligibilityByAccount;
  getGraduation: typeof getActiveLiveTradingAccountGraduation;
  getLaunch: typeof getLiveTradingLaunchControl;
  evaluateCapability: typeof evaluateLiveTradingCapability;
  probeWorker: typeof probeLiveTradingWorkerReadiness;
  entitlement: typeof paidLiveTradingEntitlement;
}

const DEFAULT_DEPENDENCIES: LiveTradingOpeningAccessDependencies = {
  currentRelease: currentLiveTradingReleaseIdentity,
  getAccount: getPrivateAccountByOwner,
  getVault: getHyperliquidExecutionVaultByAccount,
  getEligibility: getLatestVenueEligibilityByAccount,
  getGraduation: getActiveLiveTradingAccountGraduation,
  getLaunch: getLiveTradingLaunchControl,
  evaluateCapability: evaluateLiveTradingCapability,
  probeWorker: probeLiveTradingWorkerReadiness,
  entitlement: paidLiveTradingEntitlement,
};

export async function inspectLiveTradingOpeningAccess(input: {
  owner_commitment: string;
  web_session_token: string;
  required_capabilities: LiveTradingCapabilityId[];
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  dependencies?: LiveTradingOpeningAccessDependencies;
}): Promise<LiveTradingOpeningAccessInspection> {
  const env = input.env ?? process.env;
  const fetchImpl = input.fetchImpl ?? fetch;
  const dependencies = input.dependencies ?? DEFAULT_DEPENDENCIES;
  const requiredCapabilities = [...new Set(input.required_capabilities)];
  const configuredCapabilities = configuredLiveTradingCapabilities(env);
  const release = dependencies.currentRelease(env);
  const [launch, account] = await Promise.all([
    dependencies.getLaunch(),
    dependencies.getAccount(input.owner_commitment),
  ]);

  if (!account) {
    return earlyBlocked({
      error: "private_account_required",
      status: 409,
      launch,
      release,
      configuredCapabilities,
      requiredCapabilities,
      accountReady: false,
    });
  }
  const vault = await dependencies.getVault(account.account_commitment);
  if (!vault || vault.owner_commitment !== input.owner_commitment ||
      vault.account_commitment !== account.account_commitment || vault.status !== "sealed") {
    return earlyBlocked({
      error: "sealed_hyperliquid_vault_required",
      status: 409,
      launch,
      release,
      configuredCapabilities,
      requiredCapabilities,
      accountReady: true,
      accountCommitment: account.account_commitment,
    });
  }
  const vaultScope = parseHyperliquidVaultAssociatedData(vault.vault.encrypted_execution_vault.aad);
  if (vaultScope?.network !== "mainnet" || vaultScope.account_commitment !== account.account_commitment) {
    return earlyBlocked({
      error: "hyperliquid_mainnet_vault_required",
      status: 409,
      launch,
      release,
      configuredCapabilities,
      requiredCapabilities,
      accountReady: true,
      accountCommitment: account.account_commitment,
    });
  }
  if ((launch.state === "canary" &&
      vault.vault.authorization?.source !== "phantom_approve_agent_v1") ||
      !isCurrentHyperliquidVaultAuthorization(vault, Date.now(), undefined, release)) {
    return earlyBlocked({
      error: "hyperliquid_agent_authorization_required",
      status: 409,
      launch,
      release,
      configuredCapabilities,
      requiredCapabilities,
      accountReady: true,
      accountCommitment: account.account_commitment,
    });
  }

  const workerCapabilities = launch.state === "canary"
    ? configuredCapabilities
    : requiredCapabilities;
  const [worker, eligibility, graduation, entitlement, capabilityStatus] = await Promise.all([
    dependencies.probeWorker({
      env,
      fetchImpl,
      expectedRelease: release,
      requiredCapabilities: workerCapabilities,
    }),
    dependencies.getEligibility({ account_commitment: account.account_commitment, venue_id: "hyperliquid" }),
    dependencies.getGraduation({
      owner_commitment: input.owner_commitment,
      account_commitment: account.account_commitment,
      vault_commitment: vault.vault_commitment,
      release,
    }),
    dependencies.entitlement(input.web_session_token, fetchImpl, env, {
      requireComplimentaryPass: launch.state === "canary",
      requiredFilledNotionalMicroUsd: launch.state === "canary" ? undefined : 0,
    }),
    launch.state === "public"
      ? Promise.all(requiredCapabilities.map((capability) => dependencies.evaluateCapability({
          capability,
          release,
          launch_state: "public",
          visible: true,
        })))
      : Promise.resolve([] as LiveTradingCapabilityStatus[]),
  ]);

  const configuredReady = requiredCapabilities.length > 0 &&
    requiredCapabilities.every((capability) => configuredCapabilities.includes(capability));
  const launchFailures = liveTradingControlBindingFailures(
    launch,
    release,
    configuredCapabilities,
    ["canary", "public"],
  );
  const publicCapabilitiesReady = launch.state !== "public" ||
    capabilityStatus.every((capability) => capability.state === "live" && capability.visible);
  const eligibilityReady = liveTradingEligibilityReady(eligibility, input.owner_commitment);
  const graduationReady = Boolean(graduation);
  const gateReasons = [...new Set([
    ...(configuredReady ? [] : ["live_capability_not_public"]),
    ...release.reason_codes,
    ...(release.valid ? [] : ["live_release_identity_invalid"]),
    ...launchFailures,
    ...worker.reason_codes,
    ...(worker.ready ? [] : ["live_worker_not_ready"]),
    ...(launch.state === "public"
      ? capabilityStatus
          .filter((capability) => capability.state !== "live" || !capability.visible)
          .flatMap((capability) => capability.reason_codes.length
            ? capability.reason_codes
            : [`live_capability_not_proven:${capability.id}`])
      : []),
  ])];
  const reasonCodes = [...new Set([
    ...gateReasons,
    ...(eligibilityReady ? [] : ["live_trading_eligibility_required"]),
    ...(graduationReady ? [] : ["funded_account_proof_required"]),
    ...(entitlement.ok ? [] : entitlement.reason_codes),
  ])];
  const ready = configuredReady && release.valid && launchFailures.length === 0 &&
    worker.ready && publicCapabilitiesReady && eligibilityReady && graduationReady && entitlement.ok;
  const denial = ready
    ? null
    : !configuredReady
      ? denied("live_capability_not_public", 503, reasonCodes)
      : gateReasons.length || !publicCapabilitiesReady
        ? denied("live_trading_gate_closed", 503, reasonCodes)
        : !eligibilityReady
          ? denied("live_trading_eligibility_required", 451, reasonCodes)
          : !graduationReady
            ? denied("funded_account_proof_required", 409, reasonCodes)
            : entitlement.ok
              ? denied("live_trading_gate_closed", 503, reasonCodes)
              : denied(entitlement.error, entitlement.status, reasonCodes);

  return {
    ready,
    access_mode: ready ? launch.state === "canary" ? "account_canary" : "public" : null,
    launch_state: launch.state,
    launch_revision: launch.revision,
    release_identity: release,
    live_worker_readiness: worker,
    effective_caps: canonicalLiveTradingCaps(),
    configured_capabilities: configuredCapabilities,
    required_capabilities: requiredCapabilities,
    authorized_capabilities: ready ? requiredCapabilities : [],
    account_ready: true,
    vault_ready: true,
    eligibility_ready: eligibilityReady,
    entitlement_ready: entitlement.ok,
    graduation_ready: graduationReady,
    graduation_completed_at: graduation?.completed_at ?? null,
    reason_codes: reasonCodes,
    denial,
    account_commitment: account.account_commitment,
    vault_commitment: vault.vault_commitment,
  };
}

export function terminalLiveTradingOpeningCapabilities(
  env: Record<string, string | undefined> = process.env,
): LiveTradingCapabilityId[] {
  return env.GHOLA_LIVE_TRADING_POSITION_PROTECTION_ENABLED?.trim() === "true"
    ? ["limit_order", "stop_loss", "take_profit"]
    : ["limit_order"];
}

export async function paidLiveTradingEntitlement(
  sessionToken: string,
  fetchImpl: typeof fetch,
  env: Record<string, string | undefined>,
  requirements: Parameters<typeof evaluateInvestorAccess>[2] = {},
): Promise<{ ok: true } | AccessDenial> {
  if (!sessionToken) return denied("web_session_required", 401);
  const base = (env.NEXT_PUBLIC_THUMPER_API_URL || "https://thumper-cloud.onrender.com").replace(/\/+$/, "");
  const response = await fetchImpl(`${base}/api/billing/status`, {
    method: "GET",
    headers: { Authorization: `Bearer ${sessionToken}`, Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(5_000),
  }).catch(() => null);
  if (!response) return denied("billing_unavailable", 503);
  if (!response.ok) return denied("billing_rejected_request", response.status);
  const body = await response.json().catch(() => null) as ThumperBillingStatusResponse | null;
  const access = evaluateInvestorAccess(body, Date.now(), requirements);
  if (!access.ready) return denied(access.blocker ?? "billing_unavailable", 402);
  return { ok: true };
}

function liveTradingEligibilityReady(value: unknown, ownerCommitment: string) {
  const eligibility = objectValue(value);
  const credential = objectValue(eligibility.credential);
  return eligibility.owner_commitment === ownerCommitment && eligibility.status === "verified" &&
    typeof eligibility.expires_at === "string" && Date.parse(eligibility.expires_at) > Date.now() &&
    credential.credential_type === "self_attested_eligible_user" &&
    credential.eligibility_basis === "self_attested_non_us" && credential.eligible_non_us === true &&
    credential.terms_version === LIVE_TRADING_TERMS_VERSION &&
    credential.risk_disclosure_version === LIVE_TRADING_RISK_DISCLOSURE_VERSION &&
    Boolean(credential.accepted_at);
}

function earlyBlocked(input: {
  error: string;
  status: number;
  launch: LiveTradingLaunchControl;
  release: LiveTradingReleaseIdentity;
  configuredCapabilities: LiveTradingCapabilityId[];
  requiredCapabilities: LiveTradingCapabilityId[];
  accountReady: boolean;
  accountCommitment?: string;
}): LiveTradingOpeningAccessInspection {
  return {
    ready: false,
    access_mode: null,
    launch_state: input.launch.state,
    launch_revision: input.launch.revision,
    release_identity: input.release,
    live_worker_readiness: null,
    effective_caps: canonicalLiveTradingCaps(),
    configured_capabilities: input.configuredCapabilities,
    required_capabilities: input.requiredCapabilities,
    authorized_capabilities: [],
    account_ready: input.accountReady,
    vault_ready: false,
    eligibility_ready: false,
    entitlement_ready: false,
    graduation_ready: false,
    graduation_completed_at: null,
    reason_codes: [input.error],
    denial: denied(input.error, input.status),
    account_commitment: input.accountCommitment ?? null,
    vault_commitment: null,
  };
}

function denied(error: string, status: number, reasonCodes: string[] = [error]): AccessDenial {
  return { ok: false, error, status, reason_codes: reasonCodes };
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
