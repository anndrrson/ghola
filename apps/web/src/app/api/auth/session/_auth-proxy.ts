import { type NextRequest, NextResponse } from "next/server";
import {
  THUMPER_API_BASE,
  applyNoStore,
  fetchWithTimeout,
  sameOrigin,
  sessionError,
  upstreamErrorMessage,
  userFromAuthResponse,
  withSessionCookie,
} from "./_lib";

type AuthProxyOptions = {
  upstreamPath: string;
  body: Record<string, unknown>;
};

function rejectCrossOrigin(req: NextRequest) {
  const origin = req.headers.get("origin");
  if (!origin || sameOrigin(req)) return null;
  return sessionError("Cross-origin auth requests are not allowed.", 403);
}

export async function proxySessionAuth(req: NextRequest, options: AuthProxyOptions) {
  const crossOrigin = rejectCrossOrigin(req);
  if (crossOrigin) return crossOrigin;

  let upstream: Response;
  try {
    upstream = await fetchWithTimeout(`${THUMPER_API_BASE}${options.upstreamPath}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(options.body),
      cache: "no-store",
    });
  } catch {
    return sessionError("Auth service is temporarily unavailable.", 503);
  }

  const body = await upstream.json().catch(() => null);
  if (!upstream.ok) {
    const message = upstreamErrorMessage(body, `Auth API error ${upstream.status}`);
    const status = upstream.status >= 500 ? 503 : upstream.status;
    return sessionError(message, status);
  }

  const token = body && typeof body === "object"
    ? (body as Record<string, unknown>).token
    : null;
  if (typeof token !== "string" || !token) {
    return sessionError("Auth response did not include a session token.", 502);
  }

  const user = userFromAuthResponse(body);
  if (!user) {
    return sessionError("Auth response did not include user details.", 502);
  }

  const res = NextResponse.json({ user });
  withSessionCookie(res, token);
  return applyNoStore(res);
}
