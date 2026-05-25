#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROGRAM_DIR="${ROOT}/programs/said-shielded-pool"
RESULT="${PROGRAM_DIR}/tests/full_loop_devnet.result.json"
RPC_URL="${SOLANA_RPC_URL:-https://api.devnet.solana.com}"
KEYPAIR_PATH="${RELAYER_KEYPAIR_PATH:-${HOME}/.config/solana/id.json}"
PORT="${GHOLA_RELAYER_CANARY_PORT:-18088}"
RELAYER_URL="http://127.0.0.1:${PORT}"
CONFIRM="${GHOLA_RUN_FUNDED_DEVNET_CANARY:-}"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'missing required command: %s\n' "$1" >&2
    exit 127
  }
}

need cargo
need curl
need jq
need npx
need solana

if [[ "$CONFIRM" != "1" ]]; then
  cat >&2 <<'EOF'
This is a funded devnet relayer canary. It spends devnet SOL from the
configured Solana CLI keypair, starts a local shielded-pool relayer, and
broadcasts the withdraw through POST /relay.

Run explicitly with:

  GHOLA_RUN_FUNDED_DEVNET_CANARY=1 scripts/canary/solana-shielded-pool-funded-relayer-devnet.sh
EOF
  exit 64
fi

if [[ ! -f "$KEYPAIR_PATH" ]]; then
  printf 'missing relayer keypair: %s\n' "$KEYPAIR_PATH" >&2
  exit 66
fi

queue_dir="$(mktemp -d "${TMPDIR:-/tmp}/ghola-relayer-canary.XXXXXX")"
relayer_log="${queue_dir}/relayer.log"
relayer_pid=""

cleanup() {
  if [[ -n "$relayer_pid" ]]; then
    kill "$relayer_pid" 2>/dev/null || true
    wait "$relayer_pid" 2>/dev/null || true
  fi
  rm -rf "$queue_dir"
}
trap cleanup EXIT

printf 'Configured Solana keypair:\n'
solana config get | sed -n '1,4p'
printf '\nDevnet balance before:\n'
solana balance --url "$RPC_URL"

printf '\nStarting local shielded-pool relayer on %s...\n' "$RELAYER_URL"
(
  cd "$ROOT"
  RELAYER_PORT="$PORT" \
  RPC_URL="$RPC_URL" \
  RELAYER_KEYPAIR_PATH="$KEYPAIR_PATH" \
  RELAYER_QUEUE_DB="${queue_dir}/queue.db" \
  POOL_PROGRAM_ID="5bmCDeaQceBpWgK8aADB4Tz4JzqZ9hkCi3qedC6oZR8A" \
  ANONYMITY_THRESHOLD=1 \
  BATCH_SIZE=1 \
  MIN_DELAY_SECS=1 \
  MAX_DELAY_SECS=2 \
  JITTER_LAMBDA=0 \
  DECOY_RATE=0 \
  MAX_RETRIES=2 \
  INITIAL_DELAY_MS=500 \
  MAX_DELAY_MS=1500 \
  cargo run -p said-shielded-pool-relayer
) >"$relayer_log" 2>&1 &
relayer_pid="$!"

for _ in $(seq 1 60); do
  if curl -fsS "${RELAYER_URL}/healthz" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$relayer_pid" 2>/dev/null; then
    printf 'relayer exited before health check passed\n' >&2
    cat "$relayer_log" >&2
    exit 1
  fi
  sleep 1
done
curl -fsS "${RELAYER_URL}/healthz" >/dev/null

rm -f "$RESULT"
(
  cd "$PROGRAM_DIR"
  GHOLA_SHIELDED_POOL_RELAYER_URL="$RELAYER_URL" \
    npx ts-node tests/full_loop_devnet.ts
)

if [[ ! -f "$RESULT" ]]; then
  printf 'funded relayer canary did not write result file: %s\n' "$RESULT" >&2
  exit 66
fi

jq -e '
  .program_id == "5bmCDeaQceBpWgK8aADB4Tz4JzqZ9hkCi3qedC6oZR8A"
  and (.payer | type == "string" and length > 0)
  and (.mint | type == "string" and length > 0)
  and (.escrow | type == "string" and length > 0)
  and (.merkle_tree | type == "string" and length > 0)
  and ([.results[].label] | index("init_tree") != null)
  and ([.results[].label] | index("deposit") != null)
  and ([.results[].label] | index("update_root_via_proof (real)") != null)
  and ([.results[].label] | index("withdraw") != null)
  and all(.results[]; (.error | not))
  and ((.results[] | select(.label == "withdraw") | .sig) | startswith("relayer:"))
' "$RESULT" >/dev/null

printf '\nDevnet balance after:\n'
solana balance --url "$RPC_URL"

printf '\nFunded Solana shielded-pool relayer devnet canary passed.\n'
jq -r '
  "program_id: \(.program_id)",
  "payer: \(.payer)",
  "mint: \(.mint)",
  "escrow: \(.escrow)",
  "merkle_tree: \(.merkle_tree)",
  "sol_delta: \(.sol_delta)",
  (.results[] | "\(.label): \(.sig) cu=\(.cu)")
' "$RESULT"
