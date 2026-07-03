//! gen_streaming_vectors — emit a deterministic JSON file of streaming
//! envelope chunks + a receipt vector for cross-platform parity.
//!
//! Why this exists: the streaming module (`streaming.rs`) is the path
//! over which a malicious cloud could drop, reorder, or replay assistant
//! chunks. The Android port (`EnvelopeStreaming.kt`) has its own
//! implementation of `derive_chunk_nonce`, `seal_chunk`, `open_chunk`,
//! `TranscriptHasher`, and `EnvelopeReceipt`. Without a byte-exact
//! parity gate, a Kotlin off-by-one (e.g. little-endian index in the
//! nonce instead of big-endian, or a missing `is_final` byte in the AD)
//! could let an attacker replay chunks undetected.
//!
//! Run:
//!
//! ```sh
//! cargo run -p said-envelope --example gen_streaming_vectors -- \
//!   --out android/app/src/test/resources/streaming_vectors.json
//! ```
//!
//! CI re-runs this on every build and `git diff --exit-code`s the
//! output; any drift between the committed file and a fresh run blocks
//! the build (mirror of the non-streaming gate).
//!
//! ## Vector shape
//!
//! A top-level JSON document with two sections:
//!
//! - `chunks`: array of per-stream test cases. Each case fixes a DEK,
//!   `stream_id`, and a plaintext chunking, then emits the expected
//!   nonce, AD, and ciphertext for every chunk plus the final
//!   transcript hash. Cases cover: single chunk, exact-multiple,
//!   ragged last, two-chunk swap fodder, and the empty-stream edge.
//!
//! - `receipts`: array of receipt-signing test cases. Each case fixes
//!   a producer Ed25519 seed and emits the signed `EnvelopeReceipt`
//!   bytes the Kotlin side must reproduce exactly. This is what
//!   catches a domain-separator drift in `canonical_bytes`.

use std::env;
use std::fs;
use std::path::PathBuf;

use ed25519_dalek::SigningKey;
use said_envelope::did_key_from_verifying;
use said_envelope::streaming::{
    derive_chunk_nonce, seal_chunk, EnvelopeReceipt, TranscriptHasher,
};
use serde::Serialize;

#[derive(Serialize)]
struct StreamingVectors {
    chunks: Vec<ChunkCase>,
    receipts: Vec<ReceiptCase>,
}

#[derive(Serialize)]
struct ChunkCase {
    name: String,
    /// 32-byte DEK, hex.
    dek_hex: String,
    /// UTF-8 stream id.
    stream_id: String,
    /// Plaintext chunks (hex per chunk; empty list means an empty stream).
    plaintext_chunks_hex: Vec<String>,
    /// Per-chunk expected wire output. One entry per plaintext chunk.
    /// For an empty stream this list is also empty.
    chunks: Vec<ChunkExpect>,
    /// SHA-256 of the transcript (`len_be_4 || cipher_chunk` repeated).
    transcript_sha256_hex: String,
}

#[derive(Serialize)]
struct ChunkExpect {
    index: u32,
    is_final: bool,
    /// Plaintext chunk bytes (hex). Duplicated from `plaintext_chunks_hex`
    /// for ergonomic indexing on the Kotlin side.
    plaintext_hex: String,
    /// Expected 12-byte nonce derived from `(dek, index)`.
    nonce_hex: String,
    /// Expected AD = `stream_id || index_be || is_final_byte`.
    associated_data_hex: String,
    /// Expected AES-256-GCM(ct || tag) bytes.
    ciphertext_hex: String,
}

#[derive(Serialize)]
struct ReceiptCase {
    name: String,
    /// 32-byte Ed25519 seed for the producer.
    producer_seed_hex: String,
    /// Derived `did:key:z…`.
    producer_did: String,
    stream_id: String,
    model: String,
    input_tokens: u32,
    output_tokens: u32,
    completed_at: u64,
    /// SHA-256 the receipt commits to.
    transcript_sha256_hex: String,
    /// Expected hex-encoded Ed25519 signature.
    expected_signature_hex: String,
}

fn main() {
    let mut out_path: Option<PathBuf> = None;
    let mut args = env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--out" => out_path = args.next().map(PathBuf::from),
            other => panic!("unknown arg: {other}"),
        }
    }
    let out_path = out_path.expect("--out <path> required");

    let mut chunks = Vec::new();
    let mut receipts = Vec::new();

    // ---- Chunk vectors ----------------------------------------------------

    // The DEK is the only piece of key material that flows into chunk seal/
    // open. Vary it across cases so the HKDF prefix differs each time —
    // catches a Kotlin port that hard-codes the salt or info string.

    // Case A: single chunk, short plaintext, marks `is_final = true`.
    chunks.push(build_chunk_case(
        "single-chunk-final",
        [0x03u8; 32],
        "s-A",
        &[b"hello world".as_slice()],
    ));

    // Case B: exact-multiple (3 fixed-size chunks of 16 bytes each).
    {
        let pt: Vec<&[u8]> = vec![
            b"sixteen-byte-A!!",
            b"sixteen-byte-B!!",
            b"sixteen-byte-C!!",
        ];
        chunks.push(build_chunk_case(
            "exact-multiple-3x16",
            [0x11u8; 32],
            "s-B",
            &pt,
        ));
    }

    // Case C: ragged-last (first two are 32B of incrementing bytes, last is
    // 7B). Mirrors a real "tokens stream → final partial flush".
    {
        let mut a = Vec::with_capacity(32);
        let mut b = Vec::with_capacity(32);
        for i in 0..32u8 {
            a.push(i);
            b.push(0x80u8.wrapping_add(i));
        }
        let c: &[u8] = b"ragged!";
        let chunks_in: Vec<&[u8]> = vec![&a, &b, c];
        chunks.push(build_chunk_case(
            "ragged-last-2x32-plus-7",
            [0x22u8; 32],
            "s-C",
            &chunks_in,
        ));
    }

    // Case D: a two-chunk stream — small payloads chosen so the Kotlin
    // parity test can flip indices and observe AEAD failure deterministically.
    chunks.push(build_chunk_case(
        "two-chunk-swap-fodder",
        [0x33u8; 32],
        "s-D",
        &[b"first ", b"second"],
    ));

    // Case E: empty stream. Edge case — no chunks emitted, transcript
    // hash is the SHA-256 of the empty string.
    chunks.push(build_chunk_case(
        "empty-stream",
        [0x44u8; 32],
        "s-E",
        &[],
    ));

    // Case F: stream id with a multi-byte UTF-8 character. Catches a
    // Kotlin port that double-encodes / decodes the AD string.
    chunks.push(build_chunk_case(
        "utf8-stream-id",
        [0x55u8; 32],
        "s-\u{1f4a1}", // U+1F4A1 LIGHT BULB
        &[b"with-utf8-id"],
    ));

    // Case G: index 256 — exercises the high byte of the chunk index.
    // Seal indices 0..=255 implicitly is overkill; we only need to prove
    // that index 256 nonce derivation is correct.
    chunks.push(build_chunk_case_starting_at(
        "high-index-256",
        [0x66u8; 32],
        "s-G",
        &[b"high-index"],
        256,
    ));

    // ---- Receipt vectors --------------------------------------------------

    // R1: a receipt over a fixed transcript. The producer seed is fully
    // deterministic so the signature bytes are stable. Ed25519 with a
    // deterministic message + fixed seed yields a deterministic signature.
    {
        let seed = [0xAAu8; 32];
        let sk = SigningKey::from_bytes(&seed);
        let did = did_key_from_verifying(&sk.verifying_key());

        // Build a transcript from two ciphertext-shaped blobs. We don't
        // need them to be real ciphertexts for the receipt — we just need
        // the same byte feed on both sides.
        let mut h = TranscriptHasher::new();
        h.update(b"chunk-1");
        h.update(b"chunk-2");
        let tx = h.finalize();

        let stream_id = "s-1";
        let model = "test/model";
        let input_tokens = 10u32;
        let output_tokens = 20u32;
        let completed_at = 1_700_000_000u64;

        let r = EnvelopeReceipt::sign(
            &sk,
            did.clone(),
            stream_id.into(),
            model.into(),
            input_tokens,
            output_tokens,
            completed_at,
            tx,
        );

        receipts.push(ReceiptCase {
            name: "fixed-2chunk".into(),
            producer_seed_hex: hex(&seed),
            producer_did: did,
            stream_id: stream_id.into(),
            model: model.into(),
            input_tokens,
            output_tokens,
            completed_at,
            transcript_sha256_hex: hex(&tx),
            expected_signature_hex: r.signature_hex.clone(),
        });
    }

    // R2: a receipt over an empty transcript. This stresses the canonical
    // encoding's handling of the zero-byte cases (model = empty, etc).
    {
        let seed = [0xBBu8; 32];
        let sk = SigningKey::from_bytes(&seed);
        let did = did_key_from_verifying(&sk.verifying_key());

        let h = TranscriptHasher::new();
        let tx = h.finalize();

        let stream_id = "s-empty";
        let model = "";
        let input_tokens = 0u32;
        let output_tokens = 0u32;
        let completed_at = 0u64;

        let r = EnvelopeReceipt::sign(
            &sk,
            did.clone(),
            stream_id.into(),
            model.into(),
            input_tokens,
            output_tokens,
            completed_at,
            tx,
        );

        receipts.push(ReceiptCase {
            name: "empty-transcript-zero-fields".into(),
            producer_seed_hex: hex(&seed),
            producer_did: did,
            stream_id: stream_id.into(),
            model: model.into(),
            input_tokens,
            output_tokens,
            completed_at,
            transcript_sha256_hex: hex(&tx),
            expected_signature_hex: r.signature_hex.clone(),
        });
    }

    let doc = StreamingVectors { chunks, receipts };
    let json = serde_json::to_string_pretty(&doc).unwrap();
    if let Some(parent) = out_path.parent() {
        fs::create_dir_all(parent).expect("mkdir -p");
    }
    fs::write(&out_path, format!("{json}\n")).expect("write vectors");
    eprintln!(
        "wrote {} chunk cases and {} receipt cases to {}",
        doc.chunks.len(),
        doc.receipts.len(),
        out_path.display()
    );
}

fn build_chunk_case(name: &str, dek: [u8; 32], stream_id: &str, plaintexts: &[&[u8]]) -> ChunkCase {
    build_chunk_case_starting_at(name, dek, stream_id, plaintexts, 0)
}

fn build_chunk_case_starting_at(
    name: &str,
    dek: [u8; 32],
    stream_id: &str,
    plaintexts: &[&[u8]],
    start_index: u32,
) -> ChunkCase {
    let mut hasher = TranscriptHasher::new();
    let mut chunks = Vec::with_capacity(plaintexts.len());
    let plaintext_chunks_hex: Vec<String> = plaintexts.iter().map(|p| hex(p)).collect();
    for (offset, pt) in plaintexts.iter().enumerate() {
        let index = start_index + offset as u32;
        let is_final = offset == plaintexts.len() - 1;
        let nonce = derive_chunk_nonce(&dek, index);
        let ad = build_ad(stream_id, index, is_final);
        let ct = seal_chunk(&dek, index, is_final, stream_id, pt).expect("seal_chunk");
        hasher.update(&ct);
        chunks.push(ChunkExpect {
            index,
            is_final,
            plaintext_hex: hex(pt),
            nonce_hex: hex(&nonce),
            associated_data_hex: hex(&ad),
            ciphertext_hex: hex(&ct),
        });
    }
    ChunkCase {
        name: name.into(),
        dek_hex: hex(&dek),
        stream_id: stream_id.into(),
        plaintext_chunks_hex,
        chunks,
        transcript_sha256_hex: hex(&hasher.finalize()),
    }
}

/// Mirror of the private `build_chunk_ad` in `streaming.rs`. Kept here so
/// the JSON's `associated_data_hex` can be cross-checked even if the
/// crate's private helper is later refactored.
fn build_ad(stream_id: &str, index: u32, is_final: bool) -> Vec<u8> {
    let mut ad = Vec::with_capacity(stream_id.as_bytes().len() + 5);
    ad.extend_from_slice(stream_id.as_bytes());
    ad.extend_from_slice(&index.to_be_bytes());
    ad.push(if is_final { 1 } else { 0 });
    ad
}

fn hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0x0f) as usize] as char);
    }
    s
}
