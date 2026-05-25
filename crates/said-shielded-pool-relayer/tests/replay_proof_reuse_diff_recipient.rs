//! Stream 3 — proof-bytes replay with a swapped recipient.
//!
//! Scenario: the network observer captures a (signed-by-relayer)
//! `withdraw` transaction. The proof bytes are public on chain. The
//! attacker tries to construct a new `withdraw` tx with the same
//! `proof_a`, `proof_b`, `proof_c` bytes but a different `recipient`.
//!
//! Defense: the proof's public inputs include `ext_data_hash`, which
//! commits to the recipient. Changing the recipient changes
//! `ext_data_hash`, which changes the public-input vector the verifier
//! computes from the transaction data. The Groth16 verifier then
//! rejects the proof — NOT a "wrong recipient" domain error, but
//! `InvalidProof` from the `groth16-solana` verifier.
//!
//! This test is `#[ignore]`d because:
//!   - It requires a live devnet pool with non-zero escrow.
//!   - The TypeScript drill in `programs/said-shielded-pool/tests/
//!     double_spend_devnet.ts` is the canonical end-to-end check; this
//!     Rust stub is a marker so `grep replay_` lists every scenario.
//!
//! Run with:
//! ```bash
//! cargo test -p said-shielded-pool-relayer \
//!     --test replay_proof_reuse_diff_recipient -- --ignored --nocapture
//! ```

#[tokio::test]
#[ignore = "requires live devnet pool with escrow; see programs/said-shielded-pool/tests/double_spend_devnet.ts"]
async fn proof_bytes_replay_against_new_recipient_fails_with_invalid_proof() {
    // Intentional stub: the devnet harness lives in TypeScript so it
    // can reuse the snarkjs witness-generation pipeline. Replicating
    // that in pure Rust would require a Groth16 prover binding, which
    // we deliberately keep off the relayer dependency surface.
    //
    // The TS drill performs:
    //   1. deposit -> fold -> withdraw to recipient A (success)
    //   2. rebuild the same proof bytes from the same witness
    //   3. submit withdraw with proof bytes from (1) and recipient B
    //   4. assert: InvalidProof (NOT a domain-check error, NOT a
    //      nullifier collision — the verifier itself rejects because
    //      the public-input vector includes ext_data_hash(recipient_B)
    //      which does not match what the proof committed to).
    panic!("see double_spend_devnet.ts");
}
