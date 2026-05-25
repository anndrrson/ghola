import { NextRequest, NextResponse } from "next/server";
import {
  applyNoStore,
  fetchSessionUser,
  fetchWithTimeout,
  invalidSessionStatus,
  NO_STORE_HEADERS,
  sameOrigin,
  THUMPER_API_BASE,
  withSessionCookie,
} from "../_lib";

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) {
    return NextResponse.json(
      { error: "cross-site session request rejected" },
      { status: 403, headers: NO_STORE_HEADERS },
    );
  }

  let body: string;
  try {
    body = await req.text();
  } catch {
    return NextResponse.json(
      { error: "Invalid request" },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  try {
    const upstream = await fetchWithTimeout(
      `${THUMPER_API_BASE}/api/auth/google`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      },
    );
    const raw = await upstream.text();
    if (!upstream.ok) {
      return NextResponse.json(
        { error: safeError(raw, upstream.status) },
        { status: upstream.status, headers: NO_STORE_HEADERS },
      );
    }

    const parsed = JSON.parse(raw) as { token?: string };
    const token = parsed.token;
    if (!token) {
      return NextResponse.json(
        { error: "Missing token from auth provider" },
        { status: 502, headers: NO_STORE_HEADERS },
      );
    }
    const session = await fetchSessionUser(token);
    if (!session.ok) {
      return NextResponse.json(
        { error: "Invalid session from auth provider" },
        { status: invalidSessionStatus(session.status), headers: NO_STORE_HEADERS },
      );
    }

    const res = NextResponse.json({ user: session.user });
    applyNoStore(withSessionCookie(res, token));
    return res;
  } catch {
    return NextResponse.json(
      { error: "Auth provider unavailable" },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }
}

function safeError(raw: string, status: number): string {
  try {
    const parsed = JSON.parse(raw) as { error?: string };
    if (parsed.error) return parsed.error;
  } catch {}
  return `Auth request failed (${status})`;
}
