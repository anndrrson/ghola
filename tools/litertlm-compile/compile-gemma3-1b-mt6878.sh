#!/usr/bin/env bash
#
# compile-gemma3-1b-mt6878.sh
#
# Drives the end-to-end Gemma-3-1B-IT -> .litertlm AOT compile for the
# MediaTek MT6878 (Solana Seeker). Designed to be invoked inside the
# pinned Docker image built from the sibling Dockerfile so all tool
# versions are frozen.
#
# Inputs (env):
#   HF_TOKEN   — required. HuggingFace bearer token with read access
#                to `google/gemma-3-1b-it` AND
#                `litert-community/Gemma3-1B-IT` (both repos are
#                gated). Without this the download step 401s.
#   OUT_DIR    — optional. Defaults to /out (mount this from the
#                host: `-v $PWD/out:/out`).
#   SOC_TARGET — optional. Defaults to MT6878. Override only for
#                experimentation; ghola ships MT6878 here.
#
# Output (in $OUT_DIR):
#   Gemma3-1B-IT_q4_ekv1280_mt6878.litertlm  (~1 GB, the canonical pin)
#   gemma3-1b-it-int4.tflite                 (~584 MB, the upstream
#                                             anchor for the two-hash
#                                             integrity model)
#   sha256.txt                               (machine-readable hashes)
#
# Honest gaps — see docs/perf/aot-compile-mt6878.md §9:
#   - LiteRT #6462: AOT bytecode emitted here will be missing ~19
#     MDLA optimization flags until Google patches the public wheel.
#     The bundle will load + decode correctly but be slower than
#     Google's internal-pipeline bundles.
#   - litert-torch #984: the packager invocation (step 4) is the most
#     speculative part of the pipeline. We probe two candidate
#     binaries inside LiteRT-LM and fail loudly if neither exists, so
#     the auditor knows to update this script when #984 lands.

set -euo pipefail

# ── Args + env ──────────────────────────────────────────────────────
OUT_DIR="${OUT_DIR:-/out}"
SOC_TARGET="${SOC_TARGET:-MT6878}"
HF_REPO_SRC="litert-community/Gemma3-1B-IT"
HF_REPO_BASE="google/gemma-3-1b-it"
SRC_TFLITE="gemma3-1b-it-int4.tflite"
OUT_LITERTLM="Gemma3-1B-IT_q4_ekv1280_$(echo "${SOC_TARGET}" | tr '[:upper:]' '[:lower:]').litertlm"
INTERMEDIATE_TFLITE="gemma3-1b-it_$(echo "${SOC_TARGET}" | tr '[:upper:]' '[:lower:]').tflite"

if [[ -z "${HF_TOKEN:-}" ]]; then
    echo "ERROR: HF_TOKEN env var is required. Both"
    echo "       litert-community/Gemma3-1B-IT and google/gemma-3-1b-it"
    echo "       are gated repos."
    echo "       Get a token at https://huggingface.co/settings/tokens"
    echo "       and pass with: docker run -e HF_TOKEN=hf_... ..."
    exit 64
fi

mkdir -p "${OUT_DIR}"
WORK_DIR="$(mktemp -d -t litertlm-XXXXXX)"
trap 'rm -rf "${WORK_DIR}"' EXIT
cd "${WORK_DIR}"

echo "── Stage 1/4: download source .tflite from ${HF_REPO_SRC} ─────"
# huggingface-cli respects HF_TOKEN env var directly.
huggingface-cli download "${HF_REPO_SRC}" "${SRC_TFLITE}" \
    --local-dir ./src --local-dir-use-symlinks False

INPUT_TFLITE_PATH="./src/${SRC_TFLITE}"
if [[ ! -s "${INPUT_TFLITE_PATH}" ]]; then
    echo "ERROR: source .tflite missing or empty at ${INPUT_TFLITE_PATH}"
    exit 65
fi
INPUT_TFLITE_SHA256="$(sha256sum "${INPUT_TFLITE_PATH}" | awk '{print $1}')"
INPUT_TFLITE_SIZE="$(stat -c%s "${INPUT_TFLITE_PATH}")"
echo "    input .tflite: ${INPUT_TFLITE_PATH}"
echo "    size:          ${INPUT_TFLITE_SIZE} bytes"
echo "    SHA256:        ${INPUT_TFLITE_SHA256}"

echo "── Stage 2/4: AOT compile via ai_edge_litert.aot (target=${SOC_TARGET}) ──"
# Per docs/perf/aot-compile-mt6878.md §4 step 3. The SocModel enum
# membership for MT6878 is suggestive-but-not-confirmed; the Python
# block below fails fast with a clear message if MT6878 isn't in the
# enum so the auditor knows to wait for upstream or escalate to
# MediaTek BD.
mkdir -p ./out
python3 - <<PY
import sys
from ai_edge_litert.aot.aot_compile import aot_compile
from ai_edge_litert.aot.vendors.mediatek import target as mtk_target

soc_name = "${SOC_TARGET}"
try:
    soc_enum = getattr(mtk_target.SocModel, soc_name)
except AttributeError:
    avail = [n for n in dir(mtk_target.SocModel) if not n.startswith("_")]
    print(f"ERROR: SocModel.{soc_name} not present in installed wheel.")
    print(f"       Available: {avail}")
    print(f"       This is the docs/perf/aot-compile-mt6878.md §9 'MT6878 may not be in SocModel' gap.")
    print(f"       Action: wait for upstream wheel update or escalate to MediaTek BD for NeuroPilot Express.")
    sys.exit(66)

tgt = mtk_target.Target(soc_enum)
compiled = aot_compile(
    "${INPUT_TFLITE_PATH}",
    target=tgt,
    keep_going=True,
)
compiled.export("./out/${INTERMEDIATE_TFLITE}")
print(f"OK: intermediate written to ./out/${INTERMEDIATE_TFLITE}")
PY

if [[ ! -s "./out/${INTERMEDIATE_TFLITE}" ]]; then
    echo "ERROR: intermediate .tflite missing or empty after AOT step"
    exit 67
fi

echo "── Stage 3/4: package into .litertlm via LiteRT-LM packager ────"
# Per docs/perf/aot-compile-mt6878.md §4 step 4. The packager
# invocation is currently undocumented (litert-torch #984) — we probe
# two known candidate paths and abort with a useful message if
# neither resolves.
PACKAGER_BIN=""
for candidate in \
    "/opt/litert-lm/bazel-bin/tools/litertlm_packager" \
    "/opt/litert-lm/bazel-bin/runtime/util/litertlm_packager" ; do
    if [[ -x "${candidate}" ]]; then
        PACKAGER_BIN="${candidate}"
        break
    fi
done

if [[ -z "${PACKAGER_BIN}" ]]; then
    echo "    building litertlm_packager via bazel (this may take several minutes)…"
    (cd /opt/litert-lm && bazel build //tools:litertlm_packager 2>&1 \
        || bazel build //runtime/util:litertlm_packager 2>&1) | tail -50
    for candidate in \
        "/opt/litert-lm/bazel-bin/tools/litertlm_packager" \
        "/opt/litert-lm/bazel-bin/runtime/util/litertlm_packager" ; do
        if [[ -x "${candidate}" ]]; then
            PACKAGER_BIN="${candidate}"
            break
        fi
    done
fi

if [[ -z "${PACKAGER_BIN}" ]]; then
    echo "ERROR: litertlm_packager binary not found after bazel build."
    echo "       This is the docs/perf/aot-compile-mt6878.md §9 (litert-torch #984)"
    echo "       gap — the packager invocation is undocumented upstream."
    echo "       Action: monitor https://github.com/google-ai-edge/litert-torch/issues/984"
    echo "               and update tools/litertlm-compile/compile-gemma3-1b-mt6878.sh"
    echo "               with the correct target label + flags when it lands."
    exit 68
fi

echo "    packager: ${PACKAGER_BIN}"
# Invocation shape is TBD per upstream — these flags are the
# best-guess shape based on the .litertlm container spec in
# docs/perf/aot-compile-mt6878.md §5. Update once #984 lands.
"${PACKAGER_BIN}" \
    --input_tflite="./out/${INTERMEDIATE_TFLITE}" \
    --tokenizer_model_path="./src/tokenizer.model" \
    --output_path="./out/${OUT_LITERTLM}" \
    || {
        echo "ERROR: packager invocation failed. Flag shape is speculative"
        echo "       pending litert-torch #984. See script for context."
        exit 69
    }

if [[ ! -s "./out/${OUT_LITERTLM}" ]]; then
    echo "ERROR: output .litertlm missing or empty after packager"
    exit 70
fi

echo "── Stage 4/4: hash + ship ─────────────────────────────────────"
OUTPUT_LITERTLM_SHA256="$(sha256sum "./out/${OUT_LITERTLM}" | awk '{print $1}')"
OUTPUT_LITERTLM_SIZE="$(stat -c%s "./out/${OUT_LITERTLM}")"

cp -v "${INPUT_TFLITE_PATH}"      "${OUT_DIR}/${SRC_TFLITE}"
cp -v "./out/${OUT_LITERTLM}"     "${OUT_DIR}/${OUT_LITERTLM}"

cat >"${OUT_DIR}/sha256.txt" <<EOF
# Generated by tools/litertlm-compile/compile-gemma3-1b-mt6878.sh
# SoC target: ${SOC_TARGET}
# Toolchain: see Dockerfile pins
# Two-hash strategy: docs/security/native-models.md §2

INPUT_TFLITE_SHA256=${INPUT_TFLITE_SHA256}
INPUT_TFLITE_SIZE=${INPUT_TFLITE_SIZE}
INPUT_TFLITE_FILENAME=${SRC_TFLITE}

OUTPUT_LITERTLM_SHA256=${OUTPUT_LITERTLM_SHA256}
OUTPUT_LITERTLM_SIZE=${OUTPUT_LITERTLM_SIZE}
OUTPUT_LITERTLM_FILENAME=${OUT_LITERTLM}
EOF

echo ""
echo "── DONE ───────────────────────────────────────────────────────"
echo "    output dir:                  ${OUT_DIR}"
echo "    input .tflite SHA256:        ${INPUT_TFLITE_SHA256}"
echo "    input .tflite size:          ${INPUT_TFLITE_SIZE} bytes"
echo "    output .litertlm SHA256:     ${OUTPUT_LITERTLM_SHA256}  ← canonical pin"
echo "    output .litertlm size:       ${OUTPUT_LITERTLM_SIZE} bytes"
echo ""
echo "Next steps:"
echo "  1. Flip android/.../PinnedModelHashes.kt GEMMA_3_1B_LITERTLM_MT6878_SHA256"
echo "  2. Run scripts/register-litertlm-mt6878.mjs to anchor on-chain"
echo "  3. Upload bundle per tools/litertlm-compile/HOSTING.md"
