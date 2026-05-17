#!/usr/bin/env bash
#
# verify-bundle.sh — auditor tool.
#
# Given a .litertlm path and an expected SHA-256, recomputes the hash
# and emits PASS/FAIL + a non-zero exit on mismatch. Intentionally
# minimal — the entire point is to give a reviewer something they can
# run with one tool (sha256sum) on any Linux/macOS host without
# pulling the full Docker image.
#
# Usage:
#   verify-bundle.sh <path-to-.litertlm> <expected-sha256-hex>
#
# Or with the sha256.txt produced by compile-gemma3-1b-mt6878.sh:
#   verify-bundle.sh <path-to-.litertlm> --from-sha256-file <path-to-sha256.txt>
#
# Exit codes:
#   0   PASS
#   1   FAIL (hash mismatch)
#   64  usage error
#   65  file not readable
#   66  malformed sha256.txt

set -euo pipefail

usage() {
    echo "Usage: $0 <bundle-path> <expected-sha256-hex>"
    echo "       $0 <bundle-path> --from-sha256-file <sha256.txt>"
    exit 64
}

[[ $# -eq 2 || $# -eq 3 ]] || usage

BUNDLE_PATH="$1"
shift

if [[ ! -r "${BUNDLE_PATH}" ]]; then
    echo "ERROR: cannot read bundle at ${BUNDLE_PATH}"
    exit 65
fi

EXPECTED=""
if [[ "${1:-}" == "--from-sha256-file" ]]; then
    [[ $# -eq 2 ]] || usage
    SHA_FILE="$2"
    if [[ ! -r "${SHA_FILE}" ]]; then
        echo "ERROR: cannot read sha256 file at ${SHA_FILE}"
        exit 65
    fi
    EXPECTED="$(grep -E '^OUTPUT_LITERTLM_SHA256=' "${SHA_FILE}" \
                | head -1 | cut -d= -f2)"
    if [[ -z "${EXPECTED}" ]]; then
        echo "ERROR: ${SHA_FILE} has no OUTPUT_LITERTLM_SHA256= line"
        exit 66
    fi
else
    EXPECTED="$1"
fi

# Normalize: strip whitespace, lowercase.
EXPECTED="$(echo "${EXPECTED}" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"

if [[ ! "${EXPECTED}" =~ ^[0-9a-f]{64}$ ]]; then
    echo "ERROR: expected hash is not a 64-char hex string: ${EXPECTED}"
    exit 64
fi

# Prefer sha256sum (Linux); fall back to shasum -a 256 (macOS).
if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL="$(sha256sum "${BUNDLE_PATH}" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
    ACTUAL="$(shasum -a 256 "${BUNDLE_PATH}" | awk '{print $1}')"
else
    echo "ERROR: neither sha256sum nor shasum is installed"
    exit 65
fi

ACTUAL="$(echo "${ACTUAL}" | tr '[:upper:]' '[:lower:]')"
SIZE="$(wc -c <"${BUNDLE_PATH}" | tr -d '[:space:]')"

echo "bundle:   ${BUNDLE_PATH}"
echo "size:     ${SIZE} bytes"
echo "expected: ${EXPECTED}"
echo "actual:   ${ACTUAL}"

if [[ "${EXPECTED}" == "${ACTUAL}" ]]; then
    echo "result:   PASS"
    exit 0
else
    echo "result:   FAIL — hash mismatch"
    exit 1
fi
