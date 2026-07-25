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
  return probeAutopilotWorkerReadiness(config.url, fetchImpl);
}

export async function probeAutopilotWorkerReadiness(
  workerUrl: URL,
  fetchImpl: typeof fetch = fetch,
): Promise<AutopilotWorkerReadiness> {
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
