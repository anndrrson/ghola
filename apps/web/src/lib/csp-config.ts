/**
 * Single source of truth for CSP `connect-src` hosts and the
 * cross-origin-isolation header set.
 *
 * Why this file exists
 * --------------------
 * The CSP is emitted from TWO layers:
 *   1. `next.config.ts` — static `headers()` config (build time), and
 *   2. `src/proxy.ts`   — runtime Proxy/middleware on every matched route.
 * They previously DIVERGED: the proxy pinned a tight `connect-src`
 * allowlist while next.config shipped a wide-open `connect-src 'self'
 * https: wss:`, and only next.config set `Cross-Origin-Embedder-Policy`.
 * Whichever header the platform emitted last won, so the effective policy
 * depended on the route — a tight allowlist on some paths, an any-https
 * allowlist on others, and SharedArrayBuffer isolation present on some
 * responses but not others.
 *
 * This module exports the canonical host list so both layers build the
 * EXACT same `connect-src` directive, and a shared
 * `CROSS_ORIGIN_ISOLATION_HEADERS` set so COOP/COEP/CORP are emitted
 * consistently. It intentionally has NO `next/server` (or any runtime)
 * import so it can be pulled into the build-time `next.config.ts` as well
 * as the Node-runtime Proxy.
 */

// Hosts allowed for `connect-src` (fetch/XHR/WebSocket/EventSource).
// Keep this list explicit — NO wildcards (a wildcard defeats the point of
// pinning, e.g. for the OHTTP relay). Update in a single reviewed commit.
export const CONNECT_SRC_HOSTS: readonly string[] = [
  "'self'",
  // Auth + identity backends
  "https://accounts.google.com",
  "https://apis.google.com",
  "https://*.supabase.co",
  "wss://*.supabase.co",
  // Ghola / Orni / Thumper service surfaces
  "https://orni-models-api.onrender.com",
  "https://ghola-api.onrender.com",
  "https://thumper-cloud.onrender.com",
  "https://ghola-gateway.onrender.com",
  "https://ghola-merchant-gateway.onrender.com",
  // v2 surfaces — sealed transport relay + on-chain anchor receipts.
  // ghola-relay stays during the v3.5 OHTTP rollout so the legacy direct
  // POST /inference/sealed path still works.
  "https://ghola-relay.onrender.com",
  "https://ghola-receipts.onrender.com",
  // Public Hyperliquid market data stream. This is market-only data;
  // account/order submission still goes through Ghola's sealed connector.
  "wss://api.hyperliquid.xyz",
  "wss://api.hyperliquid-testnet.xyz",
  // Private voice / in-browser model runtime asset hosts. Microphone
  // audio + transcripts stay client-side until the user submits text.
  "https://cdn.jsdelivr.net",
  "https://huggingface.co",
  "https://hf.co",
  "https://cas-bridge.xethub.hf.co",
  "https://cas-server.xethub.hf.co",
  "https://raw.githubusercontent.com",
  // v3.5 Phase 2: Cloudflare OHTTP relay (RFC 9458). Single pinned host —
  // do NOT wildcard (a compromised cloudflare.com subdomain would
  // otherwise be reachable from authenticated pages). Replace with the
  // production relay hostname Cloudflare assigns post-beta, in one
  // reviewed commit; do not ship a `https://*.ohttp.cloudflare.com`.
  "https://ohttp.cloudflare.com",
];

/** The assembled `connect-src ...` directive (no trailing `;`). */
export function connectSrcDirective(): string {
  return "connect-src " + CONNECT_SRC_HOSTS.join(" ");
}

/**
 * Cross-origin isolation headers. COEP `require-corp` + COOP `same-origin`
 * enable `SharedArrayBuffer` (used by the in-browser model runtime). CORP
 * `same-origin` restricts who may embed our subresources. Emitted by BOTH
 * the static config and the runtime Proxy so isolation is uniform.
 */
export const CROSS_ORIGIN_ISOLATION_HEADERS: ReadonlyArray<{
  key: string;
  value: string;
}> = [
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
];
