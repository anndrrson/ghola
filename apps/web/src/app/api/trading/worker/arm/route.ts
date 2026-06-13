import { createHash, createHmac, randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE_NAME,
  applyNoStore,
  fetchSessionUser,
  sameOrigin,
} from "../../../auth/session/_lib";
import { createAutonomousAutopilotSessionFromBody } from "@/lib/private-account-autopilot";

const GHOLA_EXECUTION_API_BASE =
  process.env.GHOLA_EXECUTION_API_URL ||
  process.env.GHOLA_TRADING_API_URL ||
  process.env.NEXT_PUBLIC_GHOLA_GATEWAY_URL ||
  process.env.NEXT_PUBLIC_GHOLA_API_URL ||
  "https://ghola-gateway.onrender.com";

const EXEC_SESSION_COOKIE_NAME =
  process.env.GHOLA_EXECUTION_SESSION_COOKIE_NAME || "ghola_exec_session";

const BRIDGE_PATH = "trading/app/worker-grants/bridge";
const BRIDGE_URL_PATH = `/v1/${BRIDGE_PATH}`;

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function objectHashHex(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function buildV1Url(baseUrl: string, safePath: string): string {
  const cleanBase = baseUrl.trim().replace(/\/+$/g, "");
  const v1Base = cleanBase.endsWith("/v1") ? cleanBase : `${cleanBase}/v1`;
  return `${v1Base}/${safePath}`;
}

function bridgeAuthHeaders(body: unknown): Record<string, string> {
  const authId = process.env.GHOLA_EXECUTION_BRIDGE_AUTH_ID?.trim();
  const signingSecret = process.env.GHOLA_EXECUTION_BRIDGE_SIGNING_SECRET?.trim();
  if (authId && signingSecret) {
    const ts = String(Date.now());
    const nonce = randomUUID().replaceAll("-", "");
    const provider = "app_session";
    const canonical = `POST\n${BRIDGE_URL_PATH}\n${ts}\n${nonce}\n${provider}\n${objectHashHex(body)}`;
    return {
      "x-bridge-auth-id": authId,
      "x-bridge-timestamp": ts,
      "x-bridge-nonce": nonce,
      "x-bridge-provider": provider,
      "x-bridge-signature": createHmac("sha256", signingSecret).update(canonical).digest("hex"),
    };
  }

  const sharedToken =
    process.env.GHOLA_EXECUTION_BRIDGE_AUTH_TOKEN?.trim() ||
    process.env.BRIDGE_AUTH_TOKEN?.trim() ||
    "";
  return sharedToken ? { "x-bridge-auth": sharedToken } : {};
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => stringValue(item))
    .filter((item): item is string => Boolean(item));
}

function autopilotVenueId(venueId: string): string {
  return venueId === "coinbase" ? "coinbase_advanced" : venueId;
}

function redactedPlanSummary(input: {
  planId: string;
  planPolicyCommitment: string | null;
  venueIds: string[];
  body: Record<string, unknown>;
}) {
  const plan = record(input.body.planSummary);
  return {
    plan_id: input.planId,
    plan_policy_commitment: input.planPolicyCommitment,
    venue_ids: input.venueIds,
    symbol: stringValue(plan.symbol) ?? stringValue(input.body.symbol) ?? null,
    side: stringValue(plan.side) ?? stringValue(input.body.side) ?? null,
    entry_price_commitment: plan.entryPrice || input.body.entryPrice
      ? objectHashHex({ entryPrice: plan.entryPrice ?? input.body.entryPrice })
      : null,
    stop_price_commitment: plan.stopPrice || input.body.stopPrice
      ? objectHashHex({ stopPrice: plan.stopPrice ?? input.body.stopPrice })
      : null,
  };
}

function redactSensitiveGrantMaterial(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitiveGrantMaterial);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if ([
      "worker_grant_token",
      "workerGrantToken",
      "grant_token",
      "authorization",
    ].includes(key)) {
      out[key] = "redacted";
      continue;
    }
    out[key] = redactSensitiveGrantMaterial(raw);
  }
  return out;
}

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) {
    return applyNoStore(NextResponse.json({ error: "cross_site_trading_worker_arm_rejected" }, { status: 403 }));
  }

  const webSessionToken = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!webSessionToken) {
    return applyNoStore(NextResponse.json({ error: "web_session_required" }, { status: 401 }));
  }
  const executionSessionToken = req.cookies.get(EXEC_SESSION_COOKIE_NAME)?.value || "";
  if (!executionSessionToken) {
    return applyNoStore(NextResponse.json({ error: "execution_session_required" }, { status: 401 }));
  }

  const webSession = await fetchSessionUser(webSessionToken).catch(() => null);
  if (!webSession?.ok) {
    return applyNoStore(NextResponse.json({ error: "web_session_invalid" }, { status: 401 }));
  }

  const body = record(await req.json().catch(() => null));
  const csrfToken = stringValue(body.csrfToken) ?? stringValue(body.csrf);
  const planId = stringValue(body.planId) ?? stringValue(body.appLiveTradingPlanId);
  const activationId = stringValue(body.activationId) ?? stringValue(body.appLiveTradingActivationId);
  if (!csrfToken || !planId) {
    return applyNoStore(NextResponse.json({ error: "plan_id_and_csrf_required" }, { status: 400 }));
  }
  const delegationProof = record(body.delegationProof ?? body.walletDelegationProof);
  if (!stringValue(delegationProof.signature) && !stringValue(delegationProof.walletSignature)) {
    return applyNoStore(NextResponse.json({ error: "wallet_signed_delegation_proof_required" }, { status: 400 }));
  }

  const venueIds = stringArray(body.venueIds ?? body.venues).filter((venueId) =>
    ["hyperliquid", "phoenix", "coinbase"].includes(venueId),
  );
  if (!venueIds.length) {
    return applyNoStore(NextResponse.json({ error: "venue_ids_required" }, { status: 400 }));
  }

  const bridgeBody = {
    sessionToken: executionSessionToken,
    csrfToken,
    planId,
    activationId,
    venueIds,
    planPolicyCommitment: stringValue(body.planPolicyCommitment),
    delegationProof,
    workerSessionMetadata: {
      webUserCommitment: objectHashHex({ type: "ghola_web_user_v1", userId: webSession.user.id }),
      userAgentCommitment: req.headers.get("user-agent")
        ? objectHashHex({ userAgent: req.headers.get("user-agent") })
        : null,
      requestedAt: new Date().toISOString(),
    },
  };
  const upstream = await fetch(buildV1Url(GHOLA_EXECUTION_API_BASE, BRIDGE_PATH), {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...bridgeAuthHeaders(bridgeBody),
    },
    body: JSON.stringify(bridgeBody),
    cache: "no-store",
  }).catch(() => null);

  if (!upstream) {
    return applyNoStore(NextResponse.json({ error: "worker_grant_bridge_unavailable" }, { status: 503 }));
  }
  const bridgeJson = await upstream.json().catch(() => ({})) as {
    error?: string;
    appLiveTradingWorkerGrantBridge?: {
      workerGrantToken?: string;
      workerGrantId?: string;
      workerGrantCommitment?: string;
      activationId?: string | null;
      planPolicyCommitment?: string | null;
      venueIds?: string[];
      expiresAt?: string | null;
    };
  };
  const grant = bridgeJson.appLiveTradingWorkerGrantBridge;
  if (!upstream.ok || !grant?.workerGrantToken || !grant.workerGrantId || !grant.workerGrantCommitment) {
    return applyNoStore(NextResponse.json(
      { error: bridgeJson.error || "worker_grant_bridge_failed", upstreamStatus: upstream.status },
      { status: upstream.ok ? 502 : upstream.status },
    ));
  }

  const planPolicyCommitment = grant.planPolicyCommitment ?? stringValue(body.planPolicyCommitment);
  const appTradingGrant = {
    backend_url: GHOLA_EXECUTION_API_BASE,
    worker_grant_token: grant.workerGrantToken,
    worker_grant_id: grant.workerGrantId,
    worker_grant_commitment: grant.workerGrantCommitment,
    activation_id: grant.activationId ?? activationId ?? null,
    plan_id: planId,
    plan_policy_commitment: planPolicyCommitment,
    venue_ids: grant.venueIds?.length ? grant.venueIds : venueIds,
    expires_at: grant.expiresAt ?? null,
    redacted_plan_summary: redactedPlanSummary({
      planId,
      planPolicyCommitment,
      venueIds: grant.venueIds?.length ? grant.venueIds : venueIds,
      body,
    }),
  };
  const owner = {
    owner_commitment: objectHashHex({
      type: "ghola_app_trading_worker_owner_v1",
      webUserId: webSession.user.id,
    }),
  };
  const autopilot = await createAutonomousAutopilotSessionFromBody({
    session_policy: {
      strategy_id: "momentum_micro_trader",
      decision_model: "ai_direct_order_v1",
      ai_direct_enabled: true,
      venue_allowlist: venueIds.map(autopilotVenueId),
      market_allowlist: [stringValue(body.market) ?? stringValue(body.productId) ?? "BTC-USD"],
      max_notional_bucket: "25",
    },
    app_trading_grant: appTradingGrant,
  }, owner);

  const res = NextResponse.json({
    armed: autopilot.session.status !== "pending_worker",
    appTradingWorker: {
      status: autopilot.session.status,
      workerGrantId: grant.workerGrantId,
      workerGrantCommitment: grant.workerGrantCommitment,
      activationId: grant.activationId ?? activationId ?? null,
      planId,
      planPolicyCommitment,
      venueIds: appTradingGrant.venue_ids,
      expiresAt: appTradingGrant.expires_at,
      session: redactSensitiveGrantMaterial(autopilot.session),
      events: redactSensitiveGrantMaterial(autopilot.events),
      rawWorkerGrantTokenStatus: "not_returned",
    },
  });
  return applyNoStore(res);
}
