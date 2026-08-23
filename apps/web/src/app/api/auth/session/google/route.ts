import { NextRequest, NextResponse } from "next/server";
import {
  applyNoStore,
  NO_STORE_HEADERS,
  sameOrigin,
  withSessionCookie,
} from "../_lib";
import { exchangeGoogleCredential } from "./_exchange";

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) {
    return NextResponse.json(
      { error: "cross-site session request rejected" },
      { status: 403, headers: NO_STORE_HEADERS },
    );
  }

  let idToken: string;
  try {
    const body = (await req.json()) as { id_token?: unknown };
    if (typeof body.id_token !== "string") throw new Error("missing credential");
    idToken = body.id_token;
  } catch {
    return NextResponse.json(
      { error: "Invalid request" },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  const exchange = await exchangeGoogleCredential(idToken);
  if (!exchange.ok) {
    return NextResponse.json(
      { error: exchange.error },
      { status: exchange.status, headers: NO_STORE_HEADERS },
    );
  }

  const res = NextResponse.json({ user: exchange.user });
  applyNoStore(withSessionCookie(res, exchange.token));
  return res;
}
