import { NextResponse } from "next/server";
import {
  SESSION_COOKIE_NAME,
  THUMPER_API_BASE,
} from "@/app/api/auth/session/_lib";
import {
  markPhalaPrivateAgentActivity,
  wakePhalaPrivateAgentForUse,
} from "@/lib/private-agent-phala";
import { hasPrivateAgentEntitlement } from "@/lib/private-agent-runtime";
import { getPrivateAgentRuntimeStatus } from "@/lib/private-agent-runtime-server";
import { privateAgentSpendPolicy } from "@/lib/private-agent-spend-policy";
import {
  consumerProductionStoreReady,
  consumeConsumerRateLimit,
} from "@/lib/consumer-production-store";
import { privateAccountOwnerFromRequest } from "@/app/v1/private-account/_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

export interface PublicAgentWakeDependencies {
  authenticateImpl: typeof privateAccountOwnerFromRequest;
  entitlementImpl: typeof publicAgentWakeEntitlement;
  quotaStoreReadyImpl: typeof consumerProductionStoreReady;
  consumeRateLimitImpl: typeof consumeConsumerRateLimit;
  spendPolicyImpl: typeof privateAgentSpendPolicy;
  getRuntimeStatusImpl: typeof getPrivateAgentRuntimeStatus;
  markActivityImpl: typeof markPhalaPrivateAgentActivity;
  wakeImpl: typeof wakePhalaPrivateAgentForUse;
}

const dependencies: PublicAgentWakeDependencies = {
  authenticateImpl: privateAccountOwnerFromRequest,
  entitlementImpl: publicAgentWakeEntitlement,
  quotaStoreReadyImpl: consumerProductionStoreReady,
  consumeRateLimitImpl: consumeConsumerRateLimit,
  spendPolicyImpl: privateAgentSpendPolicy,
  getRuntimeStatusImpl: getPrivateAgentRuntimeStatus,
  markActivityImpl: markPhalaPrivateAgentActivity,
  wakeImpl: wakePhalaPrivateAgentForUse,
};

export function createPublicAgentWakePost(overrides: Partial<PublicAgentWakeDependencies> = {}) {
  const bound = { ...dependencies, ...overrides };
  return (request: Request) => handlePost(request, bound);
}

export async function POST(request: Request) {
  return handlePost(request, dependencies);
}

async function handlePost(request: Request, deps: PublicAgentWakeDependencies) {
  if (!publicWakeEnabled()) {
    return blocked(403);
  }
  if (!sameOriginJsonPost(request)) {
    return json({ version: 1, error: "same_origin_json_required" }, 403);
  }

  const owner = await deps.authenticateImpl(request).catch(() => null);
  if (!owner) {
    return json({ version: 1, error: "private_account_auth_required" }, 401);
  }
  const entitlement = await deps.entitlementImpl(request).catch(() => ({
    ok: false as const,
    status: 503,
    error: "billing_unavailable",
  }));
  if (!entitlement.ok) {
    return json({
      version: 1,
      status: "blocked",
      ready: false,
      error: entitlement.error,
      message: entitlement.status === 402
        ? "Private-agent access is required to start secure setup compute."
        : "Private-agent access could not be verified. The worker was not started.",
    }, entitlement.status);
  }
  if (!deps.spendPolicyImpl("wake").allowed) {
    return blocked(202, "wake_checked");
  }
  const quotaReady = await deps.quotaStoreReadyImpl().catch(() => false);
  if (!quotaReady) {
    return json({
      version: 1,
      status: "blocked",
      ready: false,
      message: "Worker start quota is unavailable. Your venue access was not used.",
    }, 503);
  }
  const quota = await deps.consumeRateLimitImpl({
    key: `private_agent_wake:${owner.owner_commitment}`,
    limit: boundedIntegerEnv("GHOLA_PUBLIC_AGENT_WAKE_RATE_LIMIT_PER_MINUTE", 3, 1, 10),
    window_ms: 60_000,
  }).catch(() => null);
  if (!quota) {
    return json({
      version: 1,
      status: "blocked",
      ready: false,
      message: "Worker start quota is unavailable. Your venue access was not used.",
    }, 503);
  }
  if (!quota.ok) {
    return json({
      version: 1,
      status: "blocked",
      ready: false,
      message: "Worker start is rate limited. Wait a moment, then try again.",
      retry_after_seconds: quota.retry_after_seconds,
    }, 429);
  }

  const leaseMs = boundedIntegerEnv("GHOLA_PUBLIC_AGENT_WAKE_LEASE_MS", 10 * 60_000, 5 * 60_000, 30 * 60_000);
  const before = await deps.getRuntimeStatusImpl();
  if (before.remote_execution_ready && before.selected_provider === "phala") {
    const lease = await deps.markActivityImpl({
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
  const provisioning = await deps.wakeImpl({
    reason: "public_agent_byo_wake",
    leaseMs,
    waitForReadyMs,
  });
  const after = await deps.getRuntimeStatusImpl();
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

function blocked(status: number, action?: string) {
  return json({
    version: 1,
    status: "blocked",
    ready: false,
    message: "Live agents are temporarily unavailable. Your venue access was not used.",
    ...(action ? { action } : {}),
  }, status);
}

function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function publicWakeEnabled() {
  return process.env.GHOLA_PUBLIC_AGENT_WAKE_ENABLED === "true";
}

export async function publicAgentWakeEntitlement(
  request: Request,
  fetchImpl: typeof fetch = fetch,
): Promise<
  | { ok: true }
  | { ok: false; status: number; error: string }
> {
  const authorization = billingAuthorization(request);
  if (!authorization) {
    return { ok: false, status: 401, error: "private_account_auth_required" };
  }
  const response = await fetchImpl(`${THUMPER_API_BASE}/api/billing/status`, {
    method: "GET",
    headers: { authorization, accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(5_000),
  }).catch(() => null);
  if (!response) return { ok: false, status: 503, error: "billing_unavailable" };
  if (!response.ok) {
    return {
      ok: false,
      status: response.status === 401 || response.status === 403 ? 401 : 503,
      error: "billing_entitlement_unavailable",
    };
  }
  const body = await response.json().catch(() => null) as { tier?: string | null } | null;
  return hasPrivateAgentEntitlement(body?.tier)
    ? { ok: true }
    : { ok: false, status: 402, error: "private_agent_subscription_required" };
}

function billingAuthorization(request: Request): string | null {
  const authorization = request.headers.get("authorization")?.trim();
  if (authorization?.startsWith("Bearer ")) return authorization;
  const cookie = request.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== SESSION_COOKIE_NAME) continue;
    const value = part.slice(separator + 1).trim();
    if (value) return `Bearer ${value}`;
  }
  return null;
}

/** Same-origin JSON is the route's CSRF contract; the session is SameSite=Strict. */
function sameOriginJsonPost(request: Request) {
  const origin = request.headers.get("origin");
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (!origin || contentType !== "application/json") return false;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
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
