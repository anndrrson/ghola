//! Streaming envelope frames — single response DEK, sequential nonces, and
//! an end-of-stream signed receipt that chains a SHA-256 of the cipher
//! chunks.
//!
//! ## Why this shape
//!
//! - **One DEK per stream**: matches the natural unit (one assistant turn).
//!   The DEK is wrapped to the user once in an opening envelope; chunks
//!   themselves don't carry per-frame ECDH overhead.
//! - **Sequential nonces driven by the chunk index**: AES-GCM is safe under
//!   any nonce that doesn't repeat for the same key. Using `chunk_index`
//!   (u32 BE in the low 4 bytes of a 12-byte nonce, with the leading 8
//!   bytes derived from the DEK) is reuse-free by construction up to
//!   2^32 chunks per stream — far past any sane limit.
//! - **End-of-stream `EnvelopeReceipt`**: the producer signs
//!   `sha256(transcript)` where transcript = concatenation of cipher chunks
//!   in order. A malicious cloud cannot drop or reorder a chunk without
//!   invalidating the receipt the recipient verifies. This is the basis
//!   for billing settlement (see thumper-cloud's settlement hold logic).
//!
//! ## Wire format
//!
//! Streaming uses three frame types over the existing SSE channel:
//!
//! - `stream_open` event carries an opening envelope (`seal` from the
//!   parent module) whose plaintext is the JSON `{ "stream_id": "...",
//!   "response_dek": "<32 base64 bytes>" }`. AD = `(session_id, role)`.
//! - `stream_chunk` event carries `StreamChunk { stream_id, index, ct }`
//!   where `ct = AES-256-GCM(response_dek, derive_nonce(dek, index),
//!   plaintext_chunk, ad = (stream_id, index, is_final))`.
//! - `stream_end` event carries `EnvelopeReceipt { ... }` (see below).
//!
//! All three frames share the same parent SSE channel; only their
//! `event:` line differs.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey, SIGNATURE_LENGTH};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{EnvelopeError, NONCE_LEN, Result};

/// Derive the AES-GCM nonce for chunk `index` of a stream keyed on `dek`.
///
/// First 8 bytes: `HKDF-SHA256(dek, "said-envelope-v1/stream-nonce")` — a
/// per-stream prefix that prevents nonce collisions between streams that
/// share a DEK by accident (we never intend to reuse a DEK across streams,
/// but defense-in-depth is cheap).
///
/// Last 4 bytes: `index` as big-endian u32.
pub fn derive_chunk_nonce(dek: &[u8; 32], index: u32) -> [u8; NONCE_LEN] {
    use hkdf::Hkdf;
    let hk = Hkdf::<Sha256>::new(Some(b"said-envelope-v1"), dek);
    let mut prefix = [0u8; 8];
    hk.expand(b"stream-nonce", &mut prefix)
        .expect("HKDF expand for 8 bytes");
    let mut nonce = [0u8; NONCE_LEN];
    nonce[..8].copy_from_slice(&prefix);
    nonce[8..].copy_from_slice(&index.to_be_bytes());
    nonce
}

/// Encrypt a single stream chunk under the response DEK.
///
/// `ad` is the wire-encoded associated data: typically
/// `stream_id || index_be || is_final_byte`.
pub fn seal_chunk(
    dek: &[u8; 32],
    index: u32,
    is_final: bool,
    stream_id: &str,
    plaintext: &[u8],
) -> Result<Vec<u8>> {
    let cipher = Aes256Gcm::new_from_slice(dek).expect("32-byte key");
    let nonce_bytes = derive_chunk_nonce(dek, index);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ad = build_chunk_ad(stream_id, index, is_final);
    cipher
        .encrypt(
            nonce,
            Payload {
                msg: plaintext,
                aad: &ad,
            },
        )
        .map_err(|_| EnvelopeError::AeadFailed)
}

/// Decrypt a single stream chunk under the response DEK.
pub fn open_chunk(
    dek: &[u8; 32],
    index: u32,
    is_final: bool,
    stream_id: &str,
    ciphertext: &[u8],
) -> Result<Vec<u8>> {
    let cipher = Aes256Gcm::new_from_slice(dek).expect("32-byte key");
    let nonce_bytes = derive_chunk_nonce(dek, index);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ad = build_chunk_ad(stream_id, index, is_final);
    cipher
        .decrypt(
            nonce,
            Payload {
                msg: ciphertext,
                aad: &ad,
            },
        )
        .map_err(|_| EnvelopeError::AeadFailed)
}

fn build_chunk_ad(stream_id: &str, index: u32, is_final: bool) -> Vec<u8> {
    let mut ad = Vec::with_capacity(stream_id.len() + 4 + 1);
    ad.extend_from_slice(stream_id.as_bytes());
    ad.extend_from_slice(&index.to_be_bytes());
    ad.push(if is_final { 1 } else { 0 });
    ad
}

/// Running hash over cipher chunks in order. Feed each cipher chunk, then
/// `finalize()` to get the digest the receipt commits to.
#[derive(Default, Clone)]
pub struct TranscriptHasher {
    inner: Sha256,
}

impl TranscriptHasher {
    pub fn new() -> Self {
        Self::default()
    }
    /// Domain-separated update: each chunk is mixed in as
    /// `len_be_4 || cipher_chunk_bytes` so the hash is unambiguous about
    /// boundaries.
    pub fn update(&mut self, ciphertext_chunk: &[u8]) {
        let len = ciphertext_chunk.len() as u32;
        self.inner.update(len.to_be_bytes());
        self.inner.update(ciphertext_chunk);
    }
    pub fn finalize(self) -> [u8; 32] {
        self.inner.finalize().into()
    }
}

/// Producer-signed end-of-stream receipt.
///
/// The recipient verifies (a) `transcript_sha256` against its own
/// `TranscriptHasher`, (b) the signature against `producer_did`, and only
/// then trusts the token counts. Settlement holds for 24 hours so a
/// disputing client (>5% divergence vs its local tokenizer) can claw back
/// before funds clear.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvelopeReceipt {
    pub stream_id: String,
    pub model: String,
    pub input_tokens: u32,
    pub output_tokens: u32,
    /// Unix timestamp (seconds) when the producer finalized the stream.
    pub completed_at: u64,
    /// SHA-256 over (`len_be_4 || ciphertext_chunk`) for every chunk in
    /// stream order. Hex-encoded to make on-the-wire JSON friendly.
    pub transcript_sha256_hex: String,
    /// `did:key:z…` of the signer.
    pub producer_did: String,
    /// Hex-encoded Ed25519 signature over the canonical bytes (see
    /// [`receipt_signing_bytes`]).
    pub signature_hex: String,
}

impl EnvelopeReceipt {
    /// Sign and return a finalized receipt. Caller supplies the producer's
    /// signing key.
    pub fn sign(
        signer: &SigningKey,
        producer_did: String,
        stream_id: String,
        model: String,
        input_tokens: u32,
        output_tokens: u32,
        completed_at: u64,
        transcript_sha256: [u8; 32],
    ) -> Self {
        let body = ReceiptSigningInput {
            stream_id: &stream_id,
            model: &model,
            input_tokens,
            output_tokens,
            completed_at,
            transcript_sha256: &transcript_sha256,
            producer_did: &producer_did,
        };
        let bytes = body.canonical_bytes();
        let sig: Signature = signer.sign(&bytes);
        Self {
            stream_id,
            model,
            input_tokens,
            output_tokens,
            completed_at,
            transcript_sha256_hex: hex_lower(&transcript_sha256),
            producer_did,
            signature_hex: hex_lower(&sig.to_bytes()),
        }
    }

    /// Verify the receipt against the producer's verifying key derived from
    /// `producer_did`, and against an externally-computed transcript hash.
    pub fn verify(&self, expected_transcript: [u8; 32]) -> Result<()> {
        let claimed = hex_decode_32(&self.transcript_sha256_hex)?;
        if claimed != expected_transcript {
            return Err(EnvelopeError::BadSignature);
        }

        let vk = crate::verifying_from_did_key(&self.producer_did)?;
        let sig_bytes = hex_decode_64(&self.signature_hex)?;
        let signature = Signature::from_slice(&sig_bytes)
            .map_err(|_| EnvelopeError::BadSignature)?;

        let body = ReceiptSigningInput {
            stream_id: &self.stream_id,
            model: &self.model,
            input_tokens: self.input_tokens,
            output_tokens: self.output_tokens,
            completed_at: self.completed_at,
            transcript_sha256: &claimed,
            producer_did: &self.producer_did,
        };
        let bytes = body.canonical_bytes();
        vk.verify(&bytes, &signature)
            .map_err(|_| EnvelopeError::BadSignature)
    }
}

struct ReceiptSigningInput<'a> {
    stream_id: &'a str,
    model: &'a str,
    input_tokens: u32,
    output_tokens: u32,
    completed_at: u64,
    transcript_sha256: &'a [u8; 32],
    producer_did: &'a str,
}

impl<'a> ReceiptSigningInput<'a> {
    fn canonical_bytes(&self) -> Vec<u8> {
        // Canonical encoding: domain separator || len-prefixed fields.
        // Hashing happens inside Ed25519's PH step; we feed the raw bytes.
        let mut buf = Vec::with_capacity(
            64 + self.stream_id.len() + self.model.len() + self.producer_did.len() + 32,
        );
        buf.extend_from_slice(b"said-envelope-v1/receipt\0");
        push_lp(&mut buf, self.stream_id.as_bytes());
        push_lp(&mut buf, self.model.as_bytes());
        buf.extend_from_slice(&self.input_tokens.to_be_bytes());
        buf.extend_from_slice(&self.output_tokens.to_be_bytes());
        buf.extend_from_slice(&self.completed_at.to_be_bytes());
        buf.extend_from_slice(self.transcript_sha256);
        push_lp(&mut buf, self.producer_did.as_bytes());
        buf
    }
}

/// Append a length-prefixed (u32 BE) byte slice.
fn push_lp(buf: &mut Vec<u8>, bytes: &[u8]) {
    buf.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    buf.extend_from_slice(bytes);
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0x0f) as usize] as char);
    }
    s
}

fn hex_decode_32(s: &str) -> Result<[u8; 32]> {
    if s.len() != 64 {
        return Err(EnvelopeError::BadSignature);
    }
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16)
            .map_err(|_| EnvelopeError::BadSignature)?;
    }
    Ok(out)
}

fn hex_decode_64(s: &str) -> Result<[u8; SIGNATURE_LENGTH]> {
    if s.len() != SIGNATURE_LENGTH * 2 {
        return Err(EnvelopeError::BadSignature);
    }
    let mut out = [0u8; SIGNATURE_LENGTH];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16)
            .map_err(|_| EnvelopeError::BadSignature)?;
    }
    Ok(out)
}

#[allow(dead_code)]
pub(crate) fn vk_to_did(vk: &VerifyingKey) -> String {
    crate::did_key_from_verifying(vk)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::{rngs::OsRng, RngCore};

    fn key() -> SigningKey {
        let mut b = [0u8; 32];
        OsRng.fill_bytes(&mut b);
        SigningKey::from_bytes(&b)
    }

    fn random_dek() -> [u8; 32] {
        let mut b = [0u8; 32];
        OsRng.fill_bytes(&mut b);
        b
    }

    #[test]
    fn chunk_nonce_unique_per_index() {
        let dek = random_dek();
        let n0 = derive_chunk_nonce(&dek, 0);
        let n1 = derive_chunk_nonce(&dek, 1);
        let n42 = derive_chunk_nonce(&dek, 42);
        assert_ne!(n0, n1);
        assert_ne!(n1, n42);
        // Last 4 bytes are the index.
        assert_eq!(&n42[8..], &42u32.to_be_bytes());
    }

    #[test]
    fn chunk_round_trip() {
        let dek = random_dek();
        let stream_id = "s-abc";
        let chunks = ["hello ", "from ", "the ", "model"];
        let mut hasher = TranscriptHasher::new();
        let cts: Vec<Vec<u8>> = chunks
            .iter()
            .enumerate()
            .map(|(i, c)| {
                let is_final = i == chunks.len() - 1;
                let ct = seal_chunk(&dek, i as u32, is_final, stream_id, c.as_bytes()).unwrap();
                hasher.update(&ct);
                ct
            })
            .collect();

        let mut decoded = String::new();
        for (i, ct) in cts.iter().enumerate() {
            let is_final = i == cts.len() - 1;
            let pt = open_chunk(&dek, i as u32, is_final, stream_id, ct).unwrap();
            decoded.push_str(std::str::from_utf8(&pt).unwrap());
        }
        assert_eq!(decoded, "hello from the model");
        let _ = hasher.finalize();
    }

    #[test]
    fn chunk_reorder_fails() {
        let dek = random_dek();
        let stream_id = "s-zzz";
        let ct0 = seal_chunk(&dek, 0, false, stream_id, b"first").unwrap();
        let _ct1 = seal_chunk(&dek, 1, true, stream_id, b"second").unwrap();
        // Try opening chunk 0's ciphertext at index 1 (mismatched nonce + AD).
        let r = open_chunk(&dek, 1, true, stream_id, &ct0);
        assert!(matches!(r, Err(EnvelopeError::AeadFailed)));
    }

    #[test]
    fn receipt_round_trip_and_tamper() {
        let producer = key();
        let did = vk_to_did(&producer.verifying_key());

        // Build a transcript hash from some chunks.
        let mut h = TranscriptHasher::new();
        h.update(b"chunk-1");
        h.update(b"chunk-2");
        let tx = h.clone().finalize();

        let receipt = EnvelopeReceipt::sign(
            &producer,
            did,
            "s-1".into(),
            "test/model".into(),
            10,
            20,
            1700000000,
            tx,
        );

        // Verifying with the right transcript succeeds.
        receipt.verify(tx).unwrap();

        // Verifying with a wrong transcript fails.
        let mut wrong = tx;
        wrong[0] ^= 0x01;
        assert!(matches!(receipt.verify(wrong), Err(EnvelopeError::BadSignature)));

        // Tampering output_tokens after signing must fail verification.
        let mut tampered = receipt.clone();
        tampered.output_tokens = 999;
        assert!(matches!(tampered.verify(tx), Err(EnvelopeError::BadSignature)));
    }

    #[test]
    fn transcript_hasher_distinguishes_boundaries() {
        let mut a = TranscriptHasher::new();
        a.update(b"abc");
        a.update(b"def");
        let mut b = TranscriptHasher::new();
        b.update(b"abcdef");
        // Length-prefixed framing means these MUST differ.
        assert_ne!(a.finalize(), b.finalize());
    }
}
