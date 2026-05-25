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
        );

        match decision {
            BatchDecision::Hold => Ok(()),
            BatchDecision::Release { reason, take } => {
                let batch = self.select_batch(&items, take)?;
                // INFO-level: count and reason only. NO ids, recipients, amounts.
                tracing::info!(
                    size = batch.len(),
                    reason = ?reason,
                    "releasing batch"
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
