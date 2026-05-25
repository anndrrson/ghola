//! said-shielded-pool-invariants — machine-checkable safety invariants
//! for the Ghola SAID Solana shielded pool.
//!
//! Every predicate in this crate corresponds to a safety property that is
//! **enforced** by the on-chain program (`programs/said-shielded-pool`)
//! and **verified** off-chain by indexers, auditors, fuzz tests, and the
//! chaos-test harness. The on-chain enforcement is the source of truth;
//! the off-chain checker exists so that:
//!
//! 1. An auditor can replay history and assert every recorded state is
//!    self-consistent without trusting the program binary.
//! 2. The relayer / indexer can self-check before broadcasting a tx.
//! 3. The chaos-test harness can detect quiet corruption in mocked
//!    backends (which intentionally don't run the on-chain enforcement).
//!
//! Each invariant is grouped into one of 8 families documented in
//! `docs/shielded-pool/INVARIANTS.md`:
//!
//! 1. **Notes** — value conservation across transfer/deposit/withdraw.
//! 2. **Nullifiers** — uniqueness, derivation binding, cross-asset isolation.
//! 3. **Roots** — windowed root history, monotone forester advancement.
//! 4. **Custody** — escrow accounting closes against deposit/withdraw flow.
//! 5. **Proofs** — VK hash commitment + canonical public-input layout.
//! 6. **Relayers** — proof-bundle dedup + k-anonymity release predicate.
//! 7. **Metering** — `queue_tail >= next_index`, forester batch bounds.
//! 8. **Revenue** — fee accumulator closes; drains gated to admin.
//!
//! # Crate boundaries
//!
//! This crate is **off-chain only** and never imported by anything in
//! `programs/`. It depends on `said-shielded-pool-types` (the pure-Rust
//! shared types) plus `light-poseidon`/`ark-bn254` for recomputing
//! commitments and nullifiers from raw note data.

#![forbid(unsafe_code)]

pub mod checks;
pub mod model;

pub use checks::*;
pub use model::*;
