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
//! ## Length-hiding plaintext padding (M1)
//!
//! `serde_json(NoteMemo)` is variable length — chiefly because `amount`
//! serializes as a variable-width decimal string and `tag` is optional.
//! ChaCha20-Poly1305 adds no padding, so the on-chain blob length would
//! otherwise leak the magnitude of the note amount (and the presence of a
//! tag). To close that side channel, the JSON is wrapped to a CONSTANT
//! plaintext length before AEAD:
//!
//! ```text
//! padded = u32_le(json.len()) || json || zero_pad   // exactly MEMO_PLAINTEXT_LEN bytes
//! ```
//!
//! Decryption reads the `u32` length prefix and slices the JSON back out.
//! Because every memo is padded to the same `MEMO_PLAINTEXT_LEN`, every
//! ciphertext (and thus every on-chain blob) is the same length regardless
//! of amount or tag presence.
//!
//! Minimum length = 32 + 12 + 16 = 60 bytes (empty plaintext + tag); with
//! padding the ciphertext is always `MEMO_PLAINTEXT_LEN + TAG_LEN` bytes, so
//! the blob is always `EPH_PK_LEN + NONCE_LEN + MEMO_PLAINTEXT_LEN + TAG_LEN`.

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

/// Number of leading bytes encoding the actual JSON length (u32 little-endian).
const LEN_PREFIX: usize = 4;

/// Fixed plaintext length fed to the AEAD, regardless of memo contents
/// (M1 length-hiding). Layout: `u32_le(json_len) || json || zero_pad`.
///
/// Sizing: the largest `serde_json(NoteMemo)` is a worst-case
/// `amount = u64::MAX` (20 decimal digits) plus three 32-byte fields and an
/// optional 32-byte `tag`, each serialized as a JSON array of up-to-3-digit
/// numbers, plus structural punctuation — measured at ~603 bytes. We round
/// up to 768 (the next power-of-two-ish boundary) to leave ample headroom
/// for the 4-byte length prefix and any future memo field. Encryption fails
/// closed ([`Error::Encryption`]) if a serialized memo ever exceeds the
/// budget rather than silently leaking length.
const MEMO_PLAINTEXT_LEN: usize = 768;

/// Plaintext that gets sealed inside the memo blob.
///
/// `Debug` is hand-written to redact the contents (mirrors `Note`'s
/// `Debug` in `said-shielded-pool-types`) and the memo zeroizes on drop so
/// the decrypted note does not linger in freed memory.
#[derive(Clone, Serialize, Deserialize)]
pub struct NoteMemo {
    /// The recipient's note in cleartext (amount, asset, owner, blinding).
    pub note: Note,
    /// Optional 32-byte free-form tag (e.g. invoice ID).
    pub tag: Option<[u8; 32]>,
}

// Secret-bearing: never print the note (amount/owner/blinding) or tag.
impl std::fmt::Debug for NoteMemo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("NoteMemo(<redacted>)")
    }
}

impl Zeroize for NoteMemo {
    fn zeroize(&mut self) {
        // `Note::zeroize` scrubs amount/asset/owner/blinding.
        self.note.zeroize();
        if let Some(tag) = self.tag.as_mut() {
            tag.zeroize();
        }
        self.tag = None;
    }
}

impl Drop for NoteMemo {
    fn drop(&mut self) {
        self.zeroize();
    }
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

    // 6. Serialize + pad to a FIXED length so the ciphertext (and thus the
    //    on-chain blob) does not leak the amount magnitude or tag presence
    //    (M1). Layout: u32_le(json_len) || json || zero pad → MEMO_PLAINTEXT_LEN.
    let plaintext = pad_memo_plaintext(memo)?;

    // 7. AEAD encrypt.
    let cipher = ChaCha20Poly1305::new((key.as_slice()).into());
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(nonce.as_slice()), plaintext.as_ref())
        .map_err(|_| Error::Encryption("aead encrypt failed"))?;

    // 8. Wire: eph_pk(32) || nonce(12) || ct||tag.
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
            // The AEAD hands back the note's JSON in clear. Hold it in
            // `Zeroizing` so it is scrubbed on every exit path (the
            // `from_slice` parse, the `?` error, and normal return) rather
            // than leaking the cleartext note into a freed `Vec`.
            let plaintext = Zeroizing::new(plaintext);
            // Strip the fixed-length padding (M1): u32_le len prefix tells us
            // how many JSON bytes follow; the rest is zero pad. `json`
            // borrows `plaintext`, so it stays alive until after the parse.
            let json = unpad_memo_plaintext(&plaintext)?;
            let memo: NoteMemo = serde_json::from_slice(json).map_err(Error::Json)?;
            // `plaintext` (and its borrowed `json`) drops + scrubs here.
            Ok(Some(memo))
        }
        Err(_) => Ok(None),
    }
}

/// Serialize a [`NoteMemo`] to JSON and pad it to exactly
/// [`MEMO_PLAINTEXT_LEN`] bytes: `u32_le(json_len) || json || zero pad`.
///
/// Fails closed if the serialized memo (plus the length prefix) would not
/// fit — never silently truncates or leaks length.
fn pad_memo_plaintext(memo: &NoteMemo) -> Result<Zeroizing<Vec<u8>>> {
    // `json` holds the secret note in clear — scrub it on drop.
    let json = Zeroizing::new(serde_json::to_vec(memo).map_err(Error::Json)?);
    if LEN_PREFIX + json.len() > MEMO_PLAINTEXT_LEN {
        return Err(Error::Encryption(
            "memo too large for fixed plaintext budget",
        ));
    }
    // The padded plaintext also carries the cleartext note; return it in
    // `Zeroizing` so the caller's copy (fed to the AEAD) scrubs too.
    let mut buf = Zeroizing::new(vec![0u8; MEMO_PLAINTEXT_LEN]);
    buf[..LEN_PREFIX].copy_from_slice(&(json.len() as u32).to_le_bytes());
    buf[LEN_PREFIX..LEN_PREFIX + json.len()].copy_from_slice(&json);
    Ok(buf)
}

/// Reverse [`pad_memo_plaintext`]: read the `u32_le` length prefix and return
/// the JSON slice. Rejects a plaintext that isn't the fixed length or whose
/// declared length runs past the buffer.
fn unpad_memo_plaintext(plaintext: &[u8]) -> Result<&[u8]> {
    if plaintext.len() != MEMO_PLAINTEXT_LEN {
        return Err(Error::Encryption("memo plaintext not fixed length"));
    }
    let json_len = u32::from_le_bytes(
        plaintext[..LEN_PREFIX]
            .try_into()
            .map_err(|_| Error::Encryption("memo length prefix"))?,
    ) as usize;
    if LEN_PREFIX + json_len > MEMO_PLAINTEXT_LEN {
        return Err(Error::Encryption("memo length prefix out of range"));
    }
    Ok(&plaintext[LEN_PREFIX..LEN_PREFIX + json_len])
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
    fn ciphertext_length_independent_of_amount_and_tag() {
        // M1: blobs for wildly different amounts (and tag present vs absent)
        // must have EQUAL length so on-chain blob length leaks nothing.
        let ivk = IncomingViewingKey([5u8; 32]);

        let small = NoteMemo {
            note: Note {
                amount: 1,
                asset_id: AssetId([1u8; 32]),
                owner_pubkey: [2u8; 32],
                blinding: [3u8; 32],
            },
            tag: None,
        };
        let large = NoteMemo {
            note: Note {
                amount: u64::MAX,
                asset_id: AssetId([0xFF; 32]),
                owner_pubkey: [0xFF; 32],
                blinding: [0xFF; 32],
            },
            tag: Some([0xFF; 32]),
        };

        let blob_small = encrypt_note_for(&ivk, &small).unwrap();
        let blob_large = encrypt_note_for(&ivk, &large).unwrap();
        assert_eq!(
            blob_small.len(),
            blob_large.len(),
            "memo blob length must not depend on amount/tag"
        );
        // And the length is the constant we expect.
        let expected = EPH_PK_LEN + NONCE_LEN + MEMO_PLAINTEXT_LEN + TAG_LEN;
        assert_eq!(blob_small.len(), expected);

        // Both still round-trip correctly through the padding.
        let got_small = try_decrypt_note(&ivk, &blob_small).unwrap().unwrap();
        assert_eq!(got_small.note.amount, 1);
        assert_eq!(got_small.tag, None);
        let got_large = try_decrypt_note(&ivk, &blob_large).unwrap().unwrap();
        assert_eq!(got_large.note.amount, u64::MAX);
        assert_eq!(got_large.tag, Some([0xFF; 32]));
    }

    #[test]
    fn pad_unpad_roundtrips() {
        let memo = sample_memo();
        let padded = pad_memo_plaintext(&memo).unwrap();
        assert_eq!(padded.len(), MEMO_PLAINTEXT_LEN, "fixed plaintext length");
        let json = unpad_memo_plaintext(&padded).unwrap();
        let back: NoteMemo = serde_json::from_slice(json).unwrap();
        assert_eq!(back.note.amount, memo.note.amount);
        assert_eq!(back.tag, memo.tag);
    }

    #[test]
    fn derive_key_nonce_returns_zeroizing() {
        let shared = [0xABu8; 32];
        let (k, n) = derive_key_nonce(&shared, &[1u8; 32], &[2u8; 32]);
        assert_eq!(k.len(), 32);
        assert_eq!(n.len(), 12);
    }

    #[test]
    fn note_memo_debug_is_redacted() {
        // Use distinctive secret bytes so we can prove none leak into Debug.
        let memo = NoteMemo {
            note: Note {
                amount: 0xDEAD_BEEF,
                asset_id: AssetId([0xAA; 32]),
                owner_pubkey: [0xBB; 32],
                blinding: [0xCC; 32],
            },
            tag: Some([0xDD; 32]),
        };
        let dbg = format!("{:?}", memo);
        assert_eq!(dbg, "NoteMemo(<redacted>)");
        // None of the secret material may appear in the rendered Debug.
        assert!(!dbg.contains("3735928559"), "amount must not leak"); // 0xDEADBEEF
        assert!(!dbg.contains("deadbeef"));
        assert!(!dbg.contains("187"), "owner byte (0xBB) must not leak");
        assert!(!dbg.contains("204"), "blinding byte (0xCC) must not leak");
        assert!(!dbg.contains("170"), "asset byte (0xAA) must not leak");
    }

    #[test]
    fn note_memo_zeroizes() {
        let mut memo = NoteMemo {
            note: Note {
                amount: 0xDEAD_BEEF,
                asset_id: AssetId([0xAA; 32]),
                owner_pubkey: [0xBB; 32],
                blinding: [0xCC; 32],
            },
            tag: Some([0xDD; 32]),
        };
        memo.zeroize();
        assert_eq!(memo.note.amount, 0, "amount scrubbed");
        assert_eq!(memo.note.owner_pubkey, [0u8; 32], "owner scrubbed");
        assert_eq!(memo.note.blinding, [0u8; 32], "blinding scrubbed");
        assert_eq!(memo.note.asset_id.0, [0u8; 32], "asset scrubbed");
        assert_eq!(memo.tag, None, "tag cleared");
    }

    #[test]
    fn roundtrip_still_works_after_zeroizing_hardening() {
        // Regression: wrapping plaintext/pad buffers in `Zeroizing` must not
        // change the encrypt -> decrypt result.
        let ivk = IncomingViewingKey([5u8; 32]);
        let memo = sample_memo();
        let blob = encrypt_note_for(&ivk, &memo).unwrap();
        let got = try_decrypt_note(&ivk, &blob).unwrap().unwrap();
        assert_eq!(got.note.amount, memo.note.amount);
        assert_eq!(got.note.asset_id, memo.note.asset_id);
        assert_eq!(got.note.owner_pubkey, memo.note.owner_pubkey);
        assert_eq!(got.note.blinding, memo.note.blinding);
        assert_eq!(got.tag, memo.tag);
    }
}
