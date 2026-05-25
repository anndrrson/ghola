//! said-shielded-pool-prover — off-chain Groth16 prover service for the
//! Ghola Solana-native shielded pool.
//!
//! This crate exposes both a library API (so the service can be embedded
//! into another binary, e.g. a TEE-hosted enclave runner in Phase 42) and
//! a thin binary (`src/main.rs`) that starts an axum HTTP server.
//!
//! # Architecture
//!
//! - [`backend::Backend`] is the trait every prover implementation satisfies.
//! - [`backend::SnarkjsBackend`] spawns `snarkjs groth16 fullprove` (reference).
//! - [`backend::RapidsnarkBackend`] spawns `rapidsnark` (fast native prover).
//! - [`backend::GnarkBackend`] is a stub for a future gnark-go prover.
//!
//! All backends emit a [`ProofBundle`](said_shielded_pool_types::ProofBundle)
//! with field elements big-endian and the G1 `A` point negated, matching
//! `groth16-solana` (Lightprotocol) pairing-check convention.
//!
//! # Security
//!
//! The prover service receives [`TransferWitness`](said_shielded_pool_types::TransferWitness)
//! payloads that contain the user's `spending_key`. The service itself
//! does NOT hold any long-lived keys and does NOT persist witnesses.
//! In production this service runs inside a TEE (Phase 42); for now it
//! runs as an ordinary process and clients should treat the prover as
//! trusted-for-availability and trusted-for-confidentiality. See README.

#![forbid(unsafe_code)]

pub mod backend;
pub mod config;
pub mod encoding;
pub mod error;
pub mod onchain_format;
pub mod routes;
pub mod wire;
pub mod witness;

pub use config::{BackendKind, Config};
pub use error::{Error, Result};
pub use routes::router;
