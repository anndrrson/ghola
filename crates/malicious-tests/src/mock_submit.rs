//! Mock [`Submitter`] implementations modelling malicious-relayer
//! behaviours.
//!
//! Each variant in this module impersonates the relayer's submission
//! layer with one specific defect (drop-on-blacklist, reorder, infinite
//! hold, …) so the integration tests can exercise the client-side
//! recovery without spinning a real RPC.
//!
//! The mocks all implement [`Submitter`] so they slot into
//! `submit_batch` interchangeably with `RpcSubmitter`. We keep the
//! state inspectable (e.g. [`SubmittedLog::events`]) so a test can
//! assert *what* happened in addition to status outcomes.

use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use said_shielded_pool_relayer::error::Result as RelayerResult;
use said_shielded_pool_relayer::queue::QueuedWithdrawal;
use said_shielded_pool_relayer::submit::Submitter;

/// A timestamped record of a submission seen by a mock submitter.
#[derive(Clone, Debug)]
pub struct SubmissionEvent {
    /// Queue id of the withdrawal as it was offered to `submit_one`.
    pub id: uuid::Uuid,
    /// Recipient bytes (NOT logged anywhere else in the suite).
    pub recipient: [u8; 32],
    /// Monotonic wall-clock when the call was observed.
    pub observed_at: std::time::Instant,
    /// `true` iff the mock returned `Ok(())` (so the relayer marked
    /// the row `Confirmed`).
    pub succeeded: bool,
}

/// Append-only log of [`SubmissionEvent`]s, shared across all mock
/// submitters. Tests inspect it after the action to check ordering,
/// censorship, or delay.
#[derive(Default, Clone)]
pub struct SubmittedLog {
    inner: std::sync::Arc<Mutex<Vec<SubmissionEvent>>>,
}

impl SubmittedLog {
    /// Empty log.
    pub fn new() -> Self {
        Self::default()
    }

    /// Append a new event.
    pub fn push(&self, ev: SubmissionEvent) {
        self.inner.lock().expect("submitted log poisoned").push(ev);
    }

    /// Snapshot the current log (clone of the inner vec).
    pub fn events(&self) -> Vec<SubmissionEvent> {
        self.inner.lock().expect("submitted log poisoned").clone()
    }

    /// Count of *successful* submissions.
    pub fn confirmed_count(&self) -> usize {
        self.events().iter().filter(|e| e.succeeded).count()
    }
}

/// Submitter that silently drops withdrawals whose recipient is on a
/// blacklist. Used by the `drop_specific_recipient` test.
pub struct BlacklistDropSubmitter {
    /// Recipients we will silently fail (the relayer marks them
    /// `Failed` after max_retries — we never actually submit).
    pub blacklist: Vec<[u8; 32]>,
    pub log: SubmittedLog,
}

#[async_trait]
impl Submitter for BlacklistDropSubmitter {
    async fn submit_one(&self, w: &QueuedWithdrawal) -> RelayerResult<()> {
        let blocked = self.blacklist.iter().any(|r| r == &w.recipient);
        let ev = SubmissionEvent {
            id: w.id,
            recipient: w.recipient,
            observed_at: std::time::Instant::now(),
            succeeded: !blocked,
        };
        self.log.push(ev);
        if blocked {
            // Return an opaque error — the relayer's retry loop will
            // exhaust attempts and mark the row Failed. The
            // adversarial relayer never tells the client *why*.
            return Err(said_shielded_pool_relayer::error::Error::Submit(
                "rpc unreachable".into(),
            ));
        }
        Ok(())
    }

    async fn submit_decoy(&self) -> RelayerResult<()> {
        Ok(())
    }
}

/// Submitter that succeeds but never within `min_delay` — used by the
/// `delay_indefinitely` test (we cap at "the test is willing to wait
/// this long" rather than truly infinite to keep CI sane).
pub struct StallingSubmitter {
    pub stall: Duration,
    pub log: SubmittedLog,
}

#[async_trait]
impl Submitter for StallingSubmitter {
    async fn submit_one(&self, w: &QueuedWithdrawal) -> RelayerResult<()> {
        tokio::time::sleep(self.stall).await;
        self.log.push(SubmissionEvent {
            id: w.id,
            recipient: w.recipient,
            observed_at: std::time::Instant::now(),
            succeeded: true,
        });
        Ok(())
    }

    async fn submit_decoy(&self) -> RelayerResult<()> {
        Ok(())
    }
}

/// Submitter that records the order it sees `submit_one` calls in.
/// Useful for the `reorder_batches` privacy test where we assert that
/// the batcher had already shuffled the batch (so the submission
/// order is uncorrelated with the queue-insertion order).
pub struct RecordingSubmitter {
    pub log: SubmittedLog,
}

#[async_trait]
impl Submitter for RecordingSubmitter {
    async fn submit_one(&self, w: &QueuedWithdrawal) -> RelayerResult<()> {
        self.log.push(SubmissionEvent {
            id: w.id,
            recipient: w.recipient,
            observed_at: std::time::Instant::now(),
            succeeded: true,
        });
        Ok(())
    }

    async fn submit_decoy(&self) -> RelayerResult<()> {
        Ok(())
    }
}
