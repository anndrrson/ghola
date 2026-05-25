//! Prover error type.

use std::path::PathBuf;

pub type Result<T, E = Error> = std::result::Result<T, E>;

#[derive(thiserror::Error, Debug)]
pub enum Error {
    /// The configured `ARTIFACTS_DIR` is missing one of the required
    /// artifact files (zkey, vk, wasm).
    #[error("required circuit artifact not found: {0}")]
    ArtifactsNotFound(PathBuf),

    /// Spawning the prover subprocess failed (binary missing, exec error,
    /// non-zero exit, stderr drained but no proof produced).
    #[error("prover backend spawn failed: {0}")]
    BackendSpawnFailed(String),

    /// The snarkjs subprocess did not return within the configured
    /// `PROVER_SUBPROCESS_TIMEOUT_MS`. We kill the child process before
    /// returning this error; the temp artifacts (witness JSON containing
    /// the spending key in clear) are removed by the
    /// `TempArtifacts` RAII guard regardless.
    #[error("snarkjs subprocess timed out after {0}ms")]
    SnarkjsTimeout(u64),

    /// The configured backend isn't available in this build (e.g. gnark
    /// stub) — return 501 from the HTTP layer.
    #[error("prover backend not implemented: {0}")]
    BackendNotImplemented(&'static str),

    /// Failed to serialize the produced proof into the on-chain
    /// `ProofBundle` form (e.g. malformed snarkjs JSON, bad field-elt
    /// size, base-point decoding error).
    #[error("proof serialization error: {0}")]
    ProofSerializeError(String),

    /// The incoming witness payload didn't satisfy the circuit's input
    /// shape (wrong arity, mismatched asset id, non-canonical field elt).
    #[error("invalid witness: {0}")]
    WitnessInvalid(String),

    /// Invalid configuration (env var parse error, unknown backend name).
    #[error("invalid config: {0}")]
    ConfigInvalid(String),

    /// IO error from the filesystem or subprocess plumbing.
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    /// JSON (de)serialization error.
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),

    /// Bubble-up from the shared types crate.
    #[error("types error: {0}")]
    Types(#[from] said_shielded_pool_types::Error),
}
