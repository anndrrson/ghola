#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ANDROID_DIR="${ROOT}/android"
APK="${ANDROID_DIR}/app/build/outputs/apk/seeker/debug/app-seeker-debug.apk"
BACKEND="${GHOLA_SHIELDED_POOL_BACKEND:-}"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'missing required command: %s\n' "$1" >&2
    exit 127
  }
}

need cargo
need unzip

if command -v /usr/libexec/java_home >/dev/null 2>&1; then
  export JAVA_HOME="${JAVA_HOME:-$(/usr/libexec/java_home -v 17 2>/dev/null || true)}"
fi

printf '1/7 Rust: checking thumper-cloud shielded rail compile...\n'
(cd "$ROOT" && cargo check -p ghola-cloud)

printf '2/7 Rust: checking Solana shielded-pool health gating...\n'
(cd "$ROOT" && cargo test -p ghola-cloud solana_shielded_pool_runtime_status_requires_account_context --lib)

printf '3/7 Rust: checking Solana relay payload validation and pool-context binding...\n'
(cd "$ROOT" && cargo test -p ghola-cloud solana_shielded_relay_payload --lib)

printf '4/7 Rust: checking no-funds signed fixture canary behavior...\n'
(cd "$ROOT" && cargo test -p ghola-cloud shielded_fixture_canary --lib -- --test-threads=1)

printf '5/7 Android: checking native prover output validation...\n'
(cd "$ANDROID_DIR" && ./gradlew :app:testSeekerDebugUnitTest --tests xyz.ghola.app.solana.ShieldedPoolNativeProverTest)

printf '6/7 Android: assembling Seeker debug APK with shielded-pool native path...\n'
(cd "$ANDROID_DIR" && ./gradlew :app:assembleSeekerDebug)

printf '7/7 APK: verifying shielded-pool artifacts are packaged...\n'
if [[ ! -f "$APK" ]]; then
  printf 'expected APK was not produced: %s\n' "$APK" >&2
  exit 66
fi

apk_listing="$(mktemp)"
unzip -l "$APK" > "$apk_listing"
grep -q 'assets/shielded_pool/transaction.wasm' "$apk_listing" || {
  printf 'APK is missing transaction.wasm\n' >&2
  rm -f "$apk_listing"
  exit 65
}
grep -q 'assets/shielded_pool/transaction.r1cs' "$apk_listing" || {
  printf 'APK is missing transaction.r1cs\n' >&2
  rm -f "$apk_listing"
  exit 65
}
grep -q 'assets/shielded_pool/transaction_final.zkey' "$apk_listing" || {
  printf 'APK is missing transaction_final.zkey\n' >&2
  rm -f "$apk_listing"
  exit 65
}
grep -q 'lib/arm64-v8a/libghola_shielded_pool.so' "$apk_listing" || {
  printf 'APK is missing JNI bridge libghola_shielded_pool.so\n' >&2
  rm -f "$apk_listing"
  exit 65
}
grep -q 'lib/arm64-v8a/libghola_shielded_pool_backend.so' "$apk_listing" || {
  printf 'APK is missing backend libghola_shielded_pool_backend.so\n' >&2
  rm -f "$apk_listing"
  exit 65
}
rm -f "$apk_listing"

if [[ -n "$BACKEND" ]]; then
  printf 'Optional backend verification: %s\n' "$BACKEND"
  "${ROOT}/scripts/security/verify-android-shielded-pool-backend.sh" "$BACKEND"
else
  printf 'Optional backend verification skipped: GHOLA_SHIELDED_POOL_BACKEND is not set.\n'
fi

cat <<'EOF'

Solana shielded-pool unfunded canary passed.

What this proves without devnet funds:
- cloud health stays fail-closed unless the Solana shielded-pool account context is complete
- malformed proof/withdraw payloads and swapped pool accounts are rejected before relayer submission
- signed no-funds settlement fixtures catch receipt tampering
- Android validates native prover output shape before submit
- the Seeker APK packages the proof artifacts, JNI bridge, and backend

What it does not prove:
- the packaged Android Groth16 backend ran on physical Seeker hardware
- a funded devnet withdraw was accepted by the on-chain program
- the relayer broadcast path finalized on Solana

On a Seeker phone, install the APK and run Wallet -> RUN LOCAL PROOF SELF-TEST.
That exercises Seed Vault derivation and the local JNI/prover path without
submitting a transaction.
EOF
