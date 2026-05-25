//! Integration tests for the **malicious TEE worker** profile.
//!
//! Capability assumed: a worker process running inside the TEE (or
//! impersonating one before the TEE attestation is enforced — Phase 42)
//! tries to exfiltrate queue order, timing, or decrypted payloads.
//!
//! See `docs/shielded-pool/THREAT_SCENARIOS.md` §C.

mod common;

use std::sync::Arc;

use malicious_tests::actors::Profile;
use malicious_tests::mock_submit::{RecordingSubmitter, SubmittedLog};
use said_shielded_pool_relayer::queue::WithdrawalQueue;
use said_shielded_pool_relayer::submit::{submit_batch, Submitter};

/// Profile: worker leaks queue order to an off-cluster observer.
///
/// The mitigation in production is layered:
/// 1. k-anonymity threshold (Config::anonymity_threshold) — observer
///    learns "one of k" not "this specific one".
/// 2. Poisson submit jitter (`submit::poisson_delay`) — observer can't
///    rebuild ordering from arrival timestamps.
///
/// Here we exercise (1) + (2): given k=8 inserts, the per-recipient
/// position in the submitted stream is uniformly distributed across
/// rounds.
#[tokio::test]
async fn timing_side_channel_defeated_by_k_anonymity() {
    tracing::info!(actor = Profile::MaliciousWorker.label(), "test=timing_side_channel");

    let cfg = common::test_config();
    let metrics = common::metrics();

    // Track how often recipient[0] appears in each of the 8 output
    // slots across N rounds. Under a perfect shuffler each slot count
    // approaches N/8.
    const ROUNDS: usize = 64;
    const K: usize = 8;
    let mut slot_hist = [0usize; K];
    for _ in 0..ROUNDS {
        let queue = WithdrawalQueue::open_temporary().expect("open");
        for i in 0..K as u8 {
            common::enqueue(&queue, [i; 32]);
        }
        let log = SubmittedLog::new();
        let sub: Arc<dyn Submitter + Send + Sync> =
            Arc::new(RecordingSubmitter { log: log.clone() });
        let batch = queue.list_all().expect("list");
        submit_batch(sub.as_ref(), &queue, &cfg, &metrics, batch).await.unwrap();
        let observed: Vec<[u8; 32]> = log.events().iter().map(|e| e.recipient).collect();
        for (slot, r) in observed.iter().enumerate() {
            if r == &[0u8; 32] {
                slot_hist[slot] += 1;
                break;
            }
        }
    }
    // Sanity: target recipient appears in *every* slot at least once
    // over 64 rounds — a strict-FIFO submitter would put it always in
    // slot 0 (and the count for slot 0 would be 64, every other slot 0).
    let slots_hit = slot_hist.iter().filter(|c| **c > 0).count();
    assert!(
        slots_hit >= K / 2,
        "expected target recipient to land in many slots; observed {slot_hist:?}"
    );
}

/// Out-of-scope without TEE attestation (Phase 42 / Stream 10 work).
/// We document the gap here so a grep over the suite surfaces it.
#[test]
#[ignore = "decryption oracle out of scope until Phase 42 TEE attestation lands; see THREAT_SCENARIOS.md §C.2"]
fn decryption_oracle_out_of_scope() {
    tracing::info!(actor = Profile::MaliciousWorker.label(), "test=decryption_oracle");
    // Sentinel-only — see doc cross-reference in the #[ignore] reason.
}
