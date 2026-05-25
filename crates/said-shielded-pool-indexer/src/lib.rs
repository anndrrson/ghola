//! said-shielded-pool-indexer — indexer + Merkle forester for the
//! Ghola Solana-native shielded pool.
//!
//! This crate has two roles, deployable independently or together:
//!
//! 1. **Indexer** — subscribes to the on-chain program's event stream,
//!    maintains an off-chain mirror of the depth-26 commitment Merkle
//!    forest in a local [`sled`] database, and serves
//!    `MerklePath`/witness queries to clients over HTTP. Anyone can run
//!    this; it only reads public chain state and holds no secrets.
//!
//! 2. **Forester** — when the on-chain insertion queue fills past a
//!    threshold, generates a batched-update SNARK that rolls multiple
//!    commitment insertions into a single new root, then submits the
//!    `update_root_via_proof` transaction to the on-chain program.
//!    Permissioned in v1 (single configured keypair = program admin);
//!    architected for a future multi-forester staked-operator model.
//!
//! The two roles share the same in-memory tree, so a single binary can
//! run both — set `FORESTER_KEYPAIR_PATH` to enable the forester half.
//!
//! # Cross-references
//!
//! - Shared types: [`said_shielded_pool_types`] — `Commitment`,
//!   `MerklePath`, `TREE_DEPTH`, etc.
//! - Hashing: [`tree::poseidon2_be`] uses `light-poseidon` (Circom
//!   `Poseidon(2)`, BN254, x^5 S-box) — matches the on-chain
//!   `sol_poseidon` syscall and the circuit.
//! - Spec: `docs/shielded-pool/SPEC.md` §5 (Merkle tree forest), §6
//!   (batched updates).

#![forbid(unsafe_code)]

pub mod backfill;
pub mod config;
pub mod error;
pub mod events;
pub mod forester;
pub mod listener;
pub mod routes;
pub mod solana;
pub mod state;
pub mod tree;
pub mod zero_hashes;

pub use config::Config;
pub use error::{Error, Result};
pub use routes::router;
pub use state::AppState;
pub use tree::IncrementalMerkleTree;
