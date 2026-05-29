//! Enclave key + quote management.
//!
//! On boot the provider mints a fresh X25519 + Ed25519 keypair in
//! enclave RAM (these never persist to disk) and asks the Nitro
//! Security Module for an attestation document binding both public
//! keys to the boot timestamp.
//!
//! The `mock-nitro` feature short-circuits the NSM syscall and returns
//! a synthetic quote. The relay running with `GHOLA_ALLOW_UNATTESTED=1`
//! plus `TeeKind::None` accepts that path; the real Nitro path is
//! exercised only in production.

use anyhow::Result;
use ed25519_dalek::SigningKey as EdSigningKey;
use rand::rngs::OsRng;
use rand::RngCore;
use sha2::{Digest, Sha256};
use x25519_dalek::{PublicKey as X25519Public, StaticSecret as X25519Secret};

use said_envelope::did_key_from_verifying;
use ghola_assistant_types::EnclaveKeyId;

/// Ephemeral, in-RAM key material for one enclave boot. Both keys live
/// only as long as this process; the cloud never sees the secrets and
/// the enclave forgets them on shutdown.
pub struct EnclaveKeys {
    pub x25519_secret: X25519Secret,
    pub x25519_public: X25519Public,
    pub ed25519_signing: EdSigningKey,
}

impl EnclaveKeys {
    /// `did:key:z…` form of the Ed25519 verifying key. Used as the
    /// `signer_did` field in receipts and as the `sender_did` in sealed
    /// response envelopes.
    pub fn enclave_did(&self) -> String {
        did_key_from_verifying(&self.ed25519_signing.verifying_key())
    }

    /// Stable `EnclaveKeyId` = hex(sha256(x25519_pub)). Matches the
    /// shape `said-attest` produces from the verified quote, so the
    /// relay can route to this enclave by the same id.
    pub fn enclave_key_id(&self) -> EnclaveKeyId {
        let mut h = Sha256::new();
        h.update(self.x25519_public.as_bytes());
        EnclaveKeyId(hex::encode(h.finalize()))
    }

    pub fn x25519_pub_hex(&self) -> String {
        hex::encode(self.x25519_public.as_bytes())
    }

    pub fn ed25519_pub_hex(&self) -> String {
        hex::encode(self.ed25519_signing.verifying_key().as_bytes())
    }
}

/// Mint a fresh X25519 + Ed25519 keypair from the OS CSPRNG.
pub fn generate_keys() -> Result<EnclaveKeys> {
    let mut rng = OsRng;

    let mut x_seed = [0u8; 32];
    rng.fill_bytes(&mut x_seed);
    let x25519_secret = X25519Secret::from(x_seed);
    let x25519_public = X25519Public::from(&x25519_secret);

    let mut ed_seed = [0u8; 32];
    rng.fill_bytes(&mut ed_seed);
    let ed25519_signing = EdSigningKey::from_bytes(&ed_seed);

    Ok(EnclaveKeys {
        x25519_secret,
        x25519_public,
        ed25519_signing,
    })
}

/// Ask the platform for an attestation document binding the keys to
/// `timestamp_ms`. The bytes returned here are what gets base64'd into
/// `ProviderAttestPayload::vendor_quote_b64`.
///
/// Layout of `user_data` matches `said-attest`'s verifier:
/// `[x25519_pub (32)][ed25519_pub (32)][ts_ms_le (8)]`. The verifier
/// does the loose-bind check against the doc's own timestamp, so the
/// caller must pass `now_ms()` rather than zero.
pub fn request_quote(keys: &EnclaveKeys, timestamp_ms: i64) -> Result<Vec<u8>> {
    let user_data = said_attest::pack_user_data(
        keys.x25519_public.as_bytes(),
        keys.ed25519_signing.verifying_key().as_bytes(),
        timestamp_ms,
    );

    #[cfg(feature = "mock-nitro")]
    {
        // Synthetic quote: a small JSON header followed by the
        // user_data bytes. The relay's `TeeKind::None` path under
        // `GHOLA_ALLOW_UNATTESTED=1` doesn't run `said-attest` over
        // it; it just trusts the pubkeys in the payload. We still
        // include `user_data` so a test harness can recover the keys
        // from the quote if it wants to without doing the COSE dance.
        let header = serde_json::json!({
            "mock": true,
            "ts_ms": timestamp_ms,
            "format": "ghola-mock-quote-v1",
        });
        let mut buf = serde_json::to_vec(&header)?;
        buf.push(0x00);
        buf.extend_from_slice(&user_data);
        return Ok(buf);
    }

    #[cfg(not(feature = "mock-nitro"))]
    {
        request_quote_real(&user_data)
    }
}

#[cfg(all(not(feature = "mock-nitro"), target_os = "linux"))]
fn request_quote_real(user_data: &[u8]) -> Result<Vec<u8>> {
    // The nsm-api dependency is `optional = true`; in a real Nitro EIF
    // build the operator adds `--features aws-nitro-enclaves-nsm-api`
    // alongside dropping `mock-nitro`. Without that feature we still
    // want to compile on Linux dev machines for `cargo check`, so the
    // body below is itself a stub when the dep isn't wired in.
    #[cfg(feature = "aws-nitro-enclaves-nsm-api")]
    {
        use aws_nitro_enclaves_nsm_api::api::{Request, Response};
        use aws_nitro_enclaves_nsm_api::driver::{nsm_init, nsm_process_request, nsm_exit};

        let fd = nsm_init();
        if fd < 0 {
            anyhow::bail!("nsm_init returned {fd}");
        }
        let req = Request::Attestation {
            user_data: Some(user_data.to_vec().into()),
            nonce: None,
            public_key: None,
        };
        let resp = nsm_process_request(fd, req);
        nsm_exit(fd);
        match resp {
            Response::Attestation { document } => Ok(document),
            Response::Error(e) => anyhow::bail!("nsm attestation error: {:?}", e),
            other => anyhow::bail!("unexpected nsm response: {:?}", other),
        }
    }

    #[cfg(not(feature = "aws-nitro-enclaves-nsm-api"))]
    {
        let _ = user_data;
        anyhow::bail!(
            "real Nitro path requires building with --features aws-nitro-enclaves-nsm-api; \
             use --features mock-nitro for non-enclave builds"
        )
    }
}

#[cfg(all(not(feature = "mock-nitro"), not(target_os = "linux")))]
fn request_quote_real(_user_data: &[u8]) -> Result<Vec<u8>> {
    anyhow::bail!(
        "real Nitro attestation only available on Linux enclaves; \
         build with --features mock-nitro on macOS/Windows"
    )
}

/// Current wall time in unix milliseconds, used to stamp the
/// attestation `user_data` and the receipt `issued_at`.
pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_have_stable_ids() {
        let k = generate_keys().unwrap();
        let id1 = k.enclave_key_id();
        let id2 = k.enclave_key_id();
        assert_eq!(id1, id2);
        assert_eq!(id1.0.len(), 64); // hex sha256
    }

    #[test]
    fn enclave_did_round_trips() {
        let k = generate_keys().unwrap();
        let did = k.enclave_did();
        let vk = said_envelope::verifying_from_did_key(&did).unwrap();
        assert_eq!(vk.as_bytes(), k.ed25519_signing.verifying_key().as_bytes());
    }

    #[cfg(feature = "mock-nitro")]
    #[test]
    fn mock_quote_contains_user_data() {
        let k = generate_keys().unwrap();
        let q = request_quote(&k, 1_700_000_000_000).unwrap();
        // Last 72 bytes should be the user_data.
        let tail = &q[q.len() - 72..];
        assert_eq!(&tail[..32], k.x25519_public.as_bytes());
        assert_eq!(&tail[32..64], k.ed25519_signing.verifying_key().as_bytes());
    }
}
