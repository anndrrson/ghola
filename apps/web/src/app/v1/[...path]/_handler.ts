import { NextRequest, NextResponse } from "next/server";
import { fetchSessionUser, sameOrigin } from "../../api/auth/session/_lib";
import { gholaCommitment } from "@/lib/private-account";
import { privateAgentTransportAllowed } from "@/lib/private-agent-spend-policy";
import {
  assertExecutionMatchesTradeOrderPlan,
  tradeOrderPlanIdempotencyKey,
} from "@/lib/trade-order-plan";
import type { TradeOrderPlan } from "@/lib/trade-order-plan";
import {
  tradeOrderPlanBindingSecret,
  verifyTradeExecutionIdentityCommitments,
  verifyTradeOrderPlanBinding,
} from "@/lib/trade-order-plan-binding.server";
import { privateAccountByoExecutionGate } from "@/lib/private-account-byo-live-gate";
import {
  assertSignedExecutionMaterialMatchesTradeOrderPlan,
  configuredHyperliquidAssetIndex,
} from "@/lib/signed-execution-material";

const THUMPER_API_BASE =
  process.env.NEXT_PUBLIC_THUMPER_API_URL ||
  "https://thumper-cloud.onrender.com";

const GHOLA_EXECUTION_API_BASE =
  process.env.GHOLA_EXECUTION_API_URL ||
  process.env.GHOLA_TRADING_API_URL ||
  process.env.NEXT_PUBLIC_GHOLA_GATEWAY_URL ||
  process.env.NEXT_PUBLIC_GHOLA_API_URL ||
  "https://ghola-gateway.onrender.com";

const SESSION_COOKIE_NAME = "ghola_thumper_session";
const GHOLA_EXECUTION_SESSION_COOKIE_NAME =
  process.env.GHOLA_EXECUTION_SESSION_COOKIE_NAME || "ghola_exec_session";
const GHOLA_BACKEND_APP_SESSION_COOKIE_NAME =
  process.env.GHOLA_BACKEND_APP_SESSION_COOKIE_NAME || "ghola_session";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
} as const;
const EXECUTION_DISPATCH_HEADER = "X-Ghola-Execution-Dispatch";
const EXECUTION_PLAN_DIGEST_HEADER = "X-Ghola-Execution-Plan-Digest";
const EXECUTION_NOT_DISPATCHED_HEADERS = {
  ...NO_STORE_HEADERS,
  [EXECUTION_DISPATCH_HEADER]: "not_dispatched",
} as const;

const UPSTREAM_TIMEOUT_MS = 15_000;

const HOP_BY_HOP = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "authorization",
  "content-type",
  "payment-signature",
  "x-payment",
  "x402-payment",
  "x-ghola-payment-rail",
  "x-payment-rail",
];

const APP_EXECUTE_FORWARDED_REQUEST_HEADERS = [
  "accept",
  "content-type",
  "payment-signature",
  "x-payment",
  "x402-payment",
  "x-ghola-payment-rail",
  "x-payment-rail",
];

const GHOLA_EXECUTION_REQUEST_HEADERS = [
  ...FORWARDED_REQUEST_HEADERS,
  "idempotency-key",
  "x-idempotency-key",
  "x-ghola-account-id",
  "x-ghola-api-key",
  "x-ghola-client-order-id",
  "x-ghola-idempotency-key",
  "x-ghola-order-id",
  "x-ghola-venue",
];

const GHOLA_EXECUTION_PATH_PREFIXES = new Set(["trading", "private-account", "onboarding"]);

export type V1ProxyDependencies = {
  fetchImpl: typeof fetch;
  fetchSessionUserImpl: typeof fetchSessionUser;
  byoExecutionGateImpl?: typeof privateAccountByoExecutionGate;
};

export type V1ProxyContext = { params: Promise<{ path: string[] }> };

async function handle(req: NextRequest, pathParts: string[], dependencies: V1ProxyDependencies) {
  const safePath = encodeSafePath(pathParts);
  if (!safePath) {
    return NextResponse.json(
      { error: "invalid proxy path" },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }
  const upstreamTarget = resolveUpstream(pathParts, safePath, req.nextUrl.search);
  const sessionToken = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  const method = req.method.toUpperCase();
  const isReadOnly = ["GET", "HEAD", "OPTIONS"].includes(method);
  const isAppExecute =
    method === "POST" &&
    req.nextUrl.search === "" &&
    pathParts.length === 3 &&
    pathParts[0] === "trading" &&
    pathParts[1] === "app" &&
    pathParts[2] === "execute";
  const isChatCompletion =
    method === "POST" &&
    req.nextUrl.search === "" &&
    pathParts.length === 2 &&
    pathParts[0] === "chat" &&
    pathParts[1] === "completions";
  if (!isReadOnly && !isAppExecute && !isChatCompletion) {
    return NextResponse.json(
      { error: "upstream_mutation_route_not_allowed" },
      { status: 405, headers: NO_STORE_HEADERS },
    );
  }
  if (
    upstreamTarget.sessionCookieAuth === false
    && !isReadOnly
    && !privateAgentTransportAllowed("execute", process.env, dependencies.fetchImpl)
  ) {
    return NextResponse.json(
      { error: "private execution mutations are disabled outside armed production" },
      { status: 503, headers: isAppExecute ? EXECUTION_NOT_DISPATCHED_HEADERS : NO_STORE_HEADERS },
    );
  }

  const headers = new Headers();
  const forwardedRequestHeaders = isAppExecute
    ? APP_EXECUTE_FORWARDED_REQUEST_HEADERS
    : upstreamTarget.forwardedHeaders;
  for (const name of forwardedRequestHeaders) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (upstreamTarget.sessionCookieAuth && !headers.has("authorization") && sessionToken) {
    if (!["GET", "HEAD", "OPTIONS"].includes(method) && !sameOrigin(req)) {
      return NextResponse.json(
        { error: "cross-site cookie-authenticated request rejected" },
        { status: 403, headers: NO_STORE_HEADERS },
      );
    }
    headers.set("authorization", `Bearer ${sessionToken}`);
  }
  if (upstreamTarget.appSessionCookieAuth) {
    const executionSessionToken = req.cookies.get(GHOLA_EXECUTION_SESSION_COOKIE_NAME)?.value;
    if (isAppExecute && !sameOrigin(req)) {
      return NextResponse.json(
        { error: "cross-site app-session request rejected" },
        { status: 403, headers: EXECUTION_NOT_DISPATCHED_HEADERS },
      );
    }
    if (isAppExecute && !executionSessionToken) {
      return NextResponse.json(
        { error: "execution_app_session_required" },
        { status: 401, headers: EXECUTION_NOT_DISPATCHED_HEADERS },
      );
    }
    if (executionSessionToken) {
      if (!isAppExecute && !["GET", "HEAD", "OPTIONS"].includes(method) && !sameOrigin(req)) {
        return NextResponse.json(
          { error: "cross-site app-session request rejected" },
          { status: 403, headers: NO_STORE_HEADERS },
        );
      }
      headers.set(
        "cookie",
        `${GHOLA_BACKEND_APP_SESSION_COOKIE_NAME}=${encodeURIComponent(executionSessionToken)}`,
      );
    }
  }

  const bodyAllowed = !["GET", "HEAD"].includes(method);
  let body: ArrayBuffer | undefined;
  let verifiedExecutionPlanDigest: string | null = null;
  if (bodyAllowed && isAppExecute) {
    const parsed = await req.json().catch(() => null);
    const verification = await verifyTradingAppOrderPlan(
      parsed,
      req.cookies.get(SESSION_COOKIE_NAME)?.value || "",
      dependencies.fetchSessionUserImpl,
    );
    if (!verification.ok) {
      return NextResponse.json(
        { error: verification.error },
        { status: verification.status, headers: EXECUTION_NOT_DISPATCHED_HEADERS },
      );
    }
    const liveGate = (dependencies.byoExecutionGateImpl ?? privateAccountByoExecutionGate)(
      verification.orderPlan,
      process.env,
    );
    if (!liveGate.allowed) {
      return NextResponse.json(
        { error: "live_trading_gate_closed", reason_codes: liveGate.reason_codes },
        { status: 503, headers: EXECUTION_NOT_DISPATCHED_HEADERS },
      );
    }
    headers.set("idempotency-key", verification.upstream.idempotencyKey);
    headers.set("x-ghola-account-id", verification.upstream.accountId);
    headers.set("x-ghola-venue", verification.upstream.venue);
    verifiedExecutionPlanDigest = verification.planDigest;
    body = new TextEncoder().encode(JSON.stringify(parsed)).buffer as ArrayBuffer;
  } else {
    body = bodyAllowed ? await req.arrayBuffer() : undefined;
  }
  let upstream: Response;
  try {
    upstream = await dependencies.fetchImpl(upstreamTarget.url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    return NextResponse.json(
      { error: "upstream unavailable" },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }

  const outHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) return;
    if (lower === "set-cookie") return;
    if (lower === EXECUTION_DISPATCH_HEADER.toLowerCase()) return;
    if (lower === EXECUTION_PLAN_DIGEST_HEADER.toLowerCase()) return;
    outHeaders.set(key, value);
  });
  outHeaders.set("Cache-Control", NO_STORE_HEADERS["Cache-Control"]);
  outHeaders.set("Pragma", NO_STORE_HEADERS.Pragma);
  if (isAppExecute) {
    outHeaders.set(EXECUTION_DISPATCH_HEADER, "dispatched");
    if (verifiedExecutionPlanDigest) outHeaders.set(EXECUTION_PLAN_DIGEST_HEADER, verifiedExecutionPlanDigest);
  }

  return new NextResponse(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: outHeaders,
  });
}

async function verifyTradingAppOrderPlan(
  body: unknown,
  webSessionToken: string,
  fetchSessionUserImpl: typeof fetchSessionUser,
): Promise<
  | {
      ok: true;
      orderPlan: TradeOrderPlan;
      planDigest: string;
      upstream: { accountId: string; venue: string; idempotencyKey: string };
    }
  | { ok: false; error: string; status: number }
> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "order_plan_binding_required", status: 400 };
  }
  const request = body as Record<string, unknown>;
  const secret = tradeOrderPlanBindingSecret();
  if (!secret) return { ok: false, error: "order_plan_binding_unavailable", status: 503 };
  const verification = verifyTradeOrderPlanBinding(request.tradeOrderPlanBinding, { secret });
  if (!verification.ok) return { ok: false, error: verification.error, status: 400 };
  const orderPlan = verification.binding.order_plan;
  const match = assertExecutionMatchesTradeOrderPlan(body, orderPlan);
  if (!match.ok) return { ok: false, error: match.error, status: 409 };
  const signedMaterial = assertSignedExecutionMaterialMatchesTradeOrderPlan(body, orderPlan, {
    hyperliquidAssetIndex: configuredHyperliquidAssetIndex(orderPlan, process.env),
  });
  if (!signedMaterial.ok) return { ok: false, error: signedMaterial.error, status: 409 };
  if (!webSessionToken) return { ok: false, error: "web_session_required", status: 401 };
  const session = await fetchSessionUserImpl(webSessionToken).catch(() => null);
  const verifiedUser = session?.ok ? session.user : null;
  if (!verifiedUser) return { ok: false, error: "web_session_invalid", status: 401 };
  const subjectCommitment = gholaCommitment("owner", verifiedUser.id);
  if (verification.subject_commitment !== subjectCommitment) {
    return { ok: false, error: "order_plan_binding_subject_mismatch", status: 403 };
  }
  const idempotencyKey = tradeOrderPlanIdempotencyKey(verification.binding);
  if (!idempotencyKey) {
    return { ok: false, error: "order_plan_idempotency_unavailable", status: 503 };
  }
  const executionIdentity = verifyTradeExecutionIdentityCommitments(request, {
    verifiedSubjectId: verifiedUser.id,
    venueId: orderPlan.venue_id,
  });
  if (!executionIdentity.ok) {
    return { ok: false, error: executionIdentity.error, status: 403 };
  }
  return {
    ok: true,
    orderPlan,
    planDigest: verification.binding.plan_digest,
    upstream: {
      accountId: executionIdentity.upstreamAccountId,
      venue: orderPlan.venue_id,
      idempotencyKey,
    },
  };
}

function resolveUpstream(
  pathParts: string[],
  safePath: string,
  search: string,
): { url: string; forwardedHeaders: string[]; sessionCookieAuth: boolean; appSessionCookieAuth: boolean } {
  const firstPart = pathParts[0]?.toLowerCase();
  if (firstPart && GHOLA_EXECUTION_PATH_PREFIXES.has(firstPart)) {
    const appSessionCookieAuth =
      pathParts[0]?.toLowerCase() === "trading" &&
      pathParts[1]?.toLowerCase() === "app";
    return {
      url: buildV1Url(GHOLA_EXECUTION_API_BASE, safePath, search),
      forwardedHeaders: GHOLA_EXECUTION_REQUEST_HEADERS,
      sessionCookieAuth: false,
      appSessionCookieAuth,
    };
  }
  return {
    url: buildV1Url(THUMPER_API_BASE, safePath, search),
    forwardedHeaders: FORWARDED_REQUEST_HEADERS,
    sessionCookieAuth: true,
    appSessionCookieAuth: false,
  };
}

function buildV1Url(baseUrl: string, safePath: string, search: string): string {
  const cleanBase = baseUrl.trim().replace(/\/+$/, "");
  const v1Base = cleanBase.endsWith("/v1") ? cleanBase : `${cleanBase}/v1`;
  return `${v1Base}/${safePath}${search}`;
}

function encodeSafePath(pathParts: string[]): string | null {
  if (pathParts.length === 0) return null;
  const encoded = [];
  for (const part of pathParts) {
    if (!part || part === "." || part === "..") return null;
    if (part.includes("/") || part.includes("\\") || part.includes("\0")) return null;
    encoded.push(encodeURIComponent(part));
  }
  return encoded.join("/");
}

/** Explicit dependency seam; private mutations still require a branded test transport. */
export function createV1ProxyHandler(dependencies: V1ProxyDependencies) {
  return async (req: NextRequest, { params }: V1ProxyContext) => {
    return handle(req, (await params).path, dependencies);
  };
}

export async function handleV1ProxyRequest(req: NextRequest, context: V1ProxyContext) {
  return handle(req, (await context.params).path, {
    fetchImpl: globalThis.fetch,
    fetchSessionUserImpl: fetchSessionUser,
  });
}
