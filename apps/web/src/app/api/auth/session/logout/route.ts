import { NextRequest, NextResponse } from "next/server";
import {
  applyNoStore,
  clearSessionCookie,
  NO_STORE_HEADERS,
  SESSION_COOKIE_NAME,
  THUMPER_API_BASE,
  fetchWithTimeout,
  sameOrigin,
} from "../_lib";

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) {
    return NextResponse.json(
      { error: "cross-site session request rejected" },
      { status: 403, headers: NO_STORE_HEADERS },
    );
  }

  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (token) {
    void fetchWithTimeout(`${THUMPER_API_BASE}/api/auth/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
  }

  const res = NextResponse.json({ ok: true }, { headers: NO_STORE_HEADERS });
  applyNoStore(clearSessionCookie(res));
  return res;
}
