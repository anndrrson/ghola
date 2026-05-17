# Local Mode and the Apple Flash-Memory Loading Scheme

This is the product-level explainer for `.claude/plans/zesty-giggling-charm.md`.
The plan is engineering-focused; this doc is for a reviewer (a16z DD,
new engineer onboarding, a writeup) who needs to understand *why* we're
applying Apple's "LLM in a Flash" techniques to ghola's browser stack.

## The problem this is solving

Local mode at [ghola.xyz/chat](https://ghola.xyz/chat) runs
Llama-3.2-1B in the browser via WebLLM. It works. It's also slow on
cold load — 10-30 seconds before the first token streams on an
M-series Mac, longer on lesser hardware. The product narrative
("the most private AI") is only credible if Local mode is *also* fast.
Today it isn't.

The 800 MB-ish model bundle has to land in cache, decompile into WebGPU
shaders, and warm a VRAM buffer pool before inference can start. We
don't currently do any of this lazily.

## Why Apple's paper matters here

Apple's 2024 paper *"LLM in a flash"* (arXiv 2312.11514) ships a
hardware-aware loading scheme for running large language models on
device-class hardware where flash >> DRAM. Three techniques:

1. **Selective persistence + windowing.** Keep dense bits in DRAM,
   stream sparse bits from flash. They show >90% of FFN neurons are
   inactive per token in ReLU-family models, so most of the model
   never needs to land in RAM.
2. **Row-column bundling.** Co-locate weights that activate together
   in the storage layout so one read pulls both.
3. **Pre-allocated DRAM management.** Avoid reallocations; use
   swap-with-last for O(1) eviction.

Results: 4× speedup on CPU, 20× on GPU, run models 2× the available
DRAM.

## Why the browser is a strong fit (and where it differs)

| Apple's setting | Ghola's setting |
|---|---|
| NAND flash | Browser OPFS / IndexedDB / Cache API |
| DRAM | JS heap + WebGPU VRAM buffer pool |
| Per-token weight load via mmap | Service-worker `cache.match()` hits |
| ReLU/FATReLU sparsity (~90%) | SwiGLU sparsity (likely 40-60%) |

The biggest unknown — and the reason Phase A measures before
committing to engineering — is **how sparse SwiGLU actually is** for
the model we ship. ReLU-family numbers do not carry over. Apple's
paper itself notes Llama-2 needed FATReLU finetuning to hit the 90%+
range.

## Plan in product terms

Five phases, in commit order:

- **Phase A — Measure (this commit).** Land the instrumentation. Browser
  marks for engine-fetch-start → engine-fetch-done → compile-done →
  first-token. Cache-byte deltas per scope. A Python sidecar
  (`scripts/measure-sparsity.py`) that gives the real SwiGLU number.
  A one-click capture surface at `/perf/cold-load`. Out of this
  comes the decision gate.
- **Phase B — Row-column bundling.** Bundle every up_proj column with
  its paired down_proj row in cache. Same model, fewer Cache API
  round-trips during load. Target: 15-25% cold-start reduction.
  Doesn't need predictor training. Requires a `bundled-manifest.json`
  companion to the SRI manifest because the rewritten shards have
  new hashes.
- **Phase C — Sparsity prediction + sliding window.** Train a
  low-rank predictor head that names the FFN neurons that will fire
  for each token. Only load those neurons; window across the last k
  tokens. Honest expectation: 30-40% latency win, not Apple's 4-20×,
  because SwiGLU isn't as sparse as ReLU. Multi-week engineering
  ask — fork or shim WebLLM's TVM-backed runtime.
- **Phase D — Pre-allocated neuron buffer.** Required to make Phase C
  efficient. Mirrors Apple's Section 3.3 data structure.
- **Phase E — Ship bigger models.** With reduced VRAM footprint,
  Local mode can run Phi-3 mini (~2.3 GB), Qwen2.5-1.5B (~1.2 GB),
  even Llama-3.2-3B (~2.5 GB) on the same devices that today only
  hold the 1B model. The 3B model is a serious chat assistant, not
  just a "see, it runs" demo.

## Honest open questions

These are stated in the plan file but worth surfacing for a reviewer:

- **SwiGLU sparsity is not ReLU sparsity.** Apple's headline numbers
  assume ReLU/FATReLU. Llama-3.2-1B uses SwiGLU. The 4-20× speedup
  almost certainly will not reproduce; 1.3-1.6× is plausible.
- **WebLLM internals are unstable.** A forked runtime is an
  upstream-rebase tax. The principled answer (custom TVM op) needs
  Apache TVM expertise.
- **OPFS != NAND.** The 32KB minimum chunk size in Apple's paper
  doesn't translate directly. Bundling still helps because each
  `cache.match()` round-trips through the service worker — fewer
  matches is faster regardless of the underlying storage profile.
- **Phase C is a quarter of work.** Phase A + B + E gets a measurable
  but smaller win in 1-2 weeks. Phase C is the larger commitment.

## What success looks like

End-to-end criteria, repeated from the plan:

1. **Cold-start TTFT down 50-70%** vs current baseline on M-series Mac.
2. **VRAM peak down 30-40%** so the same device can hold a 2× larger
   model with the same budget.
3. **Warm tokens/sec doesn't regress.** Sliding window has overhead;
   it must not dominate.
4. **SRI manifest stays reproducible** post-bundling.
5. **On-chain `weights_hash` updates** to commit to the bundled
   layout (one `close_model` + `register_model` cycle on devnet when
   Phase B lands).

## How this fits the broader a16z thesis

The "Local mode is the privacy moat" argument only works if Local
mode is competitive on UX. Today it's not — cold start is too slow,
and the 1B model is noticeably weaker than cloud Claude/GPT for
non-trivial prompts. Phases B and E together close both gaps:

- Phase B makes Local feel as fast as cloud on cold-start.
- Phase E ships a Local model that's actually a strong chat assistant
  (Phi-3 mini is competitive with GPT-3.5 on chat tasks).

If those two land, the "centralized AI solves intelligence,
decentralized AI solves trust" framing becomes operationally true
rather than aspirational. That's the bar this work is targeting.

## How to verify Phase A locally

```bash
# 1. Capture a cold load in browser
#    (open /perf/cold-load in an incognito window, click Run measurement,
#     download baseline JSON, paste into docs/perf/baseline-...json)

# 2. Run the sparsity sidecar
python -m venv .venv && source .venv/bin/activate
pip install transformers torch
python scripts/measure-sparsity.py \
    --model meta-llama/Llama-3.2-1B-Instruct \
    --output docs/perf/sparsity-llama-3.2-1b.json

# 3. Read the decision
cat docs/perf/sparsity-llama-3.2-1b.json | jq '.decision'
#   phase_c_worthwhile  → commit to the full plan
#   phase_c_marginal    → ship Phase B + E first
#   phase_c_skip        → never build Phase C, focus on B + E
```
