//! Fuzz target: Anchor ix-data borsh decode for the said-shielded-pool program.
//!
//! The on-chain program (`programs/said-shielded-pool`) deserializes its
//! instruction args via Anchor's borsh-based mechanism. The argument
//! types are fixed-layout: arrays of `[u8; 32]`, `[u8; 64]`, `[u8; 128]`,
//! `u64`, etc. — all primitives that borsh handles natively.
//!
//! We mirror the on-chain Args layout here as plain borsh structs (no
//! anchor dependency, so this target compiles cleanly under the
//! fuzz-package's nightly toolchain). The fuzzer feeds arbitrary
//! bytes into `try_from_slice` for each Args variant.
//!
//! Must NEVER panic on arbitrary input — only return `Err` for
//! truncated / malformed payloads. Panics here would mean a
//! malicious tx could halt the program; even though anchor's
//! deserializer is usually safe, the `ArrayWrapper` newtypes around
//! `[[u8; 32]; FORESTER_BATCH_SIZE]` are a subtle place borsh could
//! mis-step.
//!
//! Coverage focus:
//!   - Truncated payloads (each field cut off mid-byte).
//!   - Oversized payloads (extra trailing data — borsh rejects).
//!   - All-zeros payloads.
//!   - High-entropy random payloads.

#![no_main]

use borsh::BorshDeserialize;
use libfuzzer_sys::fuzz_target;

// ---------- mirror structs (must match programs/said-shielded-pool) ----------
//
// These are intentionally kept thin and dependency-free. If the on-chain
// args layout changes, this file must be regenerated to match —
// otherwise the fuzzer is testing a stale shape.

const FORESTER_BATCH_SIZE: usize = 4;

#[derive(BorshDeserialize)]
struct WithdrawArgs {
    _proof_a: [u8; 64],
    _proof_b: [u8; 128],
    _proof_c: [u8; 64],
    _root: [u8; 32],
    _nullifier: [u8; 32],
    _change_commitment: [u8; 32],
    _amount: u64,
    _relayer_fee: u64,
    _public_amount: [u8; 32],
    _asset_id: [u8; 32],
    _ext_data_hash: [u8; 32],
    _padding_commitment: [u8; 32],
    _input_nullifier_1: [u8; 32],
    // C2 binding: per-output memo commitments. `Vec<[u8;32]>` is a
    // borsh length-prefixed vec — a NEW unbounded-allocation surface the
    // fuzzer should exercise (a huge declared len with a short body must
    // return Err, not OOM/panic).
    _memo_commitments: Vec<[u8; 32]>,
}

#[derive(BorshDeserialize)]
struct TransferArgs {
    _proof_a: [u8; 64],
    _proof_b: [u8; 128],
    _proof_c: [u8; 64],
    _root: [u8; 32],
    _input_nullifiers: [[u8; 32]; 2],
    _output_commitments: [[u8; 32]; 2],
    _public_amount: [u8; 32],
    _asset_id: [u8; 32],
    _ext_data_hash: [u8; 32],
    // C2 binding: per-output memo commitments (length-prefixed vec).
    _memo_commitments: Vec<[u8; 32]>,
}

#[derive(BorshDeserialize)]
struct UpdateRootArgs {
    _proof_a: [u8; 64],
    _proof_b: [u8; 128],
    _proof_c: [u8; 64],
    _old_root: [u8; 32],
    _new_root: [u8; 32],
    _start_index: u64,
    _commitments: [[u8; 32]; FORESTER_BATCH_SIZE],
}

/// Deposit takes `(amount: u64, commitment: [u8; 32])` (positional args
/// rather than a struct in the on-chain handler; borsh-encoded the
/// same way regardless).
#[derive(BorshDeserialize)]
struct DepositArgsTuple {
    _amount: u64,
    _commitment: [u8; 32],
}

fuzz_target!(|data: &[u8]| {
    if data.is_empty() {
        return;
    }
    // Use the first byte as a discriminator-selector across the four
    // arg shapes. Distinct from Anchor's 8-byte SHA discriminator —
    // we're fuzzing the borsh body, not the discriminator dispatch.
    let selector = data[0] % 4;
    let body = &data[1..];

    match selector {
        0 => {
            let _: Result<WithdrawArgs, _> = WithdrawArgs::try_from_slice(body);
        }
        1 => {
            let _: Result<TransferArgs, _> = TransferArgs::try_from_slice(body);
        }
        2 => {
            let _: Result<UpdateRootArgs, _> = UpdateRootArgs::try_from_slice(body);
        }
        _ => {
            let _: Result<DepositArgsTuple, _> = DepositArgsTuple::try_from_slice(body);
        }
    }
});
