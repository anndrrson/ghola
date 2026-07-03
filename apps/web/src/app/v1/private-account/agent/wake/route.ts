import { NextResponse } from "next/server";
import {
  markPhalaPrivateAgentActivity,
  phalaJitProvisioningConfigured,
  wakePhalaPrivateAgentForUse,
} from "@/lib/private-agent-phala";
import { getPrivateAgentRuntimeStatus } from "@/lib/private-agent-runtime-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

const wakeAttempts = new Map<string, number[]>();

export async function POST(request: Request) {
  if (!publicWakeEnabled()) {
    return json({
      version: 1,
      status: "blocked",
      ready: false,
      message: "Live agents are temporarily unavailable. Your venue access was not used.",
    }, 403);
  }
  if (!sameOrigin(request)) {
    return json({ version: 1, error: "same_origin_required" }, 403);
  }
  if (!rateLimitOk(request)) {
    return json({
      version: 1,
      status: "blocked",
      ready: false,
      message: "Worker start is rate limited. Wait a moment, then try again.",
    }, 429);
  }

  const leaseMs = boundedIntegerEnv("GHOLA_PUBLIC_AGENT_WAKE_LEASE_MS", 10 * 60_000, 5 * 60_000, 30 * 60_000);
  const before = await getPrivateAgentRuntimeStatus();
  if (before.remote_execution_ready && before.selected_provider === "phala") {
    const lease = await markPhalaPrivateAgentActivity({
      reason: "public_agent_byo_wake:already_running",
      leaseMs,
    });
    return json({
      version: 1,
      status: "ready",
      ready: true,
      message: "Secure worker is ready.",
      action: "already_running",
      lease_ms: leaseMs,
      lease_expires_at: lease.lease_expires_at,
      provider: phalaSummary(before),
      checked_at: new Date().toISOString(),
    });
  }

  const waitForReadyMs = boundedIntegerEnv("GHOLA_PUBLIC_AGENT_WAKE_WAIT_MS", 75_000, 5_000, 110_000);
  const provisioning = await wakePhalaPrivateAgentForUse({
    reason: "public_agent_byo_wake",
    leaseMs,
    waitForReadyMs,
  });
  const after = await getPrivateAgentRuntimeStatus();
  const ready = after.remote_execution_ready && after.selected_provider === "phala";
  const warming = !ready && provisioning.status === "provisioning";

  return json({
    version: 1,
    status: ready ? "ready" : warming ? "warming" : "blocked",
    ready,
    message: ready
      ? "Secure worker is ready."
      : warming
        ? "Starting secure worker. This can take about a minute."
        : "Live agents are temporarily unavailable. Your venue access was not used.",
    action: provisioning.attempted ? "wake_requested" : "wake_checked",
    lease_ms: leaseMs,
    lease_expires_at: new Date(Date.now() + leaseMs).toISOString(),
    provisioning: {
      attempted: provisioning.attempted,
      ready: provisioning.ready,
      status: provisioning.status,
      reason: provisioning.reason ?? null,
      cvm_name: provisioning.cvm_name ?? null,
    },
    provider: phalaSummary(after),
    checked_at: new Date().toISOString(),
  }, ready ? 200 : 202);
}

function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function publicWakeEnabled() {
  return process.env.GHOLA_PUBLIC_AGENT_WAKE_ENABLED === "true" ||
    process.env.GHOLA_PUBLIC_LIVE_WORKER_WAKE_ENABLED === "true" ||
    phalaJitProvisioningConfigured();
}

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;
  try {
    const parsed = new URL(origin);
    const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    return parsed.host === host && (parsed.protocol === "https:" || (local && parsed.protocol === "http:"));
  } catch {
    return false;
  }
}

function rateLimitOk(request: Request) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    "unknown";
  const now = Date.now();
  const windowMs = 60_000;
  const maxAttempts = boundedIntegerEnv("GHOLA_PUBLIC_AGENT_WAKE_RATE_LIMIT_PER_MINUTE", 6, 1, 60);
  const recent = (wakeAttempts.get(ip) ?? []).filter((at) => now - at < windowMs);
  if (recent.length >= maxAttempts) {
    wakeAttempts.set(ip, recent);
    return false;
  }
  recent.push(now);
  wakeAttempts.set(ip, recent);
  return true;
}

function phalaSummary(status: Awaited<ReturnType<typeof getPrivateAgentRuntimeStatus>>) {
  const provider = status.providers.find((item) => item.id === "phala");
  return {
    selected_provider: status.selected_provider,
    remote_execution_ready: status.remote_execution_ready,
    available: provider?.available === true,
    attested: provider?.attested === true,
    supports_trading_execution: provider?.supports_trading_execution === true,
    cvm_status: provider?.evidence && typeof provider.evidence === "object"
      ? (provider.evidence as { cvm_status?: unknown }).cvm_status ?? null
      : null,
  };
}

function boundedIntegerEnv(name: string, fallback: number, min: number, max: number) {
  const value = Number.parseInt(process.env[name] || "", 10);
  if (!Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}
