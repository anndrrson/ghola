#pragma once

#include <stddef.h>

// Optional mobile Groth16 backend ABI.
//
// Package a backend shared library as:
//   android/app/src/main/jniLibs/arm64-v8a/libghola_shielded_pool_backend.so
//
// and export:
//   int ghola_shielded_pool_prove_to_file(
//       const char *transfer_witness_json,
//       const char *artifact_dir,
//       const char *output_json_path,
//       char *error_buf,
//       size_t error_buf_len);
//
// The backend must:
// - read packaged proof artifacts from artifact_dir. The Rust arkworks
//   backend uses transaction.wasm, transaction.r1cs, and transaction_final.zkey.
// - produce the Groth16 proof locally on-device
// - build the withdraw instruction payload
// - write output_json_path as UTF-8 JSON with:
//     proof_bundle
//     nullifier_hex
//     withdraw_instruction: { data_hex, accounts[] }
//     optional fee, relayer_fee, proof_b64
// - return 0 on success, non-zero on failure
//
// Ownership stays simple: the caller owns all buffers and files. The backend
// must not retain witness_json pointers or write secrets outside its temp work
// directory.
//
// SECRET-HANDLING CONTRACT (H2). transfer_witness_json contains the spending
// key and input-note secrets in plaintext. A production backend:
//   - MUST treat the witness as a caller-owned in-memory buffer and feed it to
//     the witness generator from memory. It MUST NOT write transfer_witness_json
//     (or any derivative containing the spending key) to a file. The fail-closed
//     stub currently writes input.json only because it never proves; that path
//     is NOT acceptable for a real prover.
//   - MUST zero its own working copies of the witness/secrets (e.g. via
//     explicit_bzero / memset_s) before returning, on every path including
//     error paths, so the spending key does not linger in the backend's heap.
//   - MUST keep any unavoidable scratch (e.g. snarkjs .wtns) inside a workdir
//     under artifact_dir, unlink it immediately after open where possible, and
//     overwrite-then-unlink before returning. The Kotlin caller
//     (ShieldedPoolNativeProver.secureScrubWorkdir) also wipes leftover scratch
//     as defense-in-depth, but the backend must not rely on that.
extern "C" typedef int (*ghola_shielded_pool_prove_to_file_fn)(
    const char *transfer_witness_json,
    const char *artifact_dir,
    const char *output_json_path,
    char *error_buf,
    size_t error_buf_len
);
