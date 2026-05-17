//! KMS-anchored measurement signature verifier.
//!
//! Defense-in-depth sibling to [`crate::allowlist`]. Where the allowlist
//! verifier checks an Ed25519 signature by an offline Ghola key over
//! `sha256(PCR0||PCR1||PCR2)`, this verifier checks an ECDSA P-384
//! signature by an AWS KMS-managed asymmetric key over
//! `sha384(PCR0||PCR1||PCR2)`.
//!
//! Why both? Two independent trust anchors. If the offline Ed25519 key
//! is ever lost or stolen, the KMS key (gated by IAM + CloudTrail +
//! account-level controls) still gates which measurements the relay
//! accepts. If KMS itself is compromised, the offline key still does.
//!
//! Hash choice: KMS's `ECDSA_SHA_384` signing algorithm wraps the
//! caller-supplied digest in the ECDSA-with-SHA-384 OID and only
//! accepts 48-byte SHA-384 inputs. We therefore hash the measurement
//! with SHA-384 here (not SHA-256), which is also the curve's natural
//! pairing.
//!
//! Public key format: callers pin the verifier key as a PEM-encoded
//! SubjectPublicKeyInfo (the format `aws kms get-public-key` returns
//! after base64 decoding into a `-----BEGIN PUBLIC KEY-----` envelope).
//! [`load_pem_pubkey`] decodes it once; pass the resulting `VerifyingKey`
//! into [`verify_measurement_kms`].

use p384::ecdsa::{signature::Verifier as _, Signature as P384Sig, VerifyingKey as P384Vk};
use p384::pkcs8::DecodePublicKey;
use sha2::{Digest, Sha384};

use crate::AttestationError;

/// Parse a PEM-encoded ECC P-384 SubjectPublicKeyInfo into a
/// [`P384Vk`] suitable for [`verify_measurement_kms`].
pub fn load_pem_pubkey(pem: &str) -> Result<P384Vk, AttestationError> {
    P384Vk::from_public_key_pem(pem)
        .map_err(|e| AttestationError::CertChain(format!("KMS pubkey PEM parse: {e}")))
}

/// Verify that `sig_der` is a valid ECDSA P-384 signature over
/// `sha384(measurement)` by `kms_pub`.
///
/// `sig_der` is the raw bytes AWS KMS returns from `kms:Sign`
/// (DER-encoded). For compatibility with operators who base64 the file
/// in transit, [`verify_measurement_kms_raw_or_der`] accepts either.
pub fn verify_measurement_kms(
    measurement: &[u8],
    sig_der: &[u8],
    kms_pub: &P384Vk,
) -> Result<(), AttestationError> {
    let mut hasher = Sha384::new();
    hasher.update(measurement);
    let digest = hasher.finalize();
    let sig = P384Sig::from_der(sig_der).map_err(|_| AttestationError::KmsSig)?;
    kms_pub
        .verify(&digest, &sig)
        .map_err(|_| AttestationError::KmsSig)
}

/// Variant that tries DER first then raw `r||s` (96 bytes). Useful if
/// the deployment pipeline ever decides to flatten the signature.
pub fn verify_measurement_kms_raw_or_der(
    measurement: &[u8],
    sig_bytes: &[u8],
    kms_pub: &P384Vk,
) -> Result<(), AttestationError> {
    let mut hasher = Sha384::new();
    hasher.update(measurement);
    let digest = hasher.finalize();
    let sig = P384Sig::from_der(sig_bytes)
        .or_else(|_| P384Sig::from_slice(sig_bytes))
        .map_err(|_| AttestationError::KmsSig)?;
    kms_pub
        .verify(&digest, &sig)
        .map_err(|_| AttestationError::KmsSig)
}

#[cfg(test)]
mod tests {
    use super::*;
    use p384::ecdsa::{signature::Signer, SigningKey as P384Sk};
    use p384::pkcs8::EncodePublicKey;
    use rand::rngs::OsRng;

    fn fresh_key() -> (P384Sk, P384Vk) {
        let sk = P384Sk::random(&mut OsRng);
        let vk = *sk.verifying_key();
        (sk, vk)
    }

    #[test]
    fn happy_path() {
        let (sk, vk) = fresh_key();
        let measurement = vec![0xABu8; 144]; // 3 x 48-byte PCRs
        let mut hasher = Sha384::new();
        hasher.update(&measurement);
        let digest = hasher.finalize();
        let sig: P384Sig = sk.sign(&digest);
        verify_measurement_kms(&measurement, &sig.to_der().as_bytes(), &vk).expect("happy");
    }

    #[test]
    fn tampered_measurement_fails() {
        let (sk, vk) = fresh_key();
        let measurement = vec![0x11u8; 144];
        let mut hasher = Sha384::new();
        hasher.update(&measurement);
        let digest = hasher.finalize();
        let sig: P384Sig = sk.sign(&digest);

        let mut tampered = measurement.clone();
        tampered[0] ^= 1;
        assert!(matches!(
            verify_measurement_kms(&tampered, &sig.to_der().as_bytes(), &vk),
            Err(AttestationError::KmsSig)
        ));
    }

    #[test]
    fn wrong_key_fails() {
        let (sk, _vk) = fresh_key();
        let (_sk2, vk2) = fresh_key();
        let measurement = vec![0x44u8; 144];
        let mut hasher = Sha384::new();
        hasher.update(&measurement);
        let digest = hasher.finalize();
        let sig: P384Sig = sk.sign(&digest);
        assert!(matches!(
            verify_measurement_kms(&measurement, &sig.to_der().as_bytes(), &vk2),
            Err(AttestationError::KmsSig)
        ));
    }

    #[test]
    fn pem_round_trip() {
        let (_sk, vk) = fresh_key();
        let pem = vk
            .to_public_key_pem(Default::default())
            .expect("encode pem");
        let parsed = load_pem_pubkey(&pem).expect("parse pem");
        assert_eq!(vk, parsed);
    }

    #[test]
    fn malformed_sig_fails() {
        let (_sk, vk) = fresh_key();
        let measurement = vec![0xFFu8; 144];
        assert!(matches!(
            verify_measurement_kms(&measurement, &[0u8; 8], &vk),
            Err(AttestationError::KmsSig)
        ));
    }

    #[test]
    fn raw_or_der_accepts_both() {
        let (sk, vk) = fresh_key();
        let measurement = vec![0x55u8; 144];
        let mut hasher = Sha384::new();
        hasher.update(&measurement);
        let digest = hasher.finalize();
        let sig: P384Sig = sk.sign(&digest);
        // DER
        verify_measurement_kms_raw_or_der(&measurement, &sig.to_der().as_bytes(), &vk).unwrap();
        // raw 96
        verify_measurement_kms_raw_or_der(&measurement, &sig.to_bytes(), &vk).unwrap();
    }
}
