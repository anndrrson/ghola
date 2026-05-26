//! said-shielded-pool-relayer — delayed/batched withdrawal relayer for the
//! Ghola Solana-native shielded pool.
//!
//! # Architecture
//!
//! The relayer accepts encrypted withdrawal proof bundles from anonymous
//! clients, holds them in a persistent queue, and releases them on-chain in
//! batches once an anonymity threshold is reached (or a safety timeout
//! fires). Releases are interspersed with randomized inter-submission
//! delays (Poisson jitter) so that an external observer correlating ingress
//! to on-chain activity has a harder time linking a given on-chain
//! withdrawal to a specific HTTP request.
//!
//! # ANONYMITY LIMITATIONS — read before claiming this is a mixer
//!
//! This relayer provides **timing/ordering decorrelation of the SENDER
//! within one relayer's own traffic, and nothing more.** It is NOT an
//! untraceable mixer today. Specifically:
//!
//! 1. **Amounts are public (V1 — design-gated).** Withdrawal `amount` is a
//!    clear-text `u64` on-chain (SPEC §1.4). An observer reads the exact
//!    amount credited to the recipient and matches it to a deposit amount,
//!    linking deposit→withdrawal BY VALUE ALONE, regardless of batching,
//!    jitter, or k. There is NO value-unlinkability without fixed
//!    denominations (a circuit + program + ceremony change, out of scope
//!    here).
//! 2. **Decoys are not delivered (V2 — design-gated).** `submit_decoy` is a
//!    hard no-op; the decoy pool is never populated. With no cover traffic
//!    the anonymity set at low volume collapses to concurrent real traffic
//!    (k can be 1). See [`decoy`].
//! 3. **Single trusted relayer + single fee-payer (V5/V6 — future).** One
//!    relayer keypair fee-pays every tx; the relayer sees every `/relay`
//!    request in plaintext and stores proof bundles + recipients + amounts
//!    on disk. The model is "TRUST THIS OPERATOR," not "trustless against
//!    the relayer." A multi-relayer network and per-tx payer rotation are
//!    future work.
//!
//! Optional decoy traffic and a hard `k_min` floor exist as knobs/scaffolding
//! (see [`config`]), but the two design gates above mean the rail must NOT be
//! described to users as anonymous/untraceable in its current form. See the
//! crate README "ANONYMITY LIMITATIONS (current)" for the operator-facing
//! version of this.
//!
//! # Privacy invariants
//!
//! - The relayer MUST NOT log proof contents, public inputs, recipient
//!   addresses, or amounts above DEBUG level.
//! - The relayer MUST NOT include the queue ID in any on-chain transaction.
//! - The `/status/:id` endpoint MUST NOT return the on-chain signature,
//!   only the abstract status enum.
//! - The relayer pays the network fee on behalf of the user. The proof
//!   binds the recipient via `ext_data_hash`, so the relayer cannot steal
//!   funds — but it CAN delay or refuse to submit, which is why production
//!   deployments need multiple independent relayers (the Phase 41
//!   anonymity-network framing).
//!
//! # Modules
//!
//! - [`config`] — env-loaded configuration.
//! - [`error`] — error type.
//! - [`queue`] — persistent queue of pending withdrawals.
//! - [`batcher`] — background task that releases batches.
//! - [`submit`] — submits batched withdrawals to Solana with jitter + retry.
//! - [`decoy`] — decoy-traffic scaffolding (NOT delivered — V2; see module).
//! - [`routes`] — axum HTTP API.
//! - [`metrics`] — Prometheus-format metric collection.

#![forbid(unsafe_code)]

pub mod batcher;
pub mod config;
pub mod decoy;
pub mod dedup;
pub mod error;
pub mod metrics;
pub mod queue;
pub mod routes;
pub mod submit;

pub use config::Config;
pub use dedup::{Dedup, DedupOutcome};
pub use error::{Error, Result};
pub use queue::{QueuedWithdrawal, WithdrawalQueue, WithdrawalStatus};
