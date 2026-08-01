import { NextResponse } from "next/server";
import { wakePhalaPrivateAgentForUse } from "@/lib/private-agent-phala";
import { getPrivateAgentRuntimeStatus } from "@/lib/private-agent-runtime-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: Request) {
  if (!publicWakeEnabled()) {
    return json({ error: "public_live_worker_wake_disabled" }, 403);
  }
  if (!sameOrigin(request)) {
    return json({ error: "same_origin_required" }, 403);
  }

  const before = await getPrivateAgentRuntimeStatus();
  if (before.remote_execution_ready && before.selected_provider === "phala") {
    return json({
      version: 1,
      status: "ready",
      ready: true,
      action: "already_running",
      provider: phalaSummary(before),
      checked_at: new Date().toISOString(),
    });
  }

  const leaseMs = boundedIntegerEnv("GHOLA_PUBLIC_LIVE_WORKER_WAKE_LEASE_MS", 10 * 60_000, 5 * 60_000, 30 * 60_000);
  const waitForReadyMs = boundedIntegerEnv("GHOLA_PUBLIC_LIVE_WORKER_WAKE_WAIT_MS", 75_000, 5_000, 110_000);
  const provisioning = await wakePhalaPrivateAgentForUse({
    reason: "public_live_phoenix_wake",
    leaseMs,
    waitForReadyMs,
  });
  const after = await getPrivateAgentRuntimeStatus();
  const ready = after.remote_execution_ready && after.selected_provider === "phala";

  return json({
    version: 1,
    status: ready ? "ready" : provisioning.status === "provisioning" ? "waking" : "blocked",
    ready,
    action: provisioning.attempted ? "wake_requested" : "wake_checked",
    lease_ms: leaseMs,
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
    headers: {
      "cache-control": "no-store",
    },
  });
}

function publicWakeEnabled() {
  return process.env.GHOLA_PUBLIC_LIVE_WORKER_WAKE_ENABLED === "true";
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

function phalaSummary(status: Awaited<ReturnType<typeof getPrivateAgentRuntimeStatus>>) {
  const provider = status.providers.find((item) => item.id === "phala");
  return {
    selected_provider: status.selected_provider,
    remote_execution_ready: status.remote_execution_ready,
    blocking_reasons: status.blocking_reasons,
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
