#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROGRAM_DIR="${ROOT}/programs/said-shielded-pool"
RESULT="${PROGRAM_DIR}/tests/full_loop_devnet.result.json"
RPC_URL="${SOLANA_RPC_URL:-https://api.devnet.solana.com}"
CONFIRM="${GHOLA_RUN_FUNDED_DEVNET_CANARY:-}"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'missing required command: %s\n' "$1" >&2
    exit 127
  }
}

need jq
need npx
need solana

if [[ "$CONFIRM" != "1" ]]; then
  cat >&2 <<'EOF'
This is a funded devnet canary. It spends devnet SOL from the configured
Solana CLI keypair and creates fresh devnet mint/tree/accounts.

Run explicitly with:

  GHOLA_RUN_FUNDED_DEVNET_CANARY=1 scripts/canary/solana-shielded-pool-funded-devnet.sh
EOF
  exit 64
fi

printf 'Configured Solana keypair:\n'
solana config get | sed -n '1,4p'
printf '\nDevnet balance before:\n'
solana balance --url "$RPC_URL"

rm -f "$RESULT"
(cd "$PROGRAM_DIR" && npx ts-node tests/full_loop_devnet.ts)

if [[ ! -f "$RESULT" ]]; then
  printf 'funded devnet canary did not write result file: %s\n' "$RESULT" >&2
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
  and all(.results[]; (.sig | type == "string" and length > 0) and (.error | not))
' "$RESULT" >/dev/null

printf '\nDevnet balance after:\n'
solana balance --url "$RPC_URL"

printf '\nFunded Solana shielded-pool devnet canary passed.\n'
jq -r '
  "program_id: \(.program_id)",
  "payer: \(.payer)",
  "mint: \(.mint)",
  "escrow: \(.escrow)",
  "merkle_tree: \(.merkle_tree)",
  "sol_delta: \(.sol_delta)",
  (.results[] | "\(.label): \(.sig) cu=\(.cu)")
' "$RESULT"
