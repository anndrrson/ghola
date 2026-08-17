import { NextRequest, NextResponse } from "next/server";
import {
  fetchWithTimeout,
  NO_STORE_HEADERS,
  SESSION_COOKIE_NAME,
  THUMPER_API_BASE,
  sameOrigin,
} from "../auth/session/_lib";

export function billingBearer(req: NextRequest): string | null {
  const authorization = req.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) return authorization;
  const cookieToken = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  return cookieToken ? `Bearer ${cookieToken}` : null;
}

export async function proxyBillingRequest(
  req: NextRequest,
  upstreamPath: string,
  method: "GET" | "POST" | "PATCH",
) {
  const bearer = billingBearer(req);
  if (!bearer) {
    return NextResponse.json(
      { error: "sign in required" },
      { status: 401, headers: NO_STORE_HEADERS },
    );
  }

  const mutating = method !== "GET";
  if (mutating && req.cookies.get(SESSION_COOKIE_NAME)?.value && !sameOrigin(req)) {
    return NextResponse.json(
      { error: "cross-site request rejected" },
      { status: 403, headers: NO_STORE_HEADERS },
    );
  }

  const body = mutating ? await req.text() : undefined;
  const upstream = await fetchWithTimeout(`${THUMPER_API_BASE}${upstreamPath}`, {
    method,
    headers: {
      authorization: bearer,
      accept: "application/json",
      ...(mutating ? { "content-type": "application/json" } : {}),
    },
    body,
    cache: "no-store",
  }).catch(() => null);

  if (!upstream) {
    return NextResponse.json(
      { error: "billing unavailable" },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }

  return new NextResponse(await upstream.text(), {
    status: upstream.status,
    headers: { ...NO_STORE_HEADERS, "content-type": "application/json" },
  });
}
