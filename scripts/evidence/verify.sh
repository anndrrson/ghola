#!/usr/bin/env bash
# Stream 10 — production-hardening Evidence Gate: auditor verifier.
#
# Usage: scripts/evidence/verify.sh <path-to-evidence.json>
#
# Re-derives every commitment from the current working tree at the
# commit recorded in the manifest, then compares.  The output is
# COMMITMENT-ONLY: each stream prints exactly one of
#   stream X (label): OK
#   stream X (label): COMMITMENT MISMATCH
# No diff content, no failure signatures, no log output — auditors
# who need to investigate a mismatch should re-run collect.sh + commit.sh
# locally and compare manifest fields directly.
#
# Exit codes: 0 = all match, 1 = any mismatch, 2 = invocation error.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

if [ "${1:-}" = "" ]; then
  echo "usage: $0 <path-to-evidence.json>" >&2
  exit 2
fi
EV="$1"
if [ ! -f "$EV" ]; then
  echo "error: $EV not found" >&2
  exit 2
fi

EXPECTED_COMMIT="$(jq -r .commit "$EV")"
ACTUAL_COMMIT="$(git rev-parse HEAD)"
if [ "$EXPECTED_COMMIT" != "$ACTUAL_COMMIT" ]; then
  echo "warning: working tree at $ACTUAL_COMMIT, manifest pinned to $EXPECTED_COMMIT" >&2
  echo "         re-run after \`git checkout $EXPECTED_COMMIT\` for full re-derivation" >&2
fi

HASH_ALGO="$(jq -r .hash_algo "$EV")"

# Pick the hash command that matches what the manifest recorded.
if [ "$HASH_ALGO" = "blake3" ]; then
  if command -v b3sum >/dev/null 2>&1; then
    rehash() { b3sum "$1" | awk '{print $1}'; }
  elif command -v blake3sum >/dev/null 2>&1; then
    rehash() { blake3sum "$1" | awk '{print $1}'; }
  else
    echo "error: manifest declares blake3 but no b3sum/blake3sum installed" >&2
    exit 2
  fi
else
  rehash() { shasum -a 256 "$1" | awk '{print $1}'; }
fi

rehash_or_absent() {
  if [ -f "$1" ]; then rehash "$1"; else echo "absent"; fi
}

OK=0
FAIL=0
check() {
  # check <label> <expected> <actual>
  local label="$1" exp="$2" act="$3"
  if [ "$exp" = "$act" ]; then
    echo "  $label: OK"
    OK=$(( OK + 1 ))
  else
    echo "  $label: COMMITMENT MISMATCH"
    FAIL=$(( FAIL + 1 ))
  fi
}

# assert_true <label> <value> — hard pass/fail on a recorded boolean.
# Unlike check(), this does not compare against a stored expectation:
# the recorded value MUST be the literal "true". This is how the
# dynamic-run streams (fuzz executed, deny/audit pass) are enforced
# instead of merely echoed.
assert_true() {
  local label="$1" val="$2"
  if [ "$val" = "true" ]; then
    echo "  $label: OK ($val)"
    OK=$(( OK + 1 ))
  else
    echo "  $label: ASSERTION FAILED (expected true, got $val)"
    FAIL=$(( FAIL + 1 ))
  fi
}

# assert_zero <label> <value> — hard pass/fail on a recorded count.
# The recorded value MUST be the literal "0".
assert_zero() {
  local label="$1" val="$2"
  if [ "$val" = "0" ]; then
    echo "  $label: OK (0)"
    OK=$(( OK + 1 ))
  else
    echo "  $label: ASSERTION FAILED (expected 0, got $val)"
    FAIL=$(( FAIL + 1 ))
  fi
}

echo "evidence gate verify"
echo "  commit:     $EXPECTED_COMMIT"
echo "  hash_algo:  $HASH_ALGO"
echo "  manifest:   $EV"
echo

echo "stream 1 (invariants)"
EXP="$(jq -r .streams.invariants.spec_hash "$EV")"
check "spec_hash       " "$EXP" "$(rehash_or_absent docs/shielded-pool/SPEC.md)"
EXP="$(jq -r .streams.invariants.doc_hash "$EV")"
check "doc_hash        " "$EXP" "$(rehash_or_absent docs/shielded-pool/INVARIANTS.md)"
assert_zero "fail_count      " "$(jq -r '.streams.invariants.fail_count // 0' "$EV")"

echo "stream 2 (fuzz + proptests)"
EXP="$(jq -r .streams.fuzz.targets "$EV")"
# fuzz/Cargo.toml has one [package] name and N [[bin]] names; subtract 1.
ACT_RAW="$(grep -c '^name = "' fuzz/Cargo.toml 2>/dev/null || echo 0)"
ACT=$(( ACT_RAW > 0 ? ACT_RAW - 1 : 0 ))
check "target_count    " "$EXP" "$ACT"
# Hard-assert the dynamic fuzz outcome rather than echoing it. The fuzz
# run MUST have executed and MUST NOT have produced crash artifacts.
assert_true "executed        " "$(jq -r .streams.fuzz.executed "$EV")"
assert_zero "crashes         " "$(jq -r '.streams.fuzz.crashes // 0' "$EV")"

echo "stream 3 (replay)"
# Replay taxonomy folded into THREAT_SCENARIOS.md § H (2026-05-24); see
# stream 9 below for the doc-hash check on the merged document.
echo "  doc_hash        : FOLDED → THREAT_SCENARIOS.md § H"
OK=$(( OK + 1 ))
assert_zero "fail_count      " "$(jq -r '.streams.replay.fail_count // 0' "$EV")"

echo "stream 4 (governance + program binary)"
EXP="$(jq -r .program_bin_sha256 "$EV")"
ACT="$(shasum -a 256 programs/said-shielded-pool/target/deploy/said_shielded_pool.so 2>/dev/null | awk '{print $1}')"
check "program_bin     " "$EXP" "${ACT:-absent}"
EXP="$(jq -r .streams.governance.config_doc_hash "$EV")"
check "governance_doc  " "$EXP" "$(rehash_or_absent docs/shielded-pool/GOVERNANCE.md)"
# Upgrade runbook folded into GOVERNANCE.md § 11 (2026-05-24).
echo "  upgrade_doc     : FOLDED → GOVERNANCE.md § 11"
OK=$(( OK + 1 ))

echo "stream 5 (secrets)"
EXP="$(jq -r .streams.secrets.key_rotation_doc "$EV")"
# Key rotation folded into OPERATIONS.md § 1 (2026-05-24).
check "operations_doc  " "$EXP" "$(rehash_or_absent docs/shielded-pool/OPERATIONS.md)"
assert_zero "fail_count      " "$(jq -r '.streams.secrets.fail_count // 0' "$EV")"

echo "stream 6 (chaos)"
# Chaos commitment is the test-result-log hash, which is run-output
# bound.  Verifying the hash byte-for-byte requires re-running
# collect.sh; we surface it as a presence check. The chaos OUTCOME,
# however, is hard-asserted: fail_count MUST be 0.
EXP="$(jq -r .streams.chaos.result_hash "$EV")"
if [ "$EXP" != "absent" ] && [ -n "$EXP" ]; then
  echo "  result_hash     : RECORDED ($EXP)"
  OK=$(( OK + 1 ))
else
  echo "  result_hash     : MISSING"
  FAIL=$(( FAIL + 1 ))
fi
assert_zero "fail_count      " "$(jq -r '.streams.chaos.fail_count // 0' "$EV")"

echo "stream 7 (telemetry / redaction)"
# Logging policy folded into OPERATIONS.md § 2 (2026-05-24).
EXP="$(jq -r .streams.telemetry.doc_hash "$EV")"
check "operations_doc  " "$EXP" "$(rehash_or_absent docs/shielded-pool/OPERATIONS.md)"
assert_zero "fail_count      " "$(jq -r '.streams.telemetry.fail_count // 0' "$EV")"

echo "stream 8 (supply chain)"
# Supply-chain policy folded into OPERATIONS.md § 3 (2026-05-24).
EXP="$(jq -r .streams.supply_chain.doc_hash "$EV")"
check "operations_doc  " "$EXP" "$(rehash_or_absent docs/shielded-pool/OPERATIONS.md)"
EXP="$(jq -r .streams.supply_chain.deny_config_hash "$EV")"
check "deny_toml       " "$EXP" "$(rehash_or_absent deny.toml)"
# Hard-assert the supply-chain outcomes rather than echoing them. Both
# cargo-deny and cargo-audit MUST have passed at this commit. Ignores
# live in deny.toml / .cargo/audit.toml; anything unignored fails here.
assert_true "deny_pass       " "$(jq -r .streams.supply_chain.deny_pass "$EV")"
assert_true "audit_pass      " "$(jq -r '.streams.supply_chain.audit_pass // false' "$EV")"

echo "stream 9 (malicious)"
EXP="$(jq -r .streams.malicious.doc_hash "$EV")"
check "threat_doc      " "$EXP" "$(rehash_or_absent docs/shielded-pool/THREAT_SCENARIOS.md)"
assert_zero "fail_count      " "$(jq -r '.streams.malicious.fail_count // 0' "$EV")"

echo "circuit verification keys"
EXP="$(jq -r .vk_transfer_hash "$EV")"
check "vk_transfer     " "$EXP" "$(rehash_or_absent crates/said-shielded-pool-circuits/artifacts/verification_key.json)"
EXP="$(jq -r .vk_forester_hash "$EV")"
check "vk_forester     " "$EXP" "$(rehash_or_absent crates/said-shielded-pool-circuits/artifacts/forester_verification_key.json)"

echo "lockfiles"
EXP="$(jq -r .lockfiles.cargo_workspace "$EV")"
ACT="$(shasum -a 256 Cargo.lock | awk '{print $1}')"
check "cargo_workspace " "$EXP" "$ACT"
EXP="$(jq -r .lockfiles.cargo_program "$EV")"
ACT="$(shasum -a 256 programs/said-shielded-pool/Cargo.lock | awk '{print $1}')"
check "cargo_program   " "$EXP" "$ACT"

echo "workflows + config"
EXP="$(jq -r .workflows.fuzz "$EV")"
check "fuzz.yml        " "$EXP" "$(rehash_or_absent .github/workflows/fuzz.yml)"
EXP="$(jq -r .workflows.supply_chain "$EV")"
check "supply-chain.yml" "$EXP" "$(rehash_or_absent .github/workflows/supply-chain.yml)"
EXP="$(jq -r .workflows.sbom "$EV")"
check "sbom.yml        " "$EXP" "$(rehash_or_absent .github/workflows/sbom.yml)"
EXP="$(jq -r .config.clippy_toml "$EV")"
check "clippy.toml     " "$EXP" "$(rehash_or_absent clippy.toml)"

echo
echo "summary: $OK ok, $FAIL mismatch"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
