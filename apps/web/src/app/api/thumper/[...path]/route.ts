import { NextRequest, NextResponse } from "next/server";
import { NO_STORE_HEADERS, SESSION_COOKIE_NAME, THUMPER_API_BASE } from "../../auth/session/_lib";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

async function handle(req: NextRequest, pathParts: string[]) {
  const upstreamUrl = `${THUMPER_API_BASE}/${pathParts.join("/")}${req.nextUrl.search}`;
  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;

  const headers = new Headers();
  const contentType = req.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  const accept = req.headers.get("accept");
  if (accept) headers.set("accept", accept);
  if (token) headers.set("authorization", `Bearer ${token}`);

  const method = req.method.toUpperCase();
  const bodyAllowed = !["GET", "HEAD"].includes(method);
  const upstream = await fetch(upstreamUrl, {
    method,
    headers,
    body: bodyAllowed ? req.body : undefined,
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
