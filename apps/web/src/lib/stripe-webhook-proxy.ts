const THUMPER_API_FALLBACK = "https://thumper-cloud.onrender.com";
const UPSTREAM_TIMEOUT_MS = 15_000;

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

function thumperApiBase(): string {
  return (
    process.env.NEXT_PUBLIC_THUMPER_API_URL ||
    process.env.THUMPER_API_URL ||
    THUMPER_API_FALLBACK
  );
}

function jsonError(error: string, status: number): Response {
  return Response.json(
    { error },
    {
      status,
      headers: NO_STORE_HEADERS,
    },
  );
}

function methodNotAllowed(): Response {
  return new Response(null, {
    status: 405,
    headers: {
      ...NO_STORE_HEADERS,
      Allow: "POST",
    },
  });
}

function upstreamHeaders(upstream: Response): Headers {
  const headers = new Headers();
  upstream.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) return;
    if (lower === "set-cookie") return;
    headers.set(key, value);
  });
  headers.set("Cache-Control", NO_STORE_HEADERS["Cache-Control"]);
  headers.set("Pragma", NO_STORE_HEADERS.Pragma);
  return headers;
}

export async function proxyStripeBillingWebhook(req: Request): Promise<Response> {
  if (req.method.toUpperCase() !== "POST") return methodNotAllowed();

  const stripeSignature = req.headers.get("stripe-signature");
  if (!stripeSignature) return jsonError("missing Stripe-Signature header", 400);

  const headers = new Headers();
  headers.set("stripe-signature", stripeSignature);

  const contentType = req.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);

  const accept = req.headers.get("accept");
  if (accept) headers.set("accept", accept);

  const body = await req.arrayBuffer();
  let upstream: Response;
  try {
    upstream = await fetch(new URL("/api/billing/webhook", thumperApiBase()), {
      method: "POST",
      headers,
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    return jsonError("upstream unavailable", 503);
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstreamHeaders(upstream),
  });
}
