import { NextRequest, NextResponse } from "next/server";
import {
  applyNoStore,
  clearSessionCookie,
  fetchSessionUser,
  NO_STORE_HEADERS,
  SESSION_COOKIE_NAME,
} from "../_lib";

export async function GET(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!token) {
    return NextResponse.json(
      { authenticated: false, user: null },
      { status: 200, headers: NO_STORE_HEADERS },
    );
  }

  let session;
  try {
    session = await fetchSessionUser(token);
  } catch {
    return NextResponse.json(
      { authenticated: false, user: null, error: "Auth provider unavailable" },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }

  if (!session.ok) {
    if (![401, 403, 404].includes(session.status)) {
      return NextResponse.json(
        { authenticated: false, user: null, error: "Auth provider unavailable" },
        { status: session.status === 502 ? 502 : 503, headers: NO_STORE_HEADERS },
      );
    }
    const res = NextResponse.json(
      { authenticated: false, user: null },
      { status: 200, headers: NO_STORE_HEADERS },
    );
    applyNoStore(clearSessionCookie(res));
    return res;
  }

  const res = NextResponse.json(
    { authenticated: true, user: session.user },
    { status: 200, headers: NO_STORE_HEADERS },
  );
  applyNoStore(res);
  return res;
}
