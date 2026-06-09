import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  connectSrcDirective,
  CROSS_ORIGIN_ISOLATION_HEADERS,
} from "./lib/csp-config";

// Next.js 16's Proxy (formerly middleware) always runs on the Node.js
// runtime, so `node:fs` is available here and no `runtime` segment
// config is needed (one is in fact disallowed). Reading the build-time
// inline-script hash allowlist off disk lets the Proxy CSP match the
// hash-based, `'unsafe-inline'`-free policy that `next.config.ts`
// emits — otherwise the Proxy would silently reintroduce
// `'unsafe-inline'` into `script-src` and defeat the build-time
// hardening.

const INLINE_HASHES_PATH = join(
  process.cwd(),
  "public",
  ".well-known",
  "csp-inline-hashes.json",
);

// Load the sha256 inline-script allowlist written by
// `scripts/build-inline-csp.mjs` after `next build`. Returns null when
// the file is absent or malformed. Missing hashes must not brick the
// public site, so production falls back to `'unsafe-inline'` only in
// that emergency state.
function loadInlineScriptHashes(): string[] | null {
  try {
    const raw = readFileSync(INLINE_HASHES_PATH, "utf8");
    const parsed = JSON.parse(raw) as { hashes?: unknown };
    if (
      parsed &&
      Array.isArray(parsed.hashes) &&
      parsed.hashes.length > 0 &&
      parsed.hashes.every((h) => typeof h === "string")
    ) {
      return parsed.hashes as string[];
    }
    return null;
  } catch {
    return null;
  }
}

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

export function buildContentSecurityPolicy(
  isDev: boolean,
  inlineHashes?: string[] | null,
): string {
  // Prefer hash-pinned inline scripts in production. If the build-time
  // hash manifest is missing, fail open for script bootstrap instead of
  // shipping a page that can only render a skeleton.
  const hashSources =
    !isDev && inlineHashes && inlineHashes.length > 0
      ? " " + inlineHashes.map((h) => `'${h}'`).join(" ")
      : "";
  const inlineFallback = !isDev && !hashSources ? " 'unsafe-inline'" : "";
  const scriptSrc = isDev
    ? "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' 'unsafe-eval' https://accounts.google.com https://apis.google.com"
    : `script-src 'self'${inlineFallback} 'wasm-unsafe-eval'${hashSources} https://accounts.google.com https://apis.google.com`;
  return (
    [
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
      "frame-src https://accounts.google.com",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "upgrade-insecure-requests",
      "block-all-mixed-content",
    ].join("; ") + ";"
  );
}

export function applySecurityHeaders(
  headers: Headers,
  opts: {
    isDev: boolean;
    isHttps: boolean;
    allowMicrophone?: boolean;
    inlineHashes?: string[] | null;
  },
): void {
  headers.set(
    "Content-Security-Policy",
    buildContentSecurityPolicy(opts.isDev, opts.inlineHashes),
  );
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
  // Hash allowlist is only meaningful for the enforcing (production)
  // policy; in dev we use 'unsafe-inline' and skip the disk read.
  const inlineHashes = isDev ? null : loadInlineScriptHashes();

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
    applySecurityHeaders(blockedResponse.headers, { isDev, isHttps, inlineHashes });
    return blockedResponse;
  }

  const response = NextResponse.next();
  applySecurityHeaders(response.headers, {
    isDev,
    isHttps,
    allowMicrophone: pathname === "/intent",
    inlineHashes,
  });

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
     */
    "/((?!_next/static|_next/image|favicon\\.ico).*)",
  ],
};
