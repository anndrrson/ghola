import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  WEBLLM_CACHE_SCOPES,
  formatBytes,
  getCacheInventory,
  getStorageEstimate,
} from "./local-cache-inventory";

// Lightweight CacheStorage mock — same shape `webgpu-inference.test.ts`
// uses for `computeLoadedWeightFingerprint`. The inventory helper
// reuses the enumeration pattern, so we can stub it identically.
function installMockCaches(
  contents: Record<string, Array<{ url: string; body: Uint8Array }>>,
): void {
  const stores = new Map(
    Object.entries(contents).map(([scope, entries]) => [
      scope,
      {
        keys: async () => entries.map((e) => new Request(e.url)),
        match: async (req: Request) => {
          const hit = entries.find((e) => e.url === req.url);
          if (!hit) return undefined;
          return new Response(
            hit.body.buffer.slice(0, hit.body.byteLength) as ArrayBuffer,
          );
        },
      },
    ]),
  );
  // @ts-expect-error — partial CacheStorage stub for the test sandbox
  globalThis.caches = {
    has: async (k: string) => stores.has(k),
    open: async (k: string) => {
      const s = stores.get(k);
      if (!s) throw new Error(`no cache ${k}`);
      return s as unknown as Cache;
    },
  };
}

describe("WEBLLM_CACHE_SCOPES", () => {
  it("matches the canonical scope list webgpu-inference.ts uses", () => {
    // If WebLLM ever renames its scopes, this assertion + the
    // mirroring constant in webgpu-inference.ts must update in
    // lockstep. Pinning the list here surfaces drift loudly.
    expect(WEBLLM_CACHE_SCOPES).toEqual([
      "webllm/config",
      "webllm/wasm",
      "webllm/model",
    ]);
  });
});

describe("formatBytes", () => {
  it("formats zero", () => {
    expect(formatBytes(0)).toMatch(/0\s?(B|bytes)/i);
  });

  it("formats kilobytes", () => {
    expect(formatBytes(1500)).toMatch(/KB|KiB/i);
  });

  it("formats megabytes", () => {
    expect(formatBytes(2 * 1024 * 1024)).toMatch(/MB|MiB/i);
  });

  it("formats gigabytes", () => {
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toMatch(/GB|GiB/i);
  });
});

describe("getCacheInventory", () => {
  beforeEach(() => {
    // @ts-expect-error test deletes optional browser global
    delete globalThis.caches;
  });
  afterEach(() => {
    // @ts-expect-error test deletes optional browser global
    delete globalThis.caches;
    vi.restoreAllMocks();
  });

  it("returns null or empty when CacheStorage is unavailable", async () => {
    const result = await getCacheInventory();
    // Implementation may return null or [] depending on style;
    // both are acceptable as "nothing cached."
    expect(
      result === null || (Array.isArray(result) && result.length === 0),
    ).toBe(true);
  });

  it("enumerates every entry in every WebLLM cache scope", async () => {
    installMockCaches({
      "webllm/config": [
        { url: "https://example.test/config.json", body: new Uint8Array(100) },
      ],
      "webllm/wasm": [
        { url: "https://example.test/model.wasm", body: new Uint8Array(2000) },
      ],
      "webllm/model": [
        { url: "https://example.test/shard-0.bin", body: new Uint8Array(50000) },
        { url: "https://example.test/shard-1.bin", body: new Uint8Array(50000) },
      ],
    });

    const result = await getCacheInventory();
    expect(Array.isArray(result)).toBe(true);
    expect(result?.length).toBe(3);
    const totalEntries = result?.reduce((s, scope) => s + scope.entries.length, 0);
    expect(totalEntries).toBe(4);
    const totalBytes = result?.reduce((s, scope) => s + scope.totalBytes, 0);
    expect(totalBytes).toBe(102100);
  });

  it("skips scopes that don't exist in the cache", async () => {
    // Only webllm/wasm present; the other two scopes should be
    // omitted or reported empty without throwing.
    installMockCaches({
      "webllm/wasm": [
        { url: "https://example.test/m.wasm", body: new Uint8Array(10) },
      ],
    });
    const result = await getCacheInventory();
    expect(Array.isArray(result)).toBe(true);
    // Either we get the one populated scope, or all three with two
    // marked empty. Both are acceptable interpretations.
    const wasm = result?.find((s) => s.scope === "webllm/wasm");
    expect(wasm).toBeTruthy();
    expect(wasm?.entries.length).toBe(1);
  });
});

describe("getStorageEstimate", () => {
  afterEach(() => {
    // @ts-expect-error test deletes optional browser global
    delete globalThis.navigator;
  });

  it("returns null when navigator.storage.estimate is unavailable", async () => {
    // @ts-expect-error — partial navigator stub
    globalThis.navigator = {};
    const result = await getStorageEstimate();
    expect(result).toBeNull();
  });

  it("returns the estimate when storage API is present", async () => {
    // Partial Navigator stub — the function under test only uses
    // navigator.storage.estimate, so casting through `unknown` is
    // safer than @ts-expect-error (which fired on a line that no
    // longer errors in newer TS lib defs).
    globalThis.navigator = {
      storage: {
        estimate: async () => ({ usage: 1234, quota: 999999 }),
      },
    } as unknown as Navigator;
    const result = await getStorageEstimate();
    expect(result).toEqual({ usage: 1234, quota: 999999 });
  });
});
