/**
 * Phase-A cache-read accounting for the local-mode warm-up path.
 *
 * The Apple "LLM in a flash" paper measures real per-token weight
 * read traffic to inform their bundling + sliding-window design. We
 * can't observe per-token reads from JS (WebLLM's FFN dispatch is
 * inside the MLC TVM runtime), but we CAN observe per-scope
 * CacheStorage occupancy across the whole load. That number — bytes
 * landed in `webllm/model` between fetch-start and fetch-done — is
 * the input to the Phase-B bundling target.
 *
 * Usage during a real cold load:
 *
 *   const before = await snapshotCacheBytes();
 *   await warmEngine();
 *   const after = await snapshotCacheBytes();
 *   const delta = diffCacheSnapshots(before, after);
 *   console.log(JSON.stringify({ delta }, null, 2));
 *
 * The actual per-FFN-layer activation-sparsity measurement happens
 * out-of-band via `scripts/measure-sparsity.py` (a Python sidecar
 * running the same MLC model through transformers). The browser side
 * deliberately doesn't try to instrument the WebGPU dispatch path —
 * the surface area is too unstable.
 */

import { WEBLLM_CACHE_SCOPES } from "./local-cache-inventory";

export interface CacheBytesSnapshot {
  capturedAt: number;
  perScope: Record<string, { present: boolean; entries: number; bytes: number }>;
  totalBytes: number;
}

/**
 * Walk every WebLLM cache scope and record entry counts + total bytes
 * per scope. Returns a snapshot object that can be diffed against a
 * later snapshot to attribute newly-cached bytes to the load that
 * happened in between.
 *
 * Reads each cached response's body once (Cache API doesn't expose a
 * length-only path), so this is a heavyweight call. Phase-A scripts
 * invoke it twice per measurement (before and after warm-up); UI
 * code should not call it on every render.
 *
 * Returns null when CacheStorage is unavailable (SSR, sandboxed
 * iframe, private-mode Safari).
 */
export async function snapshotCacheBytes(): Promise<CacheBytesSnapshot | null> {
  if (typeof caches === "undefined") return null;

  const perScope: CacheBytesSnapshot["perScope"] = {};
  let totalBytes = 0;

  for (const scope of WEBLLM_CACHE_SCOPES) {
    let present = false;
    try {
      present = await caches.has(scope);
    } catch {
      present = false;
    }
    if (!present) {
      perScope[scope] = { present: false, entries: 0, bytes: 0 };
      continue;
    }

    let entries = 0;
    let bytes = 0;
    try {
      const cache = await caches.open(scope);
      const reqs = await cache.keys();
      for (const r of reqs) {
        const res = await cache.match(r);
        if (!res) {
          entries += 1;
          continue;
        }
        const buf = await res.arrayBuffer();
        bytes += buf.byteLength;
        entries += 1;
      }
    } catch {
      // Partial — surface what we got.
    }
    perScope[scope] = { present: true, entries, bytes };
    totalBytes += bytes;
  }

  return { capturedAt: Date.now(), perScope, totalBytes };
}

export interface CacheBytesDelta {
  perScope: Record<
    string,
    { addedEntries: number; addedBytes: number; finalBytes: number }
  >;
  totalAddedBytes: number;
  elapsedMs: number;
}

/**
 * Compute the per-scope delta between two snapshots. Negative deltas
 * (cache eviction during the window) are clamped to zero — the
 * Phase-A goal is "how many bytes were loaded for this run," not
 * net change. Caller can derive net by subtracting raw bytes if
 * needed.
 */
export function diffCacheSnapshots(
  before: CacheBytesSnapshot,
  after: CacheBytesSnapshot,
): CacheBytesDelta {
  const perScope: CacheBytesDelta["perScope"] = {};
  let totalAddedBytes = 0;
  for (const scope of Object.keys(after.perScope)) {
    const a = after.perScope[scope];
    const b = before.perScope[scope] ?? { entries: 0, bytes: 0, present: false };
    const addedEntries = Math.max(0, a.entries - b.entries);
    const addedBytes = Math.max(0, a.bytes - b.bytes);
    perScope[scope] = { addedEntries, addedBytes, finalBytes: a.bytes };
    totalAddedBytes += addedBytes;
  }
  return {
    perScope,
    totalAddedBytes,
    elapsedMs: Math.max(0, after.capturedAt - before.capturedAt),
  };
}

/**
 * Convenience wrapper for the DevTools console use case: drop this
 * call after a cold load completes, dump the JSON, paste into
 * `docs/perf/baseline-local-llama-3.2-1b-q4f16.json`.
 *
 * For automated harnesses, prefer snapshotCacheBytes + diff so the
 * "before" point is well-defined.
 */
export async function describeCurrentCache(): Promise<CacheBytesSnapshot | null> {
  return snapshotCacheBytes();
}
