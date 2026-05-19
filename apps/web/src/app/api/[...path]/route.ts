import { NextRequest, NextResponse } from "next/server";

const THUMPER_API_BASE =
  process.env.NEXT_PUBLIC_THUMPER_API_URL || "https://thumper-cloud.onrender.com";

const SESSION_COOKIE_NAME = "ghola_thumper_session";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
} as const;

const HOP_BY_HOP = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

async function handle(req: NextRequest, pathParts: string[]) {
  const upstreamUrl = `${THUMPER_API_BASE}/api/${pathParts.join("/")}${req.nextUrl.search}`;
  const sessionToken = req.cookies.get(SESSION_COOKIE_NAME)?.value;

  const headers = new Headers();
  const contentType = req.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  const accept = req.headers.get("accept");
  if (accept) headers.set("accept", accept);
  const authorization = req.headers.get("authorization");
  if (authorization) {
    headers.set("authorization", authorization);
  } else if (sessionToken) {
    headers.set("authorization", `Bearer ${sessionToken}`);
  }

  const method = req.method.toUpperCase();
  const bodyAllowed = !["GET", "HEAD"].includes(method);
  const body = bodyAllowed ? await req.arrayBuffer() : undefined;
  const upstream = await fetch(upstreamUrl, {
    method,
    headers,
    body,
  });

  const outHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) return;
    if (lower === "set-cookie") return;
    outHeaders.set(key, value);
  });
  outHeaders.set("Cache-Control", NO_STORE_HEADERS["Cache-Control"]);
  outHeaders.set("Pragma", NO_STORE_HEADERS.Pragma);

  return new NextResponse(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: outHeaders,
  });
}

type Params = { params: Promise<{ path: string[] }> };

export async function GET(req: NextRequest, { params }: Params) {
  return handle(req, (await params).path);
}

export async function POST(req: NextRequest, { params }: Params) {
  return handle(req, (await params).path);
}

export async function PUT(req: NextRequest, { params }: Params) {
  return handle(req, (await params).path);
}

export async function PATCH(req: NextRequest, { params }: Params) {
  return handle(req, (await params).path);
}

export async function DELETE(req: NextRequest, { params }: Params) {
  return handle(req, (await params).path);
}
