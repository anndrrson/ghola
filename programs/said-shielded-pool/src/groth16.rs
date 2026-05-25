//! Groth16 verifier wrapper.
//!
//! The on-chain verifier uses Solana's `alt_bn128` precompiles via the
//! `groth16-solana` crate (https://github.com/Lightprotocol/groth16-solana).
//!
//! Public input layout — MUST stay in sync with both `circuits/transaction.circom`
//! and `crates/said-shielded-pool-types::PublicInputs`:
//!
//!   index | name              | source
//!   ------|-------------------|---------------------------------
//!     0   | root              | MerkleTree.root or root_history
//!     1   | in_nullifier_0    | written to NullifierAccount PDA
//!     2   | in_nullifier_1    | written to NullifierAccount PDA
//!     3   | out_commitment_0  | appended to CommitmentRecord queue
//!     4   | out_commitment_1  | appended to CommitmentRecord queue
//!     5   | public_amount     | signed amount (mod p); + = withdraw, − = deposit
//!         |                   | (conservation: sum(in) === sum(out) + public_amount;
//!         |                   |  withdraw spends an input → +amount; deposit adds an
//!         |                   |  output → −amount = r−amount; transfer = 0)
//!     6   | asset_id          | Poseidon(mint_pubkey)
//!     7   | ext_data_hash     | Poseidon of relayer/recipient/fee bindings
//!
//! All field elements are 32-byte BN254 elements, big-endian.

use anchor_lang::prelude::*;

use crate::error::ShieldedPoolError;
use crate::state::NUM_PUBLIC_INPUTS;

/// Strongly-typed bundle assembled by each instruction handler before
/// calling [`verify`].
pub struct VerifyInputs<'a> {
    /// Proof point A — uncompressed G1, 64 bytes (x || y), big-endian.
    pub proof_a: &'a [u8; 64],
    /// Proof point B — uncompressed G2, 128 bytes, big-endian.
    pub proof_b: &'a [u8; 128],
    /// Proof point C — uncompressed G1, 64 bytes, big-endian.
    pub proof_c: &'a [u8; 64],
    /// Public inputs, in the order documented above.
    pub public_inputs: &'a [[u8; 32]; NUM_PUBLIC_INPUTS],
    /// Encoded verifier key (raw bytes from the `VerifierKey` PDA).
    pub verifier_key: &'a [u8],
}

/// Selects which compiled-in verifying key to use.
///
/// The shielded pool has two distinct Groth16 circuits:
///   - `Transfer` — the 2-in/2-out spend/deposit/withdraw circuit
///     (`circuits/transaction.circom`), vk in [`crate::verifying_key`].
///   - `Forester` — the batched commitment-insertion circuit
///     (`circuits/batchedUpdate.circom`), vk in
///     [`crate::forester_verifying_key`]. Only used by
///     `update_root_via_proof`.
///
/// Both circuits intentionally declare `nPublic == 8` so we can keep one
/// `NUM_PUBLIC_INPUTS` constant and one shared `VerifyInputs` shape; the
/// forester circuit pads its 7th slot with a binding-only zero (see
/// `circuits/batchedUpdate.circom`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CircuitKind {
    Transfer,
    Forester,
}

/// Verifies a Groth16 proof against the on-chain verifier key.
///
/// Returns `Ok(())` on success, `Err(InvalidProof)` otherwise.
///
/// The implementation is feature-gated:
///  - With `--features real-verifier`, the call dispatches into
///    `groth16-solana` and consumes the BN254 syscalls (~200k CU).
///  - Without it (default for the Phase 36/37 scaffold), the function
///    returns `Ok(())` so integration tests can drive the account
///    state machine before the prover + verifying key are wired in.
///    Phase 38 flips the feature on for staging + mainnet artifacts.
pub fn verify(inputs: VerifyInputs<'_>) -> Result<()> {
    verify_with_kind(inputs, CircuitKind::Transfer)
}

/// Verify a proof against the forester (batched commitment-insertion) vk.
///
/// Public input layout (forester): see
/// `programs/said-shielded-pool/src/instructions/update_root.rs`.
pub fn verify_forester(inputs: VerifyInputs<'_>) -> Result<()> {
    verify_with_kind(inputs, CircuitKind::Forester)
}

fn verify_with_kind(inputs: VerifyInputs<'_>, kind: CircuitKind) -> Result<()> {
    // Defensive sanity check that callers built the input vector right.
    if inputs.public_inputs.len() != NUM_PUBLIC_INPUTS {
        return err!(ShieldedPoolError::BadPublicInputs);
    }

    #[cfg(feature = "real-verifier")]
    {
        use groth16_solana::groth16::Groth16Verifier;

        // SECURITY MODEL (H2): the verifying key is COMPILED INTO the
        // program binary (Light Protocol pattern). Verification is ALWAYS
        // performed against `crate::verifying_key::VERIFYING_KEY` /
        // `crate::forester_verifying_key::VERIFYING_KEY`. The on-chain
        // `VerifierKey` PDA carries a copy of these bytes only as a
        // governance / transparency artifact; we deliberately do NOT
        // deserialize a verifying key from admin-supplied PDA bytes,
        // because (a) `groth16-solana 0.2.0`'s `Groth16Verifyingkey`
        // borrows its `vk_ic` slice with a lifetime awkward to satisfy
        // from a runtime buffer under the BPF stack ceiling, and (b) a
        // parser over an unpinned byte layout is itself an attack surface.
        //
        // **Rotating the VK therefore requires a PROGRAM UPGRADE + a fresh
        // trusted-setup ceremony.** There is intentionally NO on-chain
        // VK-rotation governance path (the previously-cosmetic
        // propose/accept_vk_rotation flow was removed — see
        // `instructions::governance`). Tamper-detection of the PDA copy is
        // via the SHA-256 hash stored in `PoolConfig::verifier_key_hash`.
        let _ = inputs.verifier_key;
        let vk = match kind {
            CircuitKind::Transfer => &crate::verifying_key::VERIFYING_KEY,
            CircuitKind::Forester => &crate::forester_verifying_key::VERIFYING_KEY,
        };

        let mut verifier = Groth16Verifier::new(
            inputs.proof_a,
            inputs.proof_b,
            inputs.proof_c,
            inputs.public_inputs,
            vk,
        )
        .map_err(|_| error!(ShieldedPoolError::InvalidProof))?;

        verifier
            .verify()
            .map_err(|_| error!(ShieldedPoolError::InvalidProof))?;

        Ok(())
    }

    #[cfg(not(feature = "real-verifier"))]
    {
        // Stub path — proof bytes are accepted unconditionally so that
        // integration tests can exercise account-state transitions
        // without a real prover. NEVER deploy a binary built without
        // `--features real-verifier` to a live network.
        msg!(
            "shielded-pool: real-verifier feature DISABLED — accepting proof without verification (kind={:?})",
            kind
        );
        let _ = (inputs.proof_a, inputs.proof_b, inputs.proof_c, inputs.verifier_key);
        Ok(())
    }
}

/// Compute SHA-256 of the verifier key bytes. Used by `init_pool` /
/// `update_verifier_key` to detect tampering and let light clients pin
/// the active vk without downloading it.
pub fn hash_verifier_key(bytes: &[u8]) -> [u8; 32] {
    anchor_lang::solana_program::hash::hash(bytes).to_bytes()
}
