#!/usr/bin/env bash
# devnet-test.sh — Ghola agentic finance devnet test runner
#
# Builds the devnet_flow example and exercises the full:
#   wallet init → airdrop → agent wallet → discover → x402 assess → SOL transfer
# pipeline against Solana devnet.
#
# Prerequisites:
#   - Rust toolchain (cargo)
#   - Optional: solana CLI (for manual airdrop fallback)
#   - Internet access (devnet RPC + Ghola cloud API)
#
# Usage:
#   ./scripts/devnet-test.sh [--rpc <url>] [--skip-airdrop]
#
# Environment variables:
#   SOLANA_RPC_URL   Override the Solana RPC endpoint (default: devnet)
#   GHOLA_API_URL    Override the Ghola cloud API URL
#   RUST_LOG         Set log verbosity (e.g. RUST_LOG=debug)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# ── Defaults ──────────────────────────────────────────────────────────────
RPC_URL="${SOLANA_RPC_URL:-https://api.devnet.solana.com}"
GHOLA_API="${GHOLA_API_URL:-https://ghola-api.onrender.com/v1}"
SKIP_AIRDROP=false

# ── Argument parsing ───────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --rpc)
      RPC_URL="$2"; shift 2 ;;
    --skip-airdrop)
      SKIP_AIRDROP=true; shift ;;
    --help|-h)
      grep '^#' "$0" | sed 's/^# \?//' | head -30
      exit 0 ;;
    *)
      echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

echo "========================================"
echo "  Ghola Devnet Integration Test"
echo "========================================"
echo "  Repo:     ${REPO_ROOT}"
echo "  RPC:      ${RPC_URL}"
echo "  Ghola:    ${GHOLA_API}"
echo ""

# ── Prerequisite check ─────────────────────────────────────────────────────
check_dep() {
  if ! command -v "$1" &>/dev/null; then
    echo "ERROR: '$1' not found in PATH.  $2" >&2
    exit 1
  fi
}

check_dep cargo  "Install Rust from https://rustup.rs"

if ! ${SKIP_AIRDROP} && command -v solana &>/dev/null; then
  SOLANA_CLI=true
  echo "  solana CLI found — will use for airdrop fallback"
else
  SOLANA_CLI=false
  echo "  solana CLI not found — airdrop handled by devnet_flow binary"
fi

# ── Build ──────────────────────────────────────────────────────────────────
echo ""
echo "[build] Compiling integration-tests example..."
cd "${REPO_ROOT}"

cargo build \
  --package said-integration-tests \
  --example devnet_flow \
  --quiet

echo "[build] Done."

# ── Optional: pre-fund a keypair via solana CLI ────────────────────────────
TEMP_KEYPAIR=""
if ${SOLANA_CLI} && ! ${SKIP_AIRDROP}; then
  echo ""
  echo "[setup] Generating ephemeral devnet keypair with solana CLI..."
  TEMP_DIR="$(mktemp -d)"
  TEMP_KEYPAIR="${TEMP_DIR}/devnet-test.json"

  solana-keygen new \
    --outfile "${TEMP_KEYPAIR}" \
    --no-bip39-passphrase \
    --silent

  PUBKEY="$(solana-keygen pubkey "${TEMP_KEYPAIR}")"
  echo "  Keypair: ${TEMP_KEYPAIR}"
  echo "  Address: ${PUBKEY}"

  echo ""
  echo "[airdrop] Requesting 2 SOL airdrop for test keypair..."
  solana airdrop 2 "${PUBKEY}" \
    --url "${RPC_URL}" \
    --keypair "${TEMP_KEYPAIR}" \
    || echo "  Airdrop rate-limited — the binary will retry via RPC."

  export DEVNET_TEST_KEYPAIR="${TEMP_KEYPAIR}"
fi

# ── Run devnet flow ────────────────────────────────────────────────────────
echo ""
echo "[run] Starting devnet_flow example..."
echo "----------------------------------------"

SOLANA_RPC_URL="${RPC_URL}" \
GHOLA_API_URL="${GHOLA_API}" \
cargo run \
  --package said-integration-tests \
  --example devnet_flow \
  --quiet

EXIT_CODE=$?
echo "----------------------------------------"

# ── Cleanup ────────────────────────────────────────────────────────────────
if [[ -n "${TEMP_KEYPAIR}" && -d "$(dirname "${TEMP_KEYPAIR}")" ]]; then
  rm -rf "$(dirname "${TEMP_KEYPAIR}")"
fi

# ── Result ─────────────────────────────────────────────────────────────────
echo ""
if [[ ${EXIT_CODE} -eq 0 ]]; then
  echo "✓ Devnet flow test PASSED"
else
  echo "✗ Devnet flow test FAILED (exit code ${EXIT_CODE})"
fi

exit ${EXIT_CODE}
