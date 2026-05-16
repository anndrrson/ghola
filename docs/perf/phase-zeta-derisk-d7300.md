# Phase ζ.0 De-risk — PowerInfer / SmallThinker on Solana Seeker (Dimensity 7300)

Status: **HEDGE** — 1-week ζ.1 spike before committing to full Phase ζ.
Date: 2026-05-16
Source: web + repo review only. No D7300 hardware was used.

## 1. The question

Can `Tiiny-AI/PowerInfer` + `SmallThinker-4BA0.6B-Instruct` build and run usefully on Seeker (Dimensity 7300, Mali-G615 MC2, 8 GB RAM, UFS 3.1, Android 15)? PowerInfer-2's only validated Android target is the Snapdragon 8 Elite.

## 2. Prerequisite 1 — Android NDK r26 build path

**MET (with caveats).** `smallthinker/README.md` documents an NDK build for "Qualcomm 8 Elite" using the stock `android.toolchain.cmake`, ABI `arm64-v8a`, platform `android-34`, `-Ofast -flto`, and a `DISABLE_ARM_FEATURE_CHECK=ON` escape hatch.

Caveat: published flags use `-march=armv8.6-a`. The D7300's Cortex-A78 is **armv8.2-a** — no BF16, no i8mm, no SVE2. We must rebuild with `armv8.2-a+dotprod+fp16` and hope no hot path uses unconditional i8mm intrinsics.

`libaio` and `liburing` are vendored under `powerinfer/third_part/` and must be hand-built against the NDK sysroot first (no FetchContent). License: MIT, compatible with Ghola's llama.cpp.

## 3. Prerequisite 2 — io_uring on D7300 Android 15 kernels

**LIKELY MET, unverifiable without device.** Android 15 ships GKI `android15-6.6`; mainline 6.6 `init/Kconfig` sets `CONFIG_IO_URING=y` by default (verified at android.googlesource.com). Seeker runs Android 15.

Cannot verify from web: whether MediaTek's downstream BSP kept it enabled in the shipped defconfig, whether SELinux on Seeker permits `io_uring_setup(2)` from a non-system UID, or whether seccomp-bpf in the app sandbox blocks it. Mitigation: libaio is already vendored as a fallback.

## 4. Prerequisite 3 — Mali-G615 MC2 compute

**NOT ON CRITICAL PATH.** The Android build flags carry no `GGML_VULKAN` or `GGML_OPENCL` switch. PowerInfer-2's mobile path is CPU + storage I/O; the GPU is unused on the documented Snapdragon target. Mali-G615 MC2 nominally supports Vulkan 1.2 / OpenCL 2.0 if we later want offload, but Phase ζ.1 does not need it.

## 5. Performance scaling to D7300

PowerInfer-2 paper: **11.68 tok/s on Snapdragon 8 Gen 3** (TurboSparse-Mixtral-47B). SmallThinker README: 15.10 tok/s on Raspberry Pi 5 with the 4BA0.6B Q4_0 model.

| Axis | SD8 Gen 3 | D7300 | Ratio |
|------|-----------|-------|-------|
| Single-core Geekbench 6 | ~2,200 | ~1,018 | 0.46x |
| Multi-core Geekbench 6 | ~7,000 | ~2,920 | 0.42x |
| Storage rand-read | UFS 4.0 ~4 GB/s | UFS 3.1 ~2 GB/s | 0.5x |
| RAM | 12-24 GB | 8 GB | model fits, irrelevant |

Naive bound: `min(0.42, 0.5) = 0.42x`. Pi 5 (Cortex-A76 ≈ A78 - 10%, slower storage) achieving 15.10 tok/s is the better lower bound. **Predicted range: 5-10 tok/s D7300 Q4_0**. Conservative floor from the SD8 scaling: `0.42 × 11.68 ≈ 4.9 tok/s`. Use **4-6 tok/s** for product planning.

No PowerInfer benchmarks on MediaTek silicon exist in the repo issues, paper citations, or web search results — confirmed absent.

## 6. SmallThinker model availability

| Asset | Location | Size | License |
|-------|----------|------|---------|
| Q4_0 GGUF | huggingface.co/PowerInfer/SmallThinker-4BA0.6B-Instruct-GGUF | 2.47 GB | Apache-2.0 |
| **Q4_0 `.powerinfer.gguf`** | same repo | **2.29 GB** | Apache-2.0 |
| Q3_K_S (smallest) | same repo | 1.94 GB | Apache-2.0 |

`.powerinfer.gguf` has fused sparse FFN + sparse LM-head baked in — no separate sidecar files. HF chat-template tokenizer. The 21BA3B variant (8 GB Q4_0) will not fit Seeker RAM alongside Android; stay on 4BA0.6B.

## 7. Apple "LLM in a flash" techniques in PowerInfer source

| Apple technique | In PowerInfer? | Evidence |
|---|---|---|
| Sliding-window FFN load | Variant (LRU over experts) | `moe_sparse_pipeline/expert_cache.cpp` |
| Row-column bundling | No | Apple themselves reported this negative; no bundling files |
| Sparsity predictor | Yes (MoE router) | SmallThinker uses router pre-selection, not low-rank head |
| Pre-allocated DRAM buffer | Variant | `expert_cache.cpp` fixed pool sized by `max_n_cached_matrices`, LRU + offset table instead of Apple's exact `last_k_active` schema |

PowerInfer-2's cluster-loading scheme is dominant; Apple's layout was inspiration, not literal port.

## 8. Risks specific to D7300

1. **armv8.6 → armv8.2 rebuild fails or regresses.** Hot paths may use unconditional i8mm/BF16. Mitigation: build with `armv8.2-a+dotprod+fp16`. Abandon if > 50% perf delta vs. Pi 5.
2. **io_uring blocked by Seeker SELinux/seccomp.** Mitigation: ship with libaio fallback compiled in. Abandon if both blocked AND blocking-pread path < 2 tok/s.
3. **Thermal throttling on sustained decode.** D7300 is 4 nm midrange. Mitigation: pin to 2 of 4 big cores, accept 60-70% of cold-run throughput as the product number.

## 9. Recommendation: **HEDGE**

Prerequisites all have credible paths to "met." Build, libs, license, and a ready PowerInfer-format Q4_0 model are aligned. Two facts cannot be settled from a desk: (a) Seeker BSP exposure of io_uring to apps, (b) clean armv8.2-a rebuild.

**Plan**: 1 engineering week on ζ.1 — rebuild for armv8.2-a, push to a Seeker, run 256-token decode on the `.powerinfer.gguf` Q4_0 SmallThinker-4BA0.6B. **Gate**: ≥ 4 tok/s sustained → commit Phase ζ; 2-4 tok/s → narrow to offline/background only; < 2 tok/s or build fails → NO-GO, stay on existing llama.cpp Q4_0.

Do not commit the full 4-6 week budget before that gate.

## 10. Sources

- [Tiiny-AI/PowerInfer](https://github.com/Tiiny-AI/PowerInfer)
- [smallthinker README](https://github.com/Tiiny-AI/PowerInfer/blob/main/smallthinker/README.md)
- [smallthinker/powerinfer tree](https://github.com/Tiiny-AI/PowerInfer/tree/main/smallthinker/powerinfer)
- [PowerInfer issues](https://github.com/Tiiny-AI/PowerInfer/issues)
- [SmallThinker-4BA0.6B-Instruct-GGUF on HF](https://huggingface.co/PowerInfer/SmallThinker-4BA0.6B-Instruct-GGUF)
- [SmallThinker paper](https://huggingface.co/papers/2507.20984)
- [PowerInfer-2 paper](https://arxiv.org/html/2406.06282v2)
- [Apple "LLM in a flash"](https://arxiv.org/html/2312.11514v2)
- [Android 15 GKI 6.6 kernel](https://android.googlesource.com/kernel/common/+/refs/heads/android15-6.6)
- [Dimensity 7300 product page](https://www.mediatek.com/products/smartphones/mediatek-dimensity-7300)
- [Dimensity 7300 benchmarks](https://nanoreview.net/en/soc/mediatek-dimensity-7300)
- [Snapdragon 8 Gen 3 benchmarks](https://nanoreview.net/en/soc/qualcomm-snapdragon-8-gen-3)
- [Solana Seeker official](https://solanamobile.com/seeker)
- [Seeker review (Decrypt)](https://decrypt.co/336582/solana-seeker-review-more-measured-crypto-phone)
- [Mali-G615](https://www.arm.com/products/silicon-ip-multimedia/gpu/mali-g615)
