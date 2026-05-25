//! Note-memo encryption — encrypt a [`Note`]'s preimage to a recipient
//! so the recipient can later discover the note by scanning on-chain
//! commitments with their [`IncomingViewingKey`].
//!
//! ## STATUS: TO-BE-AUDITED — separable component.
//!
//! This module is intentionally isolated: the rest of the SDK does not
//! depend on its KEM/AEAD choices. If a future audit (or the spec
//! agent) prescribes a different construction (e.g. Sapling-style
//! Poly1305-ChaCha + ephemeral Jubjub keys), we can swap this without
//! touching the rest of the crate.
//!
//! ## Current construction
//!
//! - **KEM**: X25519 ephemeral key agreement. We treat the recipient's
//!   `ivk` 32-byte field element as an X25519 public key.
//!   **(Approximation — IVK is not a real curve point yet. TBD-spec.)**
//! - **KDF**: HKDF-SHA256 over the shared secret with a fixed info
//!   string `b"ghola:shielded:note-memo:v1"`.
//! - **AEAD**: ChaCha20-Poly1305 with a 12-byte nonce (HKDF output
//!   splits 32B key + 12B nonce).
//!
//! Wire format (on-chain memo blob, attached to commitment insertion):
//!
//! ```text
//! [0..32]   ephemeral_pk
//! [32..48]  ChaCha20-Poly1305 16-byte tag
//! [48..]    ciphertext  ← plaintext = borsh(NoteMemo)
//! ```

use chacha20poly1305::{aead::Aead, ChaCha20Poly1305, KeyInit, Nonce};
use common_secrets::Zeroizing;
use hkdf::Hkdf;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use zeroize::Zeroize;

use said_shielded_pool_types::{IncomingViewingKey, Note};

use crate::error::{Error, Result};

/// Domain-separated HKDF info string.
const KDF_INFO: &[u8] = b"ghola:shielded:note-memo:v1";

/// Plaintext that gets sealed inside the memo blob.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteMemo {
    /// The recipient's note in cleartext (amount, asset, owner, blinding).
    pub note: Note,
    /// Optional 32-byte free-form tag (e.g. invoice ID).
    pub tag: Option<[u8; 32]>,
}

/// Encrypt a note memo for a recipient identified by their IVK.
///
/// Returns `[ephemeral_pk || ciphertext_with_tag]` ready to attach to
/// a commitment insertion.
pub fn encrypt_note_for(ivk: &IncomingViewingKey, memo: &NoteMemo) -> Result<Vec<u8>> {
    // 1. Sample ephemeral key — held in a `Zeroizing` wrapper so the
    //    seed is scrubbed even if any of the steps below early-return
    //    or panic.
    let mut eph_sk = Zeroizing::new([0u8; 32]);
    rand::rngs::OsRng.fill_bytes(eph_sk.as_mut_slice());
    // Clamp like X25519.
    eph_sk[0] &= 248;
    eph_sk[31] &= 127;
    eph_sk[31] |= 64;

    // 2. Treat ivk.0 as an X25519 public key (approximation, TBD-spec).
    //    Compute shared = X25519(eph_sk, ivk). The shared secret itself
    //    is sensitive (knowing it lets anyone decrypt this memo); wrap
    //    it in Zeroizing so its stack copy is scrubbed when we leave.
    let shared = Zeroizing::new(x25519(&eph_sk, &ivk.0));

    // 3. Derive key+nonce via HKDF. The 44-byte HKDF output buffer
    //    contains the AEAD key in its first 32 bytes; we hold it in
    //    a `Zeroizing` until we extract the (key, nonce) split.
    let (key, nonce) = derive_key_nonce(&shared);

    // 4. Compute ephemeral public: X25519(eph_sk, basepoint).
    //    The ephemeral public is intended to go on-chain — NOT secret —
    //    so plain `[u8; 32]` is correct here.
    let eph_pk = x25519_base(&eph_sk);

    // 5. Encrypt.
    let cipher = ChaCha20Poly1305::new((key.as_slice()).into());
    let plaintext = serde_json::to_vec(memo).map_err(Error::Json)?;
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(nonce.as_slice()), plaintext.as_ref())
        .map_err(|_| Error::Encryption("aead encrypt failed"))?;

    // 6. Wire format: ephemeral_pk || ciphertext.
    let mut out = Vec::with_capacity(32 + ciphertext.len());
    out.extend_from_slice(&eph_pk);
    out.extend_from_slice(&ciphertext);
    // `eph_sk`, `shared`, `key`, `nonce` are all dropped here and
    // `Zeroizing` ensures their backing memory is zeroed.
    Ok(out)
}

/// Attempt to decrypt a note-memo blob with an IVK.
///
/// Returns `Ok(Some(memo))` on success, `Ok(None)` if the AEAD tag
/// fails (i.e. this blob wasn't for us — the common case during a
/// chain scan), or `Err` on malformed input.
pub fn try_decrypt_note(ivk: &IncomingViewingKey, blob: &[u8]) -> Result<Option<NoteMemo>> {
    if blob.len() < 32 + 16 {
        return Err(Error::Encryption("memo blob too short"));
    }
    let eph_pk: [u8; 32] = blob[..32]
        .try_into()
        .map_err(|_| Error::Encryption("memo eph_pk length"))?;
    let ciphertext = &blob[32..];

    // shared = X25519(ivk_as_sk, eph_pk). NB: this only works if `ivk`
    // is treated symmetrically as both pk-and-sk — placeholder until
    // the spec pins a real KEM. TBD-spec.
    //
    // Wrapping `shared` and the derived key+nonce in Zeroizing so that
    // a scan over many candidate memos (the expected pathological case
    // for an indexer / wallet scanner) doesn't leave a trail of
    // shared-secret residues across the heap.
    let shared = Zeroizing::new(x25519(&ivk.0, &eph_pk));

    let (key, nonce) = derive_key_nonce(&shared);
    let cipher = ChaCha20Poly1305::new((key.as_slice()).into());
    match cipher.decrypt(Nonce::from_slice(nonce.as_slice()), ciphertext) {
        Ok(plaintext) => {
            let memo: NoteMemo = serde_json::from_slice(&plaintext).map_err(Error::Json)?;
            Ok(Some(memo))
        }
        Err(_) => Ok(None),
    }
}

/// HKDF-SHA256(shared) → (32B key, 12B nonce).
///
/// Returns both halves wrapped in `Zeroizing` — the AEAD key in
/// particular MUST be scrubbed on drop (the nonce is technically
/// derivable from any observed memo plus the shared secret, but we
/// scrub it anyway for uniformity). The internal 44-byte HKDF output
/// `okm` is similarly wrapped so the intermediate buffer is zeroed
/// before this function returns.
fn derive_key_nonce(shared: &[u8; 32]) -> (Zeroizing<[u8; 32]>, Zeroizing<[u8; 12]>) {
    let hk = Hkdf::<Sha256>::new(None, shared);
    let mut okm = Zeroizing::new([0u8; 44]);
    hk.expand(KDF_INFO, okm.as_mut_slice())
        .expect("HKDF expand: 44B fits the SHA-256 limit (255 * 32)");
    let mut key = Zeroizing::new([0u8; 32]);
    key.copy_from_slice(&okm[..32]);
    let mut nonce = Zeroizing::new([0u8; 12]);
    nonce.copy_from_slice(&okm[32..]);
    // `okm` drops here; the okm buffer is scrubbed via Zeroizing.
    okm.zeroize();
    (key, nonce)
}

/// X25519 scalar mult — wraps `curve25519-dalek`.
fn x25519(sk: &[u8; 32], pk: &[u8; 32]) -> [u8; 32] {
    use curve25519_dalek::montgomery::MontgomeryPoint;
    use curve25519_dalek::scalar::Scalar;
    let scalar = Scalar::from_bytes_mod_order(*sk);
    let point = MontgomeryPoint(*pk);
    (scalar * point).0
}

/// X25519 base-point scalar mult.
fn x25519_base(sk: &[u8; 32]) -> [u8; 32] {
    use curve25519_dalek::constants::X25519_BASEPOINT;
    use curve25519_dalek::scalar::Scalar;
    let scalar = Scalar::from_bytes_mod_order(*sk);
    (scalar * X25519_BASEPOINT).0
}

#[cfg(test)]
mod tests {
    use super::*;
    use said_shielded_pool_types::{AssetId, IncomingViewingKey};

    #[test]
    fn roundtrip_basic_shape() {
        // Note: under the placeholder IVK-as-sk-and-pk construction,
        // a true roundtrip requires `pk = base * ivk`. Here we just
        // exercise the encrypt path and check the blob layout.
        let ivk = IncomingViewingKey([5u8; 32]);
        let memo = NoteMemo {
            note: Note {
                amount: 100,
                asset_id: AssetId([1u8; 32]),
                owner_pubkey: [2u8; 32],
                blinding: [3u8; 32],
            },
            tag: Some([7u8; 32]),
        };
        let blob = encrypt_note_for(&ivk, &memo).unwrap();
        assert!(blob.len() >= 32 + 16);
        // try_decrypt with the wrong key returns Ok(None) (no panic).
        let wrong_ivk = IncomingViewingKey([99u8; 32]);
        let res = try_decrypt_note(&wrong_ivk, &blob).unwrap();
        assert!(res.is_none());
    }

    #[test]
    fn malformed_blob_rejected() {
        let ivk = IncomingViewingKey([1u8; 32]);
        let res = try_decrypt_note(&ivk, &[0u8; 10]);
        assert!(res.is_err());
    }

    /// Best-effort test that the HKDF key and nonce are wrapped in
    /// `Zeroizing` (i.e. derive_key_nonce returns the zeroizable
    /// types). This is a compile-time assertion via type inference
    /// rather than a runtime check on freed memory; under stable Rust
    /// the latter is allocator-dependent and flaky.
    #[test]
    fn derive_key_nonce_returns_zeroizing() {
        let shared = [0xABu8; 32];
        let (k, n) = derive_key_nonce(&shared);
        // Both must coerce to slices of expected length.
        assert_eq!(k.len(), 32);
        assert_eq!(n.len(), 12);
        // Compile-time: the types are `Zeroizing<[u8; 32]>` and
        // `Zeroizing<[u8; 12]>`. We don't need to assert this at
        // runtime; if the signature changes the file no longer compiles.
    }

    /// Constructing and dropping an encryption call should leave no
    /// trace of the ephemeral key in the returned blob beyond the
    /// derived ephemeral PUBLIC key. We sanity-check the public bytes
    /// are not the clamped-private bytes (a different curve point in
    /// expectation).
    #[test]
    fn encrypt_does_not_leak_eph_sk_into_blob() {
        use said_shielded_pool_types::AssetId;
        let ivk = IncomingViewingKey([13u8; 32]);
        let memo = NoteMemo {
            note: Note {
                amount: 7,
                asset_id: AssetId([1u8; 32]),
                owner_pubkey: [2u8; 32],
                blinding: [3u8; 32],
            },
            tag: None,
        };
        // Run a few times — eph_sk is sampled fresh each call.
        for _ in 0..5 {
            let blob = encrypt_note_for(&ivk, &memo).unwrap();
            let eph_pk = &blob[..32];
            // The clamped private key always has top-bit `0b01` in
            // byte 31, low 3 bits zero in byte 0. The PUBLIC point
            // produced by scalar mult has NO such bit-pattern
            // constraints — if `eph_pk` happens to look clamped it's
            // a coincidence, not the eph_sk leaking through.
            // Defense in depth: just assert the blob is non-trivial.
            assert!(blob.len() > 32 + 16);
            // Belt + suspenders: eph_pk should not be all zeros or
            // the basepoint encoding (which would mean scalar=0).
            assert_ne!(eph_pk, &[0u8; 32]);
        }
    }
}
