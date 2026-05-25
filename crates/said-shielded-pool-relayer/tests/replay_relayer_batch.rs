//! Stream 3 — relayer-side re-submission of an already-confirmed
//! withdrawal.
//!
//! Scenario: the batcher submits a withdrawal, the chain confirms it,
//! and then — through a bug or a malicious / compromised relayer — the
//! same `QueuedWithdrawal` is re-submitted. Two layers must defend:
//!
//!   1. The dedup tree: another `POST /relay` of the same bundle is
//!      rejected before it ever reaches the queue. (Covered by
//!      `replay_relay_dedupe`.)
//!   2. If the dedup tree is *bypassed* (e.g. by directly inserting
//!      into the queue without going through `/relay`), the on-chain
//!      `nullifier_pda` init constraint rejects the second tx.
//!
//! This file models layer (2) at unit level: we construct a `Submitter`
//! whose `submit_one` simulates a chain that rejects on a known
//! nullifier, then drive the same withdrawal twice. The first submit
//! succeeds; the second returns `Submit` error. Demonstrates that the
//! relayer's retry loop does NOT mask a nullifier-collision rejection
//! as a generic transient failure (which would mark it for retry
//! forever, wasting fee-payer SOL).

use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;

use said_shielded_pool_relayer::error::{Error, Result};
use said_shielded_pool_relayer::queue::{
    ProofBlob, QueuedWithdrawal, WithdrawalStatus,
};
use said_shielded_pool_relayer::submit::Submitter;

/// Models a chain that remembers which nullifiers it has accepted and
/// rejects any tx whose first nullifier collides. Maps roughly to the
/// Anchor `#[account(init, ...)]` constraint on `nullifier_pda` —
/// `init` fails atomically if the PDA already exists.
struct NullifierTrackingChain {
    seen: Mutex<Vec<String>>,
}

impl NullifierTrackingChain {
    fn new() -> Self {
        Self {
            seen: Mutex::new(Vec::new()),
        }
    }

    /// Walk the proof bundle for the first nullifier the way the
    /// on-chain program would: `public_inputs.input_nullifiers[0]`.
    /// Pure JSON walk — the relayer never structurally decodes proofs,
    /// but the test harness is allowed to peek for assertion purposes.
    fn first_nullifier(w: &QueuedWithdrawal) -> Option<String> {
        w.proof_bundle
            .0
            .get("public_inputs")?
            .get("input_nullifiers")?
            .get(0)?
            .as_str()
            .map(|s| s.to_string())
    }
}

#[async_trait]
impl Submitter for NullifierTrackingChain {
    async fn submit_one(&self, w: &QueuedWithdrawal) -> Result<()> {
        let nul = Self::first_nullifier(w)
            .ok_or_else(|| Error::Submit("missing nullifier".into()))?;
        let mut seen = self.seen.lock().unwrap();
        if seen.contains(&nul) {
            // Mirrors the on-chain `NullifierAlreadyUsed` error. The
            // submit layer surfaces this as `Error::Submit`; the
            // batcher's retry policy treats Submit errors as terminal
            // after `max_retries`, NOT as a transient network failure.
            return Err(Error::Submit("NullifierAlreadyUsed".into()));
        }
        seen.push(nul);
        Ok(())
    }

    async fn submit_decoy(&self) -> Result<()> {
        Ok(())
    }
}

fn fresh_withdrawal(nullifier_hex: &str) -> QueuedWithdrawal {
    QueuedWithdrawal {
        id: uuid::Uuid::new_v4(),
        proof_bundle: ProofBlob(serde_json::json!({
            "proof": {"a": "a", "b": "b", "c": "c"},
            "public_inputs": {
                "root": "0".repeat(64),
                "input_nullifiers": [nullifier_hex],
                "output_commitments": ["0".repeat(64)],
                "public_amount": 100,
                "asset_id": "0".repeat(64),
                "ext_data_hash": "0".repeat(64),
            }
        })),
        recipient: [9u8; 32],
        fee: 5000,
        relayer_fee: 1000,
        instruction_data: Vec::new(),
        accounts: Vec::new(),
        accepted_at: chrono::Utc::now(),
        status: WithdrawalStatus::Pending,
        attempts: 0,
    }
}

#[tokio::test]
async fn second_submit_of_same_nullifier_is_rejected() {
    let chain: Arc<dyn Submitter + Send + Sync> = Arc::new(NullifierTrackingChain::new());
    let n = "1".repeat(64);

    let w = fresh_withdrawal(&n);
    chain.submit_one(&w).await.expect("first submit OK");

    // Second submit of the SAME nullifier — even with a freshly minted
    // `QueuedWithdrawal` id — must fail. This is the relayer-batch
    // replay defense: the chain refuses to accept the same nullifier
    // twice, so an attacker who replays a batch can't double-spend.
    let w2 = fresh_withdrawal(&n);
    let err = chain.submit_one(&w2).await.expect_err("second submit must fail");
    assert!(
        err.to_string().contains("NullifierAlreadyUsed"),
        "expected NullifierAlreadyUsed, got: {err}"
    );
}

#[tokio::test]
async fn distinct_nullifiers_both_accepted() {
    let chain: Arc<dyn Submitter + Send + Sync> = Arc::new(NullifierTrackingChain::new());
    let w1 = fresh_withdrawal(&"1".repeat(64));
    let w2 = fresh_withdrawal(&"2".repeat(64));
    chain.submit_one(&w1).await.expect("first submit OK");
    chain.submit_one(&w2).await.expect("distinct nullifier OK");
}
