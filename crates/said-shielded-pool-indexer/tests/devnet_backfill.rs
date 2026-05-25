//! Devnet backfill smoke test.
//!
//! Pulls the most recent batch of signatures for the deployed shielded-pool
//! program on Solana devnet, fetches each transaction, decodes every
//! `Program data: <base64>` log line, and asserts that:
//!
//! 1. No borsh decode panics on the events we currently know about.
//! 2. At least the listener loop "does the right thing" with whatever events
//!    are present (zero events is acceptable — the prior e2e run aborted
//!    before emitting `CommitmentQueued`; the value of this test is that
//!    decoding does not blow up regardless).
//!
//! Marked `#[ignore]` so CI does not hit external network. Run manually with:
//!
//! ```sh
//! cargo test -p said-shielded-pool-indexer --test devnet_backfill -- --ignored --nocapture
//! ```

use std::time::{Duration, Instant};

use said_shielded_pool_indexer::events::{decode_program_data_line, DecodedEvent};
use said_shielded_pool_indexer::solana::SolanaRpcClient;

const DEVNET_RPC: &str = "https://api.devnet.solana.com";
const POOL_PROGRAM_ID: &str = "5bmCDeaQceBpWgK8aADB4Tz4JzqZ9hkCi3qedC6oZR8A";
/// Stop after this many signatures even if we have time budget left — the
/// goal is a smoke test, not a full archival replay.
const MAX_SIGNATURES: usize = 50;
/// Wall-clock budget for the whole test. RPC nodes can be slow.
const BUDGET: Duration = Duration::from_secs(45);

#[tokio::test]
#[ignore = "hits external network (Solana devnet)"]
async fn devnet_backfill_decodes_without_panic() {
    let rpc = SolanaRpcClient::new(DEVNET_RPC);
    let start = Instant::now();

    eprintln!(
        "fetching recent signatures for {} from {}",
        POOL_PROGRAM_ID, DEVNET_RPC
    );

    let sigs = rpc
        .get_signatures_for_address(POOL_PROGRAM_ID, MAX_SIGNATURES as u32, None)
        .await
        .expect("getSignaturesForAddress");
    eprintln!("got {} signatures", sigs.len());

    let mut total_program_data_lines = 0usize;
    let mut total_decoded = 0usize;
    let mut kind_counts: std::collections::BTreeMap<&'static str, usize> =
        Default::default();
    let mut commitments_seen: Vec<String> = Vec::new();

    for (i, rec) in sigs.iter().enumerate() {
        if start.elapsed() > BUDGET {
            eprintln!("budget exceeded after {} sigs, stopping early", i);
            break;
        }
        if rec.err.is_some() {
            eprintln!("  [{i}] {} -> failed tx, skipping", rec.signature);
            continue;
        }
        let tx = match rpc.get_transaction(&rec.signature).await {
            Ok(Some(t)) => t,
            Ok(None) => {
                eprintln!("  [{i}] {} -> not found, skipping", rec.signature);
                continue;
            }
            Err(e) => {
                eprintln!("  [{i}] {} -> rpc error: {e}, skipping", rec.signature);
                continue;
            }
        };
        let logs = tx
            .meta
            .as_ref()
            .and_then(|m| m.log_messages.as_ref())
            .cloned()
            .unwrap_or_default();
        for line in &logs {
            if !line.starts_with("Program data: ") {
                continue;
            }
            total_program_data_lines += 1;
            // The key assertion: this must not panic, and unknown discriminators
            // must return Ok(None) rather than Err.
            match decode_program_data_line(line) {
                Ok(Some(ev)) => {
                    total_decoded += 1;
                    *kind_counts.entry(ev.kind()).or_insert(0) += 1;
                    if let DecodedEvent::CommitmentQueued(c) = &ev {
                        commitments_seen.push(hex::encode(c.commitment));
                    }
                    eprintln!(
                        "  [{i}] {} -> {} {}",
                        rec.signature,
                        ev.kind(),
                        match &ev {
                            DecodedEvent::CommitmentQueued(c) => format!(
                                "tree={} idx={} amt={}",
                                bs58::encode(c.tree).into_string(),
                                c.queue_index,
                                c.amount
                            ),
                            DecodedEvent::Transferred(t) => format!(
                                "tree={}",
                                bs58::encode(t.tree).into_string()
                            ),
                            DecodedEvent::RootUpdated(r) => format!(
                                "tree={} batch_size={}",
                                bs58::encode(r.tree).into_string(),
                                r.batch_size
                            ),
                            DecodedEvent::PoolInitialized(p) => format!(
                                "admin={} fee_bps={}",
                                bs58::encode(p.admin).into_string(),
                                p.fee_bps
                            ),
                            DecodedEvent::TreeInitialized(t) => format!(
                                "pool={} mint={} depth={}",
                                bs58::encode(t.pool).into_string(),
                                bs58::encode(t.mint).into_string(),
                                t.depth
                            ),
                            _ => String::new(),
                        }
                    );
                }
                Ok(None) => {
                    // Either non-event log line (already filtered) or unknown
                    // discriminator. Fine.
                }
                Err(e) => panic!(
                    "decode_program_data_line returned Err on sig {} line {:?}: {e}",
                    rec.signature, line
                ),
            }
        }
    }

    eprintln!("---- devnet_backfill summary ----");
    eprintln!("  signatures scanned:        {}", sigs.len());
    eprintln!("  program-data lines seen:   {}", total_program_data_lines);
    eprintln!("  events decoded:            {}", total_decoded);
    eprintln!("  by kind:                   {:?}", kind_counts);
    eprintln!("  commitments seen:          {} unique", commitments_seen.len());
    eprintln!("  elapsed:                   {:?}", start.elapsed());

    // Sanity: if the RPC actually returned signatures, we should have made it
    // through `MAX_SIGNATURES` without an Err from the decoder. Zero events
    // is OK (the prior e2e run may not have reached the deposit-emit path).
    // The whole point of this test is "no panics, no Errs" — assertions above
    // already cover that case.
}
