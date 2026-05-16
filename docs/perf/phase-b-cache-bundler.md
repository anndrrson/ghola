# Phase B — Cache bundler (row-column bundling for WebLLM shards)

Status: **design only, not yet implemented**. Scaffolded in
`apps/web/src/lib/cache-bundler.ts`.

Companion to `.claude/plans/zesty-giggling-charm.md` and the product
explainer at `docs/local-mode-flash-memory.md`. This doc explains the
specific browser-side variant of Apple's *row-column bundling* and how
we resolve its collision with ghola's runtime SRI enforcement.

## The bundling concept, in browser terms

Apple's paper (arXiv 2312.11514, §3.2) observes that FFN up-projection
column *i* and down-projection row *i* always activate together when
neuron *i* fires. NAND flash has a 32 KB minimum read granularity, so
co-locating those two tensors on disk halves the number of reads.

In the browser, the analogue is **CacheStorage read amplification**.
WebLLM stores weight shards in the `webllm/model` Cache scope. Each
`cache.match()` round-trips through the service worker, hits the
backing IndexedDB-on-OPFS-on-NAND stack, allocates a `Response`,
streams an `ArrayBuffer`. None of that has a 32 KB block-size story —
but each match has a measurable fixed-cost overhead (~0.5-2 ms on
M-series Macs from Phase A traces; higher on cold mobile). With ~250
weight shard requests during a cold load, that's hundreds of
milliseconds even before any byte hits the bus.

Phase B rewrites the on-disk shard layout so that paired tensors live
in the same Cache entry: one `cache.match()` returns both, halving the
match count and roughly doubling the bytes-per-IO ratio.

## The SRI collision and proposed resolution

`apps/web/public/sw.js` enforces SHA-256 over every same-origin GET
that appears in `/.well-known/sri-manifest.json`. **This does not
cover WebLLM shards** — those come from HuggingFace / JsDelivr
(cross-origin) and the SW explicitly skips cross-origin fetches.

The integrity anchor for the model scope is instead
`computeLoadedWeightFingerprint()` in `webgpu-inference.ts`: a
deterministic SHA-256 over the sorted (url, body-sha256) tuples of the
*cached* shards, compared against an on-chain `weights_hash` in the
model registry.

If we rewrite shards in place, the fingerprint we compute post-bundle
will not equal the fingerprint the on-chain registry pins (which was
generated against the *original* HuggingFace layout). That breaks the
integrity badge.

**Resolution: a `bundled-manifest.json` companion** alongside the
on-chain weights_hash:

- The on-chain `weights_hash` continues to anchor the **bundled**
  layout (what's actually in cache after Phase B runs). Newly
  published model versions ship with a hash computed over the
  bundled output.
- A separate `bundled-manifest.json` (stored in the model registry,
  fetched once) records the **pre-bundle → post-bundle** mapping:
  for each original shard URL, the bundled shard URL and the
  byte-range slice that recovers the original tensor.
- The SRI manifest (`/.well-known/sri-manifest.json`) is untouched —
  it only covers `/_next/static/*` and is enforced by the SW. The
  bundler does not interact with it.
- For backwards compatibility: a model whose registry entry does not
  ship a `bundled_manifest_url` is loaded unbundled (today's path).
  Bundling is opt-in per model.

## Cache-rewriting flow

The bundling step runs **lazily, after the first WebLLM cold load
completes**, gated by:

1. The model registry entry advertises `bundling_supported: true` and
   a `bundled_manifest_url`.
2. `computeLoadedWeightFingerprint()` matches the registry's *original*
   `weights_hash` — i.e. we verify the unbundled cache is clean
   before we rewrite it.
3. The user has not opted out (settings flag, default on).

Then `executeBundling(plan)` reads every original shard, slices each
into the layout `bundled-manifest.json` describes, and writes the new
shards into the same `webllm/model` scope under new keys. The
**original keys are deleted last**, after the new keys are committed
and re-fingerprinted against the *bundled* hash. If anything fails
mid-flight the original keys remain authoritative; a partial-bundle
state is detectable on the next load (`verifyBundling` reports
mismatch) and we either complete or roll back.

The next cold load reads the bundled shards directly. WebLLM's
loader is patched (Phase B implementation work) to consult
`bundled-manifest.json` first, find the bundled shard + byte range
for each tensor request, and issue one `cache.match()` per **pair**
instead of one per tensor.

## Cost/benefit math

Phase A baseline (M2 Air, Llama-3.2-1B-q4f16):
- Cold-load total: ~12 s
- Cache-match phase (sum of `cache.match` calls in the
  performance.measure ranges): ~480 ms across ~250 matches → ~1.9
  ms/match amortized.
- Bundling halves matches to ~125. Saved: ~240 ms.
- Bytes per match doubles; backing-store IO is bandwidth-limited
  there, not match-count-limited, so no regression expected.
- **Target: 15-20% cold-start reduction** (240 ms saved / 12 s
  total ≈ 2%, but the savings concentrate on the path between
  engine-fetch-done and first-token, which is the user-perceived
  hang. Against that ~1.5 s phase, 240 ms is ~16%.)

This is **deliberately not Apple's 32 KB story**. Browsers don't
expose block size; the win is service-worker round-trip amortization
and a smaller manifest, not flash-block alignment.

## Decision gate: skip if no benefit

After scaffolding (this commit), the next step is to **measure** the
real `cache.match()` overhead from a production trace. If Phase A's
follow-up capture shows:

- < 100 ms total spent in cache-match across the full cold load, OR
- The cache-match phase is < 5% of cold-load total,

then **Phase B is shelved**. The engineering cost (cache rewrite,
bundled-manifest publishing, registry-side hash double-tracking,
rollback paths) is not justified by single-digit-millisecond wins,
and the engineering effort goes to Phase C (sparsity prediction)
which has a much higher latency-improvement ceiling regardless of
the cache-match number.
