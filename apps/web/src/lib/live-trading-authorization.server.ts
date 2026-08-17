import {
  LIVE_TRADING_MAX_ORDER_NOTIONAL_USD,
  LIVE_TRADING_ROLLING_24H_NOTIONAL_USD,
  LIVE_TRADING_RISK_DISCLOSURE_VERSION,
  LIVE_TRADING_TERMS_VERSION,
  canonicalLiveTradingCaps,
  configuredLiveTradingCapabilities,
  liveTradingCapabilitiesForPlan,
  liveTradingCapabilityForPlan,
  type LiveTradingCapabilityId,
} from "./live-trading-contract";
import {
  currentLiveTradingReleaseIdentity,
  liveTradingLaunchBindingFailures,
} from "./live-trading-release.server";
import {
  evaluateLiveTradingCapability,
  getActiveLiveTradingAccountGraduation,
  getLiveTradingLaunchControl,
  reserveLiveTradingNotional,
  type LiveTradingNotionalReservation,
} from "./live-trading-store";
import {
  getHyperliquidExecutionVaultByAccount,
  getLatestVenueEligibilityByAccount,
  getPrivateAccountByOwner,
} from "./private-account-store";
import {
  probeEmergencyLiveTradingWorkerReadiness,
  probeLiveTradingWorkerReadiness,
} from "./private-agent-worker-readiness";
import { hasPrivateAgentEntitlement } from "./private-agent-runtime";
import type { TradeOrderPlan } from "./trade-order-plan";

export type LiveTradingAuthorizationResult =
  | {
      ok: true;
      capability: LiveTradingCapabilityId;
      account_commitment: string;
      vault_commitment: string;
      reservation: LiveTradingNotionalReservation | null;
    }
  | { ok: false; error: string; status: number; reason_codes: string[] };

export type LiveTradingRiskReductionAuthorizationResult =
  | {
      ok: true;
      account_commitment: string;
      vault_commitment: string;
    }
  | { ok: false; error: string; status: number; reason_codes: string[] };

export async function authorizeLiveTradingRiskReduction(input: {
  owner_commitment: string;
  web_session_token: string;
  emergency_action: "close" | "kill_and_flat";
  required_capabilities: Array<Extract<LiveTradingCapabilityId, "cancel" | "reduce_only">>;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
}): Promise<LiveTradingRiskReductionAuthorizationResult> {
  const env = input.env ?? process.env;
  const fetchImpl = input.fetchImpl ?? fetch;
  const requiredCapabilities = [...new Set(input.required_capabilities)];
  if (!requiredCapabilities.length) return denied("live_capability_not_supported", 409);
  const account = await getPrivateAccountByOwner(input.owner_commitment);
  if (!account) return denied("private_account_required", 409);
  const vault = await getHyperliquidExecutionVaultByAccount(account.account_commitment);
  if (!vault || vault.owner_commitment !== input.owner_commitment || vault.status !== "sealed") {
    return denied("sealed_hyperliquid_vault_required", 409);
  }
  const publicCapabilities = configuredLiveTradingCapabilities(env);
  if (!requiredCapabilities.every((required) => publicCapabilities.includes(required))) {
    return denied("live_capability_not_public", 503);
  }
  const release = currentLiveTradingReleaseIdentity(env);
  const worker = await probeEmergencyLiveTradingWorkerReadiness({
    action: input.emergency_action,
    env,
    fetchImpl,
    expectedRelease: release,
    requiredCapabilities,
  });
  const reasonCodes = [...new Set([
    ...release.reason_codes,
    ...worker.reason_codes,
  ])];
  // Emergency authority reduces exposure. Launch state, proof promotion,
  // billing, eligibility and graduation must never strand an existing
  // position, but release identity and the attested worker contract remain
  // exact and fail closed.
  if (!release.valid || !worker.ready || reasonCodes.length) {
    return { ok: false, error: "live_trading_gate_closed", status: 503, reason_codes: reasonCodes };
  }
  return {
    ok: true,
    account_commitment: account.account_commitment,
    vault_commitment: vault.vault_commitment,
  };
}

export async function authorizeLiveTradingMutation(input: {
  owner_commitment: string;
  web_session_token: string;
  order_plan: TradeOrderPlan;
  idempotency_key: string;
  plan_digest: string;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
}): Promise<LiveTradingAuthorizationResult> {
  const env = input.env ?? process.env;
  const fetchImpl = input.fetchImpl ?? fetch;
  const capability = liveTradingCapabilityForPlan(input.order_plan);
  if (!capability) return denied("live_capability_not_supported", 409);
  const requiredCapabilities = liveTradingCapabilitiesForPlan(input.order_plan);

  const account = await getPrivateAccountByOwner(input.owner_commitment);
  if (!account) return denied("private_account_required", 409);
  const vault = await getHyperliquidExecutionVaultByAccount(account.account_commitment);
  if (!vault || vault.owner_commitment !== input.owner_commitment || vault.status !== "sealed") {
    return denied("sealed_hyperliquid_vault_required", 409);
  }

  // Risk-reducing orders remain available during kill, subscription, or eligibility changes.
  if (input.order_plan.execution_policy.reduce_only) {
    return {
      ok: true,
      capability,
      account_commitment: account.account_commitment,
      vault_commitment: vault.vault_commitment,
      reservation: null,
    };
  }

  const publicCapabilities = configuredLiveTradingCapabilities(env);
  if (!requiredCapabilities.every((required) => publicCapabilities.includes(required))) {
    return denied("live_capability_not_public", 503);
  }
  const release = currentLiveTradingReleaseIdentity(env);
  const [launch, worker, capabilityStatus, eligibility, graduation, entitlement] = await Promise.all([
    getLiveTradingLaunchControl(),
    probeLiveTradingWorkerReadiness({
      env,
      fetchImpl,
      expectedRelease: release,
      requiredCapabilities,
    }),
    getLiveTradingLaunchControl().then((control) => Promise.all(requiredCapabilities.map((required) =>
      evaluateLiveTradingCapability({
        capability: required,
        release,
        launch_state: control.state,
        visible: true,
      })))),
    getLatestVenueEligibilityByAccount({ account_commitment: account.account_commitment, venue_id: "hyperliquid" }),
    getActiveLiveTradingAccountGraduation({
      owner_commitment: input.owner_commitment,
      account_commitment: account.account_commitment,
      vault_commitment: vault.vault_commitment,
    }),
    paidLiveTradingEntitlement(input.web_session_token, fetchImpl, env),
  ]);
  const reasonCodes = [...new Set([
    ...release.reason_codes,
    ...liveTradingLaunchBindingFailures(launch, release, publicCapabilities),
    ...worker.reason_codes,
    ...capabilityStatus.flatMap((status) => status.reason_codes),
  ])];
  if (reasonCodes.length || capabilityStatus.some((status) => status.state !== "live")) {
    return { ok: false, error: "live_trading_gate_closed", status: 503, reason_codes: reasonCodes };
  }
  const credential = eligibility?.credential;
  const eligible = Boolean(
    eligibility?.owner_commitment === input.owner_commitment &&
    eligibility.status === "verified" &&
    Date.parse(eligibility.expires_at) > Date.now() &&
    credential?.credential_type === "self_attested_eligible_user" &&
    credential.eligibility_basis === "self_attested_non_us" &&
    credential.eligible_non_us === true &&
    credential.terms_version === LIVE_TRADING_TERMS_VERSION &&
    credential.risk_disclosure_version === LIVE_TRADING_RISK_DISCLOSURE_VERSION &&
    Boolean(credential.accepted_at),
  );
  if (!eligible) return denied("live_trading_eligibility_required", 451);
  if (!graduation) return denied("funded_account_proof_required", 409);
  if (!entitlement.ok) return entitlement;

  const notional = Number(input.order_plan.quote_notional_usd);
  const reserved = await reserveLiveTradingNotional({
    owner_commitment: input.owner_commitment,
    account_commitment: account.account_commitment,
    idempotency_key: input.idempotency_key,
    request_commitment: input.plan_digest,
    notional_usd: notional,
    max_order_notional_usd: LIVE_TRADING_MAX_ORDER_NOTIONAL_USD,
    rolling_24h_notional_usd: LIVE_TRADING_ROLLING_24H_NOTIONAL_USD,
  });
  if (!reserved.ok) return denied(reserved.error, reserved.error === "idempotency_conflict" ? 409 : 429);
  return {
    ok: true,
    capability,
    account_commitment: account.account_commitment,
    vault_commitment: vault.vault_commitment,
    reservation: reserved.reservation,
  };
}

async function paidLiveTradingEntitlement(
  sessionToken: string,
  fetchImpl: typeof fetch,
  env: Record<string, string | undefined>,
): Promise<{ ok: true } | { ok: false; error: string; status: number; reason_codes: string[] }> {
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
  const body = await response.json().catch(() => null) as {
    tier?: string | null;
    private_agent_trading?: { live_trading_allowed?: boolean; cap_reached?: boolean } | null;
  } | null;
  if (!hasPrivateAgentEntitlement(body?.tier)) return denied("private_agent_subscription_required", 402);
  if (body?.private_agent_trading?.live_trading_allowed !== true) {
    return denied(body?.private_agent_trading?.cap_reached
      ? "private_agent_trading_fee_cap_reached"
      : "private_agent_trading_entitlement_required", 402);
  }
  return { ok: true };
}

function denied(error: string, status: number) {
  return { ok: false as const, error, status, reason_codes: [error] };
}

export function liveTradingCapsForResponse() {
  return canonicalLiveTradingCaps();
}
