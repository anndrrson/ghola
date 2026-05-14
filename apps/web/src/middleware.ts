import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// AI training crawlers and bulk scrapers that should not index the site.
// Legitimate agent access should go through the Ghola MCP/API channels.
const BLOCKED_BOT_PATTERNS = [
  /GPTBot/i,
  /CCBot/i,
  /anthropic-ai/i,
  /Claude-Web/i,
  /Google-Extended/i,
  /PerplexityBot/i,
  /cohere-ai/i,
  /Bytespider/i,
  /ImagesiftBot/i,
  /omgilibot/i,
  /FacebookBot/i,
  /DataForSeoBot/i,
  /Diffbot/i,
  // Generic scraping libraries
  /Scrapy/i,
  /python-requests/i,
  /node-fetch/i,
  /go-http-client/i,
  /libwww-perl/i,
];

// Pages that should never be indexed by any crawler
const NO_INDEX_PATHS = [
  "/dashboard",
  "/settings",
  "/onboarding",
  "/api/",
];

function isBlockedBot(ua: string): boolean {
  return BLOCKED_BOT_PATTERNS.some((pattern) => pattern.test(ua));
}

function isNoIndexPath(pathname: string): boolean {
  return NO_INDEX_PATHS.some((p) => pathname.startsWith(p));
}

export function middleware(request: NextRequest) {
  const ua = request.headers.get("user-agent") ?? "";
  const { pathname } = request.nextUrl;

  // Block known AI/scraper bots with a redirect to the API docs
  if (isBlockedBot(ua)) {
    return new NextResponse(
      JSON.stringify({
        error: "Automated access via web scraping is not permitted.",
        message:
          "Use the Ghola API or MCP server for programmatic access. See https://ghola.xyz/docs/api",
      }),
      {
        status: 403,
        headers: {
          "Content-Type": "application/json",
          "X-Robots-Tag": "noindex, nofollow",
        },
      }
    );
  }

  const response = NextResponse.next();

  // Security headers on every response.
  //
  // connect-src had to grow to include our own API backends — the marketplace
  // (orni-models-api), the SAID identity / merchant gateway (ghola-api),
  // and the assistant cloud (thumper-cloud). Without these the page was
  // silently blank because every API fetch tripped CSP.
  response.headers.set(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://accounts.google.com https://apis.google.com",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      // API + auth + identity backends
      "connect-src 'self' " +
        "https://accounts.google.com https://apis.google.com " +
        "https://*.supabase.co wss://*.supabase.co " +
        "https://orni-models-api.onrender.com " +
        "https://ghola-api.onrender.com " +
        "https://thumper-cloud.onrender.com " +
        "https://ghola-gateway.onrender.com " +
        "https://ghola-merchant-gateway.onrender.com " +
        // v2 surfaces — sealed transport relay + on-chain anchor receipts service.
        // ghola-relay stays during v3.5 OHTTP rollout so the legacy direct
        // POST /inference/sealed path still works.
        "https://ghola-relay.onrender.com " +
        "https://ghola-receipts.onrender.com " +
        // v3.5 Phase 2: Cloudflare OHTTP relay (RFC 9458).
        // TODO(phase-2-go-live): confirm Cloudflare's current OHTTP relay
        // URL once ops finishes registering with cloudflare.com/onion-routing
        // and replace the wildcard below with the exact production host.
        "https://ohttp.cloudflare.com " +
        "https://*.ohttp.cloudflare.com",
      "frame-src https://accounts.google.com",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; ") + ";"
  );
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()"
  );

  // Sensitive pages: noindex + nofollow
  if (isNoIndexPath(pathname)) {
    response.headers.set("X-Robots-Tag", "noindex, nofollow");
  }

  // API routes: always noindex, expose Ghola provenance hint
  if (pathname.startsWith("/api/")) {
    response.headers.set("X-Robots-Tag", "noindex, nofollow");
    response.headers.set(
      "X-Ghola-Api-Docs",
      "https://ghola.xyz/docs/api"
    );
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico (browser favicon)
     */
    "/((?!_next/static|_next/image|favicon\\.ico).*)",
  ],
};
