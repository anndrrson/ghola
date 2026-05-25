//! Aleo account derivation from a Turnkey Ed25519 signature.
//!
//! Per `docs/security/tier-2k-shielded-payments.md` §4.3, the shielded
//! rail must NOT expose a second wallet to the user. We derive the Aleo
//! account deterministically from a Turnkey-signed seed using the same
//! HKDF-SHA256 pattern that the sealed envelope and vault subsystems
//! use elsewhere in the workspace.
//!
//! Real snarkVM key derivation (32-byte seed → BLS12-377 view key →
//! `aleo1…` address) is intentionally **not** wired in here: pulling
//! in snarkVM Rust crates would blow up build time and lock the
//! workspace to a particular Aleo toolchain. Instead, callers wire a
//! concrete [`AleoKeyDerivation`] implementation behind a future
//! feature flag; the [`StubAleoKeyDerivation`] in this module hex-
//! encodes the seed as a placeholder address so the rest of the
//! pipeline can be exercised end-to-end.

use hkdf::Hkdf;
use sha2::Sha256;

use crate::error::ShieldedError;

/// Domain-separation label for the Aleo account seed. Stable wire
/// constant — changing this re-derives every shielded account.
pub const ALEO_ACCOUNT_LABEL: &[u8] = b"ghola-aleo-account-v1";

/// A derived Aleo account. The seed is deterministic in the Turnkey
/// signature; `view_key` and `address` are populated by whichever
/// [`AleoKeyDerivation`] impl is in use.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AleoAccount {
    /// 32-byte HKDF-SHA256 output. Real snarkVM derivation feeds this
    /// straight into account-seed → private-key → view-key → address.
    pub seed: [u8; 32],
    /// View key bytes. Stub impl returns an empty vec; a real impl
    /// returns the BLS12-377-derived view key encoded per Aleo's
    /// canonical form.
    pub view_key: Vec<u8>,
    /// Bech32m `aleo1…` address. Stub impl returns
    /// `aleo1<hex-of-seed>`; a real impl returns the canonical Aleo
    /// address.
    pub address: String,
}

/// Pluggable seed→account derivation. Production wires a snarkVM-
/// backed implementation; the [`StubAleoKeyDerivation`] below is the
/// dev/test default.
pub trait AleoKeyDerivation {
    /// Derive the Aleo account from a 32-byte HKDF seed.
    fn derive(&self, seed: [u8; 32]) -> AleoAccount;
}

/// Placeholder [`AleoKeyDerivation`] that hex-encodes the seed as the
/// address. Wire-compatible with downstream code paths; not for
/// production proof generation.
#[derive(Debug, Default, Clone, Copy)]
pub struct StubAleoKeyDerivation;

impl AleoKeyDerivation for StubAleoKeyDerivation {
    fn derive(&self, seed: [u8; 32]) -> AleoAccount {
        AleoAccount {
            seed,
            view_key: Vec::new(),
            address: format!("aleo1{}", hex::encode(seed)),
        }
    }
}

/// HKDF-SHA256 expand `turnkey_signature` under [`ALEO_ACCOUNT_LABEL`]
/// to a 32-byte seed, then run the supplied [`AleoKeyDerivation`].
///
/// The Turnkey signature is the IKM (input key material) — it is
/// already a high-entropy Ed25519 signature, so we pass it as IKM with
/// an empty salt and the domain label in `info`.
pub fn derive_aleo_account<K: AleoKeyDerivation>(
    turnkey_signature: &[u8],
    derivation: &K,
) -> Result<AleoAccount, ShieldedError> {
    let hk = Hkdf::<Sha256>::new(None, turnkey_signature);
    let mut seed = [0u8; 32];
    hk.expand(ALEO_ACCOUNT_LABEL, &mut seed)
        .map_err(|e| ShieldedError::KeyDerivation(e.to_string()))?;
    Ok(derivation.derive(seed))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derivation_is_deterministic() {
        let sig = b"turnkey-sig-bytes-AAAA";
        let stub = StubAleoKeyDerivation;
        let a = derive_aleo_account(sig, &stub).unwrap();
        let b = derive_aleo_account(sig, &stub).unwrap();
        assert_eq!(a, b, "same input must yield same account");
    }

    #[test]
    fn different_signatures_yield_different_accounts() {
        let stub = StubAleoKeyDerivation;
        let a = derive_aleo_account(b"turnkey-sig-alpha", &stub).unwrap();
        let b = derive_aleo_account(b"turnkey-sig-beta", &stub).unwrap();
        assert_ne!(a.seed, b.seed);
        assert_ne!(a.address, b.address);
    }

    #[test]
    fn stub_address_format_is_aleo1_hex() {
        let stub = StubAleoKeyDerivation;
        let acct = derive_aleo_account(b"sig", &stub).unwrap();
        assert!(acct.address.starts_with("aleo1"));
        assert_eq!(acct.address.len(), "aleo1".len() + 64);
    }

    #[test]
    fn label_is_pinned_constant() {
        // Wire stability — changing the label is a breaking change for
        // every issued account. This test makes that change loud.
        assert_eq!(ALEO_ACCOUNT_LABEL, b"ghola-aleo-account-v1");
    }
}
