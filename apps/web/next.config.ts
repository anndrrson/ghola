import type { NextConfig } from "next";
import { CROSS_ORIGIN_ISOLATION_HEADERS } from "./src/lib/csp-config";
import { withSentryConfig } from "@sentry/nextjs";

// Defense-in-depth response headers. Applied to every route except the
// API/proxy paths so chat/inference requests aren't accidentally
// blocked by Content-Security-Policy reporting noise.
//
// CSP is intentionally not emitted from next.config.ts. The runtime
// proxy owns CSP so production can use Next's per-request nonce flow
// without shipping an oversized inline hash allowlist header.
//
// Cross-Origin-Embedder / Opener — required for SharedArrayBuffer,
// which WebLLM uses for fast tensor ops in some configurations.

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

export default withSentryConfig(nextConfig, {
  silent: true,
  widenClientFileUpload: true,
  tunnelRoute: "/monitoring",
  webpack: {
    treeshake: { removeDebugLogging: true },
  },
  sourcemaps: {
    deleteSourcemapsAfterUpload: true,
  },
});
