import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export type TradingModelStatus = {
  version: 1;
  worker_configured: boolean;
  reachable: boolean;
  configured: boolean;
  provider_kind: string | null;
  model_id: string | null;
  endpoint_origin: string | null;
  local: boolean;
  structured_outputs: boolean;
  error: string | null;
};

export async function GET() {
  return NextResponse.json(await readTradingModelStatus(), {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function readTradingModelStatus({
  env = process.env,
  fetchImpl = fetch,
}: {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
} = {}): Promise<TradingModelStatus> {
  const raw = env.GHOLA_PRIVATE_AGENT_WORKER_URL?.trim() ||
    env.GHOLA_PRIVATE_AGENT_EXECUTION_URL?.trim() ||
    env.PHALA_AGENT_ENDPOINT?.trim() || "";
  if (!raw) return unavailable(false, "worker_endpoint_unconfigured");
  let base: URL;
  try {
    base = new URL(raw);
  } catch {
    return unavailable(true, "worker_endpoint_invalid");
  }
  if (base.username || base.password || !safeProtocol(base)) return unavailable(true, "worker_endpoint_unsafe");
  try {
    const response = await fetchImpl(new URL("/ready", base), {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(4_000),
    });
    const body = await response.json().catch(() => null) as { decision_provider?: unknown } | null;
    const provider = body?.decision_provider;
    if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
      return unavailable(true, "worker_model_status_unavailable", true);
    }
    const value = provider as Record<string, unknown>;
    return {
      version: 1,
      worker_configured: true,
      reachable: true,
      configured: value.configured === true,
      provider_kind: safeText(value.provider_kind),
      model_id: safeText(value.model_id),
      endpoint_origin: safeOrigin(value.endpoint_origin),
      local: value.local === true,
      structured_outputs: value.structured_outputs === true,
      error: value.configured === true ? null : safeText(value.error) || "model_unconfigured",
    };
  } catch {
    return unavailable(true, "worker_unreachable");
  }
}

function unavailable(workerConfigured: boolean, error: string, reachable = false): TradingModelStatus {
  return {
    version: 1,
    worker_configured: workerConfigured,
    reachable,
    configured: false,
    provider_kind: null,
    model_id: null,
    endpoint_origin: null,
    local: false,
    structured_outputs: false,
    error,
  };
}

function safeProtocol(url: URL) {
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
}

function safeText(value: unknown) {
  return typeof value === "string" && value.length <= 180 ? value : null;
}

function safeOrigin(value: unknown) {
  const text = safeText(value);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.username || url.password ? null : url.origin;
  } catch {
    return null;
  }
}
