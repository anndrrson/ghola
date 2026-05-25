//! Shielded keypair: spending key + spend-authority key + nullifier key.
//!
//! Mirrors the Zcash Sapling viewing-key hierarchy, simplified to match
//! the circom circuits described in `docs/shielded-pool/SPEC.md`.
//!
//! - `sk` (spending key) — 32-byte secret. Authorizes spends.
//! - `ak`  — `Poseidon1(sk)`. Public spend authority; appears as
//!   `owner_pubkey` inside note commitments.
//! - `nk`  — `Poseidon2(sk, [1])`. Viewing-key component, used ONLY for
//!   IVK derivation below (incoming-note discovery). See the WARNING.
//! - IVK   — `Poseidon2(ak, nk)`. Lets a wallet decrypt incoming notes
//!   without holding `sk`. Used by [`Scanner`](crate::Scanner).
//!
//! ## WARNING (H4 — nullifier-derivation mismatch)
//!
//! The on-chain NULLIFIER is NOT derived from `nk`. The circom circuit
//! (`circuits/keypair.circom`) and the prover witness builder
//! (`said-shielded-pool-prover::witness::nullifier_hash`) both compute
//! `nullifier = Poseidon3(sk, commitment, leaf_index)`
//! using the RAW spending key `sk` as the nullifying key (v1 single-key
//! model), NOT `nk = Poseidon2(sk, [1])`. The `nk` here is purely a
//! viewing-key input to `ivk` and must NEVER be fed into a nullifier
//! computation in this SDK — doing so would yield a value the on-chain
//! `NullifierAccount` PDA never matches, and (worse) could let the same
//! note resolve to two different nullifiers → double-spend.
//!
//! This SDK currently never computes nullifiers from `nk` (nullifiers are
//! produced inside the prover from `sk`), so there is no live bug. The
//! divergence is documented here rather than "fixed" because `nk` is
//! load-bearing for the IVK/viewing-key scheme; unifying it with the
//! nullifier key would require a spec change + ceremony.
//! TODO(spec): pin ONE nullifier-key definition across circuit, prover,
//! and SDK, and add a cross-crate vector asserting equality.
//!
//! ## Crypto status
//!
//! All derivations use Circom-compatible Poseidon-BN254 via
//! [`crate::poseidon`], matching the on-chain `sol_poseidon` syscall, the
//! Circom circuits, and the testvectors crate byte-for-byte.

use zeroize::Zeroize;

use said_shielded_pool_types::{FieldBytes, FullViewingKey, IncomingViewingKey};

use crate::poseidon::{pack_u64_be, poseidon1, poseidon2};

/// Spending key + viewing components.
///
/// `sk` is zeroized on drop. Clone with care — every clone is an
/// additional copy of the secret in memory.
#[derive(Clone, Zeroize)]
#[zeroize(drop)]
pub struct ShieldedKeypair {
    /// The spending key.
    pub sk: FieldBytes,
    /// Spend authority — public.
    pub ak: FieldBytes,
    /// Nullifier-derivation key — quasi-public (FVK reveals it).
    pub nk: FieldBytes,
}

impl ShieldedKeypair {
    /// Derive a keypair from a 32-byte seed (the spending key).
    ///
    /// The seed should come from a high-entropy source — Turnkey, an
    /// HSM, or `rand::rngs::OsRng`.
    pub fn from_seed(seed: &[u8; 32]) -> Self {
        let sk = *seed;
        let ak = derive_ak(&sk);
        let nk = derive_nk(&sk);
        Self { sk, ak, nk }
    }

    /// Generate a fresh keypair from the OS RNG.
    pub fn generate() -> Self {
        use rand::RngCore;
        let mut seed = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut seed);
        Self::from_seed(&seed)
    }

    /// Full Viewing Key — audit / incoming-note discovery, no spend.
    /// NOTE (H4): `nk` here is a viewing-key component, NOT the nullifier
    /// key. The on-chain nullifier is `Poseidon3(sk, commitment, idx)` and
    /// cannot be derived from the FVK. See the module-level WARNING.
    pub fn fvk(&self) -> FullViewingKey {
        FullViewingKey {
            ak: self.ak,
            nk: self.nk,
        }
    }

    /// Incoming Viewing Key — decrypt incoming notes only.
    pub fn ivk(&self) -> IncomingViewingKey {
        IncomingViewingKey(derive_ivk(&self.ak, &self.nk))
    }
}

impl std::fmt::Debug for ShieldedKeypair {
    /// Custom impl — never prints `sk`.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ShieldedKeypair")
            .field("sk", &"[REDACTED]")
            .field("ak", &hex::encode(self.ak))
            .field("nk", &hex::encode(self.nk))
            .finish()
    }
}

/// Derive `ak = Poseidon1(sk)` — Circom-compatible Poseidon-BN254.
///
/// Matches the on-chain `sol_poseidon` syscall and the testvectors crate.
pub fn derive_ak(sk: &FieldBytes) -> FieldBytes {
    poseidon1(sk)
}

/// Derive `nk = Poseidon2(sk, [1])` — Circom-compatible Poseidon-BN254.
///
/// The `[1]` tag (a 32-byte field element holding the integer 1) gives
/// domain separation from `ak = Poseidon1(sk)`. Same arity-2 hash used by
/// the Merkle tree.
pub fn derive_nk(sk: &FieldBytes) -> FieldBytes {
    poseidon2(sk, &pack_u64_be(1))
}

/// Derive `ivk = Poseidon2(ak, nk)` — Circom-compatible Poseidon-BN254.
///
/// IVK is a one-way function of FVK; it never reveals `sk`.
pub fn derive_ivk(ak: &FieldBytes, nk: &FieldBytes) -> FieldBytes {
    poseidon2(ak, nk)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derive_is_deterministic() {
        let seed = [7u8; 32];
        let a = ShieldedKeypair::from_seed(&seed);
        let b = ShieldedKeypair::from_seed(&seed);
        assert_eq!(a.ak, b.ak);
        assert_eq!(a.nk, b.nk);
    }

    #[test]
    fn distinct_seeds_distinct_keys() {
        let a = ShieldedKeypair::from_seed(&[1u8; 32]);
        let b = ShieldedKeypair::from_seed(&[2u8; 32]);
        assert_ne!(a.ak, b.ak);
        assert_ne!(a.nk, b.nk);
    }

    #[test]
    fn fvk_and_ivk_derive() {
        let kp = ShieldedKeypair::from_seed(&[42u8; 32]);
        let fvk = kp.fvk();
        let ivk = kp.ivk();
        assert_eq!(fvk.ak, kp.ak);
        assert_eq!(fvk.nk, kp.nk);
        assert_ne!(ivk.0, [0u8; 32]);
    }

    #[test]
    fn debug_does_not_leak_sk() {
        let kp = ShieldedKeypair::from_seed(&[9u8; 32]);
        let s = format!("{kp:?}");
        assert!(s.contains("REDACTED"));
        assert!(!s.contains("09090909"));
    }
}
