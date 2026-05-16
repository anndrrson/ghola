# Phase ζ — Tiiny-AI/PowerInfer + SmallThinker on Seeker

Standalone plan for Phase ζ of
[`zesty-giggling-charm.md`](../../.claude/plans/zesty-giggling-charm.md).
Companion to [`aot-compile-mt6878.md`](aot-compile-mt6878.md) (the
alternative NPU path) and
[`seeker-validation-runbook.md`](seeker-validation-runbook.md) (the
profiler harness pattern). iOS counterpart:
[`ios-phase-zeta-mlx-plan.md`](ios-phase-zeta-mlx-plan.md) — the
MLX/Metal cross-platform story.

## 1. Context — why Phase ζ at all

Apple's "LLM in a flash" optimizations target a regime where **DRAM
is smaller than the model** — every technique in the paper exists
to let a 13 GB fp16 OPT-6.7B run on a 4–8 GB device. The Seeker is
not in that regime for the model we want to ship. SmallThinker-4BA0.6B
at Q4_0 has a ~1 GB working set per the upstream paper; Seeker has
8 GB total / ~3.5–4.5 GB foreground budget. Apple's
don't-load-what-you-don't-need trick is the wrong tool for this
problem on this hardware.

So why ship PowerInfer at all? Two honest reasons:

1. **The real product win on Seeker is a smarter on-device model.**
   SmallThinker-4BA0.6B is a 4B MoE that activates ~0.6 B params
   per token. Per the upstream paper it beats Qwen3-1.7B and
   matches Gemma3n-E4B. That is a meaningful step up from today's
   Qwen 2.5 1.5B dense default. The user-perceptible win is "chat
   is smarter," not "inference is faster."
2. **PowerInfer is the runtime that knows how to dispatch a sparse
   MoE on mobile CPU.** llama.cpp can run MoE GGUF, but PowerInfer's
   sparse-expert routing + ReGLU activation skipping are the part
   of Apple's paper that actually applies — not because flash is
   slow, but because the model is natively sparse and a
   sparsity-aware runtime is cheaper than a dense one.

The "2–4× decode improvement" cited in the master plan stub is
**not load-bearing**. PowerInfer-2's 11.68 tok/s on Snapdragon 8
Gen 3 (24 GB) and SmallThinker's 78.99 tok/s on OnePlus 13
(Snapdragon 8 Gen 4) both reflect a hardware tier the Seeker
isn't near. On D7300 (mid-range MediaTek, two Mali-G615 cores,
UFS 3.1) realistic decode is closer to the rk3588 / Pi 5 numbers
in the upstream paper — 6–10 tok/s for the 4B model — plausibly
*worse* than llama.cpp on Qwen 2.5 1.5B for raw throughput.

### Seeker path comparison

| Axis | Phase γ — LiteRT NPU | Phase ε — ExecuTorch MTK | **Phase ζ — PowerInfer + SmallThinker** | Baseline llama.cpp + Qwen 1.5B |
|---|---|---|---|---|
| Battery (Wh/token) | 7–12× lower (D9500 NPU ratio) | 2–3× lower | **Unknown; may be worse than dense per Apple Sec 5.3** | Reference |
| Decode tok/s on Seeker | 15–28 plausible | 15+ plausible | **6–10 realistic** | ~6–8 |
| Model quality | Smaller (Gemma-3-1B) | Larger (3B dense) | **4B MoE — meaningful chat win** | Reference |
| Ship complexity | Multi-SoC ladder + #6462 | Blocked on MediaTek BD | **2–4 wk if D7300 ports, 8–12 wk if not** | Shipping |

Honest read: **Phase γ delivers the battery story, Phase ε delivers
dense-quality, Phase ζ delivers MoE-quality.** Phase ζ is *not* a
battery phase on this hardware regardless of the Apple framing.

## 2. What PowerInfer + SmallThinker actually deliver

**Apple-paper techniques implemented in PowerInfer:**

1. Sparsity prediction (low-rank predictor on LM head / router)
2. Sliding-window FFN/expert load (k≈4–5 active experts cached)
3. Row-column bundling (up_proj column i co-located with down_proj
   row i in storage)
4. Pre-allocated DRAM buffer with swap-with-last O(1) eviction
5. MoE-native sparse dispatch (router top-k=4 of 32 experts is the
   sparsity oracle)

**Why MoE sidesteps FATReLU.** The master plan's open question
about no public FATReLU-Llama-3.2 / Phi-3 is real for dense SwiGLU.
SmallThinker is natively MoE with ReGLU experts: the router is the
sparsity decision (no predictor head to train), ReGLU activations
are structurally sparse, and PowerInfer's skip-on-zero is a free
win. This is the cleanest mapping of Apple's techniques onto a
shippable mobile model — it just doesn't yield a perf headline on
D7300.

**Concrete model.** SmallThinker-4BA0.6B-Instruct Q4_0:
- 4B total, 0.6B active, 32 experts, top-k=4
- ~1 GB working set
- Distributed via HF (PowerInfer team org — verify in ζ.2)
- MMLU vs Qwen 2.5 1.5B: **not published in upstream paper.** We
  must measure ourselves in ζ.5.

**Realistic perf bounds.** Scaling upstream numbers down to D7300:

| Hardware | SmallThinker 4B Q4_0 decode | Source |
|---|---|---|
| OnePlus 13 (SD 8 Gen 4) | 78.99 tok/s | Upstream paper |
| RK3588 (Cortex-A76, LPDDR4) | 39.76 tok/s | Upstream paper |
| Raspberry Pi 5 | 28.77 tok/s | Upstream paper |
| **Seeker (D7300, A78+A55, LPDDR5, UFS 3.1)** | **6–10 tok/s estimate** | Extrapolation; **measure in ζ.5** |

The OnePlus 13 number is an outlier (SD 8 Gen 4 + UFS 4.0); the
honest planning number is RK3588 ballpark discounted modestly.

## 3. Sub-phases with go/no-go gates

Each sub-phase is independently abortable. Phase ζ blocks nothing else.

### ζ.0 — De-risk research (1 week, parallel to this plan)

- Verify Tiiny-AI/PowerInfer's Android NDK r26 build path produces
  a `libpowerinfer.so` for arm64-v8a / armv8.6-a / API 34.
- Confirm io_uring + libaio usable on the Seeker's MediaTek kernel
  (not blocked by SELinux). Test via `quick_test` on a sideloaded
  debug build.
- Check Mali-G615 MC2 Vulkan compute compatibility with PowerInfer's
  optional GPU dispatch; confirm graceful CPU-only fallback.
- Search for MediaTek-tested PowerInfer/SmallThinker benchmarks
  (almost certainly none — frame project as "scaling Snapdragon
  numbers down").
- Read PowerInfer-2 Section 6 for kernel + storage assumptions.

**Gate.** If NDK r26 won't build the .so; OR io_uring is sandboxed;
OR Mali silently regresses without fallback — **STOP Phase ζ.**
Document negative result and reallocate to Phase γ multi-SoC or ε.

### ζ.1 — Runtime integration (1–2 weeks, gated on ζ.0)

- Fork Tiiny-AI/PowerInfer at a pinned commit (record SHA here +
  in CMake).
- Add to `android/app/src/main/cpp/CMakeLists.txt` via FetchContent
  mirroring llama.cpp at b4524.
- Build `libpowerinfer.so` for arm64-v8a only.
- New `android/app/src/main/cpp/powerinfer_jni.cpp` mirroring
  `llama_jni.cpp`: `loadModel / generate / cancel / release / tokenCount`.
- Kotlin wrapper
  `android/app/src/main/java/xyz/ghola/app/ai/powerinfer/PowerInfer.kt`
  mirroring `LlamaCpp` shape.

**Gate.** If .so won't compile in 1.5 weeks, OR ggml symbol
collisions with shipping llama.cpp can't be resolved cleanly
(linker rename, two .so files, or static-link) — **STOP** and
document; the same yak-shave blocks any future llama.cpp fork.

### ζ.2 — Model + tokenizer + sidecars (3–5 days, gated on ζ.1)

- Verify SmallThinker-4BA0.6B-Instruct Q4_0 GGUF is publicly
  available with the sparsity predictor + routing tables baked in.
- Extend `ModelManager` (or sibling `PowerInferModelManager`) for
  the download using the existing HTTP Range-resume pattern.
- Compute canonical SHA-256, add
  `SMALLTHINKER_4BA06B_Q4_0_GGUF_SHA256` constant to
  `PinnedModelHashes.kt`. Anchor on-chain via existing
  `ghola-model-registry` plumbing.
- Document integrity recipe in `docs/security/native-models.md`.

**Gate.** If the GGUF isn't published in usable form — **STOP and
document.** Revisit quarterly.

### ζ.3 — PowerInferBackend.kt (1 week, gated on ζ.2)

- New
  `android/app/src/main/java/xyz/ghola/app/ai/powerinfer/PowerInferBackend.kt`
  implementing `LlmBackend`.
- `displayName = "On-device sparse MoE (SmallThinker 4BA0.6B)"`,
  `requiresInternet = false`.
- `generate(...)` via JNI; output parsing mirrors
  `LocalLlamaBackend.parseOutput` (tool-call regex +
  `ContentBlock.Text` / `ContentBlock.ToolUse`). SmallThinker chat
  template differs from Qwen3 — verify against HF model card.
- `cancel()` flips `AtomicBoolean` checked at the JNI loop boundary.
- `shutdown()` calls JNI `release()`.
- Pre-generation integrity check via `IntegrityVerifier.verifyFile`
  against the new pinned hash.

**Gate.** Seeker smoke test: load + "Hello, who are you?" + coherent
response in <30s. Gibberish, hang, or incoherence — **STOP**, file
upstream.

### ζ.4 — Settings + ChatActivity dispatch (3 days, gated on ζ.3)

- `BACKEND_POWERINFER` constant in `SecureStorage.kt`.
- New radio "On-device sparse MoE (SmallThinker)" in
  `SettingsActivity.kt`.
- Dispatch branch in `ChatActivity.createAgent()` mirroring
  Phase γ.3 wiring.
- Unit test the dispatch branch.

**Gate.** Unit test passes, manual radio persistence verified.

### ζ.5 — Real-device validation on Seeker (open-ended, gated on ζ.4)

Follows `seeker-validation-runbook.md`. Three-way comparison on
identical prompts: llama.cpp + Qwen 2.5 1.5B Q8, LiteRT-LM Generic
+ Gemma-3-1B, PowerInfer + SmallThinker.

Measure per backend: decode tok/sec + Wh-per-token (Phase α
`BatteryEnergyProfiler`), 200-token thermal trajectory, MMLU on a
held-out 50-prompt subset, qualitative chat quality on 20 hand-picked
prompts.

**Gate.** Decode <2 tok/s (unusable) OR Wh/token >2× regression OR
MMLU regression vs Qwen 2.5 1.5B — **deprioritize for v0.7+ and
document the negative result.** Negative results are themselves
useful artifacts for the mobile-LLM community.

## 4. Risks (honest)

- **D7300 + Mali-G615 + UFS 3.1 is unvalidated.** PowerInfer Android
  is SD 8 Elite-validated. Port has historically been 2 weeks best
  case, 2 months worst case (kernel scheduler, Mali driver bugs
  under sparse-load, libaio fallback bugs).
- **io_uring on the MediaTek kernel is unknown.** Mainline exists
  but Seeker SELinux policy may sandbox it. Fallback to blocking
  reads regresses decode to 2–3 tok/s.
- **Mali-G615 MC2 sparse-load patterns may kill SIMD utilization.**
  GPU path is Adreno-tuned; Mali 2-core is narrower in every dim.
- **PowerInfer-2's 21× headline does NOT transfer.** That's
  SM8650 + dense model + full stack working. Apples-to-oranges on
  every axis. Realistic 2–4× best case; parity-or-worse plausible.
- **MoE quality on Q4** may degrade more than dense Q4 (routing
  precision; Mixtral evals show the effect). Must measure MMLU
  specifically, not vibe-check.
- **APK size.** Second native runtime + vendored ggml: ~15–25 MB
  delta. Model is OTA, no APK impact there.
- **Maintenance tax.** Tiiny-AI/PowerInfer is a llama.cpp fork at a
  specific upstream point. Future llama.cpp improvements don't flow
  unless Tiiny-AI rebases — doubles the upstream-rebase tax we
  already pay.
- **No MMLU vs Qwen 2.5 1.5B published.** Upstream paper
  benchmarks against Qwen3, Gemma3n-E4B — not our baseline. The
  "SmallThinker is smarter" story is architectural until ζ.5
  measures it.

## 5. Engineering investment

Single engineer with mobile-LLM background:

- **Optimistic** (everything ports clean): 3–4 weeks
- **Realistic**: 4–6 weeks
- **Pessimistic** (Mali / io_uring walls): 8–12 weeks

ζ.0 lands in 1 week. Product-visible ship 4–6 weeks IF gates pass.
Any gate failure converts remaining budget to documentation +
reallocation.

## 6. What success looks like

- 4B-class MoE on Seeker, MMLU at parity-or-+3 vs Qwen 2.5 1.5B,
  qualitative win on ≥14/20 hand-picked prompts.
- Decode ≥4 tok/s (slow human typing speed; usable for chat UX).
- Wh/token within 2× of llama.cpp baseline — energy *parity*, not
  win, per Apple Sec 5.3.
- All five Apple-paper techniques visibly active in PowerInfer's
  runtime stats logged through Phase α profiler.
- `IntegrityVerifier` enforces SmallThinker GGUF pin; dApp Store
  posture + integrity badge extend cleanly.

## 7. What failure looks like + decision rule

- **ζ.0 fail** (NDK / io_uring / Mali): STOP. Ship Phase γ
  multi-SoC + Phase ε if BD lands. Write
  `docs/perf/phase-zeta-aborted-d7300.md`.
- **ζ.1 fail** (.so / symbol collisions): STOP.
- **ζ.2 fail** (model not distributed): STOP, revisit quarterly.
- **ζ.3 fail** (smoke test fails): STOP, file upstream.
- **ζ.5 fail** (perf or quality regression): roll back radio,
  keep code behind debug flag for future flagship hardware.

**Decision rule.** Phase ζ is the lowest-priority on-device LLM
phase. Any failure costing >1 engineer-week to recover is grounds
to abort.

## 8. Honest answer: "Would it work well?"

**SD 8 Gen 3/4, 16+ GB DRAM, UFS 4.0:** yes — 10+ tok/s, smarter
chat than any 1B dense, all Apple-paper techniques pulling their
weight (that tier has the memory bandwidth for sparse-load to
outpace dense).

**Seeker (D7300, 8 GB, Mali-G615 MC2, UFS 3.1):** coin flip
shading to no. Realistic 6–10 tok/s if everything ports; 2–4 if
io_uring or Mali fallbacks bite. Plausibly *worse* perceived UX
than llama.cpp on Qwen 2.5 1.5B even though the content is smarter.

**Architectural cleanness** (all five Apple techniques active, no
FATReLU continue-train needed) is real regardless of hardware
tier — credible dev-blog / reviewer-call story independent of perf.

**Product quality** (smarter chat) is real **IF perf clears 4
tok/s**. Below that, smarter answers come too slowly to feel like
a win.

## 9. Recommendation

1. **Spawn ζ.0 this week, 1 engineer-week budget.** Cheapest
   possible bet-derisking pass.
2. **Don't commit to ζ.1+ until ζ.0 returns clean.** Three of the
   four ζ.0 questions need no Kotlin or JNI.
3. **In parallel: prioritize the AOT-compile MT6878 path** per
   [`aot-compile-mt6878.md`](aot-compile-mt6878.md). Google fixing
   [LiteRT #6462](https://github.com/google-ai-edge/LiteRT/issues/6462)
   unblocks a clearer 7–12× battery win — the demo-able story
   Seeker most needs. Phase γ Generic shipping first, then MT6878
   AOT, is strictly better near-term than Phase ζ.
4. **Phase ζ is Q4 2026, not Q3.** Sequence behind: (a) Phase γ
   multi-SoC shipping, (b) Phase γ MT6878 AOT landing if Google
   ships, (c) Phase ε if BD lands. Phase ζ ships only if all three
   are shipped or definitively blocked.
5. **If ζ.0 returns "doesn't port,"** close Phase ζ; revisit on a
   future Seeker-2 with flagship MediaTek (D9400+) or Snapdragon
   hardware.

## 10. Sources

- [SmallThinker paper (arXiv 2507.20984v2)](https://arxiv.org/html/2507.20984v2)
- [Tiiny-AI/PowerInfer SmallThinker README](https://github.com/Tiiny-AI/PowerInfer/blob/main/smallthinker/README.md)
- [PowerInfer-2 paper (arXiv 2406.06282)](https://arxiv.org/abs/2406.06282)
- [Apple "LLM in a flash" (arXiv 2312.11514)](https://arxiv.org/abs/2312.11514)
- [HuggingFace — PowerInfer org](https://huggingface.co/PowerInfer)
- [Ghola master plan — `zesty-giggling-charm.md`](../../.claude/plans/zesty-giggling-charm.md)
- [Ghola Phase γ AOT recipe — `aot-compile-mt6878.md`](aot-compile-mt6878.md)
- [Ghola product framing — `local-mode-flash-memory.md`](../local-mode-flash-memory.md)
- [Ghola Seeker validation runbook](seeker-validation-runbook.md)
- [LiteRT issue #6462](https://github.com/google-ai-edge/LiteRT/issues/6462)
- [llama.cpp release b4524](https://github.com/ggerganov/llama.cpp/releases/tag/b4524)
