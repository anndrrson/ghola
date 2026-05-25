//! Note-memo encryption — encrypt a [`Note`]'s preimage to a recipient
//! so the recipient can later discover the note by scanning on-chain
//! commitments with their [`IncomingViewingKey`].
//!
//! ## STATUS: sound-by-construction; NEEDS EXTERNAL CRYPTOGRAPHIC REVIEW
//! ## BEFORE MAINNET.
//!
//! This module is intentionally isolated: the rest of the SDK depends only
//! on the [`encrypt_note_for`] / [`try_decrypt_note`] signatures, not on
//! the KEM/AEAD internals. If a future spec prescribes a different
//! construction (e.g. Sapling-style Jubjub KEM), it can be swapped without
//! touching the scanner.
//!
//! ## Construction — X25519-ECIES (DHIES) over the viewing key
//!
//! The recipient's X25519 keypair is derived DETERMINISTICALLY from their
//! incoming viewing key so that:
//!   * the sender can compute the recipient's X25519 *public* key from the
//!     `ivk` alone (the `ivk` is the recipient's published address), and
//!   * the recipient/scanner can re-derive the matching X25519 *secret*
//!     from the same `ivk` to decrypt.
//!
//! ```text
//! recipient_x25519_sk = clamp( HKDF-SHA256(
//!                                 ikm  = ivk.0,
//!                                 salt = "",
//!                                 info = X25519_SK_INFO ) )
//! recipient_x25519_pk = X25519_basepoint * recipient_x25519_sk
//! ```
//!
//! Encryption (sender):
//! ```text
//! eph_sk  = clamp(random 32 bytes)
//! eph_pk  = X25519_basepoint * eph_sk
//! shared  = X25519(eph_sk, recipient_x25519_pk)            // DH
//! (key, nonce) = HKDF-SHA256( ikm  = shared,
//!                             salt = eph_pk || recipient_x25519_pk,
//!                             info = AEAD_INFO )            // 32 + 12 bytes
//! ct||tag = ChaCha20Poly1305(key, nonce).encrypt(borsh-ish(NoteMemo))
//! ```
//! Decryption (recipient) recomputes `shared = X25519(recipient_x25519_sk,
//! eph_pk)` (same value by DH symmetry) and the same HKDF, then AEAD-opens.
//!
//! Transcript binding: the ephemeral and recipient public keys are folded
//! into the HKDF `salt`, so the derived key commits to both endpoints —
//! an attacker cannot splice one memo's `eph_pk` onto another recipient.
//!
//! ## Wire format (on-chain memo blob), exact offsets
//!
//! ```text
//! [ 0 .. 32)   eph_pk        — sender ephemeral X25519 public key
//! [32 .. 44)   nonce         — 12-byte ChaCha20-Poly1305 nonce (from HKDF)
//! [44 ..   )   ct || tag     — ChaCha20-Poly1305 output (plaintext + 16B tag)
//! ```
//! Minimum length = 32 + 12 + 16 = 60 bytes (empty plaintext + tag).
//!
//! The plaintext is `serde_json(NoteMemo)`.

use chacha20poly1305::{aead::Aead, ChaCha20Poly1305, KeyInit, Nonce};
use common_secrets::Zeroizing;
use hkdf::Hkdf;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use zeroize::Zeroize;

use said_shielded_pool_types::{IncomingViewingKey, Note};

use crate::error::{Error, Result};

/// Domain-separation tag for deriving the recipient's X25519 SECRET key
/// from their incoming viewing key.
const X25519_SK_INFO: &[u8] = b"ghola:shielded:note-memo:x25519-sk:v2";

/// Domain-separation tag for the AEAD key+nonce HKDF expansion.
const AEAD_INFO: &[u8] = b"ghola:shielded:note-memo:aead:v2";

/// Wire-format field sizes (see module docstring).
const EPH_PK_LEN: usize = 32;
const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;
/// Smallest valid blob: eph_pk + nonce + (empty ciphertext + tag).
const MIN_BLOB_LEN: usize = EPH_PK_LEN + NONCE_LEN + TAG_LEN;

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
/// Returns the wire blob `eph_pk || nonce || ct||tag` (see module
/// docstring for exact offsets) ready to attach to a commitment insertion.
pub fn encrypt_note_for(ivk: &IncomingViewingKey, memo: &NoteMemo) -> Result<Vec<u8>> {
    // 1. Recipient's static X25519 public key, derived from the IVK.
    //    (Public — not secret — so a plain array is fine.)
    let recipient_pk = derive_recipient_x25519_public(ivk);

    // 2. Sample + clamp an ephemeral X25519 secret. Held in `Zeroizing`
    //    so it is scrubbed even on early return / panic.
    let mut eph_sk = Zeroizing::new([0u8; 32]);
    rand::rngs::OsRng.fill_bytes(eph_sk.as_mut_slice());
    clamp_x25519(eph_sk.as_mut_slice());

    // 3. Ephemeral public (goes on-chain).
    let eph_pk = x25519_base(&eph_sk);

    // 4. DH shared secret. Sensitive — Zeroizing.
    let shared = Zeroizing::new(x25519(&eph_sk, &recipient_pk));

    // 5. HKDF → (key, nonce), salted with the transcript (eph_pk||recipient_pk).
    let (key, nonce) = derive_key_nonce(&shared, &eph_pk, &recipient_pk);

    // 6. AEAD encrypt.
    let cipher = ChaCha20Poly1305::new((key.as_slice()).into());
    let plaintext = serde_json::to_vec(memo).map_err(Error::Json)?;
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(nonce.as_slice()), plaintext.as_ref())
        .map_err(|_| Error::Encryption("aead encrypt failed"))?;

    // 7. Wire: eph_pk(32) || nonce(12) || ct||tag.
    let mut out = Vec::with_capacity(EPH_PK_LEN + NONCE_LEN + ciphertext.len());
    out.extend_from_slice(&eph_pk);
    out.extend_from_slice(nonce.as_slice());
    out.extend_from_slice(&ciphertext);
    // `eph_sk`, `shared`, `key`, `nonce` are dropped (and Zeroized) here.
    Ok(out)
}

/// Attempt to decrypt a note-memo blob with an IVK.
///
/// Returns `Ok(Some(memo))` on success, `Ok(None)` if the AEAD tag fails
/// (i.e. this blob wasn't for us — the common case during a chain scan),
/// or `Err` on a structurally malformed blob.
pub fn try_decrypt_note(ivk: &IncomingViewingKey, blob: &[u8]) -> Result<Option<NoteMemo>> {
    if blob.len() < MIN_BLOB_LEN {
        return Err(Error::Encryption("memo blob too short"));
    }

    // Parse fixed-offset header.
    let eph_pk: [u8; 32] = blob[..EPH_PK_LEN]
        .try_into()
        .map_err(|_| Error::Encryption("memo eph_pk length"))?;
    let nonce_bytes: [u8; NONCE_LEN] = blob[EPH_PK_LEN..EPH_PK_LEN + NONCE_LEN]
        .try_into()
        .map_err(|_| Error::Encryption("memo nonce length"))?;
    let ciphertext = &blob[EPH_PK_LEN + NONCE_LEN..];

    // Recipient's static X25519 keypair from the IVK.
    let recipient_sk = derive_recipient_x25519_secret(ivk);
    let recipient_pk = x25519_base(&recipient_sk);

    // DH shared secret — equals the sender's by symmetry.
    let shared = Zeroizing::new(x25519(&recipient_sk, &eph_pk));

    // Re-derive (key, nonce) with the SAME salt/info as the sender. The
    // HKDF-derived nonce must equal the on-wire nonce for a memo addressed
    // to us; we use the on-wire nonce for AEAD and rely on the AEAD tag +
    // the transcript-bound key to reject anything not meant for us.
    let (key, _derived_nonce) = derive_key_nonce(&shared, &eph_pk, &recipient_pk);

    let cipher = ChaCha20Poly1305::new((key.as_slice()).into());
    match cipher.decrypt(Nonce::from_slice(&nonce_bytes), ciphertext) {
        Ok(plaintext) => {
            let memo: NoteMemo = serde_json::from_slice(&plaintext).map_err(Error::Json)?;
            Ok(Some(memo))
        }
        Err(_) => Ok(None),
    }
}

/// Derive the recipient's static X25519 SECRET key from their IVK.
///
/// `clamp( HKDF-SHA256(ikm = ivk.0, salt = "", info = X25519_SK_INFO) )`.
/// Wrapped in `Zeroizing` — this is long-lived secret key material.
fn derive_recipient_x25519_secret(ivk: &IncomingViewingKey) -> Zeroizing<[u8; 32]> {
    let hk = Hkdf::<Sha256>::new(None, &ivk.0);
    let mut sk = Zeroizing::new([0u8; 32]);
    hk.expand(X25519_SK_INFO, sk.as_mut_slice())
        .expect("HKDF expand: 32B fits the SHA-256 limit");
    clamp_x25519(sk.as_mut_slice());
    sk
}

/// Derive the recipient's static X25519 PUBLIC key from their IVK.
/// `X25519_basepoint * recipient_sk`. Public — plain array.
pub fn derive_recipient_x25519_public(ivk: &IncomingViewingKey) -> [u8; 32] {
    let sk = derive_recipient_x25519_secret(ivk);
    x25519_base(&sk)
}

/// X25519 scalar clamp (RFC 7748 §5).
fn clamp_x25519(sk: &mut [u8]) {
    sk[0] &= 248;
    sk[31] &= 127;
    sk[31] |= 64;
}

/// HKDF-SHA256 → (32B key, 12B nonce), salted with the DH transcript.
///
/// `salt = eph_pk || recipient_pk` binds the derived key to both
/// endpoints (transcript binding); `info = AEAD_INFO` provides
/// domain separation from the X25519-SK derivation. Both halves are
/// `Zeroizing`; the intermediate 44-byte buffer is scrubbed before return.
fn derive_key_nonce(
    shared: &[u8; 32],
    eph_pk: &[u8; 32],
    recipient_pk: &[u8; 32],
) -> (Zeroizing<[u8; 32]>, Zeroizing<[u8; 12]>) {
    let mut salt = [0u8; 64];
    salt[..32].copy_from_slice(eph_pk);
    salt[32..].copy_from_slice(recipient_pk);

    let hk = Hkdf::<Sha256>::new(Some(&salt), shared);
    let mut okm = Zeroizing::new([0u8; 44]);
    hk.expand(AEAD_INFO, okm.as_mut_slice())
        .expect("HKDF expand: 44B fits the SHA-256 limit (255 * 32)");
    let mut key = Zeroizing::new([0u8; 32]);
    key.copy_from_slice(&okm[..32]);
    let mut nonce = Zeroizing::new([0u8; 12]);
    nonce.copy_from_slice(&okm[32..]);
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

    fn sample_memo() -> NoteMemo {
        NoteMemo {
            note: Note {
                amount: 100,
                asset_id: AssetId([1u8; 32]),
                owner_pubkey: [2u8; 32],
                blinding: [3u8; 32],
            },
            tag: Some([7u8; 32]),
        }
    }

    #[test]
    fn roundtrip_encrypt_then_decrypt() {
        let ivk = IncomingViewingKey([5u8; 32]);
        let memo = sample_memo();
        let blob = encrypt_note_for(&ivk, &memo).unwrap();

        // Wire-format sanity: header + tag minimum.
        assert!(blob.len() >= MIN_BLOB_LEN);

        let got = try_decrypt_note(&ivk, &blob)
            .expect("decrypt ok")
            .expect("memo present for the correct key");
        assert_eq!(got.note.amount, memo.note.amount);
        assert_eq!(got.note.asset_id, memo.note.asset_id);
        assert_eq!(got.note.owner_pubkey, memo.note.owner_pubkey);
        assert_eq!(got.note.blinding, memo.note.blinding);
        assert_eq!(got.tag, memo.tag);
    }

    #[test]
    fn wrong_key_fails_to_decrypt() {
        let ivk = IncomingViewingKey([5u8; 32]);
        let memo = sample_memo();
        let blob = encrypt_note_for(&ivk, &memo).unwrap();

        // A different IVK derives a different X25519 secret → AEAD tag
        // fails → Ok(None), never a panic and never the wrong plaintext.
        let wrong = IncomingViewingKey([99u8; 32]);
        let res = try_decrypt_note(&wrong, &blob).unwrap();
        assert!(res.is_none(), "wrong key must NOT decrypt");
    }

    #[test]
    fn distinct_ephemeral_per_call() {
        // Two encryptions to the same recipient must use distinct
        // ephemeral public keys (fresh randomness each call), so the
        // blobs differ even for identical plaintext.
        let ivk = IncomingViewingKey([5u8; 32]);
        let memo = sample_memo();
        let a = encrypt_note_for(&ivk, &memo).unwrap();
        let b = encrypt_note_for(&ivk, &memo).unwrap();
        assert_ne!(&a[..EPH_PK_LEN], &b[..EPH_PK_LEN], "eph_pk must be fresh");
        assert_ne!(a, b);
        // Both still decrypt for the recipient.
        assert!(try_decrypt_note(&ivk, &a).unwrap().is_some());
        assert!(try_decrypt_note(&ivk, &b).unwrap().is_some());
    }

    #[test]
    fn recipient_keypair_is_deterministic_from_ivk() {
        let ivk = IncomingViewingKey([42u8; 32]);
        let pk1 = derive_recipient_x25519_public(&ivk);
        let pk2 = derive_recipient_x25519_public(&ivk);
        assert_eq!(pk1, pk2, "recipient X25519 pk must be deterministic");
        // Distinct IVKs give distinct public keys.
        let other = derive_recipient_x25519_public(&IncomingViewingKey([43u8; 32]));
        assert_ne!(pk1, other);
        // Derived secret is properly clamped.
        let sk = derive_recipient_x25519_secret(&ivk);
        assert_eq!(sk[0] & 0b0000_0111, 0, "low 3 bits cleared");
        assert_eq!(sk[31] & 0b1100_0000, 0b0100_0000, "top bits clamped");
    }

    #[test]
    fn malformed_blob_rejected() {
        let ivk = IncomingViewingKey([1u8; 32]);
        let res = try_decrypt_note(&ivk, &[0u8; 10]);
        assert!(res.is_err());
        // Exactly one byte short of the minimum is still an Err.
        let res = try_decrypt_note(&ivk, &[0u8; MIN_BLOB_LEN - 1]);
        assert!(res.is_err());
    }

    #[test]
    fn tampered_ciphertext_fails() {
        let ivk = IncomingViewingKey([8u8; 32]);
        let mut blob = encrypt_note_for(&ivk, &sample_memo()).unwrap();
        // Flip a byte in the ciphertext region (past eph_pk + nonce).
        let last = blob.len() - 1;
        blob[last] ^= 0xff;
        let res = try_decrypt_note(&ivk, &blob).unwrap();
        assert!(res.is_none(), "AEAD must reject a tampered tag");
    }

    #[test]
    fn derive_key_nonce_returns_zeroizing() {
        let shared = [0xABu8; 32];
        let (k, n) = derive_key_nonce(&shared, &[1u8; 32], &[2u8; 32]);
        assert_eq!(k.len(), 32);
        assert_eq!(n.len(), 12);
    }
}
