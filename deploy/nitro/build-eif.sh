#!/usr/bin/env bash
# build-eif.sh — package the thumper-gpu-provider Docker image into a
# Nitro Enclave Image File (EIF) and record its PCR0..2 measurements.
#
# Requirements (host):
#   - docker
#   - aws-nitro-cli (`sudo dnf install aws-nitro-enclaves-cli` on AL2023)
#   - jq
#   - git
#   - sha256sum (coreutils)
#
# Output:
#   - ./build/ghola-provider.eif
#   - deploy/nitro/measurements/<git-sha>.json
#   - prints the measurement digest = sha256(pcr0 || pcr1 || pcr2) to stdout
#
# The measurement digest is the input to deploy/nitro/sign-allowlist.sh.
set -euo pipefail

# Resolve the repo root regardless of where the script is invoked from.
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "${SCRIPT_DIR}/../.." && pwd )"
MEASUREMENTS_DIR="${SCRIPT_DIR}/measurements"
BUILD_DIR="${REPO_ROOT}/build"
DOCKERFILE="${SCRIPT_DIR}/Dockerfile.nitro"

IMAGE_TAG="${IMAGE_TAG:-ghola-provider:latest}"
EIF_PATH="${EIF_PATH:-${BUILD_DIR}/ghola-provider.eif}"

mkdir -p "${MEASUREMENTS_DIR}" "${BUILD_DIR}"

# Capture the git SHA. If we're not in a clean checkout (dev iteration),
# suffix `-dirty` so the measurement file is never confused with a
# release build.
GIT_SHA="$(git -C "${REPO_ROOT}" rev-parse HEAD)"
if ! git -C "${REPO_ROOT}" diff --quiet HEAD --; then
    GIT_SHA="${GIT_SHA}-dirty"
fi
echo "==> git SHA: ${GIT_SHA}"

# ---- 1. Docker image build ----
echo "==> docker build (this can take 5-10 min the first time)"
docker build \
    -f "${DOCKERFILE}" \
    -t "${IMAGE_TAG}" \
    "${REPO_ROOT}"

# ---- 2. nitro-cli build-enclave ----
# Captures stdout + stderr so we can parse PCR values regardless of
# which stream nitro-cli prints them to.
echo "==> nitro-cli build-enclave"
BUILD_LOG="$(mktemp)"
trap 'rm -f "${BUILD_LOG}"' EXIT

nitro-cli build-enclave \
    --docker-uri "${IMAGE_TAG}" \
    --output-file "${EIF_PATH}" \
    2>&1 | tee "${BUILD_LOG}"

# nitro-cli prints a JSON blob with Measurements{PCR0,PCR1,PCR2}.
# Robustly extract it: find the first line that looks like JSON and
# pipe through jq.
MEASUREMENTS_JSON="$(awk '/^{/,/^}/' "${BUILD_LOG}" | jq -c '.Measurements // empty')"

if [[ -z "${MEASUREMENTS_JSON}" || "${MEASUREMENTS_JSON}" == "null" ]]; then
    echo "ERROR: failed to parse Measurements from nitro-cli output" >&2
    echo "Raw log saved to ${BUILD_LOG}" >&2
    exit 1
fi

PCR0="$(echo "${MEASUREMENTS_JSON}" | jq -r '.PCR0')"
PCR1="$(echo "${MEASUREMENTS_JSON}" | jq -r '.PCR1')"
PCR2="$(echo "${MEASUREMENTS_JSON}" | jq -r '.PCR2')"

for name in PCR0 PCR1 PCR2; do
    val="$(eval echo "\$${name}")"
    if [[ -z "${val}" || "${val}" == "null" ]]; then
        echo "ERROR: ${name} is empty" >&2
        exit 1
    fi
done

echo "==> PCR0: ${PCR0}"
echo "==> PCR1: ${PCR1}"
echo "==> PCR2: ${PCR2}"

# ---- 3. Compute measurement digest ----
# Measurement digest = sha256(pcr0_bytes || pcr1_bytes || pcr2_bytes).
# nitro-cli prints PCRs as 96-hex-char strings (48-byte SHA384), so we
# concatenate the raw bytes before hashing.
MEASUREMENT_DIGEST="$(
    printf '%s%s%s' "${PCR0}" "${PCR1}" "${PCR2}" \
        | xxd -r -p \
        | sha256sum \
        | awk '{print $1}'
)"
echo "==> measurement_digest (sha256 over pcr0||pcr1||pcr2): ${MEASUREMENT_DIGEST}"

# ---- 4. Persist measurement file ----
MEASUREMENT_FILE="${MEASUREMENTS_DIR}/${GIT_SHA}.json"
cat > "${MEASUREMENT_FILE}" <<EOF
{
  "git_sha": "${GIT_SHA}",
  "image_tag": "${IMAGE_TAG}",
  "eif_path": "${EIF_PATH}",
  "built_at_unix": $(date -u +%s),
  "pcr0": "${PCR0}",
  "pcr1": "${PCR1}",
  "pcr2": "${PCR2}",
  "measurement_digest_sha256": "${MEASUREMENT_DIGEST}"
}
EOF
echo "==> wrote ${MEASUREMENT_FILE}"

echo ""
echo "Next step:"
echo "  deploy/nitro/sign-allowlist.sh ${MEASUREMENT_DIGEST} /path/to/ghola-attest-signing.key"
echo "  → outputs base64 Ed25519 sig for ALLOWLIST_SIG_B64."
