//! `gnark` Groth16 prover backend — STUB.
//!
//! gnark (https://github.com/Consensys/gnark) is a Go-based SNARK
//! framework. The shielded-pool circuit lives in Circom (see
//! `crates/said-shielded-pool-circuits/transaction.circom`); for gnark
//! we'd either:
//!
//!   (a) re-implement the circuit in gnark's Go DSL and produce a
//!       parallel `circuit.gnark` artifact set, or
//!   (b) feed our circom R1CS through gnark's circom frontend
//!       (`gnark/std/circom`).
//!
//! Path (b) is simpler but lags upstream circom; path (a) gives the
//! best performance and access to gnark's GKR/PLONK paths.
//!
//! TODO(phase-43):
//!   - Decide path (a) vs (b).
//!   - Build a `ghola-shielded-prover-gnark` Go binary that reads our
//!     witness JSON on stdin and writes `proof.json` + `public.json`
//!     in the same shape as snarkjs (or a gnark-native binary format
//!     that we parse here directly).
//!   - Spawn that binary via `tokio::process::Command`; share the
//!     parse path with `super::snarkjs` if the JSON matches.
//!   - Decide whether to negate G1.A inside the prover binary or here
//!     in [`crate::encoding::negate_g1_a`] (we currently do it here).

use async_trait::async_trait;
use said_shielded_pool_types::{ProofBundle, TransferWitness};

use crate::backend::Backend;
use crate::config::Config;
use crate::error::{Error, Result};

/// gnark prover backend. Currently a stub — every method returns
/// [`Error::BackendNotImplemented`]. The struct shape matches the
/// other backends so swapping in the real impl is a drop-in change.
pub struct GnarkBackend {
    #[allow(dead_code)]
    cfg: Config,
}

impl GnarkBackend {
    pub fn new(cfg: Config) -> Self {
        Self { cfg }
    }
}

#[async_trait]
impl Backend for GnarkBackend {
    fn name(&self) -> &'static str {
        "gnark"
    }

    async fn prove(&self, _witness: TransferWitness) -> Result<ProofBundle> {
        Err(Error::BackendNotImplemented("gnark"))
    }

    async fn vk(&self) -> Result<Vec<u8>> {
        Err(Error::BackendNotImplemented("gnark"))
    }
}
