/**
 * Phase B — Cache bundler for WebLLM weight shards.
 *
 * **THIS IS A SKELETON.** All exported functions throw. The full
 * implementation is gated behind the Phase A measurement follow-up
 * (see `docs/perf/phase-b-cache-bundler.md` § "Decision gate") and a
 * design review of the SRI-collision resolution.
 *
 * What this module will do (eventually):
 *
 * Rewrite the `webllm/model` CacheStorage scope so that FFN
 * up_proj column *i* and down_proj row *i* live in the same Cache
 * entry, halving the number of `cache.match()` round-trips during
 * cold load. This is the browser-side analogue of Apple's
 * "row-column bundling" (LLM in a Flash, §3.2).
 *
 * Integrity contract (critical — see the design doc):
 *
 *   - The on-chain `weights_hash` in the model registry anchors the
 *     **bundled** layout. A `bundled-manifest.json` companion
 *     describes the pre→post mapping so the original tensor view can
 *     be reconstructed for downstream consumers.
 *   - The runtime SRI manifest (`/.well-known/sri-manifest.json`,
 *     enforced by `apps/web/public/sw.js`) covers `/_next/static/*`
 *     only. It is NOT touched by the bundler. WebLLM shards are
 *     cross-origin and not in the SRI scope.
 *   - `computeLoadedWeightFingerprint` in `webgpu-inference.ts` is
 *     the runtime integrity probe. After bundling, the fingerprint
 *     equals the bundled-layout hash, not the original one.
 *
 * Implementation is deliberately deferred. This file exists so that:
 *   1. Type shapes are reviewable independent of the rewrite logic.
 *   2. Future callers can import the stubs and get a loud, specific
 *      error rather than a TypeScript-only compile of unused names.
 *   3. The decision gate stays explicit: ungating Phase B means
 *      removing the `throw` lines, not adding a new module.
 */

/**
 * A bundled-manifest entry: how to reconstruct one original tensor
 * from a slice of a bundled shard.
 *
 * `originalUrl` is the HuggingFace-hosted URL the unbundled cache
 * would have stored. `bundledUrl` is the rewritten Cache key.
 * `byteOffset` and `byteLength` slice the bundled shard back to the
 * tensor's bytes; concatenating all slices for a single `bundledUrl`
 * yields the full bundled shard body.
 */
export interface BundledManifestEntry {
  readonly originalUrl: string;
  readonly bundledUrl: string;
  readonly byteOffset: number;
  readonly byteLength: number;
  /** Optional pairing tag — links up_proj/down_proj columns/rows. */
  readonly pairId?: string;
}

/**
 * Top-level shape of the `bundled-manifest.json` companion the model
 * registry publishes alongside the on-chain `weights_hash`.
 *
 * `originalWeightsHash` is the pre-bundle fingerprint
 * (`computeLoadedWeightFingerprint` over the HuggingFace layout).
 * `bundledWeightsHash` is the post-bundle fingerprint — i.e. what
 * the on-chain registry actually pins for a bundling-enabled model.
 *
 * Consumers that want to verify a bundled cache compute the
 * `bundledWeightsHash` and compare; consumers that want to reconstruct
 * an original-layout view walk `entries` and slice.
 */
export interface BundledManifest {
  readonly version: 1;
  readonly modelId: string;
  readonly originalWeightsHash: string;
  readonly bundledWeightsHash: string;
  readonly entries: ReadonlyArray<BundledManifestEntry>;
}

/**
 * A plan describing what `executeBundling` will do, returned by
 * `planBundling` so the caller can preview byte-cost and shard-count
 * deltas (and the cache-management UI can render a confirmation
 * dialog) before any cache write happens.
 *
 * `originalShards` is the count of entries the bundler will read.
 * `bundledShards` is the count it will write — should be roughly
 * half for the standard up_proj/down_proj pairing.
 * `estimatedBytesRead` and `estimatedBytesWritten` should be close to
 * equal (we're rewriting, not compressing).
 * `manifest` is the manifest that will be persisted post-execute.
 */
export interface BundlePlan {
  readonly scope: string;
  readonly originalShards: number;
  readonly bundledShards: number;
  readonly estimatedBytesRead: number;
  readonly estimatedBytesWritten: number;
  readonly manifest: BundledManifest;
}

/**
 * Outcome of an `executeBundling` run. `bundled` is true when the
 * cache was successfully rewritten and the original keys removed.
 * `partial` is true when new keys were written but the originals
 * could not be deleted (cache eviction, quota pressure) — in that
 * state the next load should `verifyBundling` and either roll
 * forward (delete originals) or roll back (delete bundled).
 * `bytesWritten` is observed, not estimated.
 */
export interface BundlingResult {
  readonly bundled: boolean;
  readonly partial: boolean;
  readonly bytesWritten: number;
  readonly manifest: BundledManifest | null;
  readonly error?: string;
}

const NOT_IMPLEMENTED =
  "phase-b: not yet implemented — see docs/perf/phase-b-cache-bundler.md";

/**
 * Inspect the named CacheStorage scope (typically `webllm/model`)
 * and produce a `BundlePlan` describing the rewrite the bundler
 * would perform. Reads only — does not mutate the cache.
 *
 * Must NOT be called before `computeLoadedWeightFingerprint` has
 * been compared against the model registry's `originalWeightsHash`;
 * bundling an unverified cache would propagate a poisoned shard
 * into the bundled layout. The caller is responsible for that
 * pre-check.
 *
 * @throws Always — Phase B is not yet implemented.
 */
export async function planBundling(scope: string): Promise<BundlePlan> {
  void scope;
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Execute the plan: read original shards, write bundled shards,
 * delete originals last. The two-phase write ensures any crash leaves
 * the cache in either the pre-bundle or post-bundle state, never an
 * inconsistent mix that a partial reader could splice into a corrupt
 * tensor view.
 *
 * On success, persists the `BundledManifest` to the registry-pinned
 * location and returns `{ bundled: true, partial: false }`.
 *
 * @throws Always — Phase B is not yet implemented.
 */
export async function executeBundling(plan: BundlePlan): Promise<BundlingResult> {
  void plan;
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Re-derive the bundled fingerprint over the cache scope and compare
 * against the persisted manifest. Used at next cold-load entry to
 * detect partial-bundle states left by a previous crash, and as the
 * verification step the cache-management UI's "verify integrity"
 * button calls into.
 *
 * Returns `{ valid: true, mismatches: [] }` only when every entry in
 * `bundled-manifest.json` is present in the cache and the recomputed
 * fingerprint equals `bundledWeightsHash`. Any deviation populates
 * `mismatches` with the offending URLs for diagnostic display.
 *
 * @throws Always — Phase B is not yet implemented.
 */
export async function verifyBundling(
  scope: string,
): Promise<{ valid: boolean; mismatches: string[] }> {
  void scope;
  throw new Error(NOT_IMPLEMENTED);
}
