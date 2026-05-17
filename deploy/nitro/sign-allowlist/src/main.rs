//! `ghola-sign-allowlist` — sign a Nitro enclave measurement digest
//! with the offline Ghola allowlist Ed25519 key. Output is base64,
//! ready to drop into the enclave's `ALLOWLIST_SIG_B64` env var.
//!
//! Usage:
//!   ghola-sign-allowlist <measurement-hex> <path-to-keypair>
//!
//! Keypair format: a raw 32-byte Ed25519 seed, either as 32 raw bytes
//! or as a hex string. The runbook recommends generating it on an
//! air-gapped box with `openssl rand 32 > ghola-attest.key`.

use std::fs;
use std::path::PathBuf;

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine as _;
use ed25519_dalek::{Signer, SigningKey};

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let measurement_hex = args
        .next()
        .ok_or_else(|| anyhow!("missing argument 1: measurement digest hex"))?;
    let key_path = args
        .next()
        .ok_or_else(|| anyhow!("missing argument 2: keypair path"))?;
    if args.next().is_some() {
        bail!("unexpected extra arguments");
    }

    let measurement = hex::decode(measurement_hex.trim())
        .context("measurement digest must be hex")?;
    if measurement.len() != 32 {
        bail!(
            "measurement digest must be 32 bytes (got {})",
            measurement.len()
        );
    }

    let signing_key = load_key(PathBuf::from(key_path))?;
    let sig = signing_key.sign(&measurement);
    let b64 = base64::engine::general_purpose::STANDARD.encode(sig.to_bytes());

    // Print signature to stdout (no trailing newline shenanigans — `tr`
    // and direct env var assignment both handle a single line). The
    // public key goes to stderr so the operator can sanity-check the
    // pub the relay should accept.
    println!("{}", b64);
    eprintln!("verifying_key_hex: {}", hex::encode(signing_key.verifying_key().to_bytes()));
    Ok(())
}

/// Accepts either a 32-byte raw seed or a hex-encoded seed (with or
/// without trailing newline). Anything else errors out so an operator
/// can't accidentally sign with a PEM file they meant for some other
/// system.
fn load_key(path: PathBuf) -> Result<SigningKey> {
    let raw = fs::read(&path).with_context(|| format!("reading key {}", path.display()))?;
    let seed: [u8; 32] = if raw.len() == 32 {
        raw.as_slice()
            .try_into()
            .expect("len checked")
    } else {
        // Hex path: strip whitespace and decode.
        let hex_str: String = raw
            .iter()
            .filter(|b| !b.is_ascii_whitespace())
            .map(|b| *b as char)
            .collect();
        let decoded = hex::decode(&hex_str)
            .with_context(|| "key file is neither 32 raw bytes nor valid hex")?;
        if decoded.len() != 32 {
            bail!(
                "hex-decoded key must be 32 bytes (got {})",
                decoded.len()
            );
        }
        decoded.try_into().expect("len checked")
    };
    Ok(SigningKey::from_bytes(&seed))
}
