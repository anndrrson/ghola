//! Prover-backend trait + concrete implementations.
//!
//! Each backend takes a [`TransferWitness`], runs a Groth16 prover over
//! the shielded-transfer circuit, and returns a [`ProofBundle`] with
//! the proof bytes already converted to `groth16-solana`'s expected
//! big-endian + A-negated layout.

use std::sync::Arc;

use async_trait::async_trait;
use said_shielded_pool_types::{
    BatchedUpdateWitness, ForesterProofBundle, ProofBundle, TransferWitness,
};

use crate::config::{BackendKind, Config};
use crate::error::{Error, Result};

pub mod gnark;
pub mod rapidsnark;
pub mod snarkjs;

pub use gnark::GnarkBackend;
pub use rapidsnark::RapidsnarkBackend;
pub use snarkjs::SnarkjsBackend;

/// Which circuit the backend should prove against.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CircuitKind {
    Transfer,
    Forester,
}

/// Common interface for all Groth16 prover backends.
#[async_trait]
pub trait Backend: Send + Sync + 'static {
    /// Run the Groth16 prover for the transfer circuit.
    async fn prove(&self, witness: TransferWitness) -> Result<ProofBundle>;

    /// Run the Groth16 prover for the forester (batched commitment-insertion)
    /// circuit. Default impl returns `BackendNotImplemented` so legacy
    /// backends can opt-in incrementally.
    async fn prove_forester(
        &self,
        _witness: BatchedUpdateWitness,
    ) -> Result<ForesterProofBundle> {
        Err(Error::BackendNotImplemented(
            "prove_forester not implemented for this backend",
        ))
    }

    /// Return the raw verification-key bytes (as produced by
    /// `snarkjs zkey export verificationkey`, i.e. JSON) for the named
    /// circuit. Callers may hash or parse this; the prover doesn't
    /// interpret it.
    async fn vk(&self) -> Result<Vec<u8>>;

    /// Return the forester vk bytes (snarkjs JSON). Default looks up the
    /// path in `Config::forester_vk_path`.
    async fn forester_vk(&self) -> Result<Vec<u8>> {
        Err(Error::BackendNotImplemented(
            "forester_vk not implemented for this backend",
        ))
    }

    /// Human-friendly name (snarkjs / rapidsnark / gnark).
    fn name(&self) -> &'static str;
}

/// Construct a backend instance from a [`Config`].
pub fn build(cfg: &Config) -> Arc<dyn Backend> {
    match cfg.backend {
        BackendKind::Snarkjs => Arc::new(SnarkjsBackend::new(cfg.clone())),
        BackendKind::Rapidsnark => Arc::new(RapidsnarkBackend::new(cfg.clone())),
        BackendKind::Gnark => Arc::new(GnarkBackend::new(cfg.clone())),
    }
}
