import {
  privateAgentEmergencyControlTransportAllowed,
  privateAgentTransportAllowed,
  type PrivateAgentEmergencyControlAction,
} from "./private-agent-spend-policy";
import {
  LIVE_TRADING_CONTRACT_VERSION,
  LIVE_TRADING_MAX_ORDER_NOTIONAL_USD,
  LIVE_TRADING_MAX_SLIPPAGE_BPS,
  LIVE_TRADING_ROLLING_24H_NOTIONAL_USD,
  type LiveTradingCapabilityId,
  type LiveTradingReleaseIdentity,
} from "./live-trading-contract";

export interface AutopilotWorkerConfig {
  url: URL | null;
  token: string;
  authConfigured: boolean;
}

export interface AutopilotWorkerReadiness {
  ok: boolean;
  error: string | null;
  missing: string[];
  status: number | null;
}

export interface LiveTradingWorkerReadiness {
  ready: boolean;
  endpoint_configured: boolean;
  contract_version: number | null;
  worker_git_sha: string | null;
  worker_image_digest: string | null;
  config_fingerprint: string | null;
  capabilities: LiveTradingCapabilityId[];
  reason_codes: string[];
  checked_at: string;
}

const EMERGENCY_KILLED_WORKER_REASONS = [
  "worker_global_kill_active",
  "worker_live_contract_not_ready",
] as const;

function allowUnattestedDevelopmentWorker(
  env: Record<string, string | undefined>,
): boolean {
  return env.GHOLA_PRIVATE_AGENT_ALLOW_UNATTESTED_DEV?.trim().toLowerCase() === "true";
}

export function autopilotWorkerConfig(
  env: Record<string, string | undefined> = process.env,
): AutopilotWorkerConfig {
  const rawUrl = env.GHOLA_PRIVATE_AGENT_EXECUTION_URL?.trim() ||
    env.GHOLA_PRIVATE_AGENT_WORKER_URL?.trim() ||
    env.PHALA_AGENT_ENDPOINT?.trim() ||
    "";
  const token = env.GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN?.trim() ||
    env.PRIVATE_AGENT_EXECUTION_TOKEN?.trim() ||
    env.PHALA_CLOUD_API_KEY?.trim() ||
    "";
  let url: URL | null = null;
  if (rawUrl) {
    try {
      url = new URL(rawUrl);
    } catch {
      url = null;
    }
  }
  return {
    url,
    token,
    authConfigured: Boolean(
      token ||
      env.PRIVATE_AGENT_WORKER_CAPABILITY_SECRET?.trim() ||
      env.GHOLA_WORKER_CAPABILITY_SECRET?.trim(),
    ),
  };
}

export async function probeConfiguredAutopilotWorkerReadiness(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<AutopilotWorkerReadiness> {
  const config = autopilotWorkerConfig(env);
  if (!config.url || !config.authConfigured) {
    return {
      ok: false,
      error: "worker_not_configured",
      missing: [],
      status: null,
    };
  }
  if (!privateAgentTransportAllowed("discover", env, fetchImpl)) {
    return {
      ok: false,
      error: "worker_not_configured",
      missing: [],
      status: null,
    };
  }
  return probeAutopilotWorkerReadiness(config.url, fetchImpl, {
    allowUnattestedDevelopmentWorker: allowUnattestedDevelopmentWorker(env),
    env,
  });
}

export async function probeLiveTradingWorkerReadiness(input: {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  expectedRelease: LiveTradingReleaseIdentity;
  requiredCapabilities: LiveTradingCapabilityId[];
}): Promise<LiveTradingWorkerReadiness> {
  const env = input.env ?? process.env;
  const fetchImpl = input.fetchImpl ?? fetch;
  return probePinnedLiveTradingWorkerReadiness({
    ...input,
    env,
    fetchImpl,
    transportAllowed: privateAgentTransportAllowed("discover", env, fetchImpl),
    tolerateKilledWorker: false,
  });
}

/**
 * Emergency risk reduction may cross the worker transport while production
 * spend is disarmed or locked down. A coherent global-kill state may make only
 * the live sub-contract red; general readiness, exact release identity, caps,
 * auth, and risk-reduction capabilities remain fail closed.
 */
export async function probeEmergencyLiveTradingWorkerReadiness(input: {
  action: Extract<PrivateAgentEmergencyControlAction, "close" | "kill_and_flat">;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  expectedRelease: LiveTradingReleaseIdentity;
  requiredCapabilities: Array<Extract<LiveTradingCapabilityId, "cancel" | "reduce_only">>;
}): Promise<LiveTradingWorkerReadiness> {
  const env = input.env ?? process.env;
  const fetchImpl = input.fetchImpl ?? fetch;
  return probePinnedLiveTradingWorkerReadiness({
    ...input,
    env,
    fetchImpl,
    transportAllowed: privateAgentEmergencyControlTransportAllowed(input.action, env, fetchImpl),
    tolerateKilledWorker: true,
  });
}

async function probePinnedLiveTradingWorkerReadiness(input: {
  env: Record<string, string | undefined>;
  fetchImpl: typeof fetch;
  expectedRelease: LiveTradingReleaseIdentity;
  requiredCapabilities: LiveTradingCapabilityId[];
  transportAllowed: boolean;
  tolerateKilledWorker: boolean;
}): Promise<LiveTradingWorkerReadiness> {
  const { env, fetchImpl } = input;
  const config = autopilotWorkerConfig(env);
  const checkedAt = new Date().toISOString();
  if (!config.url || !config.authConfigured || !input.transportAllowed) {
    return liveUnavailable("live_worker_not_configured", Boolean(config.url), checkedAt);
  }
  const response = await fetchImpl(new URL("/ready", config.url), {
    method: "GET",
    cache: "no-store",
    signal: AbortSignal.timeout(5_000),
  }).catch(() => null);
  if (!response) return liveUnavailable("live_worker_unavailable", true, checkedAt);
  const body = asRecord(await response.json().catch(() => null));
  const live = asRecord(body.live_trading);
  const caps = asRecord(live.caps);
  const capabilities = stringArray(live.capabilities)
    .filter((value): value is LiveTradingCapabilityId => input.requiredCapabilities.includes(value as LiveTradingCapabilityId));
  const liveReasonCodes = stringArray(live.reason_codes);
  const reasonCodes = stringArray(body.missing).map((reason) => `worker_missing:${reason}`);
  reasonCodes.push(...liveReasonCodes);
  const contractVersion = finiteInteger(live.contract_version);
  const workerGitSha = safeString(live.worker_git_sha);
  const workerImageDigest = safeString(live.worker_image_digest);
  const configFingerprint = safeString(live.config_fingerprint);
  if (!response.ok || body.ready !== true) reasonCodes.push("live_worker_not_ready");
  if (live.ready !== true) reasonCodes.push("worker_live_contract_not_ready");
  if (contractVersion !== LIVE_TRADING_CONTRACT_VERSION) reasonCodes.push("worker_contract_version_mismatch");
  if (!workerGitSha || workerGitSha !== input.expectedRelease.worker_git_sha) reasonCodes.push("worker_git_sha_mismatch");
  if (!workerImageDigest || workerImageDigest !== input.expectedRelease.worker_image_digest) reasonCodes.push("worker_image_digest_mismatch");
  if (!configFingerprint || configFingerprint !== input.expectedRelease.config_fingerprint) reasonCodes.push("worker_config_fingerprint_mismatch");
  if (!sameNumber(Number(caps.max_order_notional_usd), LIVE_TRADING_MAX_ORDER_NOTIONAL_USD)) reasonCodes.push("worker_max_order_cap_mismatch");
  if (!sameNumber(Number(caps.rolling_24h_notional_usd), LIVE_TRADING_ROLLING_24H_NOTIONAL_USD)) reasonCodes.push("worker_daily_cap_mismatch");
  if (!sameNumber(Number(caps.max_slippage_bps), LIVE_TRADING_MAX_SLIPPAGE_BPS)) reasonCodes.push("worker_slippage_cap_mismatch");
  for (const capability of input.requiredCapabilities) {
    if (!stringArray(live.capabilities).includes(capability)) reasonCodes.push(`worker_capability_missing:${capability}`);
  }
  const uniqueReasons = blockingLiveWorkerReasons(
    reasonCodes,
    input.tolerateKilledWorker &&
      live.ready === false &&
      liveReasonCodes.includes("worker_global_kill_active"),
  );
  return {
    ready: uniqueReasons.length === 0,
    endpoint_configured: true,
    contract_version: contractVersion,
    worker_git_sha: workerGitSha,
    worker_image_digest: workerImageDigest,
    config_fingerprint: configFingerprint,
    capabilities,
    reason_codes: uniqueReasons,
    checked_at: checkedAt,
  };
}

function blockingLiveWorkerReasons(reasonCodes: string[], tolerateKilledWorker: boolean): string[] {
  const uniqueReasons = [...new Set(reasonCodes)];
  if (!tolerateKilledWorker ||
      !EMERGENCY_KILLED_WORKER_REASONS.every((reason) => uniqueReasons.includes(reason))) {
    return uniqueReasons;
  }
  return uniqueReasons.filter((reason) =>
    !EMERGENCY_KILLED_WORKER_REASONS.includes(reason as typeof EMERGENCY_KILLED_WORKER_REASONS[number]));
}

export async function probeAutopilotWorkerReadiness(
  workerUrl: URL,
  fetchImpl: typeof fetch = fetch,
  options: {
    allowUnattestedDevelopmentWorker?: boolean;
    env?: Record<string, string | undefined>;
  } = {},
): Promise<AutopilotWorkerReadiness> {
  if (!privateAgentTransportAllowed("discover", options.env ?? process.env, fetchImpl)) {
    return {
      ok: false,
      error: "worker_not_configured",
      missing: [],
      status: null,
    };
  }
  const response = await fetchImpl(new URL("/ready", workerUrl), {
    method: "GET",
    cache: "no-store",
    signal: AbortSignal.timeout(5_000),
  }).catch(() => null);
  if (!response) {
    return {
      ok: false,
      error: "worker_unavailable",
      missing: [],
      status: null,
    };
  }
  const body = asRecord(await response.json().catch(() => null));
  const missing = stringArray(body.missing).slice(0, 20);
  const expectedUnattestedMissing = ["attestation", "image_digest", "measurement", "attestation_hash"];
  const isExpectedUnattestedDevelopmentWorker =
    options.allowUnattestedDevelopmentWorker === true &&
    missing.length === expectedUnattestedMissing.length &&
    expectedUnattestedMissing.every((field) => missing.includes(field));
  if (isExpectedUnattestedDevelopmentWorker) {
    return {
      ok: true,
      error: null,
      missing,
      status: response.status,
    };
  }
  if (!response.ok || body.ready !== true) {
    return {
      ok: false,
      error: missing.length
        ? `worker_not_ready:${missing.join(",")}`
        : `worker_not_ready:${response.status}`,
      missing,
      status: response.status,
    };
  }
  return {
    ok: true,
    error: null,
    missing: [],
    status: response.status,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function liveUnavailable(reason: string, endpointConfigured: boolean, checkedAt: string): LiveTradingWorkerReadiness {
  return {
    ready: false,
    endpoint_configured: endpointConfigured,
    contract_version: null,
    worker_git_sha: null,
    worker_image_digest: null,
    config_fingerprint: null,
    capabilities: [],
    reason_codes: [reason],
    checked_at: checkedAt,
  };
}

function safeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finiteInteger(value: unknown): number | null {
  return Number.isInteger(value) ? value as number : null;
}

function sameNumber(left: number, right: number) {
  return Number.isFinite(left) && Math.abs(left - right) < 0.000001;
}
