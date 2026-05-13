//! Ghola measurement allowlist verifier.
//!
//! The relay can be configured with `GHOLA_ATTEST_SIGNING_PUB`, the
//! Ed25519 public half of an offline key Ghola controls. Every Nitro
//! enclave image we build has its measurement (`sha256(PCR0||PCR1||PCR2)`)
//! signed by that key after manual review. The provider ships that
//! signature alongside the vendor quote; the relay verifies both layers.
//!
//! This is defense-in-depth: if the vendor cert chain is ever compromised
//! or an attacker swaps in a different signed measurement, the allowlist
//! signature still catches it.

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use sha2::{Digest, Sha256};

use crate::AttestationError;

/// Verify that `sig_bytes` is a valid Ed25519 signature over
/// `sha256(measurement)` by `allowlist_pub`.
pub fn verify_measurement(
    measurement: &[u8],
    sig_bytes: &[u8],
    allowlist_pub: &VerifyingKey,
) -> Result<(), AttestationError> {
    let sig_arr: [u8; 64] = sig_bytes
        .try_into()
        .map_err(|_| AttestationError::AllowlistSig)?;
    let sig = Signature::from_bytes(&sig_arr);
    let mut hasher = Sha256::new();
    hasher.update(measurement);
    let digest = hasher.finalize();
    allowlist_pub
        .verify(&digest, &sig)
        .map_err(|_| AttestationError::AllowlistSig)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn sign(measurement: &[u8], sk: &SigningKey) -> Vec<u8> {
        let mut hasher = Sha256::new();
        hasher.update(measurement);
        let digest = hasher.finalize();
        sk.sign(&digest).to_bytes().to_vec()
    }

    #[test]
    fn roundtrip_happy() {
        let mut csprng = rand::rngs::OsRng;
        let sk = SigningKey::generate(&mut csprng);
        let pk = sk.verifying_key();
        let measurement = b"PCR0||PCR1||PCR2 dummy bytes".to_vec();
        let sig = sign(&measurement, &sk);
        verify_measurement(&measurement, &sig, &pk).expect("happy path");
    }

    #[test]
    fn tampered_measurement_fails() {
        let mut csprng = rand::rngs::OsRng;
        let sk = SigningKey::generate(&mut csprng);
        let pk = sk.verifying_key();
        let measurement = b"original".to_vec();
        let sig = sign(&measurement, &sk);
        let tampered = b"tampered".to_vec();
        assert!(matches!(
            verify_measurement(&tampered, &sig, &pk),
            Err(AttestationError::AllowlistSig)
        ));
    }

    #[test]
    fn malformed_sig_len_fails() {
        let mut csprng = rand::rngs::OsRng;
        let sk = SigningKey::generate(&mut csprng);
        let pk = sk.verifying_key();
        let measurement = b"m".to_vec();
        assert!(matches!(
            verify_measurement(&measurement, &[0u8; 7], &pk),
            Err(AttestationError::AllowlistSig)
        ));
    }
}
