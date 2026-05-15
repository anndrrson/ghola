/**
 * Ghola service worker — SRI runtime enforcement + offline cache.
 *
 * Two responsibilities:
 *
 * 1. SRI ENFORCEMENT. For every same-origin GET, fetch from network,
 *    hash the response body with SHA-256, and compare against the
 *    pinned manifest at /.well-known/sri-manifest.json. A mismatch
 *    means a CDN/cache layer between us and the visitor served
 *    tampered bytes; we reply with HTTP 502 and broadcast an
 *    `sri-mismatch` message so the live security-status page can
 *    flip the corresponding card red.
 *
 *    Only paths the manifest hashes (/_next/static/...) are enforced.
 *    Unhashed paths (HTML, /api/*, images, etc.) fall through to the
 *    normal network-first cache strategy.
 *
 * 2. OFFLINE FALLBACK. Successful responses are stored in the
 *    `CACHE_NAME` cache so a visitor with a flaky connection can
 *    re-load the app from cache. SRI-failed responses are NEVER
 *    cached (fail-closed: a poisoned bundle does not get persisted).
 *
 * Message protocol (postMessage from a window client):
 *   { type: "sri-status" }
 *      → replies { type: "sri-status", manifestLoaded, hashCount, lastMismatch }
 *
 * Broadcast (sw → all clients on mismatch):
 *   { type: "sri-mismatch", path, expected, actual, at }
 *
 * Failure modes:
 *  - Manifest fetch fails → we run in fall-open mode (log it, don't
 *    block requests). The build-time `<script integrity=...>` attrs
 *    that `inject-script-integrity.mjs` adds are still a layer of
 *    defense, and the enforcing CSP catches inline-script tampering.
 *  - Response is opaque/cross-origin → we don't try to hash it; the
 *    browser's own SRI check on the script tag is the line of
 *    defense for those.
 */

const CACHE_NAME = "ghola-v2-sri";
const MANIFEST_PATH = "/.well-known/sri-manifest.json";

// In-memory state. Re-populated on every SW activation.
let MANIFEST = null; // Map<path, { sha256, sha384 }>
let MANIFEST_LOADED_AT = null;
let LAST_MISMATCH = null;

async function loadManifest() {
  try {
    const res = await fetch(MANIFEST_PATH, { cache: "no-store" });
    if (!res.ok) {
      console.warn("[sw] manifest fetch failed:", res.status);
      MANIFEST = null;
      return;
    }
    const body = await res.json();
    const map = new Map();
    for (const f of body.files || []) {
      map.set(f.path, { sha256: f.sha256, sha384: f.sha384 });
    }
    MANIFEST = map;
    MANIFEST_LOADED_AT = new Date().toISOString();
    // eslint-disable-next-line no-console
    console.log(`[sw] SRI manifest loaded: ${map.size} pinned entries`);
  } catch (err) {
    // Network blip or missing manifest in dev: fall-open. The other
    // layers (static-tag integrity attrs + CSP hashes + Next's own
    // module loader) still apply.
    console.warn("[sw] manifest load error, running in fall-open mode:", err);
    MANIFEST = null;
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(loadManifest());
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drop legacy cache buckets so a stale tampered chunk can't
      // survive a SW version bump.
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)),
      );
      await self.clients.claim();
      // Re-load the manifest after activation; install-time load may
      // have raced ahead of the new build's manifest being served.
      await loadManifest();
    })(),
  );
});

// Hex-encode an ArrayBuffer for sha256 comparison against the
// manifest, which stores the hex digest.
function toHex(buf) {
  const view = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < view.length; i++) {
    out += view[i].toString(16).padStart(2, "0");
  }
  return out;
}

async function broadcastMismatch(payload) {
  LAST_MISMATCH = payload;
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  for (const c of clients) {
    try {
      c.postMessage({ type: "sri-mismatch", ...payload });
    } catch {
      // ignore — client may be gone
    }
  }
}

// Build the 502 response we send to the browser when SRI fails.
// Body is a tiny JSON blob so a debugging fetch shows what
// happened; non-JS callers will surface this as a load error,
// which is exactly what we want for a tampered chunk.
function tamperedResponse(path, expected, actual) {
  const body = JSON.stringify({
    error: "sri_mismatch",
    path,
    expected_sha256: expected,
    actual_sha256: actual,
    detail:
      "The bytes served for this asset did not match the pinned SRI manifest. " +
      "This is a fail-closed response from the Ghola service worker.",
  });
  return new Response(body, {
    status: 502,
    statusText: "SRI Mismatch",
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

// Verify a response against the manifest entry for `path`. Returns
// the original response (clone) on match, or a 502 on mismatch.
async function verifyAndMaybeCache(path, response, request) {
  if (!response || !response.ok) return response;
  // Opaque responses (no-cors cross-origin) cannot be hashed.
  if (response.type === "opaque" || response.type === "opaqueredirect") {
    return response;
  }
  const entry = MANIFEST.get(path);
  if (!entry) return response; // not a hashed asset

  // Clone twice: one for hashing, one to return / cache.
  const forHash = response.clone();
  const buf = await forHash.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  const actual = toHex(digest);

  if (actual !== entry.sha256) {
    await broadcastMismatch({
      path,
      expected: entry.sha256,
      actual,
      at: new Date().toISOString(),
    });
    return tamperedResponse(path, entry.sha256, actual);
  }

  // Verified clean — cache for offline fallback.
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response.clone());
  } catch {
    // Cache write failures are non-fatal.
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Same-origin only — we cannot enforce SRI on cross-origin
  // responses, and we don't want to interpose on the relay/cloud
  // fetches.
  if (url.origin !== self.location.origin) return;

  // Skip API + auth + the manifest itself.
  if (url.pathname.startsWith("/api/")) return;
  if (url.pathname === MANIFEST_PATH) return;
  if (url.pathname === "/.well-known/csp-inline-hashes.json") return;

  const isHashed = MANIFEST && MANIFEST.has(url.pathname);

  event.respondWith(
    (async () => {
      try {
        const network = await fetch(req);
        if (isHashed) {
          return verifyAndMaybeCache(url.pathname, network, req);
        }
        // Unhashed path: keep the existing cache-on-success behavior
        // so the offline fallback still works for HTML/images/etc.
        if (network.ok && network.type !== "opaque") {
          try {
            const cache = await caches.open(CACHE_NAME);
            await cache.put(req, network.clone());
          } catch {
            // ignore cache failures
          }
        }
        return network;
      } catch (err) {
        // Offline path: serve from cache if we have it.
        const cached = await caches.match(req);
        if (cached) return cached;
        throw err;
      }
    })(),
  );
});

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;

  if (data.type === "sri-status") {
    const reply = {
      type: "sri-status",
      manifestLoaded: MANIFEST !== null,
      hashCount: MANIFEST ? MANIFEST.size : 0,
      loadedAt: MANIFEST_LOADED_AT,
      lastMismatch: LAST_MISMATCH,
    };
    // Prefer the MessagePort if the caller opened one, otherwise
    // reply to the source client.
    if (event.ports && event.ports[0]) {
      try {
        event.ports[0].postMessage(reply);
      } catch {
        // ignore
      }
    } else if (event.source && "postMessage" in event.source) {
      try {
        event.source.postMessage(reply);
      } catch {
        // ignore
      }
    }
  }

  if (data.type === "sri-reload-manifest") {
    event.waitUntil(loadManifest());
  }
});
