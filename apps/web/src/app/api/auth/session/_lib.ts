import { NextResponse } from "next/server";

export const THUMPER_API_BASE =
  process.env.NEXT_PUBLIC_THUMPER_API_URL || "https://thumper-cloud.onrender.com";

export const SESSION_COOKIE_NAME = "ghola_thumper_session";

export const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
} as const;

const UPSTREAM_TIMEOUT_MS = 15_000;

export interface SessionUser {
  id: string;
  email: string;
  name?: string;
  email_verified?: boolean;
}

interface JwtPayload {
  sub?: string;
  user_id?: string;
  email?: string;
  name?: string;
  email_verified?: boolean;
  exp?: number;
}

export function parseJwtPayload(token: string): JwtPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    return JSON.parse(json) as JwtPayload;
  } catch {
    return null;
  }
}

export function userFromToken(token: string): SessionUser | null {
  const payload = parseJwtPayload(token);
  const id = payload?.sub || payload?.user_id;
  const email = payload?.email;
  if (!id || !email) return null;
  return {
    id,
    email,
    name: typeof payload.name === "string" && payload.name ? payload.name : undefined,
    ...(typeof payload.email_verified === "boolean" ? { email_verified: payload.email_verified } : {}),
  };
}

export function sessionCookieMaxAge(token: string): number {
  const payload = parseJwtPayload(token);
  const exp = payload?.exp;
  if (!exp || !Number.isFinite(exp)) return 60 * 60 * 24 * 7;
  const now = Math.floor(Date.now() / 1000);
  const ttl = Math.max(0, exp - now);
  return ttl;
}

export function applyNoStore(res: NextResponse): NextResponse {
  res.headers.set("Cache-Control", NO_STORE_HEADERS["Cache-Control"]);
  res.headers.set("Pragma", NO_STORE_HEADERS.Pragma);
  return res;
}

export function withSessionCookie(res: NextResponse, token: string): NextResponse {
  res.cookies.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: sessionCookieMaxAge(token),
  });
  return res;
}

export function clearSessionCookie(res: NextResponse): NextResponse {
  res.cookies.set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 0,
  });
  return res;
}

export function fetchWithTimeout(input: string | URL | Request, init?: RequestInit) {
  return fetch(input, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
}

export function sameOrigin(req: { headers: Headers; nextUrl: { origin: string } }) {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === req.nextUrl.origin;
  } catch {
    return false;
  }
}

export function userFromProfile(profile: unknown): SessionUser | null {
  if (!profile || typeof profile !== "object") return null;
  const record = profile as Record<string, unknown>;
  const id = record.id;
  const email = record.email;
  const displayName = record.display_name ?? record.name;
  if (typeof id !== "string" || !id) return null;
  if (typeof email !== "string" || !email) return null;
  return {
    id,
    email,
    name: typeof displayName === "string" && displayName ? displayName : undefined,
    ...((typeof record.email_verified === "boolean" || typeof record.verified === "boolean")
      ? { email_verified: record.email_verified === true || record.verified === true }
      : {}),
  };
}

export async function fetchSessionUser(token: string) {
  const upstream = await fetchWithTimeout(`${THUMPER_API_BASE}/api/user/profile`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!upstream.ok) {
    return { ok: false as const, status: upstream.status };
  }
  const user = userFromProfile(await upstream.json());
  return user
    ? { ok: true as const, user }
    : { ok: false as const, status: 502 };
}

export function invalidSessionStatus(status: number) {
  return status === 401 || status === 403 ? 502 : status;
}

export function sessionError(message: string, status: number) {
  return applyNoStore(NextResponse.json({ error: message }, { status }));
}

export function upstreamErrorMessage(body: unknown, fallback: string) {
  if (!body || typeof body !== "object") return fallback;
  const record = body as Record<string, unknown>;
  const error = record.error ?? record.message ?? record.detail;
  return typeof error === "string" && error ? error : fallback;
}

export function userFromAuthResponse(body: unknown): SessionUser | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  const user = userFromProfile(record.user);
  if (user) return user;

  const token = record.token;
  if (typeof token === "string") {
    const tokenUser = userFromToken(token);
    if (tokenUser) return tokenUser;
  }

  const id = record.user_id ?? record.id;
  const email = record.email;
  const displayName = record.display_name ?? record.name;
  if (typeof id !== "string" || !id) return null;
  if (typeof email !== "string" || !email) return null;
  return {
    id,
    email,
    name: typeof displayName === "string" && displayName ? displayName : undefined,
    ...((typeof record.email_verified === "boolean" || typeof record.verified === "boolean")
      ? { email_verified: record.email_verified === true || record.verified === true }
      : {}),
  };
}
