//! Stream 3 — withdraw against a stale (rotated-out) merkle root.
//!
//! Scenario: the pool keeps a 64-deep ring buffer of recent merkle
//! roots in `root_history`. A proof built against root N is accepted
//! as long as N is still in the buffer; once 64 batched updates have
//! rotated N out, the same proof fails the `RootNotInHistory` check.
//!
//! This vector exists because an attacker who archives a proof for
//! months might try to replay it later, hoping the program forgot the
//! root invalidation rule. It also matters for honest clients: a
//! long-pending proof can become stale, in which case the client must
//! re-prove against a current root.
//!
//! Marked `#[ignore]` because executing it requires:
//!   1. A pool with at least 64 batched updates since the proof was
//!      built (otherwise the root is still in history).
//!   2. The relayer's keypair funded for the failed-tx fee.
//!
//! The expected error is the program-level `RootNotInHistory` —
//! distinct from `InvalidProof` (which is a verifier-level error) and
//! distinct from `NullifierAlreadyUsed` (which would require the
//! nullifier to have been spent successfully against a fresher root,
//! which can't happen in this scenario by construction).

#[tokio::test]
#[ignore = "requires devnet pool with >=64 batched updates past the proof root"]
async fn withdraw_against_stale_root_returns_root_not_in_history() {
    // See `programs/said-shielded-pool/tests/double_spend_devnet.ts` for
    // the canonical end-to-end exercise. This file documents the
    // scenario so the THREAT_SCENARIOS.md § H taxonomy stays grep-able.
    panic!("see double_spend_devnet.ts");
}
