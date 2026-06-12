import { NextRequest, NextResponse } from "next/server";
import { sameOrigin } from "../../api/auth/session/_lib";

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

async function handle(req: NextRequest, pathParts: string[]) {
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

  const headers = new Headers();
  for (const name of upstreamTarget.forwardedHeaders) {
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
    if (executionSessionToken) {
      if (!["GET", "HEAD", "OPTIONS"].includes(method) && !sameOrigin(req)) {
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
  const body = bodyAllowed ? await req.arrayBuffer() : undefined;
  let upstream: Response;
  try {
    upstream = await fetch(upstreamTarget.url, {
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
    outHeaders.set(key, value);
  });
  outHeaders.set("Cache-Control", NO_STORE_HEADERS["Cache-Control"]);
  outHeaders.set("Pragma", NO_STORE_HEADERS.Pragma);

  return new NextResponse(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: outHeaders,
  });
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
    if (part.includes("/") || part.includes("\\") || part.includes("\0"))
      return null;
    encoded.push(encodeURIComponent(part));
  }
  return encoded.join("/");
}

type Params = { params: Promise<{ path: string[] }> };

export async function GET(req: NextRequest, { params }: Params) {
  return handle(req, (await params).path);
}

export async function POST(req: NextRequest, { params }: Params) {
  return handle(req, (await params).path);
}

export async function PUT(req: NextRequest, { params }: Params) {
  return handle(req, (await params).path);
}

export async function PATCH(req: NextRequest, { params }: Params) {
  return handle(req, (await params).path);
}

export async function DELETE(req: NextRequest, { params }: Params) {
  return handle(req, (await params).path);
}
