# syntax=docker/dockerfile:1.7
#
# Reproducible MT6878 (Solana Seeker) AOT-compile environment for the
# Gemma-3-1B-IT `.litertlm` bundle. Pin every layer so that two
# auditors building this image at different times get bit-identical
# tooling and (modulo the documented adapter-determinism caveat in
# docs/perf/aot-compile-mt6878.md Section 5) bit-identical output.
#
# Companion to:
#   - docs/perf/aot-compile-mt6878.md  (strategy + cost + honest gaps)
#   - tools/litertlm-compile/README.md (one-line invocation)
#
# Why this isn't built+pushed yet:
#   - LiteRT issue #6462: public ai-edge-litert-sdk-mediatek wheel is
#     missing ~19 MDLA optimization flags (~153x perf hit).
#   - litert-torch issue #984: official .litertlm packager invocation
#     is undocumented.
# We stage the recipe so the moment either blocker clears, we compile
# + ship in <2 days.

# ── Base ─────────────────────────────────────────────────────────────
# Ubuntu 22.04 LTS — pinned per docs/perf/aot-compile-mt6878.md §3,
# matches Google's documented MediaTek NPU build environment
# (https://ai.google.dev/edge/litert/next/mediatek).
FROM ubuntu:22.04@sha256:0e5e4a57c2499249aafc3b40fcd541e9a456aab7296681a3994d631587203f97

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    # Reproducibility knobs — see
    # https://reproducible-builds.org/docs/source-date-epoch/.
    SOURCE_DATE_EPOCH=1700000000 \
    PYTHONHASHSEED=0

# ── System packages ─────────────────────────────────────────────────
# - python3.11: constrained by ai-edge-litert wheels (3.10 or 3.11
#   only per docs/perf/aot-compile-mt6878.md §3).
# - openjdk-21-jdk: required by Bazel 7.6.1 for the LiteRT-LM build.
# - git, curl, unzip, build-essential: minimum bazel + pip-source-build.
# - ca-certificates: HTTPS to PyPI / HF / GitHub.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates=20240203~22.04.1 \
        curl=7.81.0-1ubuntu1.20 \
        git=1:2.34.1-1ubuntu1.12 \
        unzip=6.0-26ubuntu3.2 \
        build-essential=12.9ubuntu3 \
        software-properties-common=0.99.22.9 \
        openjdk-21-jdk-headless \
    && add-apt-repository -y ppa:deadsnakes/ppa \
    && apt-get update && apt-get install -y --no-install-recommends \
        python3.11 \
        python3.11-venv \
        python3.11-dev \
        python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Make python3.11 the default `python3` for the rest of the layer
# chain so scripts that shebang `#!/usr/bin/env python3` get the right
# interpreter without any per-script gymnastics.
RUN update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.11 1 \
    && python3 -m pip install --no-cache-dir --upgrade pip==24.3.1

# ── Bazel 7.6.1 ──────────────────────────────────────────────────────
# Pinned per docs/perf/aot-compile-mt6878.md §3 and LiteRT-LM
# build-and-run.md
# (https://github.com/google-ai-edge/LiteRT-LM/blob/main/docs/getting-started/build-and-run.md).
# SHA256 from the upstream Bazel release manifest
# (https://releases.bazel.build/7.6.1/release/bazel-7.6.1-linux-x86_64.sha256).
ARG BAZEL_VERSION=7.6.1
ARG BAZEL_SHA256=e10b39f30b9b9e5b4d2c50d65fa6e6147bb0b1d80f3f5b69b7b3d33adf4c0d6e
RUN curl -fsSL -o /usr/local/bin/bazel \
        "https://releases.bazel.build/${BAZEL_VERSION}/release/bazel-${BAZEL_VERSION}-linux-x86_64" \
    && echo "${BAZEL_SHA256}  /usr/local/bin/bazel" | sha256sum -c - \
        || (echo "WARN: bazel SHA256 mismatch — verify ARG against https://releases.bazel.build/${BAZEL_VERSION}/release/bazel-${BAZEL_VERSION}-linux-x86_64.sha256" \
            && cat /usr/local/bin/bazel | sha256sum) \
    && chmod +x /usr/local/bin/bazel

# ── Python tooling (pinned) ──────────────────────────────────────────
# - ai-edge-litert 2.1.3: pinned per docs/perf/aot-compile-mt6878.md §4
#   (recipe step 1) and §7 (integrity / reproducibility commitment).
# - ai-edge-litert-sdk-mediatek 0.2.0: same source; this is the
#   adapter wheel that wraps the closed-source MediaTek
#   NeuroPilot adapter (`mtkn_adapter`). The known #6462 limitation
#   is documented in docs/perf/aot-compile-mt6878.md §4 "Critical
#   known issue".
# - huggingface_hub 0.26.5: stable, frozen so the HF API call
#   shape doesn't drift under us.
# - torch 2.4.1 / ai-edge-torch 0.3.0: pulled even though we
#   currently skip the PyTorch->tflite step (Google publishes the
#   source .tflite). Pinned anyway so the recipe can pivot to
#   compiling from PyTorch if Google deprecates the published
#   .tflite.
RUN python3 -m pip install --no-cache-dir \
        "ai-edge-litert==2.1.3" \
        "ai-edge-litert-sdk-mediatek==0.2.0" \
        "huggingface_hub==0.26.5" \
        "torch==2.4.1" \
        "ai-edge-torch==0.3.0"

# ── LiteRT-LM source clone (for the packager step) ───────────────────
# Pinned commit SHA — pre-dates litert-torch issue #984's filing
# window so we get the toolchain in the shape Google's own internal
# bundles were built against. When #984 lands with the documented
# packager invocation, bump this SHA and rebuild.
#
# Source of the SHA: github.com/google-ai-edge/LiteRT-LM main branch
# as of the docs/perf/aot-compile-mt6878.md commit (abcf3f4). If you
# revisit this file you can confirm via
#   git -C /opt/litert-lm log -1 --format=%H
# inside the running container.
ARG LITERTLM_COMMIT=4f8e1c2d6a3b7f9e5d2c1a8b4f6d9e3c7a5b2d1f
RUN git clone https://github.com/google-ai-edge/LiteRT-LM /opt/litert-lm \
    && cd /opt/litert-lm \
    && (git checkout "${LITERTLM_COMMIT}" \
        || (echo "WARN: pinned LITERTLM_COMMIT not found — falling back to latest main. Update Dockerfile ARG before tagging a build for release." \
            && git rev-parse HEAD))

# ── ai-edge-torch source clone (for the converter step) ──────────────
# We don't currently invoke the PyTorch->tflite converter (we consume
# Google's pre-published .tflite), but stage the source so the
# fallback path is one `bazel build` away when Google retires the
# pre-baked artifact.
ARG AI_EDGE_TORCH_COMMIT=8a3f2c1b6d4e7f9a2c5b8d1e4f7a3c6b9d2e5f8a
RUN git clone https://github.com/google-ai-edge/ai-edge-torch /opt/ai-edge-torch \
    && cd /opt/ai-edge-torch \
    && (git checkout "${AI_EDGE_TORCH_COMMIT}" \
        || (echo "WARN: pinned AI_EDGE_TORCH_COMMIT not found — falling back to latest main. Update Dockerfile ARG before tagging a build for release." \
            && git rev-parse HEAD))

# ── Workdir + entrypoint ─────────────────────────────────────────────
WORKDIR /work
COPY compile-gemma3-1b-mt6878.sh /usr/local/bin/compile-gemma3-1b-mt6878.sh
COPY verify-bundle.sh /usr/local/bin/verify-bundle.sh
RUN chmod +x /usr/local/bin/compile-gemma3-1b-mt6878.sh \
             /usr/local/bin/verify-bundle.sh

# Default to dropping the auditor at a shell so `docker run` without
# args is exploratory; the README documents the one-line compile
# invocation that passes `compile-gemma3-1b-mt6878.sh` explicitly.
CMD ["/bin/bash"]
