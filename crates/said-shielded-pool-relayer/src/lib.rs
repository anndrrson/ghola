//! said-shielded-pool-relayer — delayed/batched withdrawal relayer for the
//! Ghola Solana-native shielded pool.
//!
//! # Architecture
//!
//! The relayer accepts encrypted withdrawal proof bundles from anonymous
//! clients, holds them in a persistent queue, and releases them on-chain in
//! batches once an anonymity threshold is reached (or a safety timeout
//! fires). Releases are interspersed with randomized inter-submission
//! delays (Poisson jitter) and, optionally, decoy traffic so that an
//! external observer correlating ingress to on-chain activity cannot link
//! a given on-chain withdrawal to a specific HTTP request.
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
//! - [`decoy`] — decoy-traffic generator (framework; stub strategy).
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
