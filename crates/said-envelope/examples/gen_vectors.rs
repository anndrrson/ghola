//! gen_vectors — emit a deterministic JSON file of sealed envelopes.
//!
//! Used by the Android port (`android/app/src/test/resources/envelope_vectors.json`)
//! to assert byte-level wire compatibility against this crate. The seed
//! is fixed; every field — ephemeral X25519 keypair, AES-GCM nonce — is
//! derived from it, so the output is bit-stable across runs as long as
//! the wire format and the dependency versions are unchanged.
//!
//! Run:
//!
//! ```sh
//! cargo run -p said-envelope --example gen_vectors -- \
//!   --out android/app/src/test/resources/envelope_vectors.json
//! ```
//!
//! CI re-runs this on every build and `git diff --exit-code`s the output;
//! any drift between the committed file and a fresh run blocks the build.
//!
//! The fields exposed per vector are:
//!
//! - `name`: human label
//! - `recipient_kind`: 0x00 self / 0x01 peer / 0x02 model-bridge
//! - `sender_signing_seed_hex`: 32 bytes — the Ed25519 seed used to sign
//! - `recipient_x25519_secret_hex`: 32 bytes — feed to `open()`
//! - `recipient_id`: matches the wire `recipient_id` field
//! - `expected_sender_did`: the `did:key:z…` derived from the signing seed
//! - `associated_data_hex`: AD bytes
//! - `plaintext_hex`: original plaintext
//! - `wire_hex`: the full sealed-envelope wire bytes (open() must succeed)

use std::env;
use std::fs;
use std::path::PathBuf;

use ed25519_dalek::SigningKey;
use rand::rngs::StdRng;
use rand::SeedableRng;
use rand::RngCore;
use said_envelope::{
    did_key_from_verifying, ed25519_signing_to_x25519, ed25519_verifying_to_x25519,
    seal_with_rng, RecipientKind, SealParams,
};
use serde::Serialize;
use x25519_dalek::{PublicKey as X25519Public, StaticSecret};

#[derive(Serialize)]
struct Vector {
    name: String,
    recipient_kind: u8,
    sender_signing_seed_hex: String,
    recipient_x25519_secret_hex: String,
    recipient_id: String,
    expected_sender_did: String,
    associated_data_hex: String,
    plaintext_hex: String,
    wire_hex: String,
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

    let mut rng = StdRng::seed_from_u64(0xDEAD_BEEF_CAFE_F00D);
    let mut vectors = Vec::<Vector>::new();

    // --- Vector 1: peer-DID, small plaintext, simple AD. ---
    {
        let mut sender_seed = [0u8; 32];
        rng.fill_bytes(&mut sender_seed);
        let sender_sk = SigningKey::from_bytes(&sender_seed);
        let sender_did = did_key_from_verifying(&sender_sk.verifying_key());

        let mut recipient_seed = [0u8; 32];
        rng.fill_bytes(&mut recipient_seed);
        let recipient_sk = SigningKey::from_bytes(&recipient_seed);
        let recipient_did = did_key_from_verifying(&recipient_sk.verifying_key());
        let recipient_x25519_pub: X25519Public =
            ed25519_verifying_to_x25519(&recipient_sk.verifying_key()).unwrap();
        let recipient_x25519_secret: StaticSecret = ed25519_signing_to_x25519(&recipient_sk);

        let ad = b"session=abc;ts=1700000000";
        let pt = b"hello bob from alice";

        let wire = seal_with_rng(
            &mut rng,
            SealParams {
                sender: &sender_sk,
                kind: RecipientKind::PeerDid,
                recipient_id: &recipient_did,
                recipient_x25519: recipient_x25519_pub,
                associated_data: ad,
                plaintext: pt,
            },
        )
        .unwrap();

        vectors.push(Vector {
            name: "peer-did/small".into(),
            recipient_kind: 0x01,
            sender_signing_seed_hex: hex(&sender_seed),
            recipient_x25519_secret_hex: hex(recipient_x25519_secret.as_bytes()),
            recipient_id: recipient_did.clone(),
            expected_sender_did: sender_did,
            associated_data_hex: hex(ad),
            plaintext_hex: hex(pt),
            wire_hex: hex(&wire),
        });
    }

    // --- Vector 2: self-recipient, longer plaintext, empty AD. ---
    {
        let mut sender_seed = [0u8; 32];
        rng.fill_bytes(&mut sender_seed);
        let sender_sk = SigningKey::from_bytes(&sender_seed);
        let sender_did = did_key_from_verifying(&sender_sk.verifying_key());
        let recipient_x25519_pub: X25519Public =
            ed25519_verifying_to_x25519(&sender_sk.verifying_key()).unwrap();
        let recipient_x25519_secret: StaticSecret = ed25519_signing_to_x25519(&sender_sk);

        let ad: &[u8] = b"";
        let pt: Vec<u8> = (0..1024u32).flat_map(|i| (i as u8).to_be_bytes()).collect();

        let wire = seal_with_rng(
            &mut rng,
            SealParams {
                sender: &sender_sk,
                kind: RecipientKind::SelfRecipient,
                recipient_id: &sender_did,
                recipient_x25519: recipient_x25519_pub,
                associated_data: ad,
                plaintext: &pt,
            },
        )
        .unwrap();

        vectors.push(Vector {
            name: "self-recipient/large".into(),
            recipient_kind: 0x00,
            sender_signing_seed_hex: hex(&sender_seed),
            recipient_x25519_secret_hex: hex(recipient_x25519_secret.as_bytes()),
            recipient_id: sender_did.clone(),
            expected_sender_did: sender_did,
            associated_data_hex: hex(ad),
            plaintext_hex: hex(&pt),
            wire_hex: hex(&wire),
        });
    }

    // --- Vector 3: model-bridge — opaque recipient_id, dedicated x25519 secret. ---
    {
        let mut sender_seed = [0u8; 32];
        rng.fill_bytes(&mut sender_seed);
        let sender_sk = SigningKey::from_bytes(&sender_seed);
        let sender_did = did_key_from_verifying(&sender_sk.verifying_key());

        // Bridge keypair is a long-lived StaticSecret independent of any
        // wallet. Synthesize from the deterministic RNG.
        let mut bridge_secret_bytes = [0u8; 32];
        rng.fill_bytes(&mut bridge_secret_bytes);
        let bridge_secret = StaticSecret::from(bridge_secret_bytes);
        let bridge_pub = X25519Public::from(&bridge_secret);

        let recipient_id = "anthropic/claude-sonnet-4-6";
        let ad = b"role=user;model-bridge";
        let pt = b"What's the meaning of life?";

        let wire = seal_with_rng(
            &mut rng,
            SealParams {
                sender: &sender_sk,
                kind: RecipientKind::ModelBridge,
                recipient_id,
                recipient_x25519: bridge_pub,
                associated_data: ad,
                plaintext: pt,
            },
        )
        .unwrap();

        vectors.push(Vector {
            name: "model-bridge/opaque-recipient".into(),
            recipient_kind: 0x02,
            sender_signing_seed_hex: hex(&sender_seed),
            recipient_x25519_secret_hex: hex(bridge_secret.as_bytes()),
            recipient_id: recipient_id.into(),
            expected_sender_did: sender_did,
            associated_data_hex: hex(ad),
            plaintext_hex: hex(pt),
            wire_hex: hex(&wire),
        });
    }

    let json = serde_json::to_string_pretty(&vectors).unwrap();
    if let Some(parent) = out_path.parent() {
        fs::create_dir_all(parent).expect("mkdir -p");
    }
    fs::write(&out_path, format!("{json}\n")).expect("write vectors");
    eprintln!("wrote {} vectors to {}", vectors.len(), out_path.display());
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
