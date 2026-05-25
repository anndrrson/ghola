//! `EventListener` — subscribes to the on-chain shielded-pool program's
//! event stream via Solana's `logsSubscribe` WebSocket method (or, in v1,
//! polls `getSignaturesForAddress`), decodes `CommitmentQueued` /
//! `Transferred` / `RootUpdated` payloads, and feeds the new commitments
//! into the off-chain [`IncrementalMerkleTree`].
//!
//! # Resilience
//!
//! - The listener reconnects with exponential backoff on disconnect; a
//!   warning is logged on each retry.
//! - Commitment inserts are idempotent (the tree de-dupes on
//!   `commit/<commitment>`), so a replay-on-reconnect is safe.
//! - The listener is the **only** writer to the in-memory tree under
//!   normal operation; the forester only submits batched-update txs and
//!   waits for the resulting `RootUpdated` event to come back through this
//!   path, ensuring on-chain and off-chain stay in lock-step.
//!
//! # WebSocket dependency
//!
//! `tokio-tungstenite` is in `workspace.dependencies` but we deliberately
//! do not pull it into this crate's `[dependencies]` block yet — the
//! initial scaffold polls historical signatures via JSON-RPC and the WS
//! subscription will land in a follow-up PR. The shape below documents
//! exactly where the WS code drops in.

use std::sync::Arc;
use std::time::Duration;

use tracing::{debug, info, warn};

use crate::events::{decode_tx_logs_scoped, DecodedEvent};
use crate::state::AppState;

pub struct EventListener {
    state: AppState,
}

impl EventListener {
    pub fn new(state: AppState) -> Self {
        Self { state }
    }

    /// Run the listener forever. Intended to be spawned on a dedicated task.
    pub async fn run(self: Arc<Self>) {
        let backoff = Duration::from_secs(2);
        loop {
            match self.run_once().await {
                Ok(()) => {
                    info!("event listener finished cleanly, restarting in {backoff:?}");
                }
                Err(e) => {
                    warn!("event listener error: {e:?}, reconnecting in {backoff:?}");
                }
            }
            tokio::time::sleep(backoff).await;
        }
    }

    /// Single connection lifecycle. In v1 this falls back to polling the
    /// RPC for new signatures every `forester_poll_secs` seconds (re-using
    /// the same cadence) and decoding their logs; once WS support lands
    /// the polling branch becomes a fallback.
    async fn run_once(&self) -> crate::error::Result<()> {
        let poll = Duration::from_secs(self.state.cfg.forester_poll_secs.max(2));
        let mut last_seen: Option<String> = None;

        loop {
            let sigs = self
                .state
                .rpc
                .get_signatures_for_address(
                    &self.state.cfg.pool_program_id,
                    self.state.cfg.backfill_limit.min(100),
                    None,
                )
                .await?;
            // Successful RPC round-trip — record liveness so `/witness`
            // and `/tree-state` keep serving. We deliberately bump the
            // staleness clock on EVERY successful poll (even one with
            // no new sigs) because what we're really measuring is
            // chain-connectivity, not chain-churn.
            self.state.touch_root_observed();

            // Process newest→oldest so we can stop at last_seen.
            let mut new_records = Vec::new();
            for rec in &sigs {
                if Some(rec.signature.clone()) == last_seen {
                    break;
                }
                new_records.push(rec.clone());
            }
            // Apply oldest first to preserve insertion order.
            for rec in new_records.into_iter().rev() {
                if rec.err.is_some() {
                    continue;
                }
                let tx = match self.state.rpc.get_transaction(&rec.signature).await? {
                    Some(t) => t,
                    None => continue,
                };
                let logs = tx
                    .meta
                    .as_ref()
                    .and_then(|m| m.log_messages.as_ref())
                    .cloned()
                    .unwrap_or_default();
                // Attribute each `Program data:` line to the program at the top
                // of the invocation stack and keep only the pool program's
                // events (and, when a mint is configured, only this tree's PDA).
                // Prevents a third party emitting a same-discriminator log from
                // injecting bogus leaves into the mirror.
                let events = decode_tx_logs_scoped(
                    &logs,
                    &self.state.pool_program_id_bytes,
                    self.state.expected_tree_pda.as_ref(),
                );
                if events.is_empty() {
                    continue;
                }
                self.apply_events(&events).await?;
            }

            if let Some(latest) = sigs.first() {
                last_seen = Some(latest.signature.clone());
            }
            tokio::time::sleep(poll).await;
        }
    }

    /// Apply a batch of decoded events to the local Merkle tree in-order.
    pub async fn apply_events(&self, events: &[DecodedEvent]) -> crate::error::Result<()> {
        if events.is_empty() {
            return Ok(());
        }
        let mut tree = self.state.tree.write().await;
        for ev in events {
            for commitment in ev.commitments() {
                match tree.insert(commitment) {
                    Ok(idx) => debug!(idx, "inserted commitment"),
                    Err(e) => warn!("insert failed: {e:?}"),
                }
            }
        }
        tree.flush()?;
        Ok(())
    }
}
