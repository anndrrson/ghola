#!/usr/bin/env bash
#
# verify-deploy.sh — confirm the on-chain executable matches a local .so.
#
# Stream 8 of the Phase-45 production-hardening pass.
#
# Usage:
#   scripts/verify-deploy.sh <program_id> <cluster_url> <local_so_path>
#
# Example (devnet):
#   scripts/verify-deploy.sh \
#     5bmCDeaQceBpWgK8aADB4Tz4JzqZ9hkCi3qedC6oZR8A \
#     https://api.devnet.solana.com \
#     programs/said-shielded-pool/target/deploy/said_shielded_pool.so
#
# Notes on Solana program layout:
#   The Solana BPF loader stores executable data inside a "program data"
#   account associated with the program account. `solana program dump`
#   extracts the raw executable bytes (ELF) — these should match the local
#   .so file byte-for-byte if (a) the same toolchain was used and (b) no
#   intervening upgrade has occurred. The loader does NOT prepend or
#   append loader-specific bytes to the dumped output; what you get is
#   exactly the ELF that was uploaded with `solana program deploy`.
#
#   A mismatch can indicate:
#     - the local build is on a different commit than the deployed program
#     - the toolchain (rustc/cargo-build-sbf) differs between builders
#     - the program was upgraded out-of-band
#
# Exit codes:
#   0 — sha256 of on-chain bytes == sha256 of local .so
#   1 — mismatch OR missing inputs
#   2 — toolchain / CLI invocation error

set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <program_id> <cluster_url> <local_so_path>" >&2
  exit 1
fi

PROGRAM_ID="$1"
CLUSTER_URL="$2"
LOCAL_SO="$3"

if [ ! -f "$LOCAL_SO" ]; then
  echo "error: local .so not found: $LOCAL_SO" >&2
  exit 1
fi

# Locate the solana CLI. Prefer the modern Anza release (~/.cargo/bin)
# but fall back to the legacy ~/.local/share/solana/install path used on
# Ghola devnet builders.
SOLANA_BIN="${SOLANA_BIN:-}"
if [ -z "$SOLANA_BIN" ]; then
  if command -v solana >/dev/null 2>&1; then
    SOLANA_BIN="$(command -v solana)"
  elif [ -x "$HOME/.local/share/solana/install/active_release/bin/solana" ]; then
    SOLANA_BIN="$HOME/.local/share/solana/install/active_release/bin/solana"
  else
    echo "error: solana CLI not found on PATH" >&2
    exit 2
  fi
fi

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT
ONCHAIN_SO="$TMPDIR/onchain.so"

echo "==> Dumping on-chain program $PROGRAM_ID from $CLUSTER_URL"
"$SOLANA_BIN" program dump --url "$CLUSTER_URL" "$PROGRAM_ID" "$ONCHAIN_SO" >/dev/null

if [ ! -s "$ONCHAIN_SO" ]; then
  echo "error: program dump produced empty output (program not deployed or RPC unreachable)" >&2
  exit 2
fi

# Pick a sha256 binary (Linux: sha256sum, macOS: shasum -a 256).
if command -v sha256sum >/dev/null 2>&1; then
  SHA() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
  SHA() { shasum -a 256 "$1" | awk '{print $1}'; }
else
  echo "error: no sha256 binary available" >&2
  exit 2
fi

ONCHAIN_HASH="$(SHA "$ONCHAIN_SO")"
LOCAL_HASH="$(SHA "$LOCAL_SO")"
ONCHAIN_SIZE=$(wc -c < "$ONCHAIN_SO" | tr -d ' ')
LOCAL_SIZE=$(wc -c < "$LOCAL_SO" | tr -d ' ')

echo ""
echo "  on-chain  : $ONCHAIN_HASH  ($ONCHAIN_SIZE bytes)  $PROGRAM_ID"
echo "  local .so : $LOCAL_HASH  ($LOCAL_SIZE bytes)  $LOCAL_SO"
echo ""

if [ "$ONCHAIN_HASH" = "$LOCAL_HASH" ]; then
  echo "MATCH — deployed program matches local artifact"
  exit 0
else
  echo "MISMATCH — deployed program does NOT match local artifact"
  echo ""
  echo "Possible causes:"
  echo "  1. Local build is on a different commit than the deployed program."
  echo "  2. Toolchain differs (cargo-build-sbf version, rustc version)."
  echo "  3. Program was upgraded out-of-band by another operator."
  echo ""
  echo "Cross-check with:"
  echo "  $SOLANA_BIN program show --url \"$CLUSTER_URL\" \"$PROGRAM_ID\" --output json"
  exit 1
fi
