//! Internal secret-handling primitives for the Ghola shielded pool.
//!
//! # Why a separate crate?
//!
//! Every crate in the shielded-pool stack handles bytes that MUST be
//! zeroized on drop and MUST NOT leak through `Debug`, log fields, or
//! process-memory dumps:
//!
//! - `said-shielded-pool-types::SpendingKey` (already `Zeroize`)
//! - `said-shielded-pool-types::TransferWitness` (spending_key + blindings)
//! - `said-shielded-pool-relayer::submit::RpcSubmitter` signing key
//! - `said-shielded-pool-indexer::forester::ForesterKeypair` bytes
//! - `said-shielded-pool-client::encryption` ephemeral X25519 secret
//!
//! All of these share one shape — a fixed-size `[u8; N]` of raw secret
//! material — and one set of obligations:
//!
//! 1. Zero the memory on drop.
//! 2. Never emit through `Debug` / `Display` / log formatting.
//! 3. Constant-time equality (so comparators don't leak via timing).
//! 4. Explicit, named accessors (so `secret.0` doesn't compile).
//!
//! The [`SecretBytes`] newtype below packages all four. The
//! [`ScrubbedString`] type adds a redacted form for log fields where
//! emitting a short, deterministic prefix (for correlation) is useful
//! but the full value MUST be suppressed.
//!
//! Style is modeled on the `secrecy` crate (which we deliberately don't
//! depend on — it pulls in a `serde` indirection we don't want by
//! default, and we need fixed-size arrays not heap `Box<[u8]>`).

#![forbid(unsafe_code)]
#![deny(missing_docs)]

use core::fmt;

use subtle::ConstantTimeEq;
pub use zeroize::{Zeroize, Zeroizing};

pub mod scrubbed;
pub use scrubbed::ScrubbedString;

/// A fixed-size secret byte array that is zeroized on drop.
///
/// # Guarantees
///
/// - `Drop` zeroes the backing storage (via [`Zeroizing`]).
/// - `Debug` prints `"<redacted N bytes>"`; the inner value is NEVER
///   emitted through any standard formatter.
/// - `Display` is intentionally NOT implemented — there is no safe
///   default rendering. Use [`Self::expose_secret`] or
///   [`ScrubbedString`] explicitly when an audit-grade prefix is needed.
/// - `PartialEq` / `Eq` compare in constant time via
///   [`subtle::ConstantTimeEq`], so equality checks don't leak the
///   matched prefix length through timing.
/// - `Clone` is implemented (cloning is sometimes required when handing
///   the value to a one-shot signer that takes ownership) but every
///   clone carries the same zeroize-on-drop guarantee.
/// - `expose_secret` is an explicit, lint-greppable accessor — calls
///   are deliberately easy to audit by name.
///
/// # When to use
///
/// Any secret of fixed length: 32-byte spending keys, 32-byte X25519
/// ephemeral keys, 44-byte HKDF outputs, 64-byte Ed25519 signing keys.
/// For dynamically-sized secrets, wrap a `Vec<u8>` in `Zeroizing` directly.
#[derive(Clone)]
pub struct SecretBytes<const N: usize>(Zeroizing<[u8; N]>);

impl<const N: usize> SecretBytes<N> {
    /// Construct from a fixed-size array (consumes the input).
    ///
    /// Note: the input is moved, not cloned, so the caller's stack copy
    /// is the only one not under zeroize control. Best practice: produce
    /// the bytes directly into this constructor (e.g.
    /// `SecretBytes::new(rand_bytes())`) rather than holding them in a
    /// local first.
    #[inline]
    pub fn new(bytes: [u8; N]) -> Self {
        Self(Zeroizing::new(bytes))
    }

    /// Zero-filled secret. Useful as a placeholder before population.
    #[inline]
    pub fn zero() -> Self {
        Self(Zeroizing::new([0u8; N]))
    }

    /// Explicit accessor for the inner secret bytes.
    ///
    /// Named after the `secrecy` crate convention. Audit any call site
    /// of `expose_secret` carefully.
    #[inline]
    pub fn expose_secret(&self) -> &[u8; N] {
        &self.0
    }

    /// Mutable access — used when initializing from a fallible source
    /// (e.g. `rand::RngCore::fill_bytes`). Same audit guidance applies.
    #[inline]
    pub fn expose_secret_mut(&mut self) -> &mut [u8; N] {
        &mut self.0
    }

    /// Consume the wrapper and return the inner array.
    ///
    /// The returned array is **not** zeroized on drop on its own.
    /// Use this only at the boundary where you immediately hand off
    /// ownership to a type that itself implements `Zeroize` (e.g. an
    /// `ed25519_dalek::SigningKey`'s `from_bytes` constructor).
    #[inline]
    pub fn into_inner(self) -> [u8; N] {
        // We need to extract the inner array without triggering the
        // zeroize-on-drop of `Zeroizing`. Trick: replace with a zero
        // array before unwrapping.
        let mut out = [0u8; N];
        // SAFETY: we are not using unsafe; `Zeroizing` exposes the
        // inner via `DerefMut`, and we copy then let `self` drop
        // (which zeroes the now-redundant inner).
        out.copy_from_slice(&self.0[..]);
        out
    }

    /// Length of the secret in bytes. Always a const.
    #[inline]
    pub const fn len(&self) -> usize {
        N
    }

    /// Byte-length of the secret (trivially > 0 for `N > 0`; included
    /// for symmetry with `len`).
    #[inline]
    pub const fn is_empty(&self) -> bool {
        N == 0
    }
}

// --- Debug: never leak content. -----------------------------------------

impl<const N: usize> fmt::Debug for SecretBytes<N> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "<redacted {N} bytes>")
    }
}

// Display is INTENTIONALLY NOT IMPLEMENTED. Calling `format!("{}", k)`
// must not compile.

// --- Equality: constant-time. -------------------------------------------

impl<const N: usize> PartialEq for SecretBytes<N> {
    fn eq(&self, other: &Self) -> bool {
        self.0[..].ct_eq(&other.0[..]).into()
    }
}

impl<const N: usize> Eq for SecretBytes<N> {}

// --- Zeroize / Drop are inherited from Zeroizing. -----------------------

// --- Optional serde --------------------------------------------------

#[cfg(feature = "serde")]
mod serde_impl {
    use super::SecretBytes;
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    impl<const N: usize> Serialize for SecretBytes<N> {
        fn serialize<S: Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
            // Hex-encode for human-readable formats (keystore JSON).
            // Bytes go out only when the caller explicitly serializes.
            let hex = hex::encode(self.expose_secret());
            ser.serialize_str(&hex)
        }
    }

    impl<'de, const N: usize> Deserialize<'de> for SecretBytes<N> {
        fn deserialize<D: Deserializer<'de>>(de: D) -> Result<Self, D::Error> {
            let s = <String as Deserialize>::deserialize(de)?;
            let bytes = hex::decode(&s).map_err(serde::de::Error::custom)?;
            if bytes.len() != N {
                return Err(serde::de::Error::custom(format!(
                    "expected {N} bytes, got {}",
                    bytes.len()
                )));
            }
            let mut arr = [0u8; N];
            arr.copy_from_slice(&bytes);
            Ok(Self::new(arr))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_does_not_leak_bytes() {
        let s = SecretBytes::<32>::new([0xAB; 32]);
        let d = format!("{:?}", s);
        assert_eq!(d, "<redacted 32 bytes>");
        // Defense in depth: the hex of 0xAB must not appear.
        assert!(!d.contains("ab"));
        assert!(!d.contains("AB"));
    }

    #[test]
    fn equality_is_value_correct() {
        let a = SecretBytes::<8>::new([1, 2, 3, 4, 5, 6, 7, 8]);
        let b = SecretBytes::<8>::new([1, 2, 3, 4, 5, 6, 7, 8]);
        let c = SecretBytes::<8>::new([1, 2, 3, 4, 5, 6, 7, 9]);
        assert_eq!(a, b);
        assert_ne!(a, c);
    }

    #[test]
    fn into_inner_extracts() {
        let s = SecretBytes::<4>::new([9, 8, 7, 6]);
        let inner = s.into_inner();
        assert_eq!(inner, [9, 8, 7, 6]);
    }

    #[test]
    fn expose_secret_mut_can_populate() {
        let mut s = SecretBytes::<4>::zero();
        s.expose_secret_mut().copy_from_slice(&[1, 2, 3, 4]);
        assert_eq!(s.expose_secret(), &[1, 2, 3, 4]);
    }

    #[test]
    fn len_and_is_empty() {
        let s = SecretBytes::<16>::zero();
        assert_eq!(s.len(), 16);
        assert!(!s.is_empty());
        let z = SecretBytes::<0>::new([]);
        assert!(z.is_empty());
    }

    /// Constant-time equality is a property statement, not a
    /// deterministically testable claim under stable Rust (the test
    /// can be defeated by branch predictors, OS scheduler noise, and
    /// the `subtle` crate's compiler-fence stubs). We ship the test
    /// behind `#[ignore]` so it documents intent without flaking CI.
    #[test]
    #[ignore = "timing-sensitive; documents intent only"]
    fn equality_is_constant_time_best_effort() {
        use std::time::Instant;
        let a = SecretBytes::<32>::new([0u8; 32]);
        let b_match = SecretBytes::<32>::new([0u8; 32]);
        let mut b_first_byte_differs = [0u8; 32];
        b_first_byte_differs[0] = 1;
        let b_first = SecretBytes::<32>::new(b_first_byte_differs);
        let mut b_last_byte_differs = [0u8; 32];
        b_last_byte_differs[31] = 1;
        let b_last = SecretBytes::<32>::new(b_last_byte_differs);

        const ITERS: u32 = 200_000;
        let t1 = Instant::now();
        for _ in 0..ITERS {
            let _ = a == b_match;
        }
        let d1 = t1.elapsed();
        let t2 = Instant::now();
        for _ in 0..ITERS {
            let _ = a == b_first;
        }
        let d2 = t2.elapsed();
        let t3 = Instant::now();
        for _ in 0..ITERS {
            let _ = a == b_last;
        }
        let d3 = t3.elapsed();
        // Expect d2 and d3 to be within ~30% of d1 — constant-time
        // means "no dependence on input value", not literally identical.
        let ratio_first = d2.as_nanos() as f64 / d1.as_nanos() as f64;
        let ratio_last = d3.as_nanos() as f64 / d1.as_nanos() as f64;
        eprintln!("ct ratios: first={ratio_first:.3} last={ratio_last:.3}");
        assert!(ratio_first > 0.5 && ratio_first < 1.6, "first={ratio_first}");
        assert!(ratio_last > 0.5 && ratio_last < 1.6, "last={ratio_last}");
    }

    #[cfg(feature = "serde")]
    #[test]
    fn serde_roundtrip_via_hex() {
        let s = SecretBytes::<4>::new([0xAA, 0xBB, 0xCC, 0xDD]);
        let j = serde_json::to_string(&s).unwrap();
        assert_eq!(j, "\"aabbccdd\"");
        let r: SecretBytes<4> = serde_json::from_str(&j).unwrap();
        assert_eq!(r, s);
    }
}
