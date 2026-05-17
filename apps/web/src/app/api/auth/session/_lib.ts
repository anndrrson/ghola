import { NextResponse } from "next/server";

export const THUMPER_API_BASE =
  process.env.NEXT_PUBLIC_THUMPER_API_URL || "https://thumper-cloud.onrender.com";

export const SESSION_COOKIE_NAME = "ghola_thumper_session";

export const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
} as const;

export interface SessionUser {
  id: string;
  email: string;
  name?: string;
}

interface JwtPayload {
  sub?: string;
  user_id?: string;
  email?: string;
  name?: string;
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
  return { id, email, name: payload?.name };
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
    secure: true,
    sameSite: "strict",
    path: "/",
    maxAge: sessionCookieMaxAge(token),
  });
  return res;
}

export function clearSessionCookie(res: NextResponse): NextResponse {
  res.cookies.set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
    maxAge: 0,
  });
  return res;
}
