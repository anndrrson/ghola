//! Persistent withdrawal queue backed by sled.
//!
//! Privacy notes:
//! - All proof-bundle bytes live on disk; an operator with disk access
//!   can read them. The relayer is trusted-for-availability and
//!   trusted-for-confidentiality (in production: TEE — Phase 42).
//! - We index entries by random UUID (NOT by recipient or amount).
//! - Items are removed (not just status-updated) once Confirmed, after
//!   a short retention window for `/status` to remain answerable.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::path::Path;
use uuid::Uuid;

use crate::error::{Error, Result};

/// Opaque proof-bundle payload as accepted from the client.
///
/// The client sends a `ProofBundle` (see `said-shielded-pool-types`) as
/// JSON; the relayer treats it as an opaque blob whose only job is to be
/// forwarded to the on-chain program. We deliberately do NOT structurally
/// decode it inside the relayer because:
///   1. The on-chain program is the cryptographic source of truth; any
///      structural validation here just risks divergence.
///   2. Decoding it would surface field elements (nullifiers, commitments)
///      to relayer internals where they could be logged.
///   3. It decouples the relayer from `said-shielded-pool-types` version
///      bumps; the upstream type can evolve without redeploying relayers.
///
/// The blob is captured as a `serde_json::Value` so we still validate it
/// is well-formed JSON (rejecting trivial garbage early) without
/// interpreting the contents.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ProofBlob(pub serde_json::Value);

/// Coarse status visible to the client via `/status/:id`.
///
/// IMPORTANT: this enum is what the client sees. It deliberately collapses
/// `Batched` and `Submitted` into one `Submitted` for external reporting
/// in [`routes::status_response`] (so the client cannot distinguish "we
/// are mid-jitter" from "we already broadcast" — both states are equally
/// privacy-sensitive timing leaks).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum WithdrawalStatus {
    /// Sitting in queue, waiting for anonymity threshold or max delay.
    Pending,
    /// Chosen as part of a release batch but not yet broadcast.
    Batched,
    /// Broadcast to the network; awaiting confirmation.
    Submitted,
    /// Confirmed on-chain.
    Confirmed,
    /// Final failure after exhausting retries.
    Failed,
}

/// On-chain account reference, as the client side computed it.
///
/// The relayer is dumb-about-PDAs by design — the client (see
/// `said-shielded-pool-client::tx_builder`) knows the full set of
/// accounts the program expects (pool config, merkle tree, escrow,
/// nullifier PDAs, etc.) and serialises them into the queued payload.
/// The relayer's only job is to splice in its own pubkey as the fee
/// payer / signer and broadcast.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct QueuedAccountMeta {
    /// 32-byte Solana pubkey, base58-encoded for JSON friendliness.
    pub pubkey: String,
    pub is_signer: bool,
    pub is_writable: bool,
}

/// A single queued withdrawal. The on-chain signature is intentionally
/// NOT stored; only the abstract status, so even a compromised DB cannot
/// produce a request->tx link table.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct QueuedWithdrawal {
    pub id: Uuid,
    pub proof_bundle: ProofBlob,
    /// Recipient pubkey bytes. Used only when constructing the on-chain
    /// tx; never logged.
    pub recipient: [u8; 32],
    /// Total fee the user attached (network fee + relayer fee).
    pub fee: u64,
    /// Portion paid to the relayer.
    pub relayer_fee: u64,
    /// Borsh-encoded instruction data (Anchor 8-byte discriminator +
    /// args) for the said-shielded-pool program's `withdraw` ix. The
    /// relayer treats these bytes as opaque — it does NOT structurally
    /// decode them, for the same reasons documented on `ProofBlob`.
    ///
    /// `Default` so older sled rows (pre-Phase 41 chain wiring) still
    /// deserialize; a legacy row will be effectively un-submittable but
    /// won't crash the daemon on boot.
    #[serde(default)]
    pub instruction_data: Vec<u8>,
    /// Pre-computed account list for the on-chain instruction. Same
    /// order the on-chain program expects. The relayer's fee payer is
    /// NOT in this list — the submitter prepends it before signing.
    #[serde(default)]
    pub accounts: Vec<QueuedAccountMeta>,
    pub accepted_at: DateTime<Utc>,
    pub status: WithdrawalStatus,
    /// How many submit attempts have happened. Reset to 0 on accept.
    pub attempts: u32,
}

/// Persistent, async-friendly queue.
///
/// Sled is sync-only, so all DB ops happen inside `tokio::task::spawn_blocking`
/// or are short enough to be safe on the runtime. The hot operations
/// (insert, list) are fast and we keep them inline.
#[derive(Clone)]
pub struct WithdrawalQueue {
    tree: sled::Tree,
}

impl WithdrawalQueue {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let db = sled::open(path)?;
        Self::open_in(&db)
    }

    pub fn open_in(db: &sled::Db) -> Result<Self> {
        let tree = db.open_tree("withdrawals")?;
        Ok(Self { tree })
    }

    /// Open an ephemeral in-memory queue (for tests).
    pub fn open_temporary() -> Result<Self> {
        let db = sled::Config::new().temporary(true).open()?;
        let tree = db.open_tree("withdrawals")?;
        Ok(Self { tree })
    }

    pub fn insert(&self, w: &QueuedWithdrawal) -> Result<()> {
        let key = w.id.as_bytes();
        // We use JSON rather than bincode because the proof blob is a
        // `serde_json::Value` (relayer treats it as opaque), which bincode
        // can't round-trip through `deserialize_any`. JSON is more
        // verbose but the storage cost is negligible for queue depth.
        let value = serde_json::to_vec(w)
            .map_err(|e| Error::Queue(format!("serialize: {e}")))?;
        self.tree.insert(key, value)?;
        // Flush is async/best-effort; sled's WAL still gives crash-safety.
        Ok(())
    }

    pub fn get(&self, id: Uuid) -> Result<Option<QueuedWithdrawal>> {
        let key = id.as_bytes();
        match self.tree.get(key)? {
            None => Ok(None),
            Some(bytes) => {
                let w: QueuedWithdrawal = serde_json::from_slice(&bytes)
                    .map_err(|e| Error::Queue(format!("deserialize: {e}")))?;
                Ok(Some(w))
            }
        }
    }

    /// Returns every withdrawal currently in storage. Caller is responsible
    /// for filtering by status. We sort by `accepted_at` ASC so the
    /// batcher can identify the oldest item without re-walking.
    pub fn list_all(&self) -> Result<Vec<QueuedWithdrawal>> {
        let mut out = Vec::new();
        for kv in self.tree.iter() {
            let (_, v) = kv?;
            let w: QueuedWithdrawal = serde_json::from_slice(&v)
                .map_err(|e| Error::Queue(format!("deserialize: {e}")))?;
            out.push(w);
        }
        out.sort_by_key(|w| w.accepted_at);
        Ok(out)
    }

    pub fn list_pending(&self) -> Result<Vec<QueuedWithdrawal>> {
        Ok(self
            .list_all()?
            .into_iter()
            .filter(|w| matches!(w.status, WithdrawalStatus::Pending))
            .collect())
    }

    pub fn set_status(&self, id: Uuid, status: WithdrawalStatus) -> Result<()> {
        let mut w = self
            .get(id)?
            .ok_or_else(|| Error::Queue(format!("missing id")))?;
        w.status = status;
        self.insert(&w)?;
        Ok(())
    }

    pub fn increment_attempts(&self, id: Uuid) -> Result<u32> {
        let mut w = self
            .get(id)?
            .ok_or_else(|| Error::Queue(format!("missing id")))?;
        w.attempts = w.attempts.saturating_add(1);
        let attempts = w.attempts;
        self.insert(&w)?;
        Ok(attempts)
    }

    pub fn delete(&self, id: Uuid) -> Result<()> {
        let key = id.as_bytes();
        self.tree.remove(key)?;
        Ok(())
    }

    pub fn depth(&self) -> Result<usize> {
        Ok(self.list_pending()?.len())
    }
}

/// Result of [`batcher::Batcher`]'s decision check, exposed here so tests
/// can exercise the policy without spinning a tokio runtime.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BatchDecision {
    /// No batch yet — queue is empty or below threshold and oldest item
    /// hasn't aged past min_delay.
    Hold,
    /// Release: anonymity threshold reached AND oldest item exceeds min_delay.
    Release { reason: ReleaseReason, take: usize },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReleaseReason {
    /// Normal release — anonymity threshold met.
    AnonymityThresholdMet,
    /// Safety release — oldest item exceeded max_delay.
    MaxDelayExceeded,
}

/// Pure policy function so the batching logic is unit-testable.
///
/// `now` is supplied (not read) so tests can manipulate time deterministically.
pub fn decide_batch(
    now: DateTime<Utc>,
    items: &[QueuedWithdrawal],
    anonymity_threshold: usize,
    batch_size: usize,
    min_delay: std::time::Duration,
    max_delay: std::time::Duration,
) -> BatchDecision {
    let pending: Vec<_> = items
        .iter()
        .filter(|w| matches!(w.status, WithdrawalStatus::Pending))
        .collect();
    if pending.is_empty() {
        return BatchDecision::Hold;
    }

    let oldest = pending[0]; // list_all sorted by accepted_at ASC
    let age = (now - oldest.accepted_at).to_std().unwrap_or_default();

    if age >= max_delay {
        return BatchDecision::Release {
            reason: ReleaseReason::MaxDelayExceeded,
            take: pending.len().min(batch_size),
        };
    }

    if pending.len() >= anonymity_threshold && age >= min_delay {
        return BatchDecision::Release {
            reason: ReleaseReason::AnonymityThresholdMet,
            take: pending.len().min(batch_size),
        };
    }

    BatchDecision::Hold
}
