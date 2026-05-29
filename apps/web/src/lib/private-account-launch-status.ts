import { getPrivateAgentRuntimeStatus } from "./private-agent-runtime-server";
import type { PrivateAgentRuntimeStatus } from "./private-agent-runtime";
import { enterpriseGateStatus, type GholaEnterpriseGateStatus } from "./enterprise-gate-status";

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
  "GHOLA_V6_HYPERLIQUID_PILOT_ENABLED=true",
  "GHOLA_HYPERLIQUID_LIVE_MODE=tiny_fill",
  "GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_TOKEN=<worker-token>",
  "attested provider publishes execution_url and sealed recipient evidence, or GHOLA_PRIVATE_RUNTIME_URL / GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_URL are set manually",
] as const;

export async function privateAccountLaunchStatus(
  env: Record<string, string | undefined> = process.env,
  runtime?: PrivateAgentRuntimeStatus,
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
  const connectorToken =
    trimmed(env.GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_TOKEN) ||
    trimmed(env.GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN) ||
    trimmed(env.PRIVATE_AGENT_EXECUTION_TOKEN);
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
    check(
      "attested_private_agent_ready",
      currentRuntime.remote_execution_ready,
      currentRuntime.blocking_reasons[0] ?? "private_agent_runtime_not_ready",
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

function trimmed(value: string | undefined): string {
  return value?.trim() ?? "";
}
