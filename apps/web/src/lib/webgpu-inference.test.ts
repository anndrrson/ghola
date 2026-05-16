import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  computeLoadedWeightFingerprint,
  getWebGPUModelIntegrity,
  DEFAULT_WEBGPU_MODEL,
  DEFAULT_WEBGPU_MODEL_WEIGHTS_HASH,
  PHI3_MINI_WEBGPU_MODEL,
  PHI3_MINI_WEBGPU_MODEL_WEIGHTS_HASH,
} from "./webgpu-inference";

// Lightweight CacheStorage mock. Vitest's `happy-dom` env doesn't ship
// the Cache API, so the test polyfills the surface needed by the
// function-under-test: caches.has, caches.open, cache.keys, cache.match.
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
          // Slice the buffer so Response gets a fresh ArrayBuffer rather
          // than a typed-array view (TS5 lib types tightened BodyInit).
          // Cast pacifies the ArrayBuffer | SharedArrayBuffer union from
          // the .buffer accessor; our typed array is always ArrayBuffer-
          // backed in this test sandbox.
          return new Response(
            hit.body.buffer.slice(0, hit.body.byteLength) as ArrayBuffer,
          );
        },
      },
    ]),
  );
  // @ts-expect-error — installing a partial CacheStorage for tests
  globalThis.caches = {
    has: async (k: string) => stores.has(k),
    open: async (k: string) => {
      const s = stores.get(k);
      if (!s) throw new Error(`no cache ${k}`);
      return s as unknown as Cache;
    },
  };
}

describe("computeLoadedWeightFingerprint", () => {
  beforeEach(() => {
    // crypto.subtle is provided by happy-dom; ensure caches is fresh.
    // @ts-expect-error - we own this in the test sandbox
    delete globalThis.caches;
  });

  afterEach(() => {
    // @ts-expect-error - cleanup
    delete globalThis.caches;
  });

  it("returns null when CacheStorage is unavailable", async () => {
    const result = await computeLoadedWeightFingerprint();
    expect(result).toBeNull();
  });

  it("returns null when none of the WebLLM cache scopes exist", async () => {
    installMockCaches({}); // no scopes installed
    const result = await computeLoadedWeightFingerprint();
    expect(result).toBeNull();
  });

  it("computes a deterministic fingerprint over cached entries", async () => {
    const body = new Uint8Array([1, 2, 3, 4, 5]);
    installMockCaches({
      "webllm/config": [
        { url: "https://example.test/config.json", body },
      ],
      "webllm/wasm": [
        { url: "https://example.test/model.wasm", body: new Uint8Array([9, 8, 7]) },
      ],
    });
    const a = await computeLoadedWeightFingerprint();
    const b = await computeLoadedWeightFingerprint();
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.fingerprint).toBe(b!.fingerprint);
    expect(a!.files).toHaveLength(2);
    // Files must be sorted by url so the manifest is canonical.
    expect(a!.files.map((f) => f.url)).toEqual([
      "https://example.test/config.json",
      "https://example.test/model.wasm",
    ]);
    // Each fingerprint must be a 64-char hex string (sha256).
    expect(a!.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("yields different fingerprints when any artifact body changes", async () => {
    installMockCaches({
      "webllm/config": [
        { url: "https://example.test/config.json", body: new Uint8Array([1, 2, 3]) },
      ],
    });
    const a = await computeLoadedWeightFingerprint();

    installMockCaches({
      "webllm/config": [
        { url: "https://example.test/config.json", body: new Uint8Array([1, 2, 4]) },
      ],
    });
    const b = await computeLoadedWeightFingerprint();

    expect(a!.fingerprint).not.toBe(b!.fingerprint);
  });
});

describe("WebGPU model integrity registry", () => {
  // Shape-of-record assertion: every pinned model must declare
  // `config`, `model_lib`, a `tokenizer.json` SRI hash, and a
  // fail-closed `onFailure` policy. Catches a partial entry that would
  // otherwise pass WebLLM at runtime but skip part of the SRI check.
  const SRI_RE = /^sha256-[A-Za-z0-9+/]+=*$/;

  function assertIntegrityShape(modelId: string): void {
    const record = getWebGPUModelIntegrity(modelId);
    expect(record).toBeDefined();
    if (!record) return;
    expect(record.config).toMatch(SRI_RE);
    expect(record.model_lib).toMatch(SRI_RE);
    expect(record.tokenizer["tokenizer.json"]).toMatch(SRI_RE);
    expect(record.onFailure).toBe("error");
  }

  it("pins SRI hashes for the default Llama model", () => {
    assertIntegrityShape(DEFAULT_WEBGPU_MODEL);
  });

  it("pins SRI hashes for the opt-in Phi-3 mini model", () => {
    assertIntegrityShape(PHI3_MINI_WEBGPU_MODEL);
  });

  it("returns undefined for unknown model ids", () => {
    expect(getWebGPUModelIntegrity("not-a-real-model")).toBeUndefined();
  });

  it("exposes 64-hex canonical weights hashes for both pinned models", () => {
    const hex = /^[0-9a-f]{64}$/;
    expect(DEFAULT_WEBGPU_MODEL_WEIGHTS_HASH).toMatch(hex);
    expect(PHI3_MINI_WEBGPU_MODEL_WEIGHTS_HASH).toMatch(hex);
    // The two models must not collide on the canonical hash — that
    // would mean either a copy-paste mistake or a real
    // weights-collision incident worth investigating.
    expect(DEFAULT_WEBGPU_MODEL_WEIGHTS_HASH).not.toBe(
      PHI3_MINI_WEBGPU_MODEL_WEIGHTS_HASH,
    );
  });
});
