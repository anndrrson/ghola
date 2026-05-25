# Android Mobile Prover Backend Contract

The Seeker app loads `libghola_shielded_pool.so` from Kotlin and that JNI
bridge dynamically calls a backend shared library for local Groth16 proof
construction. Development builds package a fail-closed stub backend. Production
local proving requires an `arm64-v8a` backend `.so` that exports the ABI below.

## Build Selection

Default development build:

```bash
cd android
./gradlew :app:assembleSeekerDebug
```

Production-style build with a real backend:

```bash
cd android
./gradlew :app:assembleSeekerDebug \
  -PgholaShieldedPoolBackend=/absolute/path/libghola_shielded_pool_backend.so
```

Equivalent environment variable:

```bash
GHOLA_SHIELDED_POOL_BACKEND=/absolute/path/libghola_shielded_pool_backend.so \
  ./gradlew :app:assembleSeekerDebug
```

CMake fails the build if the file is missing or does not export
`ghola_shielded_pool_prove_to_file`.

## Reference Backend Crate

The repo now includes `crates/ghola-shielded-pool-mobile-backend`, which
exports the exact Android ABI as `libghola_shielded_pool_backend`.

Default feature set:

- returns a safe self-test response
- fails closed for real proofs
- does not pull the server prover stack into a mobile build

Host reference feature:

```bash
cargo test -p ghola-shielded-pool-mobile-backend --lib
cargo test -p ghola-shielded-pool-mobile-backend --features host-snarkjs --lib
cargo test -p ghola-shielded-pool-mobile-backend --features host-snarkjs \
  host_snarkjs_reference_generates_groth16_output --lib -- --ignored --nocapture
```

`host-snarkjs` builds the witness input with the same Rust mapper used by the
prover service, runs `snarkjs wtns calculate` and `snarkjs groth16 prove`, then
serializes the proof into the Android/cloud flattened `proof_bundle` shape and
builds the Anchor `withdraw` instruction bytes. It is not a production Android
backend because it shells out to Node/snarkjs.

Rust mobile backend feature:

```bash
cargo test -p ghola-shielded-pool-mobile-backend --features mobile-arkworks --lib
cargo test -p ghola-shielded-pool-mobile-backend --features mobile-arkworks \
  mobile_arkworks_reference_generates_groth16_output --lib -- --ignored --nocapture
scripts/build-android-shielded-pool-backend.sh
```

`mobile-arkworks` builds the same witness input in memory, uses the packaged
Circom `transaction.wasm` and `transaction.r1cs`, parses
`transaction_final.zkey`, constructs a Groth16 proof with arkworks, verifies it
locally, serializes the proof into the Solana on-chain byte order, and builds
the Anchor `withdraw` instruction. The produced
`target/aarch64-linux-android/release/libghola_shielded_pool_backend.so` is the
prebuilt backend path to pass into Gradle.

## Required ABI

```c
int ghola_shielded_pool_prove_to_file(
    const char *transfer_witness_json,
    const char *artifact_dir,
    const char *output_json_path,
    char *error_buf,
    size_t error_buf_len);
```

Inputs:

- `transfer_witness_json`: Rust-shaped `TransferWitness` JSON. Contains secret
  inputs and must not be logged or persisted outside the backend work directory.
  Production Android witnesses include private metadata under
  `_ghola_meta.solana_context`:
  - `program_id`
  - `mint`
  - `pool_config`
  - `verifier_key`
  - `merkle_tree`
  - `escrow`
  - `token_program`
  - `system_program`
  - optional `relayer_payer`
  - optional `relayer_token_account`
  - optional `recipient_token_account`
  - optional `change_commitment`
  - optional `queue_tail` or `next_index`, used to derive the
    `change_commitment` PDA when the PDA is not supplied directly
  - optional `tree_id`
  - `account_order`, documenting the Anchor withdraw account order expected by
    the relayer payload
- `artifact_dir`: contains `transaction.wasm`, `transaction.r1cs`, and
  `transaction_final.zkey`.
- `output_json_path`: backend writes UTF-8 JSON here on success.
- `error_buf`: backend writes a human-readable failure reason here on non-zero
  return.

Required success output:

```json
{
  "proof_bundle": {
    "a": "<64 bytes hex>",
    "b": "<128 bytes hex>",
    "c": "<64 bytes hex>",
    "root": "<32 bytes hex>",
    "input_nullifiers": ["<32 bytes hex>"],
    "output_commitments": ["<32 bytes hex>"],
    "public_amount": 1,
    "asset_id": "<32 bytes hex>",
    "ext_data_hash": "<32 bytes hex>"
  },
  "nullifier_hex": "<32 bytes hex>",
  "withdraw_instruction": {
    "data_hex": "<Anchor withdraw ix bytes hex>",
    "accounts": [
      {
        "pubkey": "<32-byte Solana pubkey base58>",
        "is_signer": false,
        "is_writable": true
      }
    ]
  },
  "fee": 0,
  "relayer_fee": 0,
  "proof_b64": "<optional base64 proof encoding>"
}
```

The Android client and cloud submit hook both validate this shape before
submission. Malformed output fails closed; there is no public USDC fallback.

## Cloud Runtime Configuration

`/health/payments` only advertises `solana_shielded_pool.ready=true` when these
environment variables are configured:

- `SOLANA_SHIELDED_POOL_ENABLED=true`
- `SOLANA_SHIELDED_POOL_PROGRAM_ID`
- `SOLANA_SHIELDED_POOL_PROVER_URL`
- `SOLANA_SHIELDED_POOL_RELAYER_URL`
- `SOLANA_SHIELDED_POOL_MINT`
- `SOLANA_SHIELDED_POOL_POOL_CONFIG`
- `SOLANA_SHIELDED_POOL_VERIFIER_KEY`
- `SOLANA_SHIELDED_POOL_MERKLE_TREE`
- `SOLANA_SHIELDED_POOL_ESCROW`

Optional:

- `SOLANA_SHIELDED_POOL_INDEXER_URL`
- `SOLANA_SHIELDED_POOL_TOKEN_PROGRAM`
- `SOLANA_SHIELDED_POOL_SYSTEM_PROGRAM`
- `SOLANA_SHIELDED_POOL_RELAYER_PAYER`
- `SOLANA_SHIELDED_POOL_RELAYER_TOKEN_ACCOUNT`
- `SOLANA_SHIELDED_POOL_TREE_ID`

## Local Verification

```bash
scripts/security/verify-android-shielded-pool-backend.sh \
  /absolute/path/libghola_shielded_pool_backend.so
```

This checks the `.so` exists, is an ARM64 Android ELF, and exports
`ghola_shielded_pool_prove_to_file`.

## Current State And Remaining Validation

The ABI, output contract, Rust Groth16 proof construction, ARM64 Android
cross-compile, and APK packaging path are implemented. The remaining production
gate is physical Seeker validation: install an APK built with the
`mobile-arkworks` backend, run the local proof self-test on-device, measure
proof time/memory, and confirm Android runtime policy accepts the Wasmer-backed
WASM witness execution before enabling the rail.
