//! said-receipts-service — Merkle batcher and on-chain anchor publisher
//! for per-message Ghola receipts.
//!
//! The crate is split so the `bin` target wires up Postgres + Solana
//! and the `lib` target exposes the pieces (merkle, receipt types,
//! storage trait, batcher, router builder) for integration tests
//! and downstream tools.

pub mod batch;
pub mod merkle;
pub mod receipt;
pub mod routes;
pub mod solana;
pub mod storage;

#[cfg(test)]
mod tests;
