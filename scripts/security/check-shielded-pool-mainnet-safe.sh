#!/usr/bin/env bash
set -euo pipefail

# check-shielded-pool-mainnet-safe.sh
#
# Machine gate replacing "trust the DO-NOT-DEPLOY comment banner" for the
# said-shielded-pool Groth16 verifier. Fails (non-zero exit) if the pool is
# not safe to deploy. The escrow/mint SECURITY LOGIC is already in the code
# (C1/C2 public_amount binding, C-NEW-1/C-NEW-2 proof-gated deposit, H1
# in-circuit range checks); what this gate protects is the one remaining
# way to ship a catastrophically-unsafe binary: a verifying key that does
# NOT correspond to the current circuit, or a build that silently disables
# real proof verification.
#
# Threats gated:
#   1. STALE VERIFYING KEY. The H1 range-constraint change (2026-05-25)
#      invalidated the compiled-in VK. Deploying a VK that predates the
#      current circuit either bricks liveness (honest proofs fail) or —
#      worse — enforces an OLDER, weaker constraint system. The deployable
#      artifacts must not carry a STALE / DO-NOT-DEPLOY marker.
#   2. UNCEREMONIED KEY. A production VK must come from a real multi-party
#      MPC ceremony (SPEC.md §13: >=10 contributors, >=3 external, + beacon).
#      A single-party setup lets the setup runner forge unlimited proofs.
#      Enforced via ceremony/ATTESTATION.toml.
#   3. CIRCUIT/VK DRIFT. The ceremony attestation must bind to the EXACT
#      circuit source that is checked in (circuit_sha256), so a VK cannot be
#      attested against a different circuit than the one deployed.
#   4. STUB VERIFIER. `real-verifier` must stay in the program's default
#      features, or `groth16::verify` returns Ok(()) for any bytes.
#
# MODES:
#   --mode=merge   (default) Block-on-merge. Enforces only invariants that
#                  must never regress on any commit, and does NOT block while
#                  the VK is honestly self-marked STALE (so PRs are not
#                  blocked during the pending ceremony): the real-verifier
#                  default (Check 4) and the anti-forge rule that a VK which
#                  claims freshness MUST have a matching, valid attestation
#                  (Checks 2+3 applied only when the STALE marker is absent).
#   --mode=deploy  Pre-mainnet-deploy. Enforces EVERYTHING (Checks 1-4).
#                  Must pass for the artifact to be deployable to mainnet.
#
# Exit codes: 0 = safe, 1 = unsafe artifact (gate failure),
#             2 = script/usage error.

MODE="merge"
for arg in "$@"; do
  case "$arg" in
    --mode=merge) MODE="merge" ;;
    --mode=deploy) MODE="deploy" ;;
    *) echo "usage: $0 [--mode=merge|--mode=deploy]" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROG="$ROOT/programs/said-shielded-pool"
CIRCUITS="$ROOT/crates/said-shielded-pool-circuits/circuits"
CEREMONY="$ROOT/crates/said-shielded-pool-circuits/ceremony"
VK="$PROG/src/verifying_key.rs"
FORESTER_VK="$PROG/src/forester_verifying_key.rs"
CARGO="$PROG/Cargo.toml"
ATTEST="$CEREMONY/ATTESTATION.toml"

fail() { echo "GATE FAIL [$MODE]: $1" >&2; exit 1; }
ok()   { echo "  ok: $1"; }

command -v shasum >/dev/null 2>&1 && SHA="shasum -a 256" || SHA="sha256sum"

# Deterministic hash of the local circuit source that defines the constraint
# system (circomlib includes are version-pinned via package-lock.json). Any
# edit to these files changes the hash, so a checked-in VK/attestation minted
# against a different circuit is detectable.
compute_circuit_hash() {
  local files=(
    "$CIRCUITS/transaction.circom"
    "$CIRCUITS/merkleProof.circom"
    "$CIRCUITS/commitment.circom"
    "$CIRCUITS/keypair.circom"
    "$CIRCUITS/package-lock.json"
  )
  local f
  for f in "${files[@]}"; do
    [[ -f "$f" ]] || fail "circuit source missing: ${f#$ROOT/} (cannot compute circuit hash)"
  done
  # Sort by path for determinism, hash the concatenated file bytes.
  cat "${files[@]}" | $SHA | awk '{print $1}'
}

vk_is_stale() {
  grep -qiE "STALE|DO NOT DEPLOY|DO-NOT-DEPLOY" "$VK" 2>/dev/null
}

[[ -f "$VK" ]]    || fail "verifying_key.rs not found at ${VK#$ROOT/}"
[[ -f "$CARGO" ]] || fail "program Cargo.toml not found"

# ---- Check 4: real-verifier must stay default (both modes) ----------------
# Extract the `default = [...]` line from [features] and require real-verifier.
if ! awk '/^\[features\]/{f=1} f && /^default[[:space:]]*=/{print; exit}' "$CARGO" \
     | grep -q '"real-verifier"'; then
  fail "programs/said-shielded-pool default features do not include \"real-verifier\" — \
groth16::verify would be a stub (returns Ok(()) for any proof). Restore it."
fi
ok "real-verifier is in default features"

CIRCUIT_HASH="$(compute_circuit_hash)"

# ---- Attestation validation helper ----------------------------------------
# Returns 0 and sets ATTEST_ERR="" if the attestation is a valid production
# ceremony bound to the current circuit; else sets ATTEST_ERR to the reason.
ATTEST_ERR=""
validate_attestation() {
  ATTEST_ERR=""
  if [[ ! -f "$ATTEST" ]]; then
    ATTEST_ERR="ceremony attestation missing: ${ATTEST#$ROOT/} (SPEC.md §13). \
A production VK requires a recorded multi-party ceremony."
    return 1
  fi
  local contributors external beacon circ
  contributors="$(awk -F= '/^[[:space:]]*contributors[[:space:]]*=/{gsub(/[^0-9]/,"",$2);print $2;exit}' "$ATTEST")"
  external="$(awk -F= '/^[[:space:]]*external_contributors[[:space:]]*=/{gsub(/[^0-9]/,"",$2);print $2;exit}' "$ATTEST")"
  beacon="$(awk -F= '/^[[:space:]]*beacon[[:space:]]*=/{print $2;exit}' "$ATTEST" | tr -d ' "')"
  circ="$(awk -F= '/^[[:space:]]*circuit_sha256[[:space:]]*=/{print $2;exit}' "$ATTEST" | tr -d ' "')"

  [[ -n "$contributors" && "$contributors" -ge 10 ]] \
    || { ATTEST_ERR="ceremony contributors=${contributors:-0}, need >=10 (SPEC.md §13)"; return 1; }
  [[ -n "$external" && "$external" -ge 3 ]] \
    || { ATTEST_ERR="ceremony external_contributors=${external:-0}, need >=3 (SPEC.md §13)"; return 1; }
  [[ -n "$beacon" ]] \
    || { ATTEST_ERR="ceremony attestation missing a beacon value (SPEC.md §13)"; return 1; }
  [[ -n "$circ" ]] \
    || { ATTEST_ERR="ceremony attestation missing circuit_sha256"; return 1; }
  [[ "$circ" == "$CIRCUIT_HASH" ]] \
    || { ATTEST_ERR="attestation circuit_sha256 ($circ) != current circuit hash ($CIRCUIT_HASH) — \
the ceremony was run against a different circuit than what is checked in"; return 1; }
  return 0
}

if [[ "$MODE" == "deploy" ]]; then
  # ---- Check 1: no stale marker on the deployable VK(s) --------------------
  vk_is_stale && fail "verifying_key.rs is marked STALE / DO-NOT-DEPLOY. The H1 circuit \
change invalidated it; regenerate via a fresh MPC ceremony (SPEC.md §13) before deploy."
  if [[ -f "$FORESTER_VK" ]] && grep -qiE "STALE|DO NOT DEPLOY|DO-NOT-DEPLOY" "$FORESTER_VK"; then
    fail "forester_verifying_key.rs is marked STALE / DO-NOT-DEPLOY."
  fi
  ok "no STALE marker on deployable verifying keys"

  # ---- Checks 2+3: real, circuit-bound ceremony ---------------------------
  validate_attestation || fail "$ATTEST_ERR"
  ok "ceremony attestation valid and bound to current circuit ($CIRCUIT_HASH)"

  echo "PASS [deploy]: said-shielded-pool is safe to deploy."
  exit 0
fi

# ---- merge mode -----------------------------------------------------------
# Do not block PRs while the VK is honestly self-marked STALE (ceremony
# pending). But if someone REMOVES the STALE marker (claims freshness), a
# valid, circuit-bound attestation MUST be present — no faking fresh.
if vk_is_stale; then
  ok "VK is honestly marked STALE (ceremony pending) — merge allowed; deploy gate will block"
  echo "PASS [merge]: no regression (VK self-marked stale; real-verifier default intact)."
  exit 0
fi

if ! validate_attestation; then
  fail "verifying_key.rs is NOT marked stale (claims freshness) but has no valid, \
circuit-bound ceremony attestation: $ATTEST_ERR"
fi
ok "fresh VK is backed by a valid, circuit-bound ceremony attestation"
echo "PASS [merge]: no regression."
exit 0
