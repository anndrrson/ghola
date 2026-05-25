//! Crate-wide error type.
//!
//! Wraps the small set of failure modes a client can hit. Designed to
//! be `Send + Sync + 'static` so it composes with async chains and with
//! `anyhow::Error` callers.

use thiserror::Error;

/// Client SDK result alias.
pub type Result<T> = std::result::Result<T, Error>;

/// All errors surfaced by the client SDK.
#[derive(Debug, Error)]
pub enum Error {
    /// Generic encoding / decoding failure (hex, bs58, borsh, etc).
    #[error("encoding error: {0}")]
    Encoding(String),

    /// Field-element value (amount, public_amount, etc) is outside the
    /// valid range. e.g. an amount larger than `u64::MAX` or a
    /// `public_amount` outside `[-(p-1)/2, (p-1)/2]` for BN254.
    #[error("value out of range: {0}")]
    ValueOutOfRange(&'static str),

    /// Inputs and outputs of a transfer use mismatched asset IDs.
    /// All notes in a single circuit invocation must share an asset.
    #[error("mismatched asset ids in transfer")]
    AssetMismatch,

    /// Invalid public/private key material — wrong length, zero, etc.
    #[error("invalid key: {0}")]
    InvalidKey(&'static str),

    /// HTTP error talking to the prover service.
    #[error("prover http error: {0}")]
    ProverHttp(#[from] reqwest::Error),

    /// Prover service returned a non-2xx response.
    #[error("prover responded {status}: {body}")]
    ProverStatus {
        /// HTTP status code.
        status: u16,
        /// Body string (may be truncated).
        body: String,
    },

    /// JSON serialization / deserialization failure.
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),

    /// Note-memo encryption or decryption failure.
    #[error("encryption error: {0}")]
    Encryption(&'static str),

    /// Underlying types-crate error (shared between client, prover, relayer).
    #[error("types error: {0}")]
    Types(#[from] said_shielded_pool_types::Error),

    /// Catch-all for unexpected internal invariants.
    #[error("internal: {0}")]
    Internal(String),
}

impl From<bs58::decode::Error> for Error {
    fn from(e: bs58::decode::Error) -> Self {
        Error::Encoding(format!("bs58: {e}"))
    }
}

impl From<hex::FromHexError> for Error {
    fn from(e: hex::FromHexError) -> Self {
        Error::Encoding(format!("hex: {e}"))
    }
}
