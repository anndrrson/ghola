import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import {
  connectSrcDirective,
  CROSS_ORIGIN_ISOLATION_HEADERS,
} from "./lib/csp-config";

// Next consumes `x-nonce` from the request headers and applies it to
// framework-managed scripts. Keeping CSP here avoids the previous
// production issue where next.config.ts emitted a very large per-build
// inline hash allowlist that could exceed Node/Undici header limits.

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

const HSTS_HEADER_VALUE = "max-age=63072000; includeSubDomains; preload";

function isBlockedBot(ua: string): boolean {
  return BLOCKED_BOT_PATTERNS.some((pattern) => pattern.test(ua));
}

function isNoIndexPath(pathname: string): boolean {
  return NO_INDEX_PATHS.some((p) => pathname.startsWith(p));
}

export function buildContentSecurityPolicy(isDev: boolean): string {
  // Next's statically prerendered app pages include inline bootstrap
  // scripts. Vercel can serve those pages from the prerender cache before
  // a per-request nonce reaches the rendered HTML, so production must allow
  // inline bootstrap scripts until these pages are made fully dynamic or the
  // build emits a stable hash allowlist.
  const scriptSrc = isDev
    ? "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' 'unsafe-eval' https://accounts.google.com https://apis.google.com https://challenges.cloudflare.com"
    : "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://accounts.google.com https://apis.google.com https://challenges.cloudflare.com";
  const directives = [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "media-src 'self' blob:",
    "manifest-src 'self'",
    "worker-src 'self' blob:",
    // API + auth + identity backends. Pinned host list is shared with
    // next.config.ts via src/lib/csp-config.ts so the runtime Proxy and
    // the static headers() config emit the IDENTICAL connect-src — no
    // more wide-open `connect-src 'self' https: wss:` on some routes and
    // a tight allowlist on others. No wildcards (see csp-config.ts).
    connectSrcDirective(),
    "frame-src https://accounts.google.com https://challenges.cloudflare.com",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ];

  if (!isDev) {
    directives.push("upgrade-insecure-requests", "block-all-mixed-content");
  }

  return directives.join("; ") + ";";
}

export function buildApiContentSecurityPolicy(): string {
  return [
    "default-src 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ") + ";";
}

function cspNonce(): string {
  return randomBytes(16).toString("base64");
}

export function applySecurityHeaders(
  headers: Headers,
  opts: {
    isDev: boolean;
    isHttps: boolean;
    allowMicrophone?: boolean;
    nonce?: string | null;
    api?: boolean;
  },
): void {
  headers.set(
    "Content-Security-Policy",
    opts.api
      ? buildApiContentSecurityPolicy()
      : buildContentSecurityPolicy(opts.isDev),
  );
  if (opts.nonce && !opts.api) headers.set("x-nonce", opts.nonce);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  // Cross-origin isolation (COOP + COEP + CORP) — shared with
  // next.config.ts so the Proxy no longer drops COEP `require-corp`
  // (which previously left SharedArrayBuffer isolation present on
  // static-header routes but absent on Proxy-handled responses).
  for (const { key, value } of CROSS_ORIGIN_ISOLATION_HEADERS) {
    headers.set(key, value);
  }
  headers.set("X-DNS-Prefetch-Control", "off");
  headers.set("X-Permitted-Cross-Domain-Policies", "none");
  headers.set("Origin-Agent-Cluster", "?1");
  headers.set(
    "Permissions-Policy",
    opts.allowMicrophone
      ? "camera=(), microphone=(self), geolocation=(), payment=(), usb=()"
      : "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  );
  if (opts.isHttps) {
    headers.set("Strict-Transport-Security", HSTS_HEADER_VALUE);
  }
}

export function proxy(request: NextRequest) {
  const ua = request.headers.get("user-agent") ?? "";
  const { pathname } = request.nextUrl;
  const isDev = process.env.NODE_ENV !== "production";
  const isHttps = request.nextUrl.protocol === "https:";
  const isApiPath =
    pathname.startsWith("/api/") ||
    pathname.startsWith("/v1/") ||
    pathname.startsWith("/.well-known/");
  const nonce = !isDev && !isApiPath ? cspNonce() : null;

  // Block known AI/scraper bots with a redirect to the API docs
  if (isBlockedBot(ua)) {
    const blockedResponse = new NextResponse(
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
    applySecurityHeaders(blockedResponse.headers, { isDev, isHttps, api: true });
    return blockedResponse;
  }

  const requestHeaders = new Headers(request.headers);
  if (nonce) {
    requestHeaders.set("x-nonce", nonce);
    requestHeaders.set(
      "Content-Security-Policy",
      buildContentSecurityPolicy(isDev),
    );
  }
  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });
  applySecurityHeaders(response.headers, {
    isDev,
    isHttps,
    allowMicrophone: pathname === "/intent",
    nonce,
    api: isApiPath,
  });

  // Sensitive pages: noindex + nofollow
  if (isNoIndexPath(pathname)) {
    response.headers.set("X-Robots-Tag", "noindex, nofollow");
  }

  // API routes: always noindex, expose Ghola provenance hint
  if (isApiPath) {
    response.headers.set("X-Robots-Tag", "noindex, nofollow");
    if (pathname.startsWith("/api/") || pathname.startsWith("/v1/")) {
      response.headers.set(
        "X-Ghola-Api-Docs",
        "https://ghola.xyz/docs/api"
      );
    }
    // API responses can carry credentials and private payloads.
    response.headers.set("Cache-Control", "no-store, max-age=0");
    response.headers.set("Pragma", "no-cache");
  }

  // Harden auth/token helper endpoints against intermediary caching.
  if (pathname.startsWith("/api/auth/") || pathname.startsWith("/api/turnkey/")) {
    response.headers.set("Cache-Control", "no-store, max-age=0");
    response.headers.set("Pragma", "no-cache");
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
     * - Workflow's authenticated internal queue handlers
     */
    "/((?!_next/static|_next/image|favicon\\.ico|\\.well-known/workflow/).*)",
  ],
};
