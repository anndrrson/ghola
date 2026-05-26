//! Background batcher task.
//!
//! Polls the persistent queue on a tick. When the policy in
//! [`crate::queue::decide_batch`] says "release", it marks the chosen
//! items `Batched` and hands them off to the submitter.

use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use tokio::sync::Notify;

use crate::config::Config;
use crate::error::Result;
use crate::metrics::Metrics;
use crate::queue::{decide_batch, BatchDecision, QueuedWithdrawal, WithdrawalQueue, WithdrawalStatus};
use crate::submit::Submitter;

/// Period at which the batcher wakes to re-evaluate the queue policy.
/// This is independent of `min_delay` / `max_delay` — those are policy
/// thresholds, the tick is just the granularity. 1s is plenty.
const TICK: Duration = Duration::from_secs(1);

pub struct Batcher {
    queue: WithdrawalQueue,
    config: Arc<Config>,
    submitter: Arc<dyn Submitter + Send + Sync>,
    metrics: Arc<Metrics>,
    /// Optional notification handle so `/relay` can poke the batcher
    /// immediately when an insert crosses the threshold (avoids worst-case
    /// 1s tick latency on the happy path).
    pub(crate) wake: Arc<Notify>,
}

impl Batcher {
    pub fn new(
        queue: WithdrawalQueue,
        config: Arc<Config>,
        submitter: Arc<dyn Submitter + Send + Sync>,
        metrics: Arc<Metrics>,
    ) -> Self {
        Self {
            queue,
            config,
            submitter,
            metrics,
            wake: Arc::new(Notify::new()),
        }
    }

    /// Background loop. Cancel by dropping the JoinHandle / aborting the task.
    pub async fn run(self) {
        loop {
            tokio::select! {
                _ = tokio::time::sleep(TICK) => {}
                _ = self.wake.notified() => {}
            }

            if let Err(e) = self.tick().await {
                // Privacy: log only that a tick failed, not which item.
                tracing::warn!(error = %e, "batcher tick failed");
            }
        }
    }

    async fn tick(&self) -> Result<()> {
        let items = self.queue.list_all()?;
        let pending_depth = items
            .iter()
            .filter(|w| matches!(w.status, WithdrawalStatus::Pending))
            .count();
        self.metrics.set_queue_depth(pending_depth);

        let decision = decide_batch(
            Utc::now(),
            &items,
            self.config.anonymity_threshold,
            self.config.batch_size,
            self.config.min_delay,
            self.config.max_delay,
            self.config.relay_k_min,
            self.config.release_below_kmin,
        );

        match decision {
            BatchDecision::Hold => Ok(()),
            BatchDecision::HoldBelowKMin { available } => {
                // V3: the safety valve fired but we are below k_min and the
                // operator chose anonymity over liveness. This is NOT
                // routine — the withdrawal is being delayed past max_delay
                // to protect the sender. Surface it at WARN so operators
                // notice a thin-traffic stall (and the available count is
                // NOT a per-withdrawal leak — it's the same coarse depth
                // already exposed via /metrics). The privacy-sensitive
                // detail (which item) is never logged.
                tracing::warn!(
                    k_min = self.config.relay_k_min,
                    "batch held below k_min past max_delay \
                     (RELAY_RELEASE_BELOW_KMIN=false): favouring sender \
                     anonymity over liveness; raise traffic or flip the flag"
                );
                let _ = available; // available is debug-only context
                tracing::debug!(available, "held-below-k_min detail");
                Ok(())
            }
            BatchDecision::Release { reason, take, degraded } => {
                let batch = self.select_batch(&items, take)?;
                // M3 (privacy): keep INFO generic — NO size, NO reason, NO
                // ids/recipients/amounts. The exact anonymity-set size and
                // the release reason (threshold vs timeout) are a
                // side-channel: an observer with log access could use a
                // timeout release with size < k to narrow the set. Demote
                // both to DEBUG, consistent with the dedup module's
                // privacy-logging rule.
                tracing::info!("releasing batch");
                if degraded {
                    // V3: liveness chosen — we are releasing a batch below
                    // k_min. NEVER silent. We log the configured k_min (a
                    // static config value, not per-withdrawal data) so the
                    // operator can see the degradation, but NOT the actual
                    // batch size (that exact value is the side-channel).
                    tracing::warn!(
                        k_min = self.config.relay_k_min,
                        "privacy degraded: released batch below k_min \
                         (RELAY_RELEASE_BELOW_KMIN=true); sender anonymity \
                         set may be as small as 1 at this traffic level"
                    );
                }
                tracing::debug!(
                    size = batch.len(),
                    reason = ?reason,
                    degraded,
                    "releasing batch (detail)"
                );
                self.metrics.observe_anonymity_set(batch.len());
                self.submit_batch(batch).await
            }
        }
    }

    fn select_batch(
        &self,
        items: &[QueuedWithdrawal],
        take: usize,
    ) -> Result<Vec<QueuedWithdrawal>> {
        // Take the oldest `take` pending items, mark Batched in storage,
        // and return owned copies.
        let mut out = Vec::with_capacity(take);
        for w in items.iter().filter(|w| matches!(w.status, WithdrawalStatus::Pending)) {
            if out.len() >= take {
                break;
            }
            self.queue.set_status(w.id, WithdrawalStatus::Batched)?;
            let mut owned = w.clone();
            owned.status = WithdrawalStatus::Batched;
            out.push(owned);
        }
        Ok(out)
    }

    async fn submit_batch(&self, batch: Vec<QueuedWithdrawal>) -> Result<()> {
        // We do NOT reveal which item won which slot in the batch — the
        // submitter shuffles internally (see `submit::submit_batch`).
        let submitter = self.submitter.clone();
        let queue = self.queue.clone();
        let config = self.config.clone();
        let metrics = self.metrics.clone();

        tokio::spawn(async move {
            if let Err(e) = crate::submit::submit_batch(
                submitter.as_ref(),
                &queue,
                &config,
                metrics.as_ref(),
                batch,
            )
            .await
            {
                tracing::warn!(error = %e, "batch submission failed");
            }
        });
        Ok(())
    }
}
