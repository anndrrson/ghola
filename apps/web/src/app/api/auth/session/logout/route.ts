import { type NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE_NAME,
  THUMPER_API_BASE,
  applyNoStore,
  clearSessionCookie,
  fetchWithTimeout,
} from "../_lib";

export async function POST(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (token) {
    fetchWithTimeout(`${THUMPER_API_BASE}/api/auth/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    }).catch(() => {});
  }

  const res = NextResponse.json({ ok: true });
  clearSessionCookie(res);
  return applyNoStore(res);
}
