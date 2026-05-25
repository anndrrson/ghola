//! Failure-mode / chaos test harness for the said-shielded-pool stack.
//!
//! Stream 6 of the production-hardening pass. This crate is **not** a
//! production runtime — it only ever appears in `cargo test` workflows.
//! It exists to make pathological-backend tests cheap and uniform:
//!
//! - Mock prover (wiremock) configurable to hang, return 5xx for the
//!   first N calls, or return a canned valid proof. See [`harness::ProverBehavior`].
//! - Mock Solana JSON-RPC (wiremock) configurable to return stale block
//!   heights, flap 503→200, or pretend a tx is permanently
//!   `Unknown`. See [`harness::RpcBehavior`].
//! - Light helpers to boot the real relayer and indexer with chaos
//!   config plugged in.
//!
//! Every scenario lives under `tests/` as a separate integration test so
//! they can run in parallel (each gets its own tokio runtime + temp
//! sled directory + free TCP port).
//!
//! # Privacy
//!
//! The harness only fabricates inputs; it does NOT exfiltrate anything.
//! All proof bundles used here are dummies that share the structural
//! shape the relayer expects (so it accepts them) but contain only
//! zero field elements.

pub mod harness;
pub mod scenarios;
