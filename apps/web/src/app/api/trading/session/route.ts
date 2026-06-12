import { createHash, createHmac, randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE_NAME,
  applyNoStore,
  fetchSessionUser,
  sameOrigin,
} from "../../auth/session/_lib";

const GHOLA_EXECUTION_API_BASE =
  process.env.GHOLA_EXECUTION_API_URL ||
  process.env.GHOLA_TRADING_API_URL ||
  process.env.NEXT_PUBLIC_GHOLA_GATEWAY_URL ||
  process.env.NEXT_PUBLIC_GHOLA_API_URL ||
  "https://ghola-gateway.onrender.com";

const EXEC_SESSION_COOKIE_NAME =
  process.env.GHOLA_EXECUTION_SESSION_COOKIE_NAME || "ghola_exec_session";

const BRIDGE_PATH = "trading/app/session/bridge";
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

function executionCookieMaxAge(expiresAt?: string | null): number {
  const ms = Date.parse(String(expiresAt || ""));
  if (!Number.isFinite(ms)) return 60 * 60 * 24 * 7;
  return Math.max(0, Math.floor((ms - Date.now()) / 1000));
}

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) {
    return applyNoStore(NextResponse.json({ error: "cross_site_trading_session_rejected" }, { status: 403 }));
  }

  const webSessionToken = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!webSessionToken) {
    return applyNoStore(NextResponse.json({ error: "web_session_required" }, { status: 401 }));
  }

  const webSession = await fetchSessionUser(webSessionToken).catch(() => null);
  if (!webSession?.ok) {
    return applyNoStore(NextResponse.json({ error: "web_session_invalid" }, { status: 401 }));
  }

  const existingSessionToken = req.cookies.get(EXEC_SESSION_COOKIE_NAME)?.value || "";
  const bridgeBody = {
    webUserId: webSession.user.id,
    email: webSession.user.email,
    name: webSession.user.name ?? "",
    existingSessionToken,
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
    return applyNoStore(NextResponse.json({ error: "execution_bridge_unavailable" }, { status: 503 }));
  }

  const body = await upstream.json().catch(() => ({})) as {
    error?: string;
    appSessionBridge?: {
      status?: string;
      sessionToken?: string;
      sessionId?: string;
      csrfToken?: string;
      expiresAt?: string | null;
    };
  };
  const sessionToken = body.appSessionBridge?.sessionToken;
  const csrfToken = body.appSessionBridge?.csrfToken;
  if (!upstream.ok || !body.appSessionBridge || !sessionToken || !csrfToken) {
    return applyNoStore(NextResponse.json(
      {
        error: body.error || "execution_bridge_failed",
        upstreamStatus: upstream.status,
      },
      { status: upstream.ok ? 502 : upstream.status },
    ));
  }

  const bridge = body.appSessionBridge;
  const res = NextResponse.json({
    authenticated: true,
    appSession: {
      status: bridge.status || "app_session_ready",
      sessionId: bridge.sessionId || null,
      csrfToken,
      expiresAt: bridge.expiresAt || null,
    },
  });
  res.cookies.set(EXEC_SESSION_COOKIE_NAME, sessionToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: executionCookieMaxAge(bridge.expiresAt),
  });
  return applyNoStore(res);
}
