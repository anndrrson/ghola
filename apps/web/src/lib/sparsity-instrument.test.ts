import { afterEach, describe, expect, it } from "vitest";

import {
  diffCacheSnapshots,
  snapshotCacheBytes,
} from "./sparsity-instrument";

// Reuses the same CacheStorage mock shape as
// local-cache-inventory.test.ts — the two modules walk the cache
// identically and a drift between them is what these tests pin down.
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

afterEach(() => {
  // @ts-expect-error test deletes optional browser global
  delete globalThis.caches;
});

describe("snapshotCacheBytes", () => {
  it("returns null when CacheStorage is unavailable", async () => {
    const snap = await snapshotCacheBytes();
    expect(snap).toBeNull();
  });

  it("sums bytes across every WebLLM scope", async () => {
    installMockCaches({
      "webllm/config": [
        { url: "https://x/config.json", body: new Uint8Array(100) },
      ],
      "webllm/wasm": [{ url: "https://x/m.wasm", body: new Uint8Array(2000) }],
      "webllm/model": [
        { url: "https://x/p0.bin", body: new Uint8Array(50000) },
        { url: "https://x/p1.bin", body: new Uint8Array(50000) },
      ],
    });
    const snap = await snapshotCacheBytes();
    expect(snap).not.toBeNull();
    expect(snap!.totalBytes).toBe(102100);
    expect(snap!.perScope["webllm/model"].bytes).toBe(100000);
    expect(snap!.perScope["webllm/model"].entries).toBe(2);
  });

  it("records absent scopes as present:false / bytes:0", async () => {
    installMockCaches({
      "webllm/wasm": [{ url: "https://x/m.wasm", body: new Uint8Array(10) }],
    });
    const snap = await snapshotCacheBytes();
    expect(snap!.perScope["webllm/config"].present).toBe(false);
    expect(snap!.perScope["webllm/config"].bytes).toBe(0);
    expect(snap!.perScope["webllm/wasm"].present).toBe(true);
    expect(snap!.perScope["webllm/wasm"].bytes).toBe(10);
  });
});

describe("diffCacheSnapshots", () => {
  it("attributes only newly-cached bytes to the delta", async () => {
    // Before: only config is cached.
    installMockCaches({
      "webllm/config": [
        { url: "https://x/c.json", body: new Uint8Array(100) },
      ],
    });
    const before = (await snapshotCacheBytes())!;

    // After: model + wasm have arrived; config unchanged.
    installMockCaches({
      "webllm/config": [
        { url: "https://x/c.json", body: new Uint8Array(100) },
      ],
      "webllm/wasm": [{ url: "https://x/m.wasm", body: new Uint8Array(500) }],
      "webllm/model": [
        { url: "https://x/p0.bin", body: new Uint8Array(70000) },
      ],
    });
    const after = (await snapshotCacheBytes())!;

    const delta = diffCacheSnapshots(before, after);
    expect(delta.totalAddedBytes).toBe(70500);
    expect(delta.perScope["webllm/config"].addedBytes).toBe(0);
    expect(delta.perScope["webllm/wasm"].addedBytes).toBe(500);
    expect(delta.perScope["webllm/model"].addedBytes).toBe(70000);
    expect(delta.perScope["webllm/model"].finalBytes).toBe(70000);
  });

  it("clamps eviction (negative delta) to zero", async () => {
    installMockCaches({
      "webllm/model": [{ url: "https://x/p0.bin", body: new Uint8Array(100) }],
    });
    const before = (await snapshotCacheBytes())!;
    installMockCaches({}); // model evicted
    const after = (await snapshotCacheBytes())!;

    const delta = diffCacheSnapshots(before, after);
    expect(delta.perScope["webllm/model"].addedBytes).toBe(0);
    expect(delta.totalAddedBytes).toBe(0);
  });
});
