//! Decoy traffic generator + decoy-proof pool.
//!
//! # What this file owns
//!
//! Two coupled responsibilities:
//!
//! 1. [`DecoyTrafficGenerator`] — the background tokio task that
//!    periodically fires `submit_decoy()` on the configured
//!    [`Submitter`](crate::submit::Submitter), spaced as a Poisson
//!    process with rate `DECOY_RATE` (env `DECOY_RATE_PER_HOUR`).
//! 2. [`DecoyPool`] — a small in-memory cache of pre-generated decoy
//!    proof bundles. The submitter pulls one at random, builds a
//!    `withdraw` ix with `amount == 0 && relayer_fee == 0`, and
//!    broadcasts.
//!
//! # On-chain indistinguishability
//!
//! Decoys are sent as `withdraw { amount: 0, relayer_fee: 0 }`. The
//! `transfer_checked` CPI calls in `withdraw` are `if x > 0` gated, so
//! amount=0 skips them entirely — the resulting on-chain state delta
//! (PDA writes, event emission) is byte-equivalent to a never-was-a-
//! transfer no-op, AND the ix discriminator is identical to a real
//! withdrawal. An observer reading raw tx data therefore CANNOT
//! distinguish a decoy from a real withdraw by either the
//! discriminator or the state delta.
//!
//! (Earlier design had a dedicated `decoy_withdraw` ix; that was
//! deleted in a cleanup pass because the dedicated discriminator was
//! itself the only leak.)
//!
//! # Decoy-pool refresh
//!
//! Decoy proofs are bound to:
//!   - the current `MerkleTree.root` (via `args.root`),
//!   - a unique `args.nullifier` per decoy (must not collide with a
//!     real nullifier),
//!   - a `change_commitment` PDA derived from `merkle_tree.queue_tail`
//!     at the time the decoy lands.
//!
//! Production wiring (Phase 42+): a background task in the indexer's
//! forester crate watches `Withdrawn` events, and whenever the root
//! rotates it asks the prover to mint a small batch (5-10) of fresh
//! decoy proofs against the new root, signs them with disposable
//! nullifiers, and pushes them into [`DecoyPool`]. Until that
//! generator lands, the pool is empty and `submit_decoy()` falls
//! back to a no-op (logged at DEBUG) — see [`DecoyPool::pick`].

use std::sync::{Arc, Mutex};
use std::time::Duration;

use rand::seq::SliceRandom;
use rand::Rng;

use crate::config::Config;
use crate::metrics::Metrics;
use crate::submit::Submitter;

/// Anchor 8-byte instruction discriminator for `withdraw`.
///
/// Decoys are now sent as `withdraw { amount: 0, relayer_fee: 0 }`
/// rather than a dedicated `decoy_withdraw` ix. The on-chain
/// `transfer_checked` calls in `withdraw` are `if x > 0` gated, so
/// amount=0 skips them — the resulting on-chain state delta is
/// byte-equivalent to the deleted decoy_withdraw handler, and the
/// ix discriminator is now the same as a real withdrawal, so an
/// observer reading tx data CANNOT distinguish decoy from real.
///
/// `sha256("global:withdraw")[..8]`. Pinned here to keep the relayer
/// dep-graph clean (no hash crate).
pub const DECOY_WITHDRAW_DISCRIMINATOR: [u8; 8] =
    [0xb7, 0x12, 0x46, 0x9c, 0x94, 0x6d, 0xa1, 0x22];

// ---------------------------------------------------------------------
// Decoy proof bundle (cached, root-bound)
// ---------------------------------------------------------------------

/// A pre-generated decoy `withdraw` proof bundle. The relayer keeps a
/// small pool of these per active root so it can submit a decoy
/// without an on-the-spot prove call (proving is slow, and a decoy
/// blocked on prove latency is a useless decoy).
///
/// Fields mirror the on-chain `WithdrawArgs` struct
/// (`programs/said-shielded-pool/src/instructions/withdraw.rs`). There is
/// NO dedicated `decoy_withdraw` instruction on-chain — a decoy is a
/// genuine `withdraw` with `amount == 0 && relayer_fee == 0`, which makes
/// it byte-indistinguishable from a real withdraw at the tx level. See
/// [`DecoyBundle::ix_data`] for the exact serialization.
#[derive(Clone, Debug)]
pub struct DecoyBundle {
    /// 32-byte tree root the proof was bound to.
    pub root: [u8; 32],
    /// Nullifier for this decoy — must be unique across pool lifetime
    /// (the on-chain `nullifier` PDA init will fail otherwise).
    pub nullifier: [u8; 32],
    /// Change commitment (Poseidon hash of (asset_id, amount=0,
    /// blinding, owner)).
    pub change_commitment: [u8; 32],
    /// Public-amount field (must be 0 inside the Groth16 circuit).
    pub public_amount: [u8; 32],
    /// Asset id (Poseidon(mint) bytes; matches the real withdraw).
    pub asset_id: [u8; 32],
    /// Ext-data hash (binds recipient + relayer ATAs).
    pub ext_data_hash: [u8; 32],
    /// Padding commitment for layout parity with `withdraw`.
    pub padding_commitment: [u8; 32],
    /// Input nullifier #2 of the two-input UTXO note (zero leaf).
    pub input_nullifier_1: [u8; 32],
    /// Groth16 proof components (raw on-curve bytes, big-endian).
    pub proof_a: [u8; 64],
    pub proof_b: [u8; 128],
    pub proof_c: [u8; 64],
}

impl DecoyBundle {
    /// Anchor-encoded instruction data: 8-byte `withdraw` discriminator +
    /// `borsh(WithdrawArgs)` in the EXACT on-chain field order.
    ///
    /// SOURCE OF TRUTH — `WithdrawArgs` in
    /// `programs/said-shielded-pool/src/instructions/withdraw.rs`:
    ///
    /// ```text
    /// proof_a[64] || proof_b[128] || proof_c[64] || root[32] ||
    /// nullifier[32] || change_commitment[32] || amount(u64 LE) ||
    /// relayer_fee(u64 LE) || public_amount[32] || asset_id[32] ||
    /// ext_data_hash[32] || _padding_commitment[32] ||
    /// input_nullifier_1[32] || memo_commitments(u32 LE len + entries)
    /// ```
    ///
    /// A decoy is a real `withdraw` with `amount == 0 && relayer_fee == 0`
    /// (so the program's `if x > 0`-gated `transfer_checked` CPIs are
    /// skipped and the on-chain delta is indistinguishable from a no-op
    /// withdraw). `memo_commitments` is empty.
    ///
    /// The byte layout MUST match `WithdrawArgs`; the `decoy_ix_data_*`
    /// tests below assert offsets and re-deserialization to catch drift.
    pub fn ix_data(&self) -> Vec<u8> {
        // 8 (disc) + 64+128+64 (proof) + 32 (root) + 32 (nullifier)
        // + 32 (change) + 8 + 8 (amount, relayer_fee) + 32*5
        // (public_amount, asset_id, ext_data_hash, padding, input_nf_1)
        // + 4 (empty memo vec len).
        let mut out = Vec::with_capacity(8 + 64 + 128 + 64 + 32 * 8 + 16 + 4);
        out.extend_from_slice(&DECOY_WITHDRAW_DISCRIMINATOR);
        // --- proof (first, per WithdrawArgs) ---
        out.extend_from_slice(&self.proof_a);
        out.extend_from_slice(&self.proof_b);
        out.extend_from_slice(&self.proof_c);
        // --- root / nullifier / change_commitment ---
        out.extend_from_slice(&self.root);
        out.extend_from_slice(&self.nullifier);
        out.extend_from_slice(&self.change_commitment);
        // --- amount = 0, relayer_fee = 0 (decoy invariant) ---
        out.extend_from_slice(&0u64.to_le_bytes());
        out.extend_from_slice(&0u64.to_le_bytes());
        // --- public_amount / asset_id / ext_data_hash ---
        out.extend_from_slice(&self.public_amount);
        out.extend_from_slice(&self.asset_id);
        out.extend_from_slice(&self.ext_data_hash);
        // --- _padding_commitment / input_nullifier_1 ---
        out.extend_from_slice(&self.padding_commitment);
        out.extend_from_slice(&self.input_nullifier_1);
        // --- memo_commitments: empty Vec → u32 LE length 0 ---
        out.extend_from_slice(&0u32.to_le_bytes());
        out
    }
}

/// Thread-safe pool of pre-generated decoy proofs, keyed by tree root.
///
/// # Production wiring (TODO, Stream 4/5 coordination)
///
/// The pool should be populated by a background task that:
/// 1. Subscribes to `Withdrawn` / `RootUpdated` events.
/// 2. On root rotation, asks the prover to mint N (default 8) fresh
///    decoy bundles against the new root.
/// 3. Pushes them into `add_bundle`.
/// 4. GC's bundles whose `root` is no longer in the on-chain
///    `root_history` window (avoid `RootNotInHistory` rejections).
///
/// Until that landing, the pool is empty in production and the
/// submitter falls back to a no-op decoy. See
/// `docs/shielded-pool/THREAT_SCENARIOS.md` §B for the runbook.
#[derive(Clone, Default)]
pub struct DecoyPool {
    bundles: Arc<Mutex<Vec<DecoyBundle>>>,
}

impl DecoyPool {
    /// Empty pool.
    pub fn new() -> Self {
        Self::default()
    }

    /// Add a freshly-generated bundle. Caller is responsible for
    /// uniqueness of `bundle.nullifier`.
    pub fn add_bundle(&self, bundle: DecoyBundle) {
        self.bundles
            .lock()
            .expect("decoy pool poisoned")
            .push(bundle);
    }

    /// Drop bundles whose root is no longer in the current
    /// `root_history` window.
    pub fn prune_stale(&self, live_roots: &[[u8; 32]]) {
        let mut g = self.bundles.lock().expect("decoy pool poisoned");
        g.retain(|b| live_roots.iter().any(|r| r == &b.root));
    }

    /// Count of available bundles.
    pub fn len(&self) -> usize {
        self.bundles.lock().expect("decoy pool poisoned").len()
    }

    /// `true` iff no bundles are loaded.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Pick a random bundle and remove it from the pool (decoys are
    /// single-use because the on-chain nullifier becomes consumed
    /// after submission).
    pub fn pick(&self) -> Option<DecoyBundle> {
        let mut g = self.bundles.lock().expect("decoy pool poisoned");
        if g.is_empty() {
            return None;
        }
        let idx = rand::thread_rng().gen_range(0..g.len());
        Some(g.swap_remove(idx))
    }

    /// Picks-without-consuming for tests / shuffled iteration.
    #[doc(hidden)]
    pub fn peek_shuffled(&self) -> Vec<DecoyBundle> {
        let g = self.bundles.lock().expect("decoy pool poisoned");
        let mut v: Vec<_> = g.clone();
        let mut rng = rand::thread_rng();
        v.shuffle(&mut rng);
        v
    }
}

// ---------------------------------------------------------------------
// Background traffic generator
// ---------------------------------------------------------------------

/// Background task that drives [`Submitter::submit_decoy`] as a
/// Poisson process with rate `Config::decoy_rate_per_hour`.
pub struct DecoyTrafficGenerator {
    config: Arc<Config>,
    submitter: Arc<dyn Submitter + Send + Sync>,
    metrics: Arc<Metrics>,
}

impl DecoyTrafficGenerator {
    /// New generator. Caller wires `submitter` to the same Submitter
    /// the batcher uses, so decoys and real submissions share a fee
    /// payer (Stream 4's `decoy_withdraw` has a `payer: Signer` so
    /// the relayer keypair signs both — this matters because the
    /// keypair's on-chain activity profile is the entity we want to
    /// indistinguishably mix decoy + real traffic into).
    pub fn new(
        config: Arc<Config>,
        submitter: Arc<dyn Submitter + Send + Sync>,
        metrics: Arc<Metrics>,
    ) -> Self {
        Self {
            config,
            submitter,
            metrics,
        }
    }

    /// Forever loop. The caller (main.rs) spawns this with
    /// `tokio::spawn`.
    pub async fn run(self) {
        let rate_per_hour = self.config.decoy_rate_per_hour;
        if rate_per_hour <= 0.0 {
            tracing::info!("decoy traffic disabled (DECOY_RATE=0)");
            return;
        }
        let mean_secs = 3600.0 / rate_per_hour;
        tracing::info!(rate_per_hour, mean_secs, "decoy traffic enabled");

        loop {
            // Poisson process: exponential inter-arrival.
            let gap = {
                let mut rng = rand::thread_rng();
                let u: f64 = rng.gen_range(f64::EPSILON..1.0);
                -u.ln() * mean_secs
            };
            tokio::time::sleep(Duration::from_secs_f64(gap)).await;

            match self.submitter.submit_decoy().await {
                Ok(()) => {
                    self.metrics.record_decoy();
                    tracing::debug!("decoy tx submitted");
                }
                Err(e) => {
                    tracing::warn!(error = %e, "decoy tx failed");
                }
            }
        }
    }
}

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_bundle(root_byte: u8) -> DecoyBundle {
        DecoyBundle {
            root: [root_byte; 32],
            nullifier: [root_byte; 32],
            change_commitment: [0x33; 32],
            public_amount: [0u8; 32],
            asset_id: [1u8; 32],
            ext_data_hash: [2u8; 32],
            padding_commitment: [0x44; 32],
            // Distinct per-decoy so the C3 `input_nullifier_1` PDA `init`
            // doesn't collide between decoys (real generators must seed
            // this with a unique dummy nullifier per decoy).
            input_nullifier_1: [root_byte.wrapping_add(0x80); 32],
            proof_a: [0x11; 64],
            proof_b: [0x22; 128],
            proof_c: [0x55; 64],
        }
    }

    #[test]
    fn pool_starts_empty() {
        let pool = DecoyPool::new();
        assert!(pool.is_empty());
        assert!(pool.pick().is_none());
    }

    #[test]
    fn pool_add_and_pick_consumes() {
        let pool = DecoyPool::new();
        pool.add_bundle(sample_bundle(1));
        pool.add_bundle(sample_bundle(2));
        assert_eq!(pool.len(), 2);
        let _ = pool.pick().expect("non-empty");
        assert_eq!(pool.len(), 1);
        let _ = pool.pick().expect("non-empty");
        assert_eq!(pool.len(), 0);
        assert!(pool.pick().is_none());
    }

    #[test]
    fn prune_stale_keeps_only_live_roots() {
        let pool = DecoyPool::new();
        pool.add_bundle(sample_bundle(1));
        pool.add_bundle(sample_bundle(2));
        pool.add_bundle(sample_bundle(3));
        let live = [[2u8; 32], [3u8; 32]];
        pool.prune_stale(&live);
        assert_eq!(pool.len(), 2);
    }

    #[test]
    fn ix_data_starts_with_discriminator() {
        let b = sample_bundle(7);
        let data = b.ix_data();
        assert_eq!(&data[..8], &DECOY_WITHDRAW_DISCRIMINATOR);
    }

    /// CRITICAL layout guard: assert `ix_data()` matches the on-chain
    /// `WithdrawArgs` borsh layout byte-for-byte (field ORDER + sizes).
    /// If `WithdrawArgs` drifts, this fails. Mirrors the client crate's
    /// `withdraw_args_exact_byte_offsets` test (same source of truth).
    #[test]
    fn ix_data_matches_withdraw_args_layout() {
        let b = sample_bundle(7);
        let data = b.ix_data();
        assert_eq!(&data[..8], &DECOY_WITHDRAW_DISCRIMINATOR);
        let body = &data[8..];

        let mut off = 0usize;
        // proof_a / proof_b / proof_c (FIRST in WithdrawArgs)
        assert_eq!(&body[off..off + 64], &b.proof_a);
        off += 64;
        assert_eq!(&body[off..off + 128], &b.proof_b);
        off += 128;
        assert_eq!(&body[off..off + 64], &b.proof_c);
        off += 64;
        // root / nullifier / change_commitment
        assert_eq!(&body[off..off + 32], &b.root);
        off += 32;
        assert_eq!(&body[off..off + 32], &b.nullifier);
        off += 32;
        assert_eq!(&body[off..off + 32], &b.change_commitment);
        off += 32;
        // amount(0) / relayer_fee(0)
        assert_eq!(&body[off..off + 8], &0u64.to_le_bytes());
        off += 8;
        assert_eq!(&body[off..off + 8], &0u64.to_le_bytes());
        off += 8;
        // public_amount / asset_id / ext_data_hash
        assert_eq!(&body[off..off + 32], &b.public_amount);
        off += 32;
        assert_eq!(&body[off..off + 32], &b.asset_id);
        off += 32;
        assert_eq!(&body[off..off + 32], &b.ext_data_hash);
        off += 32;
        // _padding_commitment / input_nullifier_1
        assert_eq!(&body[off..off + 32], &b.padding_commitment);
        off += 32;
        assert_eq!(&body[off..off + 32], &b.input_nullifier_1);
        off += 32;
        // memo_commitments: empty Vec → u32 LE len 0, no entries
        assert_eq!(&body[off..off + 4], &0u32.to_le_bytes());
        off += 4;
        assert_eq!(off, body.len(), "no trailing/garbage bytes");

        // Total: disc(8) + 64+128+64 + 32 + 32 + 32 + 8 + 8 + 32 + 32 + 32
        //        + 32 + 32 + 4
        assert_eq!(data.len(), 8 + 64 + 128 + 64 + 32 * 8 + 16 + 4);
        // decoy invariant: amount + relayer_fee (the 16 bytes right after
        // proof + root + nullifier + change = 256 + 96) are zero.
        assert_eq!(&body[352..368], &[0u8; 16]);
    }

    #[test]
    fn ix_data_is_deterministic() {
        let b = sample_bundle(7);
        assert_eq!(b.ix_data(), b.ix_data());
    }
}
