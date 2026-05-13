#!/usr/bin/env bash
# sign-allowlist.sh — sign a Nitro measurement digest with the offline
# Ghola allowlist Ed25519 key. Wraps the `ghola-sign-allowlist` Rust
# binary (deploy/nitro/sign-allowlist/) and prints a base64 signature
# suitable for `ALLOWLIST_SIG_B64`.
#
# Usage:
#   deploy/nitro/sign-allowlist.sh <measurement-hex> <path-to-keypair>
#
# The keypair file must be either 32 raw bytes or a 64-char hex string.
# It must NEVER be checked into source control or kept on a network-
# attached host. The runbook covers offline / HSM-backed flows.
set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
SIGNER_DIR="${SCRIPT_DIR}/sign-allowlist"

if [[ $# -ne 2 ]]; then
    echo "Usage: $0 <measurement-hex> <path-to-keypair>" >&2
    exit 2
fi

MEASUREMENT_HEX="$1"
KEY_PATH="$2"

if [[ ! -f "${KEY_PATH}" ]]; then
    echo "ERROR: keypair file not found: ${KEY_PATH}" >&2
    exit 1
fi

# Build the signer binary if it isn't cached. On the recommended ops
# laptop this is a one-time ~30s compile; subsequent invocations are
# instant. We keep the target dir alongside the binary so it survives
# `git clean -fdx` at the repo root.
BIN="${SIGNER_DIR}/target/release/ghola-sign-allowlist"
if [[ ! -x "${BIN}" ]]; then
    echo "==> compiling ghola-sign-allowlist (one-time)" >&2
    (cd "${SIGNER_DIR}" && cargo build --release --quiet)
fi

# Pass through; the binary prints the base64 sig to stdout.
"${BIN}" "${MEASUREMENT_HEX}" "${KEY_PATH}"
