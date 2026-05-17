# `litertlm-compile` — auditor-reproducible MT6878 AOT pipeline

Stages the Docker-pinned toolchain that compiles
`Gemma3-1B-IT_q4_ekv1280_mt6878.litertlm` for the MediaTek MT6878
(Solana Seeker) NPU. Companion to
[`docs/perf/aot-compile-mt6878.md`](../../docs/perf/aot-compile-mt6878.md) —
read that strategy doc first for the *why*; this README is the *how*.

## TL;DR — one-line invocation (once unblocked)

```bash
docker build -t litertlm-compile tools/litertlm-compile && \
  docker run --rm \
    -v "$PWD/out:/out" \
    -e HF_TOKEN="$HF_TOKEN" \
    litertlm-compile compile-gemma3-1b-mt6878.sh
```

Output: `out/Gemma3-1B-IT_q4_ekv1280_mt6878.litertlm`,
`out/gemma3-1b-it-int4.tflite`, `out/sha256.txt`.

## Why this is not run yet

Two upstream blockers, both documented in
[`docs/perf/aot-compile-mt6878.md` §9 "Honest gaps"](../../docs/perf/aot-compile-mt6878.md#9-honest-gaps):

1. **[LiteRT #6462](https://github.com/google-ai-edge/LiteRT/issues/6462)** —
   the public `ai-edge-litert-sdk-mediatek` wheel emits MDLA bytecode
   missing ~19 optimization flags. Compiling today produces a
   technically-correct but ~153× slower bundle than Google's internal
   pipeline. We could ship it, but the user-visible NPU battery win
   would be a fraction of what the wheel-fix unlocks, so we wait.
2. **[litert-torch #984](https://github.com/google-ai-edge/litert-torch/issues/984)** —
   the official `.litertlm` packager invocation
   (`.tflite` + tokenizer + config → bundle container) is undocumented.
   We probe two candidate `bazel-bin` paths in
   `compile-gemma3-1b-mt6878.sh` and fail loudly with a useful error
   when neither is present; the script will update to the documented
   invocation as soon as #984 lands.

**Either blocker clearing unblocks ship in 1–2 days** (compile, hash,
flip pin, register on-chain, upload). Path A is "Google ships fix";
Path B is "MediaTek BD lands NeuroPilot Express SDK" — that gives us
direct `mtkn_compile` access and sidesteps #6462 entirely.

## Prerequisites

| Requirement | Notes |
|---|---|
| Docker 24+ with BuildKit | The Dockerfile uses `# syntax=docker/dockerfile:1.7` heredocs and `--check` lint support |
| ~10 GB free disk | Image layers + intermediate artifacts + ~1 GB output bundle |
| `HF_TOKEN` env var | Required. HuggingFace bearer token with read access to BOTH `google/gemma-3-1b-it` and `litert-community/Gemma3-1B-IT` (both are gated). Get one at <https://huggingface.co/settings/tokens> |
| MT6878 device (Seeker) | **Only for verification** of the resulting bundle. Compile itself is host-CPU only |

## Pin matrix

Every layer is auditor-pinned for reproducibility. The intent: two
reviewers building this image six months apart get bit-identical
tooling and (modulo the adapter-determinism caveat below) bit-identical
output.

| Layer | Pin | Source |
|---|---|---|
| Base OS | `ubuntu:22.04@sha256:0e5e4a57c2499249aafc3b40fcd541e9a456aab7296681a3994d631587203f97` | Docker Hub digest |
| Python | 3.11 (deadsnakes PPA) | `docs/perf/aot-compile-mt6878.md` §3 |
| Bazel | `7.6.1` (SHA256 in Dockerfile `ARG`) | `LiteRT-LM/docs/getting-started/build-and-run.md` |
| `ai-edge-litert` | `2.1.3` | `docs/perf/aot-compile-mt6878.md` §4 step 1 |
| `ai-edge-litert-sdk-mediatek` | `0.2.0` | `docs/perf/aot-compile-mt6878.md` §4 step 1 |
| `ai-edge-torch` (source) | git SHA in Dockerfile `ARG AI_EDGE_TORCH_COMMIT` | github.com/google-ai-edge/ai-edge-torch |
| `LiteRT-LM` (source) | git SHA in Dockerfile `ARG LITERTLM_COMMIT` | github.com/google-ai-edge/LiteRT-LM |
| `huggingface_hub` | `0.26.5` | frozen for API stability |
| `torch` | `2.4.1` | matches `ai-edge-torch==0.3.0` constraints |

The two git-SHA pins fall back to `main` with a `WARN` if the pinned
commit isn't found (e.g. force-push, repo rename). For a release-tagged
ghola build the maintainer must verify the SHA resolves cleanly before
shipping the image hash to users.

## Reproducibility commitment

Same Dockerfile + same `HF_TOKEN`-fetched inputs → byte-identical
output, **modulo** the open question in
[`docs/perf/aot-compile-mt6878.md` §5 "SHA-256 reproducibility"](../../docs/perf/aot-compile-mt6878.md#5-output-artifact-spec):
the closed-source MediaTek adapter binary may or may not be
deterministic given fixed inputs. We assert reproducibility as
best-effort, and rely on the **two-hash strategy** as defence-in-depth:

- the input `.tflite` hash is Google's upstream-supply-chain anchor,
- the output `.litertlm` hash is what ghola pins + enforces on-device,
- both are anchored on-chain in `ghola-model-registry`.

If two reviewers get different output hashes from the same image, the
input-hash anchor still proves we started from Google's published
artifact, and the on-device fingerprint check still enforces *the
specific compiled bytes* the registry was anchored against.

## Expected output (format)

```text
out/
├── Gemma3-1B-IT_q4_ekv1280_mt6878.litertlm   # ~1 GB (TBD until first compile)
├── gemma3-1b-it-int4.tflite                  # 584 MB (Google's published artifact)
└── sha256.txt                                # machine-readable hashes

# sha256.txt content:
INPUT_TFLITE_SHA256=<64-hex>
INPUT_TFLITE_SIZE=<bytes>
INPUT_TFLITE_FILENAME=gemma3-1b-it-int4.tflite
OUTPUT_LITERTLM_SHA256=<64-hex>           # ← canonical on-chain + Kotlin pin
OUTPUT_LITERTLM_SIZE=<bytes>
OUTPUT_LITERTLM_FILENAME=Gemma3-1B-IT_q4_ekv1280_mt6878.litertlm
```

Both numbers are TBD until the first successful compile.

## Verifying a bundle (auditor path)

```bash
# Recompute from sha256.txt
./tools/litertlm-compile/verify-bundle.sh \
    out/Gemma3-1B-IT_q4_ekv1280_mt6878.litertlm \
    --from-sha256-file out/sha256.txt

# Or against a known-good hex
./tools/litertlm-compile/verify-bundle.sh \
    out/Gemma3-1B-IT_q4_ekv1280_mt6878.litertlm \
    deadbeef...   # whatever ghola publishes on-chain
```

`verify-bundle.sh` shells out to `sha256sum` (Linux) or `shasum -a 256`
(macOS) and exits 0 PASS / 1 FAIL. It deliberately has zero
dependencies beyond the shell — an auditor doesn't need the Docker
image to verify a downloaded bundle.

## What ships when the blockers clear

The two-PR ship list:

1. **This repo** (`ghola`):
   - Flip `GEMMA_3_1B_LITERTLM_MT6878_SHA256` in
     `android/app/src/main/java/xyz/ghola/app/ai/PinnedModelHashes.kt`
     from `null` to the hex emitted by `sha256.txt`.
   - Run `node scripts/register-litertlm-mt6878.mjs` to anchor on-chain.
   - Update `LiteRtVariant.Mt6878` (if it doesn't already exist) so
     `LiteRtModelManager` resolves to the new bundle on Seeker.
2. **Hosting** (per [`HOSTING.md`](./HOSTING.md)):
   - Push the bundle to `huggingface.co/ghola/Gemma3-1B-IT-mt6878`.
   - Mirror to R2 + IPFS pin.
   - Wire the Android client variant URL to the HF mirror.

## See also

- [`docs/perf/aot-compile-mt6878.md`](../../docs/perf/aot-compile-mt6878.md) — strategy + cost
- [`docs/security/native-models.md`](../../docs/security/native-models.md) — two-hash integrity
- [`HOSTING.md`](./HOSTING.md) — HF / R2 / IPFS deploy plan
- [`scripts/register-litertlm-mt6878.mjs`](../../scripts/register-litertlm-mt6878.mjs) — on-chain anchor
