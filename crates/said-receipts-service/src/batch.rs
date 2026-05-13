//! Merkle batcher.
//!
//! Runs on a tokio interval. Each tick: drain pending receipts, build
//! a Merkle tree, insert a `batches` row, then publish on-chain.
//!
//! Retry: if Solana publish fails, the batch row exists with
//! `solana_signature IS NULL`. On the next tick `flush_unpublished`
//! resends them. The DB insert (which owns the leaf assignment) is
//! split from the RPC call deliberately — we never want to re-Merkle
//! the same receipts under a different root.

use std::sync::Arc;
use std::time::Duration;

use crate::merkle::build_tree;
use crate::solana::{PublishRequest, SolanaPublisher};
use crate::storage::{Batch, ReceiptsStore};

pub const MAX_BATCH_SIZE: i32 = 10_000;

#[derive(Clone)]
pub struct Batcher {
    pub store: Arc<dyn ReceiptsStore>,
    pub publisher: Arc<dyn SolanaPublisher>,
}

impl Batcher {
    pub fn new(
        store: Arc<dyn ReceiptsStore>,
        publisher: Arc<dyn SolanaPublisher>,
    ) -> Self {
        Self { store, publisher }
    }

    /// Execute one tick end-to-end: assign a batch (if any pending)
    /// and try to publish anything that's still unpublished.
    pub async fn tick(&self) -> anyhow::Result<Option<Batch>> {
        let assigned = self.assign_new_batch().await?;
        self.flush_unpublished().await?;
        Ok(assigned)
    }

    /// Drain pending receipts into a new batch row (no Solana call).
    /// Returns `None` if nothing was pending.
    pub async fn assign_new_batch(&self) -> anyhow::Result<Option<Batch>> {
        let pending = self.store.list_pending(MAX_BATCH_SIZE).await?;
        if pending.is_empty() {
            return Ok(None);
        }

        let leaves: Vec<[u8; 32]> = pending.iter().map(|p| p.receipt_hash).collect();
        let tree = build_tree(&leaves);
        let root = tree.root().ok_or_else(|| anyhow::anyhow!("empty tree"))?;

        let batch = self.store.assign_batch(root, &pending).await?;
        tracing::info!(
            batch_id = batch.id,
            count = batch.count,
            "assigned new batch"
        );
        Ok(Some(batch))
    }

    /// Walk every batch row that hasn't been anchored yet and try to
    /// publish it. Run after `assign_new_batch` so freshly-assigned
    /// batches get their first publish attempt on the same tick.
    pub async fn flush_unpublished(&self) -> anyhow::Result<()> {
        let pending = self.store.list_unpublished_batches().await?;
        for batch in pending {
            let req = PublishRequest {
                root: batch.root,
                count: batch.count as u32,
                period_start_unix: batch.period_start_unix,
                period_end_unix: batch.period_end_unix,
            };
            match self.publisher.publish_root(req).await {
                Ok(sig) => {
                    let now = chrono::Utc::now().timestamp();
                    self.store
                        .mark_batch_published(batch.id, &sig, now)
                        .await?;
                    tracing::info!(batch_id = batch.id, %sig, "published batch on-chain");
                }
                Err(err) => {
                    // Leave solana_signature NULL; next tick retries.
                    tracing::warn!(batch_id = batch.id, %err, "publish failed; will retry");
                }
            }
        }
        Ok(())
    }
}

/// Spawn the batcher loop. Returns immediately; the task runs until
/// the process exits.
pub fn spawn(batcher: Batcher, interval_secs: u64) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(interval_secs));
        // Skip the immediate tick that `interval` fires on construction
        // -- we want one full interval of grace before the first publish.
        tick.tick().await;
        loop {
            tick.tick().await;
            if let Err(err) = batcher.tick().await {
                tracing::error!(%err, "batcher tick failed");
            }
        }
    })
}
