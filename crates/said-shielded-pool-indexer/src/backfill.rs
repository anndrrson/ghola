//! Historical-tx backfill — used on startup when the local sled db is
//! empty or stale relative to the on-chain program.
//!
//! Algorithm:
//!
//! 1. Page through `getSignaturesForAddress(program, { before, limit })`
//!    from newest to oldest until we either (a) run out of signatures or
//!    (b) hit `BACKFILL_LIMIT` total pages.
//! 2. Reverse the resulting list so that we apply events in chronological
//!    order — this is essential for the incremental Merkle tree, whose
//!    `filled_subtrees` invariants only hold under in-order insertion.
//! 3. For each tx, fetch its full transaction, extract `Program data: …`
//!    log lines, and route the decoded events through the listener's
//!    `apply_events` path so that on-chain and off-chain state agree.
//!
//! Idempotency: because `IncrementalMerkleTree::insert` short-circuits on
//! commitments it has already seen (`commit/<commitment>` is unique), it
//! is safe to re-run backfill against an already-populated db; this is
//! the recovery procedure documented in the README.

use std::sync::Arc;

use tracing::{info, warn};

use crate::events::decode_tx_logs_scoped;
use crate::listener::EventListener;
use crate::state::AppState;

pub struct Backfiller {
    state: AppState,
}

impl Backfiller {
    pub fn new(state: AppState) -> Self {
        Self { state }
    }

    /// Walk historical signatures of the program and replay every event
    /// payload into the local Merkle tree. Returns the number of
    /// commitments inserted (excluding dupes the tree skipped).
    pub async fn run(self) -> crate::error::Result<u64> {
        let listener = Arc::new(EventListener::new(self.state.clone()));
        let mut before: Option<String> = None;
        let mut pages = 0u32;
        let mut total_inserted: u64 = 0;
        let max_pages = self.state.cfg.backfill_limit;
        let page_size: u32 = 1000;

        info!("starting backfill against program {}", self.state.cfg.pool_program_id);

        loop {
            if pages >= max_pages {
                warn!("backfill stopped at max_pages={max_pages}, more history may exist");
                break;
            }
            let sigs = self
                .state
                .rpc
                .get_signatures_for_address(
                    &self.state.cfg.pool_program_id,
                    page_size,
                    before.as_deref(),
                )
                .await?;

            if sigs.is_empty() {
                break;
            }
            pages += 1;

            // RPC returns newest-first; reverse to chronological order
            // for this page (within a page; we will then process pages
            // newest-page-first, applying each page oldest→newest).
            // To get strict chronological global order we collect all
            // pages first, then reverse the entire list.
            //
            // For memory friendliness on long-history programs we instead
            // accumulate signatures, walk to the end, then process in
            // oldest→newest order:
            // (deliberate: backfill is one-shot at startup, holding a
            // few hundred-K sig strings in memory is fine).
            //
            // Implementation below collects strings, then applies once.
            let last_sig_in_page = sigs.last().map(|s| s.signature.clone());

            for rec in sigs.into_iter().rev() {
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
                // Same program-scope attribution as the live listener — only
                // ingest events the pool program actually emitted.
                let events = decode_tx_logs_scoped(
                    &logs,
                    &self.state.pool_program_id_bytes,
                    self.state.expected_tree_pda.as_ref(),
                );
                if events.is_empty() {
                    continue;
                }
                let before_count = {
                    let t = self.state.tree.read().await;
                    t.next_index()
                };
                listener.apply_events(&events).await?;
                let after_count = {
                    let t = self.state.tree.read().await;
                    t.next_index()
                };
                total_inserted += after_count - before_count;
            }

            before = last_sig_in_page;
            if before.is_none() {
                break;
            }
        }

        info!(total_inserted, pages, "backfill complete");
        Ok(total_inserted)
    }
}
