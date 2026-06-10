import { type NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE_NAME,
  applyNoStore,
  clearSessionCookie,
  fetchSessionUser,
} from "../_lib";

export async function GET(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!token) {
    return applyNoStore(NextResponse.json({ authenticated: false, user: null }));
  }

  try {
    const session = await fetchSessionUser(token);
    if (session.ok) {
      return applyNoStore(NextResponse.json({
        authenticated: true,
        user: session.user,
      }));
    }
  } catch {
    // Fall through to clearing the bad cookie.
  }

  const res = NextResponse.json({ authenticated: false, user: null }, { status: 401 });
  clearSessionCookie(res);
  return applyNoStore(res);
}
