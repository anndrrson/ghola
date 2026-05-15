import type { NextConfig } from "next";

// Defense-in-depth response headers. Applied to every route except the
// API/proxy paths so chat/inference requests aren't accidentally
// blocked by Content-Security-Policy reporting noise. CSP is shipped
// in report-only mode initially so we collect violations without
// breaking the app; once the policy is dialed in (Tier 1C follow-up)
// we promote it to enforcing.
//
// Cross-Origin-Embedder / Opener / Resource — required for
// SharedArrayBuffer, which WebLLM uses for fast tensor ops in some
// configurations. Without these, mobile Safari falls back to a slow
// path.
const SECURITY_HEADERS = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value:
      "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
  },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  // Cross-origin isolation lets the in-browser model runtime use
  // SharedArrayBuffer. Required for WebLLM's fastest path on some
  // backends; harmless when the runtime doesn't need it.
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
  // Report-only CSP: catches violations without breaking the app.
  // Promote to enforcing once the manifest of allowed origins
  // (WebLLM model CDN, Solana RPC, Turnkey, thumper-cloud) is
  // stable. The 'wasm-unsafe-eval' source is required for WebLLM's
  // WASM compilation step.
  {
    key: "Content-Security-Policy-Report-Only",
    value: [
      "default-src 'self'",
      "script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      "connect-src 'self' https: wss:",
      "worker-src 'self' blob:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join("; "),
  },
];

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
        // Apply to everything except the API surface; the proxy/relay
        // routes are server-to-server and don't benefit from these.
        source: "/((?!api/).*)",
        headers: SECURITY_HEADERS,
      },
    ];
  },
};

export default nextConfig;
