import {
  LIVE_TRADING_MAX_ORDER_NOTIONAL_USD,
  LIVE_TRADING_ROLLING_24H_NOTIONAL_USD,
  canonicalLiveTradingCaps,
  configuredLiveTradingCapabilities,
  liveTradingCapabilitiesForPlan,
  liveTradingCapabilityForPlan,
  type LiveTradingCapabilityId,
} from "./live-trading-contract";
import {
  currentLiveTradingReleaseIdentity,
} from "./live-trading-release.server";
import {
  getUnresolvedLiveTradingWorkOrder,
  reserveLiveTradingNotional,
  type LiveTradingNotionalReservation,
} from "./live-trading-store";
import {
  getHyperliquidExecutionVaultByAccount,
  getPrivateAccountByOwner,
} from "./private-account-store";
import {
  probeEmergencyLiveTradingWorkerReadiness,
} from "./private-agent-worker-readiness";
import { parseHyperliquidVaultAssociatedData } from "./hyperliquid-vault-seal";
import { inspectLiveTradingOpeningAccess } from "./live-trading-opening-access.server";
import type { TradeOrderPlan } from "./trade-order-plan";

export type LiveTradingAuthorizationResult =
  | {
      ok: true;
      capability: LiveTradingCapabilityId;
      account_commitment: string;
      vault_commitment: string;
      launch_revision: number | null;
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
  if (!vault || vault.owner_commitment !== input.owner_commitment ||
      vault.account_commitment !== account.account_commitment || vault.status !== "sealed") {
    return denied("sealed_hyperliquid_vault_required", 409);
  }
  const vaultAad = vault.vault?.encrypted_execution_vault?.aad;
  const vaultScope = typeof vaultAad === "string"
    ? parseHyperliquidVaultAssociatedData(vaultAad)
    : null;
  if (vaultScope?.network !== "mainnet" || vaultScope.account_commitment !== account.account_commitment) {
    return denied("hyperliquid_mainnet_vault_required", 409);
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

  // Risk-reducing orders remain available during kill, subscription, or eligibility changes.
  if (input.order_plan.execution_policy.reduce_only) {
    const account = await getPrivateAccountByOwner(input.owner_commitment);
    if (!account) return denied("private_account_required", 409);
    const vault = await getHyperliquidExecutionVaultByAccount(account.account_commitment);
    if (!vault || vault.owner_commitment !== input.owner_commitment ||
        vault.account_commitment !== account.account_commitment || vault.status !== "sealed") {
      return denied("sealed_hyperliquid_vault_required", 409);
    }
    const vaultAad = vault.vault?.encrypted_execution_vault?.aad;
    const vaultScope = typeof vaultAad === "string"
      ? parseHyperliquidVaultAssociatedData(vaultAad)
      : null;
    if (vaultScope?.network !== "mainnet" || vaultScope.account_commitment !== account.account_commitment) {
      return denied("hyperliquid_mainnet_vault_required", 409);
    }
    return {
      ok: true,
      capability,
      account_commitment: account.account_commitment,
      vault_commitment: vault.vault_commitment,
      launch_revision: null,
      reservation: null,
    };
  }

  const access = await inspectLiveTradingOpeningAccess({
    owner_commitment: input.owner_commitment,
    web_session_token: input.web_session_token,
    required_capabilities: requiredCapabilities,
    env,
    fetchImpl,
  });
  if (!access.ready || !access.account_commitment || !access.vault_commitment) {
    return access.denial ?? denied("live_trading_gate_closed", 503);
  }

  const unresolved = await getUnresolvedLiveTradingWorkOrder({
    owner_commitment: input.owner_commitment,
    account_commitment: access.account_commitment,
  });
  if (unresolved) return denied("live_work_order_reconciliation_required", 409);

  const notional = Number(input.order_plan.quote_notional_usd);
  const reserved = await reserveLiveTradingNotional({
    owner_commitment: input.owner_commitment,
    account_commitment: access.account_commitment,
    idempotency_key: input.idempotency_key,
    request_commitment: input.plan_digest,
    notional_usd: notional,
    max_order_notional_usd: LIVE_TRADING_MAX_ORDER_NOTIONAL_USD,
    rolling_24h_notional_usd: LIVE_TRADING_ROLLING_24H_NOTIONAL_USD,
  });
  if (!reserved.ok) {
    return denied(
      reserved.error,
      reserved.error === "idempotency_conflict" || reserved.error === "dispatch_absence_proven" ||
        reserved.error === "unresolved_work_order" ? 409 : 429,
    );
  }
  return {
    ok: true,
    capability,
    account_commitment: access.account_commitment,
    vault_commitment: access.vault_commitment,
    launch_revision: access.launch_revision,
    reservation: reserved.reservation,
  };
}

function denied(error: string, status: number) {
  return { ok: false as const, error, status, reason_codes: [error] };
}

export function liveTradingCapsForResponse() {
  return canonicalLiveTradingCaps();
}
