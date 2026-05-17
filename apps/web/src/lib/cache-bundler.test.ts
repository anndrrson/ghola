import { describe, expect, it } from "vitest";

import {
  type BundlePlan,
  type BundledManifest,
  type BundledManifestEntry,
  type BundlingResult,
  executeBundling,
  planBundling,
  verifyBundling,
} from "./cache-bundler";

/**
 * Phase B skeleton tests.
 *
 * The implementation is intentionally stubbed (see
 * `docs/perf/phase-b-cache-bundler.md`). These tests serve two roles:
 *
 *   1. Pin the public type shapes so a future implementer cannot
 *      silently regress the contract reviewed in the design doc.
 *   2. Pin the "not yet implemented" error string so anyone wiring
 *      the bundler into the cold-load path gets a loud, specific
 *      failure rather than a silent no-op if they ship the call
 *      before the implementation lands.
 *
 * When Phase B actually lands, these tests are expected to be
 * REPLACED (not deleted-and-recreated) by behavioural coverage that
 * exercises the cache rewriting itself.
 */

const NOT_IMPLEMENTED_MESSAGE =
  "phase-b: not yet implemented — see docs/perf/phase-b-cache-bundler.md";

describe("cache-bundler: type shapes (compile-time + structural)", () => {
  it("BundledManifestEntry has the documented field set", () => {
    // Constructing a literal exercises the structural type at
    // runtime; if a future edit narrows or renames a field this
    // test fails to compile.
    const entry: BundledManifestEntry = {
      originalUrl: "https://huggingface.co/.../shard-0.bin",
      bundledUrl: "https://huggingface.co/.../bundled-0.bin",
      byteOffset: 0,
      byteLength: 1024,
      pairId: "ffn.layer0.pair0",
    };
    expect(entry.byteOffset + entry.byteLength).toBe(1024);
    expect(entry.pairId).toMatch(/^ffn\./);
  });

  it("BundledManifest pins originalWeightsHash and bundledWeightsHash separately", () => {
    // The two-hash design is load-bearing: the on-chain registry
    // anchors `bundledWeightsHash`, but reconstructing the original
    // layout requires `originalWeightsHash` for cross-verification
    // against pre-bundle WebLLM caches. Both fields must be present.
    const manifest: BundledManifest = {
      version: 1,
      modelId: "Llama-3.2-1B-Instruct-q4f16_1-MLC",
      originalWeightsHash: "a".repeat(64),
      bundledWeightsHash: "b".repeat(64),
      entries: [],
    };
    expect(manifest.originalWeightsHash).not.toEqual(
      manifest.bundledWeightsHash,
    );
    expect(manifest.version).toBe(1);
  });

  it("BundlePlan reports both read and write byte estimates", () => {
    // Rewriting is roughly byte-conserving (we're not compressing),
    // so a future implementer who returns 0 for one side is
    // probably wrong — but we don't enforce equality here, only the
    // presence of both fields.
    const plan: BundlePlan = {
      scope: "webllm/model",
      originalShards: 250,
      bundledShards: 125,
      estimatedBytesRead: 800_000_000,
      estimatedBytesWritten: 800_000_000,
      manifest: {
        version: 1,
        modelId: "m",
        originalWeightsHash: "x".repeat(64),
        bundledWeightsHash: "y".repeat(64),
        entries: [],
      },
    };
    expect(plan.bundledShards).toBeLessThan(plan.originalShards);
    expect(plan.estimatedBytesRead).toBeGreaterThan(0);
    expect(plan.estimatedBytesWritten).toBeGreaterThan(0);
  });

  it("BundlingResult distinguishes partial from clean states", () => {
    // Partial-bundle detection is the failsafe described in the
    // design doc. The type must allow a `partial: true, bundled:
    // false` state for the rollback path.
    const partial: BundlingResult = {
      bundled: false,
      partial: true,
      bytesWritten: 123_456,
      manifest: null,
      error: "cache quota exceeded mid-write",
    };
    expect(partial.partial).toBe(true);
    expect(partial.bundled).toBe(false);
    expect(partial.error).toBeTruthy();
  });
});

describe("cache-bundler: stubs throw with the documented error", () => {
  it("planBundling throws not-implemented", async () => {
    await expect(planBundling("webllm/model")).rejects.toThrow(
      NOT_IMPLEMENTED_MESSAGE,
    );
  });

  it("executeBundling throws not-implemented", async () => {
    const dummyPlan: BundlePlan = {
      scope: "webllm/model",
      originalShards: 0,
      bundledShards: 0,
      estimatedBytesRead: 0,
      estimatedBytesWritten: 0,
      manifest: {
        version: 1,
        modelId: "m",
        originalWeightsHash: "0".repeat(64),
        bundledWeightsHash: "1".repeat(64),
        entries: [],
      },
    };
    await expect(executeBundling(dummyPlan)).rejects.toThrow(
      NOT_IMPLEMENTED_MESSAGE,
    );
  });

  it("verifyBundling throws not-implemented", async () => {
    await expect(verifyBundling("webllm/model")).rejects.toThrow(
      NOT_IMPLEMENTED_MESSAGE,
    );
  });

  it("error message points at the design doc by path", async () => {
    // The error text is the discoverability anchor: the design doc
    // path appears verbatim so anyone hitting the throw can grep
    // for the right file without having to read this source.
    await expect(planBundling("any")).rejects.toThrow(
      /docs\/perf\/phase-b-cache-bundler\.md/,
    );
  });
});
