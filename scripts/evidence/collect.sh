#!/usr/bin/env bash
# Stream 10 — production-hardening Evidence Gate: collect raw artifacts.
#
# Runs every hardening stream's verification command, captures each
# result's content hash, writes everything to
#   artifacts/hardening-evidence/<commit>/raw/
#
# The raw/ directory is LOCAL ONLY and is .gitignore'd. The public
# manifest (`evidence.json`) is produced by commit.sh from these
# raw artifacts and contains hashes only — never failure signatures
# or test output.
#
# Hash algorithm: prefers `b3sum` (BLAKE3). Falls back to `shasum -a
# 256` if b3sum is not installed. The chosen algorithm is recorded
# inside every `*.hash` file (first whitespace-delimited token) and
# echoed into `raw/_algo` so verify.sh can re-derive byte-for-byte.
#
# Environment knobs:
#   EVIDENCE_FUZZ_SECS  — per-fuzz-target wall-clock budget (default 30
#                          locally; CI overrides to 120).
#   EVIDENCE_SKIP_FUZZ  — set to 1 to skip cargo-fuzz (useful when no
#                          nightly toolchain is installed locally).
#
# Always exits 0 even if a downstream test fails. Pass/fail is encoded
# in the captured log hash; verify.sh confirms commitment match, not
# test pass.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

COMMIT="$(git rev-parse HEAD)"
OUT="artifacts/hardening-evidence/$COMMIT/raw"
mkdir -p "$OUT"

FUZZ_SECS="${EVIDENCE_FUZZ_SECS:-30}"

# ── Hash helper ────────────────────────────────────────────────────────
if command -v b3sum >/dev/null 2>&1; then
  HASH_ALGO="blake3"
  hash_file() { b3sum "$1" | awk '{print "blake3 " $1 "  " $2}'; }
elif command -v blake3sum >/dev/null 2>&1; then
  HASH_ALGO="blake3"
  hash_file() { blake3sum "$1" | awk '{print "blake3 " $1 "  " $2}'; }
else
  HASH_ALGO="sha256"
  hash_file() { shasum -a 256 "$1" | awk '{print "sha256 " $1 "  " $2}'; }
fi
echo "$HASH_ALGO" > "$OUT/_algo"

write_hash() {
  # write_hash <path-to-input> <path-to-hash-output>
  hash_file "$1" > "$2"
}

run_capture() {
  # run_capture <label> <log-path> -- <cmd...>
  # Always continues on failure; the log itself records the exit state.
  local label="$1"
  local log="$2"
  shift 2
  if [ "$1" = "--" ]; then shift; fi
  echo "[collect] $label …" >&2
  {
    echo "# Stream 10 evidence — $label"
    echo "# commit: $COMMIT"
    echo "# cmd:    $*"
    echo "# ts:     $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "---"
    set +e
    "$@" 2>&1
    local ec=$?
    set -e
    echo "---"
    echo "# exit:   $ec"
  } > "$log" 2>&1 || true
  write_hash "$log" "${log%.log}.hash"
}

# ── Stream 1: invariants ───────────────────────────────────────────────
run_capture "stream-1 invariants" "$OUT/invariants.log" -- \
  cargo test -p said-shielded-pool-invariants --tests --no-fail-fast

# ── Stream 2: fuzz + proptests ─────────────────────────────────────────
if [ "${EVIDENCE_SKIP_FUZZ:-0}" = "1" ]; then
  echo "[collect] EVIDENCE_SKIP_FUZZ=1 — skipping cargo-fuzz" >&2
  echo "skipped (EVIDENCE_SKIP_FUZZ=1)" > "$OUT/fuzz-skipped.log"
  write_hash "$OUT/fuzz-skipped.log" "$OUT/fuzz-skipped.hash"
else
  for target in prover_witness_parse relayer_relay_payload \
                indexer_commitment_hex program_args_decode \
                vk_parse merkle_insert; do
    run_capture "stream-2 fuzz $target ($FUZZ_SECS s)" \
      "$OUT/fuzz-$target.log" -- \
      bash -c "cd fuzz && cargo +nightly fuzz run $target -- -max_total_time=$FUZZ_SECS"
  done
fi

# Proptests (live in invariants + relayer crates already; smoke them
# all via a workspace test pass restricted to prop_/property_ patterns).
run_capture "stream-2 proptests" "$OUT/proptest.log" -- \
  cargo test --workspace --tests --no-fail-fast -- prop_ property_

# ── Stream 3: replay tests ─────────────────────────────────────────────
run_capture "stream-3 replay" "$OUT/replay.log" -- \
  cargo test -p said-shielded-pool-relayer --tests --no-fail-fast

# ── Stream 4: program binary + governance docs ─────────────────────────
if [ -f programs/said-shielded-pool/target/deploy/said_shielded_pool.so ]; then
  shasum -a 256 programs/said-shielded-pool/target/deploy/said_shielded_pool.so \
    > "$OUT/program-bin.sha256"
else
  echo "missing: programs/said-shielded-pool/target/deploy/said_shielded_pool.so" \
    > "$OUT/program-bin.sha256"
fi

# IDL: not currently emitted by `cargo build` (anchor build produces it).
# Record canonical absence so verify.sh can match.
if [ -f programs/said-shielded-pool/target/idl/said_shielded_pool.json ]; then
  shasum -a 256 programs/said-shielded-pool/target/idl/said_shielded_pool.json \
    > "$OUT/program-idl.sha256"
else
  echo "absent  (anchor build not run at this commit)" \
    > "$OUT/program-idl.sha256"
fi

write_hash docs/shielded-pool/GOVERNANCE.md "$OUT/governance-doc.hash"

# ── Stream 5: secrets ──────────────────────────────────────────────────
run_capture "stream-5 common-secrets" "$OUT/secrets.log" -- \
  cargo test -p common-secrets --no-fail-fast
write_hash docs/shielded-pool/OPERATIONS.md "$OUT/operations-doc.hash"

# ── Stream 6: chaos ────────────────────────────────────────────────────
run_capture "stream-6 chaos-tests" "$OUT/chaos.log" -- \
  cargo test -p chaos-tests --no-fail-fast

# ── Stream 7: telemetry / redaction ────────────────────────────────────
run_capture "stream-7 common-log" "$OUT/telemetry.log" -- \
  cargo test -p common-log --no-fail-fast
# (Logging policy now lives in docs/shielded-pool/OPERATIONS.md § 2;
#  the doc hash is captured once via the operations-doc.hash above.)

# ── Stream 8: supply chain ─────────────────────────────────────────────
if command -v cargo-audit >/dev/null 2>&1 || cargo audit --version >/dev/null 2>&1; then
  run_capture "stream-8 cargo audit" "$OUT/audit.log" -- cargo audit
else
  echo "cargo-audit not installed at this commit" > "$OUT/audit.log"
  write_hash "$OUT/audit.log" "$OUT/audit.hash"
fi

if cargo deny --version >/dev/null 2>&1; then
  run_capture "stream-8 cargo deny" "$OUT/deny.log" -- \
    cargo deny --all-features check
else
  echo "cargo-deny not installed at this commit" > "$OUT/deny.log"
  write_hash "$OUT/deny.log" "$OUT/deny.hash"
fi

# (Supply-chain policy now lives in docs/shielded-pool/OPERATIONS.md § 3;
#  the doc hash is captured once via the operations-doc.hash above.)

# ── Stream 9: malicious actors ─────────────────────────────────────────
run_capture "stream-9 malicious-tests" "$OUT/malicious.log" -- \
  cargo test -p malicious-tests --no-fail-fast
write_hash docs/shielded-pool/THREAT_SCENARIOS.md "$OUT/threat-scenarios-doc.hash"

# ── Spec + invariants doc + circuit verification keys ──────────────────
write_hash docs/shielded-pool/SPEC.md       "$OUT/spec.hash"
write_hash docs/shielded-pool/INVARIANTS.md "$OUT/invariants-doc.hash"
# (Replay taxonomy now folded into THREAT_SCENARIOS.md § H; its doc hash
#  is captured once via threat-scenarios-doc.hash above.)

if [ -f crates/said-shielded-pool-circuits/artifacts/verification_key.json ]; then
  write_hash crates/said-shielded-pool-circuits/artifacts/verification_key.json \
    "$OUT/vk-transfer.hash"
fi
if [ -f crates/said-shielded-pool-circuits/artifacts/forester_verification_key.json ]; then
  write_hash crates/said-shielded-pool-circuits/artifacts/forester_verification_key.json \
    "$OUT/vk-forester.hash"
fi

# ── Lockfiles ──────────────────────────────────────────────────────────
shasum -a 256 Cargo.lock programs/said-shielded-pool/Cargo.lock \
  > "$OUT/lockfiles.sha256"

# ── deny.toml + clippy.toml + workflow files ───────────────────────────
write_hash deny.toml                             "$OUT/deny-config.hash"
write_hash clippy.toml                           "$OUT/clippy-config.hash"
write_hash .github/workflows/fuzz.yml            "$OUT/workflow-fuzz.hash"
write_hash .github/workflows/supply-chain.yml    "$OUT/workflow-supply-chain.hash"
write_hash .github/workflows/sbom.yml            "$OUT/workflow-sbom.hash"

echo "[collect] done → $OUT" >&2
echo "$OUT"
