import type { NextConfig } from "next";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  connectSrcDirective,
  CROSS_ORIGIN_ISOLATION_HEADERS,
} from "./src/lib/csp-config";

// Defense-in-depth response headers. Applied to every route except the
// API/proxy paths so chat/inference requests aren't accidentally
// blocked by Content-Security-Policy reporting noise.
//
// CSP MODE TOGGLE (build-time): if the inline-script hash allowlist
// at `public/.well-known/csp-inline-hashes.json` exists AND is
// non-empty, we splice those `'sha256-...'` sources into `script-src`
// (dropping `'unsafe-inline'`) and emit the policy as ENFORCING. The
// allowlist is written by `scripts/build-inline-csp.mjs`, which runs
// after `next build` in `npm run build`.
//
// If the file is missing (dev/local workflows, `npm run dev`, or a
// hot-edit before a fresh build) we FALL BACK to the historical
// report-only policy with `'unsafe-inline'`. This is the dev-fallback:
// it intentionally never breaks dev because the post-build steps are
// only run by `npm run build`. The regression test in
// `src/lib/security-headers.test.ts` asserts that when the allowlist
// IS present, `'unsafe-inline'` is gone — so we can't silently regress
// into the dev-fallback in production.
//
// Cross-Origin-Embedder / Opener — required for SharedArrayBuffer,
// which WebLLM uses for fast tensor ops in some configurations.

const INLINE_HASHES_PATH = join(
  process.cwd(),
  "public",
  ".well-known",
  "csp-inline-hashes.json",
);

function loadInlineHashes(): string[] | null {
  try {
    const raw = readFileSync(INLINE_HASHES_PATH, "utf8");
    const parsed = JSON.parse(raw) as { hashes?: string[] };
    if (
      parsed &&
      Array.isArray(parsed.hashes) &&
      parsed.hashes.length > 0 &&
      parsed.hashes.every((h) => typeof h === "string")
    ) {
      return parsed.hashes;
    }
    return null;
  } catch {
    return null;
  }
}

export function buildCspHeader(): { key: string; value: string } {
  const inlineHashes = loadInlineHashes();

  // CSP violations POST to `/api/csp-report` (handler at
  // apps/web/src/app/api/csp-report/route.ts). Browsers logging via
  // the legacy `report-uri` directive; we don't ship a Reporting API
  // group header yet because the legacy form is wider-supported.
  // The report endpoint logs every violation as a structured JSON
  // line so an operator can `vercel logs --since 1h | grep csp-violation`.
  const reportUri = "report-uri /api/csp-report";

  if (inlineHashes && inlineHashes.length > 0) {
    // ENFORCING mode: every legitimate inline `<script>` body has
    // its sha256 listed; `'unsafe-inline'` is gone.
    const hashSources = inlineHashes.map((h) => `'${h}'`).join(" ");
    return {
      key: "Content-Security-Policy",
      value: [
        "default-src 'self'",
        `script-src 'self' 'wasm-unsafe-eval' ${hashSources}`,
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob: https:",
        "font-src 'self' data:",
        // Pinned host allowlist shared with the runtime Proxy
        // (src/lib/csp-config.ts) — replaces the previous wide-open
        // `connect-src 'self' https: wss:` so both layers agree.
        connectSrcDirective(),
        "worker-src 'self' blob:",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "object-src 'none'",
        reportUri,
      ].join("; "),
    };
  }

  // Dev-fallback (allowlist missing): report-only with
  // 'unsafe-inline' so dev workflows aren't broken. This branch
  // should never be hit in production: `npm run build` always
  // produces the allowlist via `scripts/build-inline-csp.mjs`.
  return {
    key: "Content-Security-Policy-Report-Only",
    value: [
      "default-src 'self'",
      "script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      // Same pinned allowlist as the enforcing branch / the Proxy.
      connectSrcDirective(),
      "worker-src 'self' blob:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
      reportUri,
    ].join("; "),
  };
}

const LOCKED_PERMISSIONS_POLICY =
  "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()";

const INTENT_PERMISSIONS_POLICY =
  "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(self), payment=(), usb=()";

export const SECURITY_HEADERS = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: LOCKED_PERMISSIONS_POLICY,
  },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  // Cross-origin isolation (COOP + COEP + CORP) lets the in-browser model
  // runtime use SharedArrayBuffer. Shared with the runtime Proxy via
  // src/lib/csp-config.ts so the same isolation set is emitted on every
  // response (the Proxy previously omitted COEP).
  ...CROSS_ORIGIN_ISOLATION_HEADERS,
  buildCspHeader(),
];

export const INTENT_SECURITY_HEADERS = SECURITY_HEADERS.map((header) =>
  header.key === "Permissions-Policy"
    ? { ...header, value: INTENT_PERMISSIONS_POLICY }
    : header,
);

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  // Deterministic build id. Without this Next.js generates a random
  // 20-char id per build, which leaks into manifest paths and
  // defeats reproducible builds. Pinning to the git commit (or an
  // explicit env var) means two builds at the same SHA produce
  // identical SRI manifest hashes — the whole point of the
  // /.well-known/sri-manifest.json supply-chain story.
  //
  // Fallbacks: GIT_COMMIT (CI), then `git rev-parse HEAD` (local), then
  // a static dev sentinel so dev builds don't ship random ids either.
  async generateBuildId() {
    if (process.env.GIT_COMMIT) return process.env.GIT_COMMIT;
    try {
      const { execSync } = await import("node:child_process");
      return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
    } catch {
      return "ghola-dev-build";
    }
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "*.supabase.co",
      },
    ],
  },
  async headers() {
    return [
      {
        source: "/intent",
        headers: INTENT_SECURITY_HEADERS,
      },
      {
        // Apply to everything except the API surface; the proxy/relay
        // routes are server-to-server and don't benefit from these.
        source: "/((?!api/|intent$).*)",
        headers: SECURITY_HEADERS,
      },
    ];
  },
};

export default nextConfig;
