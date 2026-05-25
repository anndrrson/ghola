//! Stream 3 — same-nullifier replay against two different merkle roots.
//!
//! Scenario: the prover constructs two proofs that share the same
//! input-nullifier but are built against two different merkle roots
//! that both live inside the 64-deep history window. Both proofs are
//! individually valid (the nullifier hash is the same regardless of
//! which root they prove inclusion against). On-chain, the first
//! spend's `nullifier_pda` `init` succeeds; the second's `init`
//! collides on the same PDA and fails.
//!
//! Model-level: we don't have a live cluster here, so we mirror the
//! constraint with a `Vec<String>` of accepted nullifiers and assert
//! the second insertion is rejected regardless of which root the proof
//! references.
//!
//! Marked `#[ignore]` for the *true* on-chain variant; the model variant
//! runs by default and matches what `replay_relayer_batch` exercises in
//! a more general form. We keep both files because they're separately
//! reproducible and so that the test names map 1:1 with the
//! `THREAT_SCENARIOS.md` § H (replay vectors) taxonomy.

use std::collections::BTreeSet;

/// Mirror the on-chain `init` collision rule.
fn accept_nullifier(seen: &mut BTreeSet<[u8; 32]>, nullifier: [u8; 32]) -> Result<(), &'static str> {
    if !seen.insert(nullifier) {
        return Err("NullifierAlreadyUsed");
    }
    Ok(())
}

#[test]
fn same_nullifier_two_roots_second_rejected() {
    let mut seen: BTreeSet<[u8; 32]> = BTreeSet::new();
    let nullifier = [7u8; 32];

    // Proof 1: built against root A. (Root not modeled — irrelevant
    // to the nullifier-PDA collision; it would matter for the
    // `RootNotInHistory` check, which is a different vector.)
    accept_nullifier(&mut seen, nullifier).expect("first spend OK");

    // Proof 2: built against root B, same nullifier. On-chain the
    // verifier accepts the proof (correct relative to root B), but
    // the program-level `init nullifier_pda` collides.
    let err = accept_nullifier(&mut seen, nullifier).expect_err("second spend rejected");
    assert_eq!(err, "NullifierAlreadyUsed");

    assert_eq!(seen.len(), 1);
}

#[test]
#[ignore = "requires devnet + real proofs against two roots; covered by double_spend_devnet.ts"]
fn same_nullifier_two_roots_second_rejected_on_devnet() {
    // Placeholder: the actual devnet drill lives in
    // `programs/said-shielded-pool/tests/double_spend_devnet.ts`.
    // Marking ignored so `cargo test -p said-shielded-pool-relayer`
    // doesn't try to hit RPC.
}
