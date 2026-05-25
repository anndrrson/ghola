import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
// the file is absent (dev / pre-build) or malformed, in which case the
// production CSP falls back to a policy without `'unsafe-inline'` and
// without hashes (strictest available; first-party inline scripts must
// be hashed via the build step to load).
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
  // In production we MUST NOT emit `'unsafe-inline'` for scripts — that
  // would defeat the hash-based CSP that `next.config.ts` builds from
  // `public/.well-known/csp-inline-hashes.json`. Instead we splice the
  // same per-build sha256 hashes into `script-src`. In development the
  // Next dev server injects unhashable inline + eval'd scripts (HMR,
  // React refresh), so `'unsafe-inline' 'unsafe-eval'` are required.
  const hashSources =
    !isDev && inlineHashes && inlineHashes.length > 0
      ? " " + inlineHashes.map((h) => `'${h}'`).join(" ")
      : "";
  const scriptSrc = isDev
    ? "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' 'unsafe-eval' https://accounts.google.com https://apis.google.com"
    : `script-src 'self' 'wasm-unsafe-eval'${hashSources} https://accounts.google.com https://apis.google.com`;
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
        // Private voice downloads ONNX/WASM runtime assets and model weights,
        // but microphone audio and transcripts stay in the browser until the
        // user submits text. These hosts are intentionally explicit.
        "https://cdn.jsdelivr.net " +
        "https://huggingface.co https://hf.co " +
        "https://cas-bridge.xethub.hf.co https://cas-server.xethub.hf.co " +
        "https://raw.githubusercontent.com " +
        // v3.5 Phase 2: Cloudflare OHTTP relay (RFC 9458).
        //
        // SECURITY: do NOT add a wildcard host here. Wildcards in
        // `connect-src` defeat the entire purpose of pinning OHTTP traffic
        // to a known relay — a compromised subdomain of cloudflare.com
        // would otherwise be silently reachable from authenticated pages.
        //
        // The single pinned host below is the public landing URL for the
        // Cloudflare OHTTP relay during invite-only beta. Once Cloudflare
        // assigns our production-tier relay hostname (post-onboarding via
        // cloudflare.com/onion-routing), update the line below in a
        // single, reviewed commit — do not paper over with a wildcard.
        //
        // TODO(phase-2-go-live): replace `https://ohttp.cloudflare.com`
        // with the exact relay hostname Cloudflare assigns us once we are
        // out of invite-only beta. If the assigned host is unknown at
        // deploy time, gate the OHTTP rollout on this CSP entry — do NOT
        // ship a `https://*.ohttp.cloudflare.com` wildcard to production.
        "https://ohttp.cloudflare.com",
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
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
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
