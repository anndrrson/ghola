import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { verifyLocalIntegrity } from "./integrity-verification";
import {
  DEFAULT_WEBGPU_MODEL,
  DEFAULT_WEBGPU_MODEL_WEIGHTS_HASH,
} from "./webgpu-inference";

// ── Mock helpers ────────────────────────────────────────────────────
//
// The verifier reaches across three browser surfaces: navigator.gpu,
// CacheStorage, and fetch (used by Solana RPC under the hood). Each
// helper installs the bare minimum needed for one branch of the
// orchestrator and tears down cleanly in afterEach.

function installWebGPU(present: boolean): void {
  const nav = globalThis.navigator as unknown as Record<string, unknown>;
  if (present) {
    nav.gpu = { __mock: true };
  } else {
    delete nav.gpu;
  }
}

function installMockCaches(
  contents: Record<string, Array<{ url: string; body: Uint8Array }>> | null,
): void {
  if (contents === null) {
    // @ts-expect-error — uninstalling the mock for this branch
    delete globalThis.caches;
    return;
  }
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
  // @ts-expect-error — partial CacheStorage shim for tests
  globalThis.caches = {
    has: async (k: string) => stores.has(k),
    open: async (k: string) => {
      const s = stores.get(k);
      if (!s) throw new Error(`no cache ${k}`);
      return s as unknown as Cache;
    },
  };
}

// Solana RPC fetch mock. Note: in jsdom, `@solana/web3.js`'s
// `PublicKey.findProgramAddress` fails before fetch is even called
// (cross-realm Uint8Array prototype mismatch — same caveat called
// out in model-registry.test.ts). So in practice every test branch
// observes `lookupModel` returning `unreachable`, regardless of
// what fetch returns. The mock is still installed to suppress real
// network attempts; the `mode` parameter is documentation only.
function installRpcFetch(_mode: "unregistered" | "unreachable"): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(new Error("network down")),
  );
}

describe("verifyLocalIntegrity", () => {
  beforeEach(() => {
    installWebGPU(false);
    installMockCaches(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    installWebGPU(false);
    installMockCaches(null);
  });

  it("returns 'unavailable' when WebGPU is missing", async () => {
    installWebGPU(false);
    installRpcFetch("unreachable");
    const result = await verifyLocalIntegrity("any-model");
    expect(result.overall).toBe("unavailable");
    expect(result.modelId).toBe("any-model");
    const webgpuCheck = result.checks.find(
      (c) => c.label === "WebGPU available",
    );
    expect(webgpuCheck?.pass).toBe(false);
    // verifiedAt is an ISO 8601 instant.
    expect(() => new Date(result.verifiedAt).toISOString()).not.toThrow();
  });

  it("returns 'failed' when registry is unreachable, even with WebGPU present", async () => {
    installWebGPU(true);
    installMockCaches({}); // caches API exists but every scope is empty
    installRpcFetch("unreachable");
    const result = await verifyLocalIntegrity(DEFAULT_WEBGPU_MODEL);
    // The registry-reachable check is a hard fail (not a skip) when
    // the RPC throws, so the rollup is `failed`, not `partial`.
    expect(result.overall).toBe("failed");
    const registryCheck = result.checks.find(
      (c) => c.label === "On-chain registry reachable",
    );
    expect(registryCheck?.pass).toBe(false);
  });

  it("emits every check label even when the chain is unreachable", async () => {
    installWebGPU(true);
    installMockCaches({}); // no cached model
    installRpcFetch("unreachable");
    const result = await verifyLocalIntegrity(DEFAULT_WEBGPU_MODEL);
    // Registry unreachable is a failure for the rollup, even though
    // downstream rows skip cleanly.
    expect(result.overall).toBe("failed");
    const labels = result.checks.map((c) => c.label);
    expect(labels).toEqual([
      "WebGPU available",
      "Local weight fingerprint computed",
      "On-chain registry reachable",
      "On-chain hash matches local",
    ]);
    // Fingerprint check should be skipped (no cache), hash-match
    // skipped (no fingerprint), so neither contributes a hard fail.
    expect(
      result.checks.find(
        (c) => c.label === "Local weight fingerprint computed",
      )?.skipped,
    ).toBe(true);
  });

  it("captures the modelId on the result regardless of branch", async () => {
    installWebGPU(false);
    installRpcFetch("unreachable");
    const result = await verifyLocalIntegrity("Custom-Model-Id");
    expect(result.modelId).toBe("Custom-Model-Id");
    // Four checks always emitted (WebGPU, fingerprint, registry, hash).
    expect(result.checks.length).toBe(4);
  });

  it("computes a fingerprint when a cached model is present", async () => {
    installWebGPU(true);
    // Two scopes with one tiny artifact each — the verifier should
    // discover them, hash each, and roll up a fingerprint.
    installMockCaches({
      "webllm/config": [
        {
          url: "https://example.invalid/config.json",
          body: new TextEncoder().encode('{"x":1}'),
        },
      ],
      "webllm/model": [
        {
          url: "https://example.invalid/params.bin",
          body: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
        },
      ],
    });
    installRpcFetch("unreachable");
    const result = await verifyLocalIntegrity(DEFAULT_WEBGPU_MODEL);
    const fpCheck = result.checks.find(
      (c) => c.label === "Local weight fingerprint computed",
    );
    expect(fpCheck?.pass).toBe(true);
    expect(fpCheck?.skipped).toBeFalsy();
    // localFingerprint is hex 64 chars (sha256).
    expect(result.localFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("surfaces a skipped hash-match row with a non-empty detail string", async () => {
    installWebGPU(true);
    installMockCaches({}); // no cached model → fingerprint check skips
    installRpcFetch("unreachable");
    const result = await verifyLocalIntegrity(DEFAULT_WEBGPU_MODEL);
    const hashCheck = result.checks.find(
      (c) => c.label === "On-chain hash matches local",
    );
    expect(hashCheck).toBeDefined();
    expect(hashCheck?.skipped).toBe(true);
    expect(hashCheck?.detail.length).toBeGreaterThan(0);
    // localFingerprint should be absent when nothing was cached.
    expect(result.localFingerprint).toBeUndefined();
    // Canonical constant remains exported for downstream consumers.
    expect(DEFAULT_WEBGPU_MODEL_WEIGHTS_HASH.length).toBe(64);
  });
});
