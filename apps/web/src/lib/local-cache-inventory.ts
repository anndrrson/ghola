/**
 * Browser-side inventory of the WebLLM CacheStorage scopes.
 *
 * WebLLM splits the model bundle across three Cache API scopes:
 *
 *   - `webllm/config` — JSON config + tokenizer.json
 *   - `webllm/wasm`   — the inference WASM (`model_lib`)
 *   - `webllm/model`  — the multi-GB weight shards
 *
 * The first two are SRI-pinned via WebLLM's `ModelIntegrity` path
 * (see `webgpu-inference.ts::DEFAULT_WEBGPU_MODEL_INTEGRITY`). The
 * `webllm/model` scope is the integrity gap the rest of the stack is
 * filling with the on-chain registry hash + the runtime
 * `computeLoadedWeightFingerprint` walk.
 *
 * This module exposes enumeration helpers for the cache-management UI
 * at `/settings/cache`. It deliberately does NOT hash bodies — the
 * canonical fingerprint walk lives in `webgpu-inference.ts` and we
 * import that when a "Re-verify" action is requested. Here we only
 * enumerate URLs + byte sizes.
 */

/**
 * The cache scopes WebLLM writes to. Re-exported so other modules
 * don't need to duplicate this list. The order matches the natural
 * load order (config → wasm → model) so UI lists feel chronological.
 */
export const WEBLLM_CACHE_SCOPES: ReadonlyArray<string> = [
  "webllm/config",
  "webllm/wasm",
  "webllm/model",
];

export interface CacheEntry {
  url: string;
  byteLength: number;
}

export interface CacheScopeReport {
  scope: string;
  /** True if the cache exists at all (CacheStorage has an entry for this name). */
  present: boolean;
  entries: CacheEntry[];
  totalBytes: number;
}

/**
 * Walk every WebLLM cache scope, opening it, listing every entry,
 * fetching each entry's response body, and recording the byte length.
 *
 * Returns one `CacheScopeReport` per scope, including scopes that
 * are absent from CacheStorage (`present: false`, empty entries) so
 * the UI can render a complete table.
 *
 * Returns `null` only when CacheStorage is unavailable entirely — SSR,
 * private-mode Safari, sandboxed iframes. UI should treat null as
 * "no on-device cache surface" rather than "empty cache".
 */
export async function getCacheInventory(): Promise<CacheScopeReport[] | null> {
  if (typeof caches === "undefined") {
    return null;
  }

  const reports: CacheScopeReport[] = [];
  for (const scope of WEBLLM_CACHE_SCOPES) {
    let present = false;
    try {
      present = await caches.has(scope);
    } catch {
      // CacheStorage.has can reject in some private contexts.
      present = false;
    }

    if (!present) {
      reports.push({ scope, present: false, entries: [], totalBytes: 0 });
      continue;
    }

    const entries: CacheEntry[] = [];
    let totalBytes = 0;
    try {
      const cache = await caches.open(scope);
      const requests = await cache.keys();
      for (const req of requests) {
        const res = await cache.match(req);
        if (!res) {
          entries.push({ url: req.url, byteLength: 0 });
          continue;
        }
        // We only need the byte length, not the body itself, but the
        // Cache API doesn't expose a length-only path. arrayBuffer()
        // is the cheapest portable read; for the ~800MB weight scope
        // this walks the full payload — acceptable for an on-demand
        // user action on the settings page (not an automatic probe).
        const buf = await res.arrayBuffer();
        entries.push({ url: req.url, byteLength: buf.byteLength });
        totalBytes += buf.byteLength;
      }
    } catch {
      // Leave this scope partially populated; surface what we got.
    }

    entries.sort((a, b) =>
      a.url < b.url ? -1 : a.url > b.url ? 1 : 0,
    );
    reports.push({ scope, present: true, entries, totalBytes });
  }

  return reports;
}

/**
 * Remove a single cache scope. Returns true if the scope existed and
 * was deleted, false otherwise (including when CacheStorage is
 * unavailable).
 */
export async function clearCacheScope(scope: string): Promise<boolean> {
  if (typeof caches === "undefined") return false;
  try {
    return await caches.delete(scope);
  } catch {
    return false;
  }
}

/**
 * Remove every WebLLM-managed cache scope. Returns the list of scopes
 * that were actually deleted (i.e. existed before the call).
 */
export async function clearAllWebLLMCaches(): Promise<string[]> {
  if (typeof caches === "undefined") return [];
  const cleared: string[] = [];
  for (const scope of WEBLLM_CACHE_SCOPES) {
    const ok = await clearCacheScope(scope);
    if (ok) cleared.push(scope);
  }
  return cleared;
}

export interface StorageEstimate {
  usage: number;
  quota: number;
}

/**
 * Thin wrapper over `navigator.storage.estimate()` that normalizes
 * the result for the cache UI. Returns null when the API is
 * unavailable.
 */
export async function getStorageEstimate(): Promise<StorageEstimate | null> {
  if (
    typeof navigator === "undefined" ||
    typeof navigator.storage === "undefined" ||
    typeof navigator.storage.estimate !== "function"
  ) {
    return null;
  }
  try {
    const est = await navigator.storage.estimate();
    return {
      usage: typeof est.usage === "number" ? est.usage : 0,
      quota: typeof est.quota === "number" ? est.quota : 0,
    };
  } catch {
    return null;
  }
}

/**
 * Format a byte count as a short human-readable string. Used by the
 * cache UI; lives here so the page and the manager component agree on
 * presentation.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : n >= 10 ? 1 : 2)} ${units[i]}`;
}
