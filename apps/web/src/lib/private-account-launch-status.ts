import { getPrivateAgentRuntimeStatus } from "./private-agent-runtime-server";
import type { PrivateAgentRuntimeStatus } from "./private-agent-runtime";
import { enterpriseGateStatus, type GholaEnterpriseGateStatus } from "./enterprise-gate-status";
import { freshSealedRuntimeHealth, type GholaRuntimeHealth } from "./private-account-runtime";
import {
  getLatestLiveTradingCanaryReport,
  type PrivateLiveTradingCanaryReportRecordV1,
} from "./private-account-store";

export interface GholaLaunchCheck {
  check: string;
  status: "ready" | "missing" | "blocked";
  reason: string | null;
}

export interface GholaPrivateAccountLaunchStatus {
  version: 1;
  ready_to_accept_users: boolean;
  live_flow: "hyperliquid_tiny_fill";
  checks: GholaLaunchCheck[];
  runtime: {
    remote_execution_ready: boolean;
    selected_provider: string | null;
    blocking_reasons: string[];
  };
  enterprise_gate: GholaEnterpriseGateStatus;
  required_env: string[];
  checked_at: string;
}

const REQUIRED_LIVE_ENV = [
  "GHOLA_PRIVATE_AGENT_BETA_PUBLIC_ENABLED=true",
  "GHOLA_LIVE_TRADING_PUBLIC_ENABLED=true",
  "GHOLA_V6_HYPERLIQUID_PILOT_ENABLED=true",
  "NEXT_PUBLIC_GHOLA_LEGACY_HYPERLIQUID_API_KEYS=true (verified trade-only scoped-wallet onboarding)",
  "GHOLA_HYPERLIQUID_LIVE_MODE=tiny_fill",
  "GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_MODE=enforce",
  "GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_SECRET=<32+ character production secret>",
  "GHOLA_LIVE_TRADING_MAX_ORDER_NOTIONAL_USD<=50",
  "GHOLA_LIVE_TRADING_DAILY_CAP_USD<=250",
  "GHOLA_LIVE_TRADING_MAX_SLIPPAGE_BPS<=100",
  "PRIVATE_AGENT_GLOBAL_KILL_SWITCH=false (explicitly configured)",
  "GHOLA_PUBLIC_BETA_MONITORING_ENABLED=true",
  "GHOLA_OPERATIONS_ALERT_WEBHOOK=<secret URL>, SENTRY_DSN=<secret>, GHOLA_LOG_DRAIN_CONFIGURED=true, or GHOLA_VERCEL_ALERTS_CONFIGURED=true",
  "GHOLA_PUBLIC_BETA_ROLLBACK_READY=true",
  "GHOLA_PUBLIC_BETA_RUNBOOK_VERSION=2026-08-23",
  "GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_TOKEN=<worker-token>",
  "attested provider publishes execution_url and sealed recipient evidence, or GHOLA_PRIVATE_RUNTIME_URL / GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_URL are set manually",
  "fresh Hyperliquid capital-free no-submit canary is green and matches public beta caps",
] as const;

export async function privateAccountLaunchStatus(
  env: Record<string, string | undefined> = process.env,
  runtime?: PrivateAgentRuntimeStatus,
  runtimeHealth?: GholaRuntimeHealth,
  noSubmitCanary?: PrivateLiveTradingCanaryReportRecordV1 | null,
): Promise<GholaPrivateAccountLaunchStatus> {
  const currentRuntime = runtime ?? await getPrivateAgentRuntimeStatus();
  const enterpriseGate = enterpriseGateStatus(env);
  const selectedProvider = currentRuntime.providers.find(
    (provider) => provider.id === currentRuntime.selected_provider,
  );
  const runtimeExecutionUrl = trimmed(selectedProvider?.execution_url ?? undefined);
  const connectorUrl = trimmed(env.GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_URL) || runtimeExecutionUrl;
  const explicitConnectorReadiness = trimmed(
    env.GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_READINESS,
  );
  const connectorReady =
    explicitConnectorReadiness === "ready" ||
    (!explicitConnectorReadiness && currentRuntime.remote_execution_ready && Boolean(runtimeExecutionUrl));
  const runtimeUrl = trimmed(env.GHOLA_PRIVATE_RUNTIME_URL) || runtimeExecutionUrl;
  const currentRuntimeHealth = runtimeHealth ?? await freshSealedRuntimeHealth(undefined, {
    ...env,
    GHOLA_PRIVATE_RUNTIME_URL: runtimeUrl,
  });
  const currentNoSubmitCanary = noSubmitCanary === undefined
    ? await getLatestLiveTradingCanaryReport("hyperliquid", "capital_free_no_submit")
    : noSubmitCanary;
  const noSubmitCanaryReady = freshHyperliquidNoSubmitCanary(currentNoSubmitCanary, env);
  const primaryCapabilitySecret = trimmed(env.PRIVATE_AGENT_WORKER_CAPABILITY_SECRET);
  const legacyCapabilitySecret = trimmed(env.GHOLA_WORKER_CAPABILITY_SECRET);
  const capabilitySecretAliasesCoherent =
    !primaryCapabilitySecret ||
    !legacyCapabilitySecret ||
    primaryCapabilitySecret === legacyCapabilitySecret;
  const connectorToken =
    trimmed(env.GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_TOKEN) ||
    trimmed(env.GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN) ||
    trimmed(env.PRIVATE_AGENT_EXECUTION_TOKEN) ||
    primaryCapabilitySecret ||
    legacyCapabilitySecret;
  const killSwitch = trimmed(env.PRIVATE_AGENT_GLOBAL_KILL_SWITCH).toLowerCase();
  const alertingConfigured = Boolean(
    trimmed(env.GHOLA_OPERATIONS_ALERT_WEBHOOK) ||
    trimmed(env.SENTRY_DSN) ||
    trimmed(env.NEXT_PUBLIC_SENTRY_DSN) ||
    env.GHOLA_LOG_DRAIN_CONFIGURED === "true" ||
    env.GHOLA_VERCEL_ALERTS_CONFIGURED === "true"
  );
  const checks: GholaLaunchCheck[] = [
    check(
      "auth_api_configured",
      Boolean(trimmed(env.NEXT_PUBLIC_THUMPER_API_URL) || trimmed(env.THUMPER_API_URL)),
      "auth_api_missing",
    ),
    {
      check: "browser_user_signer_available",
      status: "ready",
      reason: null,
    },
    blockingCheck(
      "scoped_api_wallet_onboarding_enabled",
      env.NEXT_PUBLIC_GHOLA_LEGACY_HYPERLIQUID_API_KEYS === "true",
      "scoped_api_wallet_onboarding_disabled",
    ),
    check(
      "bounded_public_beta_enabled",
      env.GHOLA_PRIVATE_AGENT_BETA_PUBLIC_ENABLED === "true",
      "bounded_public_beta_disabled",
    ),
    check(
      "public_live_trading_enabled",
      env.GHOLA_LIVE_TRADING_PUBLIC_ENABLED === "true",
      "public_live_trading_disabled",
    ),
    check(
      "hyperliquid_pilot_enabled",
      env.GHOLA_V6_HYPERLIQUID_PILOT_ENABLED === "true",
      "hyperliquid_pilot_disabled",
    ),
    check(
      "hyperliquid_live_tiny_fill_enabled",
      env.GHOLA_HYPERLIQUID_LIVE_MODE === "tiny_fill",
      "hyperliquid_live_mode_not_tiny_fill",
    ),
    check(
      "hyperliquid_connector_url_configured",
      Boolean(connectorUrl),
      "hyperliquid_connector_url_missing",
    ),
    check(
      "hyperliquid_connector_token_configured",
      Boolean(connectorToken),
      "hyperliquid_connector_token_missing",
    ),
    blockingCheck(
      "worker_capability_secret_aliases_coherent",
      capabilitySecretAliasesCoherent,
      "worker_capability_secret_alias_mismatch",
    ),
    blockingCheck(
      "request_proof_enforced",
      trimmed(env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_MODE).toLowerCase() === "enforce",
      "request_proof_not_enforced",
    ),
    blockingCheck(
      "request_proof_secret_configured",
      validProductionSecret(env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_SECRET),
      "request_proof_secret_missing_or_weak",
    ),
    blockingCheck(
      "public_beta_order_cap",
      capAtMost(env.GHOLA_LIVE_TRADING_MAX_ORDER_NOTIONAL_USD, 50),
      "public_beta_order_cap_missing_or_above_50",
    ),
    blockingCheck(
      "public_beta_daily_cap",
      capAtMost(env.GHOLA_LIVE_TRADING_DAILY_CAP_USD, 250),
      "public_beta_daily_cap_missing_or_above_250",
    ),
    blockingCheck(
      "public_beta_slippage_cap",
      capAtMost(env.GHOLA_LIVE_TRADING_MAX_SLIPPAGE_BPS, 100),
      "public_beta_slippage_cap_missing_or_above_100",
    ),
    blockingCheck(
      "global_kill_switch_configured",
      killSwitch === "true" || killSwitch === "false",
      "global_kill_switch_unconfigured",
    ),
    blockingCheck(
      "global_kill_switch_inactive",
      killSwitch === "false",
      killSwitch === "true" ? "global_kill_switch_active" : "global_kill_switch_unconfigured",
    ),
    blockingCheck(
      "production_monitoring_enabled",
      env.GHOLA_PUBLIC_BETA_MONITORING_ENABLED === "true",
      "production_monitoring_disabled",
    ),
    blockingCheck(
      "actionable_alerting_configured",
      alertingConfigured,
      "actionable_alerting_unconfigured",
    ),
    blockingCheck(
      "rollback_ready",
      env.GHOLA_PUBLIC_BETA_ROLLBACK_READY === "true",
      "rollback_not_acknowledged",
    ),
    blockingCheck(
      "public_beta_runbook_acknowledged",
      env.GHOLA_PUBLIC_BETA_RUNBOOK_VERSION === "2026-08-23",
      "public_beta_runbook_not_acknowledged",
    ),
    check(
      "hyperliquid_connector_ready",
      connectorReady,
      "hyperliquid_connector_not_marked_ready",
    ),
    check(
      "sealed_runtime_url_configured",
      Boolean(runtimeUrl),
      "sealed_runtime_url_missing",
    ),
    blockingCheck(
      "sealed_runtime_health_fresh",
      currentRuntimeHealth.status === "green",
      currentRuntimeHealth.reason || "sealed_runtime_unhealthy",
    ),
    blockingCheck(
      "hyperliquid_no_submit_canary_fresh",
      noSubmitCanaryReady,
      currentNoSubmitCanary ? "hyperliquid_no_submit_canary_failed_or_stale" : "hyperliquid_no_submit_canary_missing",
    ),
  ];

  return {
    version: 1,
    ready_to_accept_users: checks.every((item) => item.status === "ready"),
    live_flow: "hyperliquid_tiny_fill",
    checks,
    runtime: {
      remote_execution_ready: currentRuntime.remote_execution_ready,
      selected_provider: currentRuntime.selected_provider,
      blocking_reasons: currentRuntime.blocking_reasons,
    },
    enterprise_gate: enterpriseGate,
    required_env: [...REQUIRED_LIVE_ENV],
    checked_at: new Date().toISOString(),
  };
}

function check(checkName: string, ready: boolean, reason: string): GholaLaunchCheck {
  return {
    check: checkName,
    status: ready ? "ready" : "missing",
    reason: ready ? null : reason,
  };
}

function blockingCheck(checkName: string, ready: boolean, reason: string): GholaLaunchCheck {
  return {
    check: checkName,
    status: ready ? "ready" : "blocked",
    reason: ready ? null : reason,
  };
}

function trimmed(value: string | undefined): string {
  return value?.trim() ?? "";
}

function capAtMost(value: string | undefined, max: number): boolean {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= max;
}

function validProductionSecret(value: string | undefined): boolean {
  const secret = trimmed(value);
  const lowered = secret.toLowerCase();
  return secret.length >= 32 &&
    !["dev", "test", "default", "local", "changeme", "example", "placeholder"].some((item) =>
      lowered === item || lowered.includes(item)
    );
}

function freshHyperliquidNoSubmitCanary(
  report: PrivateLiveTradingCanaryReportRecordV1 | null,
  env: Record<string, string | undefined>,
): boolean {
  if (!report) return false;
  const observedAt = Date.parse(report.observed_at);
  const expiresAt = Date.parse(report.expires_at);
  const maxStaleMs = positiveInteger(env.GHOLA_LIVE_TRADING_CANARY_MAX_STALE_MS, 24 * 60 * 60 * 1_000);
  return report.venue_id === "hyperliquid" &&
    report.network === "mainnet" &&
    report.status === "green" &&
    report.live_mode === "no_submit" &&
    report.canary_kind === "capital_free_no_submit" &&
    report.broadcast_performed === false &&
    report.reconcile_status === "reconciled" &&
    Boolean(report.receipt_commitment) &&
    Boolean(report.result_commitment) &&
    report.order_notional_usd > 0 &&
    report.order_notional_usd <= Number(env.GHOLA_LIVE_TRADING_MAX_ORDER_NOTIONAL_USD) &&
    sameNumber(report.max_order_notional_usd, Number(env.GHOLA_LIVE_TRADING_MAX_ORDER_NOTIONAL_USD)) &&
    sameNumber(report.daily_cap_usd, Number(env.GHOLA_LIVE_TRADING_DAILY_CAP_USD)) &&
    report.max_slippage_bps <= Number(env.GHOLA_LIVE_TRADING_MAX_SLIPPAGE_BPS) &&
    Number.isFinite(observedAt) &&
    Number.isFinite(expiresAt) &&
    expiresAt > Date.now() &&
    Date.now() - observedAt <= maxStaleMs;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function sameNumber(left: number, right: number): boolean {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) < 0.000001;
}
