import { createHash, createHmac, randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import {
  privateAccountOwnerFromRequest,
  rejectForbiddenFields,
  type PrivateAccountRequestOwner,
} from "@/app/v1/private-account/_lib";
import { NO_STORE_HEADERS, sameOrigin } from "../../auth/session/_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type LiveProxyBody = {
  path?: unknown;
  method?: unknown;
  body?: unknown;
};

const LIVE_GUARDED_MUTATION_PATHS = [
  /^\/v1\/private-account\/actions\/execute$/,
  /^\/v1\/private-account\/autopilot\/sessions$/,
  /^\/v1\/private-account\/autopilot\/sessions\/[^/]+$/,
  /^\/v1\/private-account\/autopilot\/sessions\/[^/]+\/(?:pause|resume|kill)$/,
  /^\/v1\/private-account\/connectors\/(?:submit|verify-no-submit|reconcile)$/,
  /^\/v1\/private-account\/hyperliquid\/(?:account-snapshot|managed-allocation)$/,
  /^\/v1\/private-account\/hyperliquid\/agent\/session$/,
  /^\/v1\/private-account\/hyperliquid\/vault$/,
  /^\/v1\/private-account\/omnibus\/(?:allocate|reconcile)$/,
  /^\/v1\/private-account\/venues\/[^/]+\/(?:agent\/session|eligibility|pool\/allocate|preflight|reconcile|secret-handles\/create|stealth-account\/create|vault)$/,
];

const FORWARDED_HEADERS = [
  "authorization",
  "cookie",
  "idempotency-key",
  "x-idempotency-key",
  "x-ghola-account-id",
  "x-ghola-api-key",
  "x-ghola-client-order-id",
  "x-ghola-idempotency-key",
  "x-ghola-order-id",
  "x-ghola-venue",
];

const RESPONSE_HEADERS = [
  "content-type",
  "x-ghola-receipt-commitment",
  "x-ghola-session-id",
];

function json(body: unknown, status: number) {
  return NextResponse.json(body, {
    status,
    headers: NO_STORE_HEADERS,
  });
}

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) {
    return json({ error: "cross_site_live_proxy_rejected" }, 403);
  }

  const payload = (await req.json().catch(() => null)) as LiveProxyBody | null;
  if (!payload || typeof payload !== "object") {
    return json({ error: "invalid_live_proxy_payload" }, 400);
  }

  const method = typeof payload.method === "string" ? payload.method.toUpperCase() : "";
  if (method !== "POST") {
    return json({ error: "live_proxy_method_not_allowed" }, 405);
  }

  const target = resolveTarget(req, payload.path);
  if (!target.ok) return json({ error: target.error }, target.status);

  const owner = await privateAccountOwnerFromRequest(req);
  if (!owner) return json({ error: "private_account_auth_required" }, 401);

  const body = payload.body ?? {};
  const forbidden = rejectForbiddenFields(body);
  if (forbidden) return forbidden;

  const proof = requestProofHeaders({
    method,
    pathname: target.pathname,
    owner,
    body,
  });
  if (!proof && privateAccountRequestProofRequired()) {
    return json({ error: "private_account_request_proof_unconfigured" }, 503);
  }

  const headers = new Headers({
    accept: "application/json",
    "content-type": "application/json",
    ...(proof ?? {}),
  });
  for (const name of FORWARDED_HEADERS) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }

  const upstream = await fetch(target.url, {
    method,
    headers,
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!upstream) return json({ error: "live_proxy_upstream_unavailable" }, 503);

  const outHeaders = new Headers(NO_STORE_HEADERS);
  for (const name of RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) outHeaders.set(name, value);
  }

  return new NextResponse(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: outHeaders,
  });
}

function resolveTarget(
  req: NextRequest,
  rawPath: unknown,
):
  | { ok: true; url: string; pathname: string }
  | { ok: false; status: number; error: string } {
  if (typeof rawPath !== "string" || !rawPath.startsWith("/")) {
    return { ok: false, status: 400, error: "invalid_live_proxy_path" };
  }
  if (rawPath.startsWith("//")) {
    return { ok: false, status: 400, error: "invalid_live_proxy_path" };
  }

  const target = new URL(rawPath, req.nextUrl.origin);
  if (target.origin !== req.nextUrl.origin) {
    return { ok: false, status: 400, error: "invalid_live_proxy_origin" };
  }
  if (!LIVE_GUARDED_MUTATION_PATHS.some((pattern) => pattern.test(target.pathname))) {
    return { ok: false, status: 404, error: "live_proxy_path_not_allowed" };
  }

  return {
    ok: true,
    url: `${req.nextUrl.origin}${target.pathname}${target.search}`,
    pathname: target.pathname,
  };
}

function requestProofHeaders(input: {
  method: string;
  pathname: string;
  owner: PrivateAccountRequestOwner;
  body: unknown;
}): Record<string, string> | null {
  const secret = process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_SECRET?.trim() ?? "";
  if (!validLiveGuardProofSecret(secret)) return null;

  const timestamp = String(Date.now());
  const nonce = randomUUID().replaceAll("-", "");
  const canonicalBody = stableJson(input.body);
  const bodyHash = createHash("sha256").update(canonicalBody).digest("hex");
  const message = [
    input.method.toUpperCase(),
    input.pathname,
    input.owner.owner_commitment,
    timestamp,
    nonce,
    bodyHash,
  ].join("\n");
  const proof = createHmac("sha256", secret).update(message).digest("hex");

  return {
    "x-ghola-request-timestamp": timestamp,
    "x-ghola-request-nonce": nonce,
    "x-ghola-request-proof": proof,
  };
}

function privateAccountRequestProofRequired() {
  const configured = (
    process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_MODE ||
    process.env.GHOLA_PRIVATE_ACCOUNT_LIVE_GUARD_MODE ||
    ""
  ).trim().toLowerCase();
  if (configured === "enforce") return true;
  if (configured === "report_only" || configured === "off") return false;
  return process.env.NODE_ENV === "production" ||
    process.env.VERCEL_ENV === "production" ||
    process.env.SECURITY_PROFILE === "prod";
}

function validLiveGuardProofSecret(secret: string): boolean {
  if (!secret) return false;
  if (process.env.NODE_ENV !== "production" && process.env.VERCEL_ENV !== "production" && process.env.SECURITY_PROFILE !== "prod") {
    return true;
  }
  const lowered = secret.toLowerCase();
  return secret.length >= 32 &&
    !["dev", "test", "default", "local", "changeme", "example", "placeholder"].some((value) =>
      lowered === value || lowered.includes(value)
    );
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}
