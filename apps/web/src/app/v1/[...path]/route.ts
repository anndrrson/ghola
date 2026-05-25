import { NextRequest, NextResponse } from "next/server";
import { sameOrigin } from "../../api/auth/session/_lib";

const THUMPER_API_BASE =
  process.env.NEXT_PUBLIC_THUMPER_API_URL ||
  "https://thumper-cloud.onrender.com";

const SESSION_COOKIE_NAME = "ghola_thumper_session";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
} as const;

const UPSTREAM_TIMEOUT_MS = 15_000;

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

const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "authorization",
  "content-type",
  "payment-signature",
  "x-payment",
  "x402-payment",
  "x-ghola-payment-rail",
  "x-payment-rail",
];

async function handle(req: NextRequest, pathParts: string[]) {
  const safePath = encodeSafePath(pathParts);
  if (!safePath) {
    return NextResponse.json(
      { error: "invalid proxy path" },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }
  const upstreamUrl = `${THUMPER_API_BASE}/v1/${safePath}${req.nextUrl.search}`;
  const sessionToken = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  const method = req.method.toUpperCase();

  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (!headers.has("authorization") && sessionToken) {
    if (!["GET", "HEAD", "OPTIONS"].includes(method) && !sameOrigin(req)) {
      return NextResponse.json(
        { error: "cross-site cookie-authenticated request rejected" },
        { status: 403, headers: NO_STORE_HEADERS },
      );
    }
    headers.set("authorization", `Bearer ${sessionToken}`);
  }

  const bodyAllowed = !["GET", "HEAD"].includes(method);
  const body = bodyAllowed ? await req.arrayBuffer() : undefined;
  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    return NextResponse.json(
      { error: "upstream unavailable" },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }

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

function encodeSafePath(pathParts: string[]): string | null {
  if (pathParts.length === 0) return null;
  const encoded = [];
  for (const part of pathParts) {
    if (!part || part === "." || part === "..") return null;
    if (part.includes("/") || part.includes("\\") || part.includes("\0"))
      return null;
    encoded.push(encodeURIComponent(part));
  }
  return encoded.join("/");
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
