//! Error surface for the shielded-payment crate.
//!
//! Variants line up 1:1 with the failure modes in
//! `docs/security/tier-2k-shielded-payments.md` §4.5.

use thiserror::Error;

/// Errors returned by the shielded-payment client when broadcasting a
/// transition to the adapter or when validating its signed response.
#[derive(Debug, Error)]
pub enum ShieldedError {
    /// The adapter HTTP endpoint could not be reached, returned a non-2xx
    /// status, or the response body failed to deserialize.
    #[error("shielded adapter unreachable: {0}")]
    AdapterUnreachable(String),

    /// The adapter returned a structurally valid response but rejected the
    /// transition (e.g. `settled=false`, malformed proof).
    #[error("shielded adapter rejected transition: {0}")]
    AdapterRejected(String),

    /// The Ed25519 signature on the adapter response did not verify against
    /// the configured adapter public key.
    #[error("shielded adapter signature verification failed")]
    BadSignature,

    /// The `(provider, receipt_or_nullifier)` pair has already been seen.
    #[error("shielded receipt replay detected")]
    Replay,

    /// The adapter confirmed a smaller amount than the caller required.
    #[error("shielded payment amount insufficient: required {required}, got {got}")]
    AmountInsufficient {
        /// Micro-USDC the caller required.
        required: u64,
        /// Micro-USDC the adapter confirmed.
        got: u64,
    },

    /// The adapter response's `expiration_time` is in the past.
    #[error("shielded adapter receipt expired at {0}")]
    Expired(i64),

    /// Local key-derivation failure (HKDF expand never errors for 32-byte
    /// output in practice; this exists for defence in depth).
    #[error("shielded key derivation failed: {0}")]
    KeyDerivation(String),
}
