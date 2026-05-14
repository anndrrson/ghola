//! Public types for `said-attest`.
//!
//! These are surfaced for downstream consumers (the relay's
//! attested-providers map, the in-enclave provider, the web verifier).

use serde::{Deserialize, Serialize};
use thiserror::Error;
use thumper_types::{EnclaveKeyId, TeeKind};

/// A fully verified attestation, ready for the relay to insert into its
/// in-memory attested-providers map.
///
/// `provider_id` is intentionally left empty by [`crate::verify_attestation`];
/// the caller (typically the relay) populates it from the WebSocket session
/// that delivered the `ProviderAttest` envelope, so the attestation is bound
/// to the provider's long-lived auth pubkey.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AttestedEnclave {
    /// bs58 of the provider's long-lived auth pubkey, set by the caller.
    pub provider_id: String,
    /// Stable identifier = sha256(enclave_x25519_pub).
    pub enclave_key_id: EnclaveKeyId,
    pub enclave_x25519_pub: [u8; 32],
    pub enclave_ed25519_pub: [u8; 32],
    pub tee_kind: TeeKind,
    /// For Nitro this is `PCR0 || PCR1 || PCR2`. Opaque bytes for other TEEs.
    pub measurement: Vec<u8>,
    pub attested_at_unix: i64,
    pub expires_at_unix: i64,
}

/// Decoded view of an AWS Nitro Enclave attestation document.
///
/// Mirrors the CBOR payload of the `COSE_Sign1` envelope (see
/// `https://docs.aws.amazon.com/enclaves/latest/user/verify-root.html`).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct NitroAttestation {
    pub module_id: String,
    pub timestamp_ms: u64,
    /// pcr index -> digest bytes.
    pub pcrs: Vec<(u32, Vec<u8>)>,
    /// Leaf certificate that signed this document (DER).
    pub certificate_der: Vec<u8>,
    /// Chain from leaf toward the AWS Nitro Root G1 (DER per element).
    pub cabundle_der: Vec<Vec<u8>>,
    /// Optional, often unused in our flow.
    pub public_key: Option<Vec<u8>>,
    /// We bind `sha256("ghola-attest-v1" || x25519_pub || ed25519_pub || ts)`
    /// here. For the orchestration in [`crate::verify_attestation`] we use
    /// the simpler concatenation `x25519_pub || ed25519_pub || ts_le_i64`.
    pub user_data: Option<Vec<u8>>,
    pub nonce: Option<Vec<u8>>,
}

#[derive(Debug, Error)]
pub enum AttestationError {
    #[error("malformed COSE_Sign1 envelope: {0}")]
    Cose(String),
    #[error("malformed CBOR payload: {0}")]
    Cbor(String),
    #[error("certificate chain verification failed: {0}")]
    CertChain(String),
    #[error("signature verification failed")]
    Signature,
    #[error("missing PCR{0}")]
    MissingPcr(u32),
    #[error("user_data does not bind enclave keys")]
    UserDataMismatch,
    #[error("allowlist signature invalid")]
    AllowlistSig,
    #[error("KMS measurement signature invalid")]
    KmsSig,
    #[error("attestation expired (now {now}, doc ts {ts})")]
    Expired { now: i64, ts: i64 },
    #[error("attestation timestamp in the future")]
    FutureTimestamp,
    #[error("unsupported tee_kind for this verifier")]
    UnsupportedTeeKind,
    #[error("internal: {0}")]
    Internal(String),
}
