//! # said-envelope — Sealed envelope v1
//!
//! Server-blind end-to-end encrypted frames shared across every Ghola surface
//! that needs to move ciphertext through an untrusted intermediary (the
//! thumper-cloud chat path, the marketplace relay, the SAID MCP HTTP
//! transport, and the apps/web client). One wire format; one library; the
//! TypeScript port at `apps/web/src/lib/envelope.ts` reproduces this byte
//! layout against Web Crypto so a frame round-trips identically in both
//! runtimes.
//!
//! ## Wire format
//!
//! ```text
//! magic               4  bytes  = b"SEv1"
//! version             1  byte   = 0x01
//! recipient_kind      1  byte   = 0x00 self | 0x01 peer-DID | 0x02 model-bridge
//! sender_did_len      2  bytes  big-endian
//! sender_did          var       UTF-8 did:key string
//! recipient_id_len    2  bytes  big-endian
//! recipient_id        var       UTF-8 did:key OR opaque model-id
//! ephem_pub          32  bytes  X25519 ephemeral public key
//! nonce              12  bytes  AES-GCM nonce (CSPRNG; for streams, derived
//!                                deterministically — see streaming module)
//! ad_len              2  bytes  big-endian length of associated data
//! ad                  var       associated data (e.g. session_id, role, ts)
//! ct_len              4  bytes  big-endian length of (ciphertext || tag)
//! ciphertext + tag    var       AES-256-GCM output (includes the 16-byte tag)
//! sig                64  bytes  Ed25519 signature over SHA-256 of every byte
//!                                preceding `sig`, by the sender's identity key
//! ```
//!
//! All length-prefixed fields use big-endian byte order.
//!
//! ## What "server-blind" means here
//!
//! - The cloud sees: header bytes, ephemeral public key, opaque ciphertext,
//!   signature. The cloud can route by `sender_did` / `recipient_id` and
//!   verify the signature, but it cannot recover plaintext.
//! - DEK derivation: `HKDF-SHA256(ikm = X25519(ephem_priv, recipient_pub),
//!   salt = magic || version, info = "said-envelope-v1/" || recipient_id)`.
//!   The recipient is the only party with both the X25519 secret and the
//!   knowledge of which DID it owns — so only the recipient can derive the
//!   DEK.
//! - Signature is mandatory: prevents the cloud (or any other intermediary)
//!   from swapping ciphertexts between users.
//!
//! ## Recipient kinds
//!
//! | byte | meaning                 | use                                          |
//! |------|-------------------------|----------------------------------------------|
//! | 0x00 | self                    | client encrypts to its own DID for storage   |
//! | 0x01 | peer-DID                | client encrypts to a specific peer DID       |
//! | 0x02 | model-bridge            | client encrypts to a session DEK held by the |
//! |      |                         | cloud, knowing the cloud will unwrap and     |
//! |      |                         | forward to a third-party LLM provider        |
//!
//! `0x02` is **NOT zero-knowledge**. It exists so the UI can show users an
//! explicit "cloud-readable" badge for sessions that need third-party LLMs
//! or cloud-side tool calls (e.g. `wallet_send_usdc`).
//!
//! ## Streaming
//!
//! See the `streaming` module: a streamed assistant turn uses **one**
//! response DEK with sequential nonces driven by a chunk index, plus an
//! end-of-stream `EnvelopeReceipt` signed by the producer that chains
//! `sha256(stream_chunks_in_order)` so a malicious cloud cannot drop or
//! reorder chunks without detection.

#![forbid(unsafe_code)]

use aes_gcm::aead::{Aead, KeyInit, OsRng, Payload};
use aes_gcm::{AeadCore, Aes256Gcm, Nonce};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey, SIGNATURE_LENGTH};
use hkdf::Hkdf;
use rand::{CryptoRng, RngCore};
use sha2::{Digest, Sha256};
use thiserror::Error;
use x25519_dalek::{EphemeralSecret, PublicKey as X25519Public, StaticSecret};
use zeroize::Zeroize;

pub mod streaming;

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

pub const MAGIC: [u8; 4] = *b"SEv1";
pub const VERSION: u8 = 0x01;
pub const NONCE_LEN: usize = 12;
pub const TAG_LEN: usize = 16;
pub const EPHEM_PUB_LEN: usize = 32;
pub const HKDF_INFO_PREFIX: &[u8] = b"said-envelope-v1/";

// --------------------------------------------------------------------------
// Recipient kinds
// --------------------------------------------------------------------------

/// Who the envelope is addressed to. The byte value is the wire encoding.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum RecipientKind {
    /// Encrypted to the sender's own DID — used by clients to persist data
    /// the cloud must store but cannot read.
    SelfRecipient = 0x00,
    /// Encrypted to another wallet's DID — peer-to-peer.
    PeerDid = 0x01,
    /// Encrypted to a session DEK held by the cloud for relay to a
    /// third-party LLM. **Not zero-knowledge** — the cloud can read this.
    ModelBridge = 0x02,
}

impl RecipientKind {
    fn from_byte(b: u8) -> Result<Self> {
        match b {
            0x00 => Ok(RecipientKind::SelfRecipient),
            0x01 => Ok(RecipientKind::PeerDid),
            0x02 => Ok(RecipientKind::ModelBridge),
            other => Err(EnvelopeError::InvalidRecipientKind(other)),
        }
    }

    fn as_byte(self) -> u8 {
        self as u8
    }
}

// --------------------------------------------------------------------------
// Errors
// --------------------------------------------------------------------------

#[derive(Debug, Error)]
pub enum EnvelopeError {
    #[error("envelope is too short")]
    Truncated,
    #[error("magic mismatch — expected SEv1")]
    BadMagic,
    #[error("unsupported envelope version: {0}")]
    BadVersion(u8),
    #[error("invalid recipient kind byte: {0:#x}")]
    InvalidRecipientKind(u8),
    #[error("invalid sender did: {0}")]
    InvalidSenderDid(String),
    #[error("did:key did not encode an Ed25519 key")]
    DidNotEd25519,
    #[error("invalid ephemeral public key")]
    InvalidEphemPub,
    #[error("AEAD open failed (likely tamper or wrong recipient)")]
    AeadFailed,
    #[error("signature verification failed")]
    BadSignature,
    #[error("field length overflow: {0}")]
    LengthOverflow(&'static str),
}

pub type Result<T> = std::result::Result<T, EnvelopeError>;

// --------------------------------------------------------------------------
// did:key helpers (Ed25519 multicodec)
// --------------------------------------------------------------------------

const ED25519_MULTICODEC: [u8; 2] = [0xed, 0x01];

/// Encode an Ed25519 verifying key as a `did:key:z…` string.
pub fn did_key_from_verifying(vk: &VerifyingKey) -> String {
    let mut bytes = Vec::with_capacity(2 + 32);
    bytes.extend_from_slice(&ED25519_MULTICODEC);
    bytes.extend_from_slice(vk.as_bytes());
    format!("did:key:z{}", bs58::encode(&bytes).into_string())
}

/// Decode a `did:key:z…` string into an Ed25519 verifying key.
pub fn verifying_from_did_key(did: &str) -> Result<VerifyingKey> {
    let z = did
        .strip_prefix("did:key:z")
        .ok_or_else(|| EnvelopeError::InvalidSenderDid(did.into()))?;
    let bytes = bs58::decode(z)
        .into_vec()
        .map_err(|_| EnvelopeError::InvalidSenderDid(did.into()))?;
    if bytes.len() != 2 + 32 || bytes[..2] != ED25519_MULTICODEC {
        return Err(EnvelopeError::DidNotEd25519);
    }
    let key_bytes: [u8; 32] = bytes[2..].try_into().expect("len checked");
    VerifyingKey::from_bytes(&key_bytes).map_err(|_| EnvelopeError::DidNotEd25519)
}

// --------------------------------------------------------------------------
// X25519 conversion (mirrors said-core::mesh)
// --------------------------------------------------------------------------

/// Map an Ed25519 verifying key to its X25519 (Montgomery) form.
pub fn ed25519_verifying_to_x25519(vk: &VerifyingKey) -> Result<X25519Public> {
    use curve25519_dalek::edwards::CompressedEdwardsY;
    let compressed = CompressedEdwardsY(*vk.as_bytes());
    let edwards = compressed
        .decompress()
        .ok_or(EnvelopeError::InvalidEphemPub)?;
    Ok(X25519Public::from(edwards.to_montgomery().to_bytes()))
}

/// Map an Ed25519 signing key (seed) to a long-lived X25519 static secret —
/// SHA-512 the seed, take the first 32 clamped bytes (per the standard
/// Ed25519↔X25519 derivation).
pub fn ed25519_signing_to_x25519(sk: &SigningKey) -> StaticSecret {
    use sha2::Sha512;
    let hash = Sha512::digest(sk.to_bytes());
    let mut key = [0u8; 32];
    key.copy_from_slice(&hash[..32]);
    StaticSecret::from(key)
}

// --------------------------------------------------------------------------
// DEK derivation
// --------------------------------------------------------------------------

fn derive_dek(shared_secret: &[u8; 32], recipient_id: &str) -> [u8; 32] {
    let mut salt = Vec::with_capacity(MAGIC.len() + 1);
    salt.extend_from_slice(&MAGIC);
    salt.push(VERSION);
    let mut info = Vec::with_capacity(HKDF_INFO_PREFIX.len() + recipient_id.len());
    info.extend_from_slice(HKDF_INFO_PREFIX);
    info.extend_from_slice(recipient_id.as_bytes());
    let hk = Hkdf::<Sha256>::new(Some(&salt), shared_secret);
    let mut key = [0u8; 32];
    hk.expand(&info, &mut key)
        .expect("HKDF expand always succeeds for 32 bytes");
    key
}

// --------------------------------------------------------------------------
// SealParams / OpenedEnvelope
// --------------------------------------------------------------------------

/// Inputs to seal a single envelope frame.
pub struct SealParams<'a> {
    pub sender: &'a SigningKey,
    pub kind: RecipientKind,
    /// For `PeerDid` and `SelfRecipient`, this is the recipient's
    /// `did:key:z…` string. For `ModelBridge`, it's an opaque model id
    /// (e.g. `"anthropic/claude-sonnet-4-6"`) — encryption still goes to
    /// `recipient_x25519` which the caller must supply (the cloud's
    /// per-session bridge key).
    pub recipient_id: &'a str,
    /// X25519 public key the ephemeral DH targets. For peer/self this is
    /// derived from the recipient's Ed25519 DID; for model-bridge it's the
    /// cloud-issued bridge key for that session.
    pub recipient_x25519: X25519Public,
    pub associated_data: &'a [u8],
    pub plaintext: &'a [u8],
}

/// Result of opening a sealed envelope.
#[derive(Debug)]
pub struct OpenedEnvelope {
    pub kind: RecipientKind,
    pub sender_did: String,
    pub recipient_id: String,
    pub associated_data: Vec<u8>,
    pub plaintext: Vec<u8>,
}

// --------------------------------------------------------------------------
// Wire encoding helpers
// --------------------------------------------------------------------------

fn put_u16_be(buf: &mut Vec<u8>, n: usize, field: &'static str) -> Result<()> {
    if n > u16::MAX as usize {
        return Err(EnvelopeError::LengthOverflow(field));
    }
    buf.extend_from_slice(&(n as u16).to_be_bytes());
    Ok(())
}

fn put_u32_be(buf: &mut Vec<u8>, n: usize, field: &'static str) -> Result<()> {
    if n > u32::MAX as usize {
        return Err(EnvelopeError::LengthOverflow(field));
    }
    buf.extend_from_slice(&(n as u32).to_be_bytes());
    Ok(())
}

struct Cursor<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Cursor<'a> {
    fn new(buf: &'a [u8]) -> Self {
        Self { buf, pos: 0 }
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        let end = self
            .pos
            .checked_add(n)
            .ok_or(EnvelopeError::Truncated)?;
        if end > self.buf.len() {
            return Err(EnvelopeError::Truncated);
        }
        let slice = &self.buf[self.pos..end];
        self.pos = end;
        Ok(slice)
    }

    fn take_u16(&mut self) -> Result<usize> {
        let bytes = self.take(2)?;
        Ok(u16::from_be_bytes([bytes[0], bytes[1]]) as usize)
    }

    fn take_u32(&mut self) -> Result<usize> {
        let bytes = self.take(4)?;
        Ok(u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize)
    }
}

// --------------------------------------------------------------------------
// seal / open
// --------------------------------------------------------------------------

/// Encrypt and sign a single envelope frame, returning the wire bytes.
pub fn seal(params: SealParams<'_>) -> Result<Vec<u8>> {
    seal_with_rng(&mut OsRng, params)
}

/// Like [`seal`] but uses a caller-supplied CSPRNG for the per-envelope
/// ephemeral X25519 keypair and the AES-GCM nonce. Production callers use
/// [`seal`]; this exists for parity-vector generators and crash-replay
/// tests that need deterministic outputs.
pub fn seal_with_rng<R>(rng: &mut R, params: SealParams<'_>) -> Result<Vec<u8>>
where
    R: RngCore + CryptoRng,
{
    let ephem = EphemeralSecret::random_from_rng(&mut *rng);
    let ephem_pub = X25519Public::from(&ephem);
    let shared = ephem.diffie_hellman(&params.recipient_x25519);
    let mut dek = derive_dek(shared.as_bytes(), params.recipient_id);

    let cipher = Aes256Gcm::new_from_slice(&dek).expect("32-byte key");
    let nonce_bytes = Aes256Gcm::generate_nonce(&mut *rng);
    let ciphertext = cipher
        .encrypt(
            &nonce_bytes,
            Payload {
                msg: params.plaintext,
                aad: params.associated_data,
            },
        )
        .map_err(|_| EnvelopeError::AeadFailed)?;
    dek.zeroize();

    let sender_did = did_key_from_verifying(&params.sender.verifying_key());

    let mut buf = Vec::with_capacity(
        MAGIC.len()
            + 1
            + 1
            + 2 + sender_did.len()
            + 2 + params.recipient_id.len()
            + EPHEM_PUB_LEN
            + NONCE_LEN
            + 2 + params.associated_data.len()
            + 4 + ciphertext.len()
            + SIGNATURE_LENGTH,
    );

    buf.extend_from_slice(&MAGIC);
    buf.push(VERSION);
    buf.push(params.kind.as_byte());

    put_u16_be(&mut buf, sender_did.len(), "sender_did")?;
    buf.extend_from_slice(sender_did.as_bytes());

    put_u16_be(&mut buf, params.recipient_id.len(), "recipient_id")?;
    buf.extend_from_slice(params.recipient_id.as_bytes());

    buf.extend_from_slice(ephem_pub.as_bytes());
    buf.extend_from_slice(&nonce_bytes);

    put_u16_be(&mut buf, params.associated_data.len(), "associated_data")?;
    buf.extend_from_slice(params.associated_data);

    put_u32_be(&mut buf, ciphertext.len(), "ciphertext")?;
    buf.extend_from_slice(&ciphertext);

    let digest = Sha256::digest(&buf);
    let sig: Signature = params.sender.sign(&digest);
    buf.extend_from_slice(&sig.to_bytes());

    Ok(buf)
}

/// Verify the signature, derive the DEK, and decrypt.
///
/// `recipient_x25519_secret` is the long-lived X25519 secret of whoever owns
/// `recipient_id`. For peer/self envelopes this is derived from the
/// recipient's Ed25519 wallet key (`ed25519_signing_to_x25519`). For
/// model-bridge envelopes this is the cloud's per-session bridge secret.
pub fn open(
    wire: &[u8],
    recipient_x25519_secret: &StaticSecret,
) -> Result<OpenedEnvelope> {
    if wire.len() < SIGNATURE_LENGTH + MAGIC.len() + 2 {
        return Err(EnvelopeError::Truncated);
    }

    let body_end = wire.len() - SIGNATURE_LENGTH;
    let body = &wire[..body_end];
    let sig_bytes = &wire[body_end..];

    let mut cur = Cursor::new(body);

    let magic = cur.take(MAGIC.len())?;
    if magic != MAGIC {
        return Err(EnvelopeError::BadMagic);
    }
    let version = cur.take(1)?[0];
    if version != VERSION {
        return Err(EnvelopeError::BadVersion(version));
    }
    let kind = RecipientKind::from_byte(cur.take(1)?[0])?;

    let sender_did_len = cur.take_u16()?;
    let sender_did_bytes = cur.take(sender_did_len)?;
    let sender_did = std::str::from_utf8(sender_did_bytes)
        .map_err(|_| EnvelopeError::InvalidSenderDid("non-utf8".into()))?
        .to_string();

    let recipient_id_len = cur.take_u16()?;
    let recipient_id_bytes = cur.take(recipient_id_len)?;
    let recipient_id = std::str::from_utf8(recipient_id_bytes)
        .map_err(|_| EnvelopeError::InvalidSenderDid("recipient non-utf8".into()))?
        .to_string();

    let ephem_pub_bytes: [u8; EPHEM_PUB_LEN] = cur
        .take(EPHEM_PUB_LEN)?
        .try_into()
        .map_err(|_| EnvelopeError::InvalidEphemPub)?;
    let ephem_pub = X25519Public::from(ephem_pub_bytes);

    let nonce_bytes: [u8; NONCE_LEN] = cur
        .take(NONCE_LEN)?
        .try_into()
        .expect("len checked");

    let ad_len = cur.take_u16()?;
    let associated_data = cur.take(ad_len)?.to_vec();

    let ct_len = cur.take_u32()?;
    let ciphertext = cur.take(ct_len)?;

    if cur.pos != body.len() {
        return Err(EnvelopeError::Truncated);
    }

    // Verify signature first — cheaper to bail than to attempt AEAD on a
    // tampered frame.
    let sender_vk = verifying_from_did_key(&sender_did)?;
    let signature = Signature::from_slice(sig_bytes)
        .map_err(|_| EnvelopeError::BadSignature)?;
    let digest = Sha256::digest(body);
    sender_vk
        .verify(&digest, &signature)
        .map_err(|_| EnvelopeError::BadSignature)?;

    // Derive DEK and open AEAD.
    let shared = recipient_x25519_secret.diffie_hellman(&ephem_pub);
    let mut dek = derive_dek(shared.as_bytes(), &recipient_id);
    let cipher = Aes256Gcm::new_from_slice(&dek).expect("32-byte key");
    let nonce = Nonce::from_slice(&nonce_bytes);
    let plaintext = cipher
        .decrypt(
            nonce,
            Payload {
                msg: ciphertext,
                aad: &associated_data,
            },
        )
        .map_err(|_| EnvelopeError::AeadFailed)?;
    dek.zeroize();

    Ok(OpenedEnvelope {
        kind,
        sender_did,
        recipient_id,
        associated_data,
        plaintext,
    })
}

// --------------------------------------------------------------------------
// Convenience: peer-to-peer with Ed25519 wallet keys on both ends
// --------------------------------------------------------------------------

/// Seal a peer envelope from `sender` to the wallet identified by
/// `recipient_did`. The recipient_id on the wire equals `recipient_did`.
pub fn seal_to_peer(
    sender: &SigningKey,
    recipient_did: &str,
    associated_data: &[u8],
    plaintext: &[u8],
) -> Result<Vec<u8>> {
    let recipient_vk = verifying_from_did_key(recipient_did)?;
    let recipient_x25519 = ed25519_verifying_to_x25519(&recipient_vk)?;
    seal(SealParams {
        sender,
        kind: RecipientKind::PeerDid,
        recipient_id: recipient_did,
        recipient_x25519,
        associated_data,
        plaintext,
    })
}

/// Open a peer envelope addressed to `recipient`'s wallet key.
pub fn open_as_peer(wire: &[u8], recipient: &SigningKey) -> Result<OpenedEnvelope> {
    let secret = ed25519_signing_to_x25519(recipient);
    open(wire, &secret)
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use rand::rngs::OsRng;
    use rand::RngCore;

    fn fresh_signing_key() -> SigningKey {
        let mut bytes = [0u8; 32];
        OsRng.fill_bytes(&mut bytes);
        SigningKey::from_bytes(&bytes)
    }

    #[test]
    fn peer_round_trip() {
        let alice = fresh_signing_key();
        let bob = fresh_signing_key();
        let bob_did = did_key_from_verifying(&bob.verifying_key());

        let ad = b"session=abc;ts=1700000000";
        let pt = b"hello bob from alice";

        let wire = seal_to_peer(&alice, &bob_did, ad, pt).unwrap();
        let opened = open_as_peer(&wire, &bob).unwrap();

        assert_eq!(opened.kind, RecipientKind::PeerDid);
        assert_eq!(opened.sender_did, did_key_from_verifying(&alice.verifying_key()));
        assert_eq!(opened.recipient_id, bob_did);
        assert_eq!(opened.associated_data, ad);
        assert_eq!(opened.plaintext, pt);
    }

    #[test]
    fn wrong_recipient_fails() {
        let alice = fresh_signing_key();
        let bob = fresh_signing_key();
        let mallory = fresh_signing_key();
        let bob_did = did_key_from_verifying(&bob.verifying_key());

        let wire = seal_to_peer(&alice, &bob_did, b"ad", b"secret").unwrap();
        let result = open_as_peer(&wire, &mallory);
        assert!(matches!(result, Err(EnvelopeError::AeadFailed)));
    }

    #[test]
    fn associated_data_is_authenticated() {
        let alice = fresh_signing_key();
        let bob = fresh_signing_key();
        let bob_did = did_key_from_verifying(&bob.verifying_key());

        let mut wire = seal_to_peer(&alice, &bob_did, b"ad-original", b"pt").unwrap();
        // Flip a bit inside the associated_data field. Layout: after the
        // fixed prefix + 2 length bytes for sender_did + sender_did bytes
        // + 2 length bytes for recipient_id + recipient_id bytes + 32
        // ephem_pub + 12 nonce + 2 ad_len, the next bytes are ad. We
        // brute-force locate "ad-original".
        let pos = wire
            .windows(b"ad-original".len())
            .position(|w| w == b"ad-original")
            .expect("ad bytes present in wire");
        wire[pos] ^= 0x01;
        let result = open_as_peer(&wire, &bob);
        // Either signature catches it (we changed body bytes without
        // updating sig) — that's the expected outcome.
        assert!(matches!(result, Err(EnvelopeError::BadSignature)));
    }

    #[test]
    fn ciphertext_tamper_detected_by_signature() {
        let alice = fresh_signing_key();
        let bob = fresh_signing_key();
        let bob_did = did_key_from_verifying(&bob.verifying_key());

        let mut wire = seal_to_peer(&alice, &bob_did, b"ad", b"plain").unwrap();
        // Flip a byte well inside the ciphertext (avoid the trailing 64-byte sig).
        let target = wire.len() - SIGNATURE_LENGTH - 4;
        wire[target] ^= 0x01;
        let result = open_as_peer(&wire, &bob);
        assert!(matches!(result, Err(EnvelopeError::BadSignature)));
    }

    #[test]
    fn signature_strip_fails() {
        let alice = fresh_signing_key();
        let bob = fresh_signing_key();
        let bob_did = did_key_from_verifying(&bob.verifying_key());

        let wire = seal_to_peer(&alice, &bob_did, b"ad", b"plain").unwrap();
        // Truncate the signature → length check should reject.
        let truncated = &wire[..wire.len() - 1];
        let result = open_as_peer(truncated, &bob);
        assert!(result.is_err());

        // Replace signature with random garbage → BadSignature.
        let mut bad = wire.clone();
        let sig_start = bad.len() - SIGNATURE_LENGTH;
        for b in &mut bad[sig_start..] {
            *b ^= 0xff;
        }
        let result = open_as_peer(&bad, &bob);
        assert!(matches!(result, Err(EnvelopeError::BadSignature)));
    }

    #[test]
    fn cross_byte_tamper_sweep() {
        // For a small frame, mutate every byte in turn and verify the
        // open path rejects each variant.
        let alice = fresh_signing_key();
        let bob = fresh_signing_key();
        let bob_did = did_key_from_verifying(&bob.verifying_key());
        let original = seal_to_peer(&alice, &bob_did, b"ad", b"plain").unwrap();
        for i in 0..original.len() {
            let mut bad = original.clone();
            bad[i] ^= 0x01;
            let r = open_as_peer(&bad, &bob);
            assert!(
                r.is_err(),
                "tampering byte {} produced a valid envelope",
                i
            );
        }
    }

    #[test]
    fn magic_and_version_checked() {
        let alice = fresh_signing_key();
        let bob = fresh_signing_key();
        let bob_did = did_key_from_verifying(&bob.verifying_key());
        let mut wire = seal_to_peer(&alice, &bob_did, b"ad", b"plain").unwrap();

        // The header is parsed before the signature is verified, so a
        // corrupted magic byte surfaces as BadMagic.
        wire[0] = b'X';
        let r = open_as_peer(&wire, &bob);
        assert!(matches!(r, Err(EnvelopeError::BadMagic)));

        // Wrong version byte → BadVersion.
        let mut wire2 = seal_to_peer(&alice, &bob_did, b"ad", b"plain").unwrap();
        wire2[MAGIC.len()] = 0x99;
        let r2 = open_as_peer(&wire2, &bob);
        assert!(matches!(r2, Err(EnvelopeError::BadVersion(0x99))));
    }

    #[test]
    fn did_round_trip() {
        let sk = fresh_signing_key();
        let did = did_key_from_verifying(&sk.verifying_key());
        let vk = verifying_from_did_key(&did).unwrap();
        assert_eq!(vk.as_bytes(), sk.verifying_key().as_bytes());
    }

    #[test]
    fn invalid_did_rejected() {
        assert!(verifying_from_did_key("did:web:example.com").is_err());
        assert!(verifying_from_did_key("did:key:zNotBase58!!").is_err());
    }
}
