import { NextRequest, NextResponse } from "next/server";
import {
  fetchWithTimeout,
  NO_STORE_HEADERS,
  SESSION_COOKIE_NAME,
  THUMPER_API_BASE,
  sameOrigin,
} from "../../auth/session/_lib";
import {
  hasPrivateAgentEntitlement,
  type ConfidentialComputeProviderId,
} from "@/lib/private-agent-runtime";
import { getPrivateAgentRuntimeStatus } from "@/lib/private-agent-runtime-server";
import {
  ensurePhalaPrivateAgentProvisioned,
  markPhalaPrivateAgentActivity,
  phalaWorkerExecutionToken,
  privateAgentRemoteExecutionDisabled,
  wakePhalaPrivateAgentForUse,
} from "@/lib/private-agent-phala";
import {
  buildAcceptedPrivateAgentSession,
  validatePrivateAgentSessionRequest,
} from "@/lib/private-agent-session";
import {
  workerAuthorizationHeader,
  workerCapabilityExpectedFromBody,
} from "@/lib/private-agent-capability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

interface BillingStatus {
  tier?: string | null;
  private_agent_compute?: {
    remaining_seconds?: number;
    active_agent_count?: number;
    active_agent_limit?: number;
  } | null;
}

const PRIVATE_AGENT_SESSION_RESERVATION_SECONDS = Number.parseInt(
  process.env.GHOLA_PRIVATE_AGENT_SESSION_RESERVATION_SECONDS || "3600",
  10,
);

function json(body: unknown, status: number) {
  return NextResponse.json(body, {
    status,
    headers: NO_STORE_HEADERS,
  });
}

function bearerForRequest(req: NextRequest): string | null {
  const authorization = req.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) return authorization;
  const cookieToken = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  return cookieToken ? `Bearer ${cookieToken}` : null;
}

async function billingTier(req: NextRequest): Promise<{
  ok: boolean;
  status: number;
  bearer?: string;
  tier?: string | null;
  privateAgentCompute?: BillingStatus["private_agent_compute"];
  error?: string;
}> {
  const bearer = bearerForRequest(req);
  if (!bearer) return { ok: false, status: 401, error: "sign in required" };
  if (req.cookies.get(SESSION_COOKIE_NAME)?.value && !sameOrigin(req)) {
    return { ok: false, status: 403, error: "cross-site request rejected" };
  }

  const upstream = await fetchWithTimeout(`${THUMPER_API_BASE}/api/billing/status`, {
    method: "GET",
    headers: {
      Authorization: bearer,
      Accept: "application/json",
    },
    cache: "no-store",
  }).catch(() => null);
  if (!upstream) {
    return { ok: false, status: 503, error: "billing unavailable" };
  }
  if (!upstream.ok) {
    return { ok: false, status: upstream.status, error: "billing rejected request" };
  }
  const body = (await upstream.json().catch(() => null)) as BillingStatus | null;
  return {
    ok: true,
    status: 200,
    bearer,
    tier: body?.tier ?? "free",
    privateAgentCompute: body?.private_agent_compute ?? null,
  };
}

function executionUrlForProvider(provider: ConfidentialComputeProviderId): string | null {
  if (provider === "phala") {
    return process.env.GHOLA_PRIVATE_AGENT_EXECUTION_URL || process.env.PHALA_AGENT_ENDPOINT || null;
  }
  if (provider === "gensyn") {
    return process.env.GENSYN_PRIVATE_AGENT_EXECUTION_URL || process.env.GENSYN_API_URL || null;
  }
  if (provider === "relay_attested_pool") {
    return process.env.GHOLA_PRIVATE_AGENT_EXECUTION_URL || null;
  }
  return null;
}

function providerToken(provider: ConfidentialComputeProviderId): string | null {
  const token =
    provider === "phala"
      ? phalaWorkerExecutionToken()
      : provider === "gensyn"
        ? process.env.GENSYN_API_KEY
        : process.env.GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN;
  return token || null;
}

async function reservePrivateAgentCompute(input: {
  bearer: string;
  reservationId: string;
  seconds: number;
}): Promise<{ ok: boolean; status: number; error?: string }> {
  const upstream = await fetchWithTimeout(
    `${THUMPER_API_BASE}/api/billing/private-agent/compute/reserve`,
    {
      method: "POST",
      headers: {
        Authorization: input.bearer,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        session_id: input.reservationId,
        seconds: input.seconds,
      }),
      cache: "no-store",
    },
  ).catch(() => null);
  if (!upstream) return { ok: false, status: 503, error: "billing unavailable" };
  if (!upstream.ok) {
    const body = (await upstream.json().catch(() => null)) as { error?: string } | null;
    return {
      ok: false,
      status: upstream.status,
      error: body?.error ?? "private-agent compute allowance unavailable",
    };
  }
  return { ok: true, status: upstream.status };
}

async function releasePrivateAgentCompute(input: {
  bearer: string;
  reservationId: string;
  status: "failed" | "paused" | "completed";
}) {
  await fetchWithTimeout(
    `${THUMPER_API_BASE}/api/billing/private-agent/compute/release`,
    {
      method: "POST",
      headers: {
        Authorization: input.bearer,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        session_id: input.reservationId,
        status: input.status,
      }),
      cache: "no-store",
    },
  ).catch(() => null);
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  const validation = validatePrivateAgentSessionRequest(body);
  if (!validation.ok || !validation.request) {
    return json({ error: "invalid private-agent session request", details: validation.errors }, 400);
  }

  const billing = await billingTier(req);
  if (!billing.ok) {
    return json({ error: billing.error ?? "billing unavailable" }, billing.status);
  }
  if (!hasPrivateAgentEntitlement(billing.tier)) {
    return json(
      {
        error: "private-agent subscription required",
        entitlement_required: "paid_private_agent_plan",
      },
      402,
    );
  }
  const remainingSeconds = billing.privateAgentCompute?.remaining_seconds ?? 0;
  const activeCount = billing.privateAgentCompute?.active_agent_count ?? 0;
  const activeLimit = billing.privateAgentCompute?.active_agent_limit ?? 0;
  if (remainingSeconds < PRIVATE_AGENT_SESSION_RESERVATION_SECONDS) {
    return json(
      {
        error: "private-agent compute allowance exhausted",
        entitlement_required: "paid_private_agent_plan",
        required_seconds: PRIVATE_AGENT_SESSION_RESERVATION_SECONDS,
        remaining_seconds: remainingSeconds,
      },
      402,
    );
  }
  if (activeLimit > 0 && activeCount >= activeLimit) {
    return json(
      {
        error: "active private-agent limit reached",
        active_agent_count: activeCount,
        active_agent_limit: activeLimit,
      },
      402,
    );
  }

  if (privateAgentRemoteExecutionDisabled()) {
    return json(
      {
        error: "sealed private-agent execution is disabled",
        blocking_reasons: ["operator_spend_lock"],
      },
      503,
    );
  }

  let runtime = await getPrivateAgentRuntimeStatus();
  let provisioning: Awaited<ReturnType<typeof ensurePhalaPrivateAgentProvisioned>> | null = null;
  if (!runtime.remote_execution_ready) {
    provisioning = await wakePhalaPrivateAgentForUse({
      reason: "private_agent_session_request",
      waitForReadyMs: 45_000,
      leaseMs: Math.max(
        PRIVATE_AGENT_SESSION_RESERVATION_SECONDS * 1000 + 10 * 60_000,
        30 * 60_000,
      ),
    });
    if (provisioning.attempted || provisioning.ready) {
      runtime = await getPrivateAgentRuntimeStatus();
    }
  } else if (runtime.selected_provider === "phala") {
    await markPhalaPrivateAgentActivity({
      reason: "private_agent_session_request",
      leaseMs: Math.max(
        PRIVATE_AGENT_SESSION_RESERVATION_SECONDS * 1000 + 10 * 60_000,
        30 * 60_000,
      ),
    });
  }
  if (!runtime.remote_execution_ready || !runtime.selected_provider) {
    return json(
      {
        error: "sealed private-agent execution is unavailable",
        blocking_reasons: runtime.blocking_reasons,
        ...(provisioning
          ? {
              provisioning: {
                status: provisioning.status,
                reason: provisioning.reason,
              },
            }
          : {}),
      },
      503,
    );
  }
  if (
    validation.request.requested_provider &&
    validation.request.requested_provider !== runtime.selected_provider
  ) {
    return json(
      {
        error: "requested provider is not the selected attested provider",
        selected_provider: runtime.selected_provider,
      },
      409,
    );
  }

  if (runtime.selected_provider === "mock_attested") {
    return json(
      buildAcceptedPrivateAgentSession({
        provider: "mock_attested",
        request: validation.request,
      }),
      201,
    );
  }

  const executionUrl = executionUrlForProvider(runtime.selected_provider);
  if (!executionUrl) {
    return json(
      {
        error: "private-agent execution endpoint is not configured",
        selected_provider: runtime.selected_provider,
      },
      503,
    );
  }

  if (!billing.bearer) {
    return json({ error: "sign in required" }, 401);
  }
  const reservationId = `par_${crypto.randomUUID()}`;
  const reservation = await reservePrivateAgentCompute({
    bearer: billing.bearer,
    reservationId,
    seconds: PRIVATE_AGENT_SESSION_RESERVATION_SECONDS,
  });
  if (!reservation.ok) {
    return json(
      {
        error: reservation.error ?? "private-agent compute allowance unavailable",
      },
      reservation.status,
    );
  }

  const upstreamPath = "/private-agent/sessions";
  const upstreamBody = {
    ...validation.request,
    selected_provider: runtime.selected_provider,
  };
  const authorization = workerAuthorizationHeader({
    fallbackToken: providerToken(runtime.selected_provider),
    method: "POST",
    path: upstreamPath,
    scope: "session:create",
    body: upstreamBody,
    expected: workerCapabilityExpectedFromBody(upstreamBody),
  });
  const headers = new Headers({
    "content-type": "application/json",
    accept: "application/json",
    "x-ghola-sealed-execution-required": "true",
    "x-ghola-private-agent-provider": runtime.selected_provider,
    "x-ghola-private-agent-reservation-id": reservationId,
  });
  if (authorization) headers.set("authorization", authorization);

  const upstream = await fetchWithTimeout(
    new URL(upstreamPath, executionUrl),
    {
      method: "POST",
      headers,
      body: JSON.stringify(upstreamBody),
      cache: "no-store",
    },
  ).catch(() => null);
  if (!upstream) {
    await releasePrivateAgentCompute({
      bearer: billing.bearer,
      reservationId,
      status: "failed",
    });
    return json({ error: "private-agent execution provider unavailable" }, 503);
  }
  if (!upstream.ok) {
    const upstreamBody = await upstream.json().catch(() => null);
    await releasePrivateAgentCompute({
      bearer: billing.bearer,
      reservationId,
      status: "failed",
    });
    return json(
      {
        error: "private-agent execution provider rejected request",
        upstream: upstreamBody,
      },
      upstream.status,
    );
  }

  if (runtime.selected_provider === "phala") {
    await markPhalaPrivateAgentActivity({
      reason: "private_agent_session_accepted",
      leaseMs: Math.max(
        PRIVATE_AGENT_SESSION_RESERVATION_SECONDS * 1000 + 10 * 60_000,
        30 * 60_000,
      ),
    });
  }

  return new NextResponse(upstream.body, {
    status: upstream.status,
    headers: {
      ...NO_STORE_HEADERS,
      "content-type": upstream.headers.get("content-type") ?? "application/json",
    },
  });
}
