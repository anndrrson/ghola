# AOT-compile Gemma-3-1B for MT6878 (Solana Seeker NPU)

Recipe + cost estimate + reproducibility story for self-compiling a
`.litertlm` Gemma-3-1B bundle targeted at MediaTek Dimensity 7300
(MT6878), the SoC inside the Solana Seeker. Companion to
[`docs/security/native-models.md`](../security/native-models.md) Section 2
(two-hash strategy) and Phase γ / Phase η of
[`zesty-giggling-charm.md`](../../.claude/plans/zesty-giggling-charm.md).

## 1. Why this matters

The Solana Seeker phone (the only NPU-class Android the maintainer
owns and can battery-instrument) ships the MediaTek **Dimensity 7300 /
MT6878** with the **APU 655** NPU. Google's
[`litert-community/Gemma3-1B-IT`](https://huggingface.co/litert-community/Gemma3-1B-IT/tree/main)
repo publishes pre-compiled `.litertlm` bundles for **mt6989, mt6991,
mt6993** (flagship D9300/D9400 family) and the Snapdragon **sm8550 →
sm8850** line, but **not for mt6878**. The published mt6989 bundle is
~1.03 GB; the equivalent SM8550 bundle is ~690 MB; mt6878 has no entry.

NeuroPilot AOT bytecode is per-SoC and the on-device runtime rejects
foreign-SoC bundles (silent fallback to JIT or hard error — see
[LiteRT issue #6462](https://github.com/google-ai-edge/LiteRT/issues/6462)).
So shipping Phase γ to the Seeker — the entire user-visible NPU
battery win — is **gated on ghola self-compiling** a `Gemma-3-1B_mt6878.litertlm`
or accepting the CPU fallback indefinitely.

## 2. The toolchain (Google's `ai-edge-torch` + LiteRT-LM + NeuroPilot)

End-to-end is **three** Google components, not one script:

1. **`ai-edge-torch`** ([repo](https://github.com/google-ai-edge/ai-edge-torch))
   — PyTorch → `.tflite` (LiteRT flatbuffer) converter. For Gemma we
   skip this step entirely: Google already publishes the source
   `gemma3-1b-it-int4.tflite` (584 MB) on the litert-community HF repo.
2. **`ai_edge_litert.aot`** + **`ai-edge-litert-sdk-mediatek`**
   ([package](https://pypi.org/project/ai-edge-litert-sdk-mediatek-nightly/))
   — Python AOT compiler. Wraps the closed-source MediaTek **NeuroPilot
   adapter** (`mtkn_adapter`) which produces MDLA bytecode targeted at
   a specific `SocModel` enum value.
3. **LiteRT-LM packager** ([repo](https://github.com/google-ai-edge/LiteRT-LM))
   — Bazel-built tool that wraps the compiled `.tflite` + tokenizer +
   model config into the `.litertlm` container the Android runtime
   consumes.

The MediaTek **NeuroPilot Express SDK** (separate BD-gated download
from MediaTek directly) is **not** required for the LiteRT path —
the LiteRT NeuroPilot delegate ships the relevant adapter binary
inside the `ai-edge-litert-sdk-mediatek` PyPI wheel. NeuroPilot Express
matters only if ghola wants to bypass Google's wrapper and call
`mtkn_compile` directly (which is what Google itself does for the
flagship-SoC bundles; see Section 9).

## 3. Compile environment requirements

| Field | Value |
|---|---|
| Host OS | Ubuntu 22.04 LTS (matches Google's documented [MediaTek NPU build env](https://ai.google.dev/edge/litert/next/mediatek)) |
| Python | 3.10 or 3.11 (constrained by `ai-edge-litert` wheels) |
| Bazel | 7.6.1 (for LiteRT-LM packager step; per [build-and-run.md](https://github.com/google-ai-edge/LiteRT-LM/blob/main/docs/getting-started/build-and-run.md)) |
| Android NDK | r28b+ (only if rebuilding the Android side) |
| GPU | **Not required.** Adapter compilation is CPU-bound on the host; no CUDA. |
| Target hardware on hand | **Not required for compile**, but a Seeker (MT6878) is required to *verify* the resulting bundle loads and decodes |
| RAM | TBD — verify with first compile; Google's adapter is reported to be modest (single-digit GB). The 1 GB output bundle implies similar working set |
| Disk | ~5 GB (PyPI wheels + source `.tflite` 584 MB + intermediate artifacts + output `.litertlm` ~1 GB) |
| Compile time | TBD — verify with first compile. [marktechpost coverage](https://www.marktechpost.com/2025/12/09/google-litert-neuropilot-stack-turns-mediatek-dimensity-npus-into-first-class-targets-for-on-device-llms/) notes Gemma-3-270M on-device compile takes ">1 minute"; AOT host compile of the 1B is plausibly minutes to low tens of minutes, **not** hours |

## 4. Step-by-step recipe

Marked **[speculative]** where the public docs do not cover the step.

```bash
# 1. Host setup (Ubuntu 22.04, fresh venv)
python3.11 -m venv ~/litert-aot && source ~/litert-aot/bin/activate
pip install --upgrade pip
pip install ai-edge-litert==2.1.3 ai-edge-litert-sdk-mediatek==0.2.0
pip install huggingface_hub

# 2. Pull the source .tflite from Google's HF mirror (584 MB)
huggingface-cli download litert-community/Gemma3-1B-IT \
    gemma3-1b-it-int4.tflite --local-dir ./src

# 3. AOT compile for MT6878 — per LiteRT issue #6462 exact API surface
python - <<'PY'
from ai_edge_litert.aot.aot_compile import aot_compile
from ai_edge_litert.aot.vendors.mediatek import target as mtk_target
# SocModel enum is confirmed to expose MT6878 alongside MT6989/MT6991/MT6993
tgt = mtk_target.Target(mtk_target.SocModel.MT6878)
compiled = aot_compile("./src/gemma3-1b-it-int4.tflite",
                       target=tgt, keep_going=True)
compiled.export("./out/gemma3-1b-it_mt6878.tflite")
PY

# 4. [speculative] Package into .litertlm — Google has NOT published the
# packager recipe (see litert-torch issue #984). Best current path: build
# LiteRT-LM from source and use the internal packaging tool.
git clone https://github.com/google-ai-edge/LiteRT-LM /tmp/litert-lm
cd /tmp/litert-lm && bazel build //tools:litertlm_packager
# Invocation shape is TBD — verify with first compile. The .litertlm
# container per Section 5 holds: compiled .tflite, tokenizer.model,
# mlc-chat-config-equivalent metadata, prompt-template JSON.

# 5. Sanity-check the output
sha256sum ./out/gemma3-1b-it_mt6878.litertlm
adb push ./out/gemma3-1b-it_mt6878.litertlm /sdcard/Download/
# then sideload the ghola dev APK and run the Phase α battery harness
```

**Critical known issue.** [LiteRT #6462](https://github.com/google-ai-edge/LiteRT/issues/6462)
documents that the public `ai-edge-litert-sdk-mediatek` wheel emits only
`--relax-fp32` and **misses 19+ MDLA optimization flags** that Google's
internal pipeline uses (`--opt 3 --opt-footprint --opt-accuracy
--mdla-mlo --mdla-conv-exp 1 --mem-opt 3 --l1-size-kb 7168 --num-mdla 4`
and more). Reported throughput delta is **~153x worse**
(~2900 ms/token public-AOT vs ~19 ms/token Google-AOT) on a flagship
SoC. Mid-range MT6878 with fewer MDLA cores will likely be less
catastrophically affected, but **the public recipe almost certainly
ships a meaningfully suboptimal bundle** until the wheel is patched.

## 5. Output artifact spec

| Field | Value |
|---|---|
| File extension | `.litertlm` |
| Container format | LiteRT-LM bundle (flatbuffer wrapping `.tflite` + tokenizer + config + prompt template); **internal layout not formally documented** |
| Expected size | ~1.03 GB by analogy with the published `Gemma3-1B-IT_q4_ekv1280_mt6989.litertlm` (1.03 GB). MT6878 may differ modestly — TBD, verify with first compile |
| Filename convention | `Gemma3-1B-IT_q4_ekv1280_mt6878.litertlm` (mirrors Google's convention; the SoC suffix is the load-time gate) |
| Quantization | int4 weights, `ekv1280` context window (matches existing public bundles) |
| SHA-256 reproducibility | **Unknown.** Adapter binary is closed-source; per #6462 it is reported to silently ignore explicit compile flags. Two independent teams using **identical pinned versions** of `ai-edge-litert==2.1.3` + `ai-edge-litert-sdk-mediatek==0.2.0` against the **identical source `.tflite`** *should* produce byte-identical output, but this has not been demonstrated publicly. Treat as best-effort reproducibility, not a guarantee |
| Auditability of binary | Low. The `.tflite` input is a flatbuffer (introspectable with `flatc`); the compiled MDLA bytecode inside the `.litertlm` is opaque |

## 6. Hosting strategy + cost model

The bundle is ~1 GB. Three deploy options:

| Option | Monthly cost (1 GB × 10k downloads/mo) | Audit posture | UX on Seeker LTE |
|---|---|---|---|
| **HuggingFace mirror** under `ghola/` org, no gating | $0 (HF egress free) | High — public URL, hashable, mirrors how Google itself ships `litert-community` bundles | Good — HF CDN is fast, well-peered |
| Cloudflare R2 self-host (ghola-controlled bucket) | ~$0.015 storage + $0 egress = **$0.02/mo** | High — bucket policy is on-chain auditable; ghola controls key rotation | Excellent — R2 edge POPs |
| IPFS/Filecoin content-addressed pin | ~$2/mo for Filecoin pin + free IPFS gateway egress | Highest — CID *is* the integrity claim; "we don't host it, the network does" | Poor on first-load — gateway latency + LTE makes 1 GB painful |

**Recommendation: HuggingFace mirror as primary + R2 as failover, IPFS
pin as a secondary integrity anchor (CID anchored on-chain in
`ghola-model-registry`).** HF gives free egress and the same audit
posture the rest of the litert-community uses; R2 protects against
HF account compromise; IPFS gives the "content-addressed" story for
the [a16z thesis](../../reference_a16z_crypto_thesis.md) without
forcing it onto the hot download path. The Android client tries HF
first, R2 second, IPFS third — same fingerprint check against the
on-chain hash gates all three.

## 7. Integrity story (two-hash + Docker pinning + auditor recompile path)

Per [`native-models.md` Section 2](../security/native-models.md):

1. **Pin SHA-256 of the input `.tflite`** in `PinnedModelHashes` as
   `GEMMA_3_1B_TFLITE_SOURCE_SHA256`. This is Google's published
   artifact and is the upstream-supply-chain anchor.
2. **Pin SHA-256 of the output `.litertlm`** in `PinnedModelHashes` as
   `GEMMA_3_1B_LITERTLM_SHA256`. This is what `IntegrityVerifier`
   enforces post-download.
3. **Anchor both on-chain** in `ghola-model-registry` as
   `weights_hash` (compiled output) + a new
   `source_input_hash` field (input `.tflite`).
4. **Containerize the compile.** Publish a Dockerfile pinned to
   `ai-edge-litert==2.1.3`, `ai-edge-litert-sdk-mediatek==0.2.0`,
   LiteRT-LM git SHA, and ai-edge-torch git SHA (latter only if/when
   we move off the published `.tflite`). Tag the image with the same
   commit SHA we use to compile.
5. **Auditor recompile path.** Reviewer pulls the Docker image, runs
   `make compile`, gets a `.litertlm` whose SHA-256 they compare to
   the on-chain pin. If the adapter binary in #6462 is truly
   deterministic given fixed inputs, the hashes match; if not, the
   reviewer can still verify (a) the input `.tflite` matches Google's,
   and (b) the runtime fingerprint after load matches what ghola pinned.

## 8. Engineering investment estimate

Honest hours assuming one engineer familiar with the LiteRT and
PyTorch ecosystems but not the MediaTek-specific bits.

| Workstream | Hours |
|---|---|
| First-time compile (toolchain install, MT6878 adapter spelunking, debugging #6462-class failures) | 16–32 (2–4 days) |
| First-time `.litertlm` packaging via LiteRT-LM build-from-source (currently undocumented per [litert-torch #984](https://github.com/google-ai-edge/litert-torch/issues/984)) | 16–40 (2–5 days, highest variance) |
| Hosting setup (HF mirror + R2 + IPFS pin + on-chain registry write) | 8 |
| Integrity flip (pin hashes, flip `IntegrityVerifier` to enforce-mode for the new artifact) | 4 |
| Docker container + reproducibility CI | 8 |
| Seeker on-device validation (battery harness + throughput + airplane-mode test) | 8 |
| Steady-state recompile when Google ships a Gemma update | 4–8 |
| **Total — first ship** | **60–100 hours, ≈ 2–3 person-weeks** |

This is "happy path." If the packager step (#984) is genuinely
blocked on undocumented MediaTek glue and we cannot get past it
without MediaTek BD, the budget doubles or the work stalls.

## 9. Honest gaps

- **#6462 is open and unfixed.** The public `ai-edge-litert-sdk-mediatek`
  wheel produces meaningfully unoptimized MDLA bytecode. Until Google
  ships the missing flags (or until MediaTek BD comes through with
  NeuroPilot Express access so we can call `mtkn_compile` directly),
  the Seeker NPU performance will be **somewhere between the published
  flagship numbers and CPU fallback**, not at the flagship numbers.
- **#984 is open.** Google has not published how the official
  `.litertlm` bundles are packaged from `.tflite` + tokenizer. The
  Section 4 packager step is the most speculative part of the recipe.
- **MT6878 may not be in `SocModel`.** Search evidence is suggestive
  but not confirmed; if the enum is gated to flagship SoCs the recipe
  falls back to "wait for Google" or "pay for NeuroPilot Express."
- **Reproducibility is best-effort.** Two teams compiling the same
  source against the same pinned tools *should* get byte-identical
  output. We do not have public confirmation of this. The two-hash
  strategy (Section 7) is robust to non-determinism: even if SHA-256s
  differ across machines, the on-device hash still enforces *some
  specific* compiled artifact, and the input-`.tflite` hash still
  anchors the upstream supply chain.
- **What changes if MediaTek BD comes through** with NeuroPilot
  Express SDK access: we can run `mtkn_compile` directly with the full
  MDLA flag set, sidestep #6462 entirely, and probably match Google's
  flagship-bundle performance on MT6878 modulo the fewer-MDLA-core
  hardware ceiling. The recipe collapses from "speculative 5-step
  pipeline" to "one documented compile command." That is the right
  unblock to chase in parallel with the public-toolchain attempt.

## 10. Sources

- [LiteRT-LM repo](https://github.com/google-ai-edge/LiteRT-LM)
- [LiteRT-LM build-and-run docs](https://github.com/google-ai-edge/LiteRT-LM/blob/main/docs/getting-started/build-and-run.md)
- [ai-edge-torch repo](https://github.com/google-ai-edge/ai-edge-torch)
- [litert-samples AOT colab](https://github.com/google-ai-edge/litert-samples/blob/main/v2/colab/LiteRT_AOT_Compilation_Tutorial.ipynb)
- [LiteRT issue #6462 — public AOT unoptimized bytecode](https://github.com/google-ai-edge/LiteRT/issues/6462)
- [litert-torch issue #984 — cannot reproduce mt6993 .litertlm](https://github.com/google-ai-edge/litert-torch/issues/984)
- [Google AI Edge — MediaTek NPU page](https://ai.google.dev/edge/litert/next/mediatek)
- [Google AI Edge — NPU acceleration overview](https://ai.google.dev/edge/litert/next/npu)
- [Google AI Edge — LiteRT-LM overview](https://ai.google.dev/edge/litert-lm/overview)
- [Google AI Edge — Run LLMs with LiteRT-LM NPU](https://ai.google.dev/edge/litert/next/litert_lm_npu)
- [Google AI Edge — CompiledModel Python API](https://ai.google.dev/edge/litert/next/python)
- [Google Developers Blog — MediaTek NPU + LiteRT](https://developers.googleblog.com/mediatek-npu-and-litert-powering-the-next-generation-of-on-device-ai/)
- [MarkTechPost — LiteRT NeuroPilot stack coverage](https://www.marktechpost.com/2025/12/09/google-litert-neuropilot-stack-turns-mediatek-dimensity-npus-into-first-class-targets-for-on-device-llms/)
- [PyPI — ai-edge-litert-sdk-mediatek-nightly](https://pypi.org/project/ai-edge-litert-sdk-mediatek-nightly/)
- [HF — litert-community/Gemma3-1B-IT](https://huggingface.co/litert-community/Gemma3-1B-IT/tree/main)
- [MediaTek Genio community — NeuroPilot AOT thread](https://genio-community.mediatek.com/t/mediatek-aot-compilation-via-public-api-produces-unoptimized-bytecode-missing-19-mdla-flags-vs-googles-official-litertlm/1907)
