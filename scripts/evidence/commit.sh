#!/usr/bin/env bash
# Stream 10 — production-hardening Evidence Gate: commit canonical manifest.
#
# Reads the raw artifact directory produced by `collect.sh` and emits
# a canonical `evidence.json` next to it.  The manifest contains
# COMMITMENT HASHES ONLY — no test output, no log content, no failure
# signatures.  Public consumers (auditors, CI gate, on-chain
# attestation) work entirely from this file.
#
# Signature: if `cosign` is available AND `COSIGN_EXPERIMENTAL=1`
# (keyless OIDC mode), we sign the canonical JSON in-place and embed
# the base64 signature in the `signed_by` field.  Otherwise the field
# is `"unsigned-local-stream10-generation"`; production CI runs in
# OIDC mode so the baseline tracked in `.github/evidence-baseline.json`
# is always signed.
#
# Canonical JSON: `jq -S` (sort all keys recursively).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

COMMIT="$(git rev-parse HEAD)"
RAW="artifacts/hardening-evidence/$COMMIT/raw"
OUT="artifacts/hardening-evidence/$COMMIT/evidence.json"

if [ ! -d "$RAW" ]; then
  echo "error: $RAW does not exist. Run scripts/evidence/collect.sh first." >&2
  exit 2
fi

HASH_ALGO="$(cat "$RAW/_algo" 2>/dev/null || echo sha256)"

# read_hash <hash-file>  →  prints just the digest (algo prefix stripped)
read_hash() {
  if [ -f "$1" ]; then
    awk '{print $2}' "$1"
  else
    echo "absent"
  fi
}

# read_sha256 <sha256-file>  →  prints the bare sha256 (first column)
read_sha256() {
  if [ -f "$1" ]; then
    awk '{print $1; exit}' "$1"
  else
    echo "absent"
  fi
}

# Counts derived from raw logs (commitment-only — we record cardinality,
# not content). The auditor re-derives these by re-running collect.sh.
count_passed() {
  # Parse "test result: ok. N passed" or "FAILED. N passed" lines.
  if [ -f "$1" ]; then
    awk '/test result:.*passed/ {
      match($0, /[0-9]+ passed/);
      if (RLENGTH > 0) {
        s = substr($0, RSTART, RLENGTH);
        gsub(/ passed/, "", s);
        sum += s;
      }
    } END { print (sum ? sum : 0) }' "$1"
  else
    echo 0
  fi
}

count_failed() {
  if [ -f "$1" ]; then
    awk '/test result:.*failed/ {
      match($0, /[0-9]+ failed/);
      if (RLENGTH > 0) {
        s = substr($0, RSTART, RLENGTH);
        gsub(/ failed/, "", s);
        sum += s;
      }
    } END { print (sum ? sum : 0) }' "$1"
  else
    echo 0
  fi
}

count_ignored() {
  if [ -f "$1" ]; then
    awk '/test result:.*ignored/ {
      match($0, /[0-9]+ ignored/);
      if (RLENGTH > 0) {
        s = substr($0, RSTART, RLENGTH);
        gsub(/ ignored/, "", s);
        sum += s;
      }
    } END { print (sum ? sum : 0) }' "$1"
  else
    echo 0
  fi
}

# Aggregate fuzz state: crashes are detected by presence of artifacts in
# fuzz/artifacts/<target>/ produced during this collect run. Logs report
# "DONE" + cycle counts.
count_fuzz_crashes() {
  local n=0
  for t in prover_witness_parse relayer_relay_payload \
           indexer_commitment_hex program_args_decode \
           vk_parse merkle_insert; do
    if [ -d "fuzz/artifacts/$t" ]; then
      n=$(( n + $(ls "fuzz/artifacts/$t" 2>/dev/null | wc -l | tr -d ' ') ))
    fi
  done
  echo "$n"
}

# Fuzz minutes total = (per-target wall-clock) × (target count). For the
# baseline we read the configured value from the log preamble.
fuzz_minutes() {
  local secs
  secs="$(grep -h max_total_time "$RAW"/fuzz-*.log 2>/dev/null \
          | head -1 \
          | sed -E 's/.*-max_total_time=([0-9]+).*/\1/' \
          || echo 0)"
  if ! [[ "$secs" =~ ^[0-9]+$ ]]; then secs=0; fi
  echo $(( (secs * 6) / 60 ))   # 6 targets
}

# Per-stream commitments ────────────────────────────────────────────────
PROGRAM_BIN_SHA256="$(read_sha256 "$RAW/program-bin.sha256")"
PROGRAM_IDL_SHA256="$(read_sha256 "$RAW/program-idl.sha256")"

VK_TRANSFER_HASH="$(read_hash "$RAW/vk-transfer.hash")"
VK_FORESTER_HASH="$(read_hash "$RAW/vk-forester.hash")"

INV_PASSED="$(count_passed "$RAW/invariants.log")"
INV_FAILED="$(count_failed "$RAW/invariants.log")"
INV_RESULT_HASH="$(read_hash "$RAW/invariants.hash")"
INV_SPEC_HASH="$(read_hash "$RAW/spec.hash")"
INV_DOC_HASH="$(read_hash "$RAW/invariants-doc.hash")"

REPLAY_PASSED="$(count_passed "$RAW/replay.log")"
REPLAY_FAILED="$(count_failed "$RAW/replay.log")"
REPLAY_RESULT_HASH="$(read_hash "$RAW/replay.hash")"
# Replay taxonomy is now folded into THREAT_SCENARIOS.md § H; reuse the
# threat-scenarios-doc hash so the field stays populated for back-compat.
REPLAY_DOC_HASH="$(read_hash "$RAW/threat-scenarios-doc.hash")"

GOV_DOC_HASH="$(read_hash "$RAW/governance-doc.hash")"
# Upgrade runbook is now folded into GOVERNANCE.md § 11; reuse the same
# governance-doc hash so the field remains populated for back-compat
# with existing baseline schemas.
UPGRADE_DOC_HASH="$GOV_DOC_HASH"

# Consolidated operations doc — covers Streams 5 (Keys), 7 (Logging),
# and 8 (Supply chain). One hash, three references below.
OPS_DOC_HASH="$(read_hash "$RAW/operations-doc.hash")"

SECRETS_PASSED="$(count_passed "$RAW/secrets.log")"
SECRETS_FAILED="$(count_failed "$RAW/secrets.log")"
SECRETS_RESULT_HASH="$(read_hash "$RAW/secrets.hash")"
KEY_ROTATION_DOC_HASH="$OPS_DOC_HASH"

CHAOS_PASSED="$(count_passed "$RAW/chaos.log")"
CHAOS_FAILED="$(count_failed "$RAW/chaos.log")"
CHAOS_RESULT_HASH="$(read_hash "$RAW/chaos.hash")"

LOG_PASSED="$(count_passed "$RAW/telemetry.log")"
LOG_FAILED="$(count_failed "$RAW/telemetry.log")"
LOG_RESULT_HASH="$(read_hash "$RAW/telemetry.hash")"
LOGGING_DOC_HASH="$OPS_DOC_HASH"

# deny / audit pass = exit-0 logs end with "# exit:   0"
DENY_PASS="false"
if [ -f "$RAW/deny.log" ] && grep -q "^# exit:   0$" "$RAW/deny.log"; then
  DENY_PASS="true"
fi
AUDIT_PASS="false"
if [ -f "$RAW/audit.log" ] && grep -q "^# exit:   0$" "$RAW/audit.log"; then
  AUDIT_PASS="true"
fi
SUPPLY_CHAIN_DOC_HASH="$OPS_DOC_HASH"
DENY_CONFIG_HASH="$(read_hash "$RAW/deny-config.hash")"

MAL_PASSED="$(count_passed "$RAW/malicious.log")"
MAL_FAILED="$(count_failed "$RAW/malicious.log")"
MAL_IGNORED="$(count_ignored "$RAW/malicious.log")"
MAL_RESULT_HASH="$(read_hash "$RAW/malicious.hash")"
THREAT_DOC_HASH="$(read_hash "$RAW/threat-scenarios-doc.hash")"

# Fuzz aggregate. The configured target count is structural (always 6
# in this audit cut), independent of whether the local collect run
# actually executed cargo-fuzz; `executed` records that bit.
FUZZ_TARGETS=6
if [ -f "$RAW/fuzz-skipped.hash" ]; then
  FUZZ_EXECUTED=false
  FUZZ_CORPUS_HASH="skipped"
  FUZZ_MINUTES=0
  FUZZ_CRASHES=0
else
  FUZZ_EXECUTED=true
  # Corpus commitment = hash-of-hashes of each per-target log hash, then
  # combined via shasum -a 256 for stability across hash-algo choice.
  FUZZ_CORPUS_HASH="$(
    for t in prover_witness_parse relayer_relay_payload \
             indexer_commitment_hex program_args_decode \
             vk_parse merkle_insert; do
      read_hash "$RAW/fuzz-$t.hash"
    done | shasum -a 256 | awk '{print $1}'
  )"
  FUZZ_MINUTES="$(fuzz_minutes)"
  FUZZ_CRASHES="$(count_fuzz_crashes)"
fi

# Lockfile hashes
LOCK_WORKSPACE_SHA256="$(awk '/^[0-9a-f]+  Cargo.lock$/ {print $1}' "$RAW/lockfiles.sha256")"
LOCK_PROGRAM_SHA256="$(awk '/said-shielded-pool\/Cargo.lock$/ {print $1}' "$RAW/lockfiles.sha256")"

# Workflow / config commitments
WF_FUZZ_HASH="$(read_hash "$RAW/workflow-fuzz.hash")"
WF_SUPPLY_HASH="$(read_hash "$RAW/workflow-supply-chain.hash")"
WF_SBOM_HASH="$(read_hash "$RAW/workflow-sbom.hash")"
CLIPPY_HASH="$(read_hash "$RAW/clippy-config.hash")"

TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Build canonical JSON via jq. `--sort-keys` is applied by piping
# through `jq -S '.'` at the end.
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

jq -n \
  --arg commit              "$COMMIT" \
  --arg program_id          "5bmCDeaQceBpWgK8aADB4Tz4JzqZ9hkCi3qedC6oZR8A" \
  --arg program_bin_sha256  "$PROGRAM_BIN_SHA256" \
  --arg program_idl_sha256  "$PROGRAM_IDL_SHA256" \
  --arg vk_transfer_hash    "$VK_TRANSFER_HASH" \
  --arg vk_forester_hash    "$VK_FORESTER_HASH" \
  --arg hash_algo           "$HASH_ALGO" \
  --arg spec_hash           "$INV_SPEC_HASH" \
  --arg invariants_doc      "$INV_DOC_HASH" \
  --argjson inv_pass        "${INV_PASSED:-0}" \
  --argjson inv_fail        "${INV_FAILED:-0}" \
  --arg inv_result_hash     "$INV_RESULT_HASH" \
  --argjson fuzz_targets    "$FUZZ_TARGETS" \
  --argjson fuzz_executed   "$FUZZ_EXECUTED" \
  --arg fuzz_corpus_hash    "$FUZZ_CORPUS_HASH" \
  --argjson fuzz_minutes    "$FUZZ_MINUTES" \
  --argjson fuzz_crashes    "$FUZZ_CRASHES" \
  --argjson replay_pass     "${REPLAY_PASSED:-0}" \
  --argjson replay_fail     "${REPLAY_FAILED:-0}" \
  --arg replay_result_hash  "$REPLAY_RESULT_HASH" \
  --arg replay_doc_hash     "$REPLAY_DOC_HASH" \
  --arg gov_doc_hash        "$GOV_DOC_HASH" \
  --arg upgrade_doc_hash    "$UPGRADE_DOC_HASH" \
  --argjson timelock_secs   172800 \
  --argjson secrets_pass    "${SECRETS_PASSED:-0}" \
  --argjson secrets_fail    "${SECRETS_FAILED:-0}" \
  --arg secrets_result_hash "$SECRETS_RESULT_HASH" \
  --arg key_rot_doc_hash    "$KEY_ROTATION_DOC_HASH" \
  --argjson chaos_pass      "${CHAOS_PASSED:-0}" \
  --argjson chaos_fail      "${CHAOS_FAILED:-0}" \
  --arg chaos_result_hash   "$CHAOS_RESULT_HASH" \
  --argjson log_pass        "${LOG_PASSED:-0}" \
  --argjson log_fail        "${LOG_FAILED:-0}" \
  --arg log_result_hash     "$LOG_RESULT_HASH" \
  --arg logging_doc_hash    "$LOGGING_DOC_HASH" \
  --argjson deny_pass       "$DENY_PASS" \
  --argjson audit_pass      "$AUDIT_PASS" \
  --arg supply_doc_hash     "$SUPPLY_CHAIN_DOC_HASH" \
  --arg deny_config_hash    "$DENY_CONFIG_HASH" \
  --argjson mal_pass        "${MAL_PASSED:-0}" \
  --argjson mal_fail        "${MAL_FAILED:-0}" \
  --argjson mal_ignored     "${MAL_IGNORED:-0}" \
  --arg mal_result_hash     "$MAL_RESULT_HASH" \
  --arg threat_doc_hash     "$THREAT_DOC_HASH" \
  --arg lock_workspace      "$LOCK_WORKSPACE_SHA256" \
  --arg lock_program        "$LOCK_PROGRAM_SHA256" \
  --arg wf_fuzz             "$WF_FUZZ_HASH" \
  --arg wf_supply           "$WF_SUPPLY_HASH" \
  --arg wf_sbom             "$WF_SBOM_HASH" \
  --arg clippy_hash         "$CLIPPY_HASH" \
  --arg generated_at        "$TIMESTAMP" \
  '{
    schema_version: "stream10.v1",
    commit: $commit,
    generated_at: $generated_at,
    hash_algo: $hash_algo,
    program_id: $program_id,
    program_bin_sha256: $program_bin_sha256,
    program_idl_sha256: $program_idl_sha256,
    vk_transfer_hash:   $vk_transfer_hash,
    vk_forester_hash:   $vk_forester_hash,
    streams: {
      invariants: {
        spec_hash:    $spec_hash,
        doc_hash:     $invariants_doc,
        pass_count:   $inv_pass,
        fail_count:   $inv_fail,
        result_hash:  $inv_result_hash
      },
      fuzz: {
        targets:      $fuzz_targets,
        executed:     $fuzz_executed,
        corpus_hash:  $fuzz_corpus_hash,
        minutes:      $fuzz_minutes,
        crashes:      $fuzz_crashes
      },
      replay: {
        pass_count:   $replay_pass,
        fail_count:   $replay_fail,
        result_hash:  $replay_result_hash,
        doc_hash:     $replay_doc_hash
      },
      governance: {
        config_doc_hash:  $gov_doc_hash,
        upgrade_doc_hash: $upgrade_doc_hash,
        timelock_secs:    $timelock_secs
      },
      secrets: {
        pass_count:       $secrets_pass,
        fail_count:       $secrets_fail,
        audit_hash:       $secrets_result_hash,
        key_rotation_doc: $key_rot_doc_hash
      },
      chaos: {
        pass_count:   $chaos_pass,
        fail_count:   $chaos_fail,
        result_hash:  $chaos_result_hash
      },
      telemetry: {
        pass_count:      $log_pass,
        fail_count:      $log_fail,
        leak_test_hash:  $log_result_hash,
        doc_hash:        $logging_doc_hash
      },
      supply_chain: {
        deny_pass:        $deny_pass,
        audit_pass:       $audit_pass,
        deny_config_hash: $deny_config_hash,
        doc_hash:         $supply_doc_hash
      },
      malicious: {
        pass_count:    $mal_pass,
        fail_count:    $mal_fail,
        ignored_count: $mal_ignored,
        result_hash:   $mal_result_hash,
        doc_hash:      $threat_doc_hash
      }
    },
    workflows: {
      fuzz:         $wf_fuzz,
      supply_chain: $wf_supply,
      sbom:         $wf_sbom
    },
    config: {
      clippy_toml: $clippy_hash
    },
    lockfiles: {
      cargo_workspace: $lock_workspace,
      cargo_program:   $lock_program
    },
    signed_by: "unsigned-local-stream10-generation"
  }' | jq -S '.' > "$TMP"

# Try cosign keyless signing if available + opted-in.
if [ "${COSIGN_EXPERIMENTAL:-0}" = "1" ] && command -v cosign >/dev/null 2>&1; then
  SIG="$(cosign sign-blob --yes "$TMP" 2>/dev/null || true)"
  if [ -n "$SIG" ]; then
    jq --arg sig "$SIG" '.signed_by = ("cosign-keyless:" + $sig)' "$TMP" \
      | jq -S '.' > "$OUT"
  else
    cp "$TMP" "$OUT"
  fi
else
  cp "$TMP" "$OUT"
fi

echo "[commit] manifest → $OUT" >&2
echo "$OUT"
