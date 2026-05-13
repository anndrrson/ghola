//! Turnkey `X-Stamp` request signing.
//!
//! Every Turnkey API call is authenticated by a P-256 ECDSA signature over
//! the raw HTTP request body. The signature is wrapped in a JSON envelope and
//! base64url-no-pad encoded, then sent as the `X-Stamp` header.
//!
//! Envelope wire format:
//! ```text
//! base64url_no_pad(
//!   JSON.stringify({
//!     publicKey: hex(api_public_key),
//!     scheme: "SIGNATURE_SCHEME_TK_API_P256",
//!     signature: hex(DER-encoded ECDSA signature)
//!   })
//! )
//! ```

use base64::Engine;
use p256::ecdsa::{signature::Signer, Signature, SigningKey};
use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum StampError {
    #[error("invalid api secret hex: {0}")]
    InvalidSecret(String),
    #[error("invalid signing key: {0}")]
    InvalidKey(String),
    #[error("serialize stamp envelope: {0}")]
    Serialize(String),
}

#[derive(Serialize)]
struct StampEnvelope<'a> {
    #[serde(rename = "publicKey")]
    public_key: &'a str,
    scheme: &'static str,
    signature: String,
}

/// Build the `X-Stamp` header value for a Turnkey API request.
///
/// * `api_secret_hex` — 32-byte P-256 private scalar, hex-encoded.
/// * `api_public_hex` — compressed/uncompressed P-256 public key, hex-encoded.
///   Passed through verbatim into the envelope's `publicKey` field.
/// * `body` — the exact request body bytes that will be POSTed.
pub fn build_stamp(
    api_secret_hex: &str,
    api_public_hex: &str,
    body: &[u8],
) -> Result<String, StampError> {
    let secret_bytes = hex::decode(api_secret_hex.trim())
        .map_err(|e| StampError::InvalidSecret(e.to_string()))?;
    let signing_key = SigningKey::from_slice(&secret_bytes)
        .map_err(|e| StampError::InvalidKey(e.to_string()))?;

    let sig: Signature = signing_key.sign(body);
    let der = sig.to_der();
    let signature_hex = hex::encode(der.as_bytes());

    let env = StampEnvelope {
        public_key: api_public_hex,
        scheme: "SIGNATURE_SCHEME_TK_API_P256",
        signature: signature_hex,
    };
    let json = serde_json::to_vec(&env).map_err(|e| StampError::Serialize(e.to_string()))?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&json))
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::{signature::Verifier, VerifyingKey};

    // Generated once, deterministic key for testing.
    // Private scalar = 1 (smallest valid). This is not used anywhere else.
    fn fixture_keys() -> (String, String, VerifyingKey) {
        // 32-byte scalar of value 1.
        let mut sk = [0u8; 32];
        sk[31] = 1;
        let signing = SigningKey::from_slice(&sk).unwrap();
        let verifying = *signing.verifying_key();
        let pub_bytes = verifying.to_encoded_point(false);
        (hex::encode(sk), hex::encode(pub_bytes.as_bytes()), verifying)
    }

    #[test]
    fn stamp_is_base64url_decodable_and_signature_verifies() {
        let (sk_hex, pk_hex, vk) = fixture_keys();
        let body = br#"{"hello":"world"}"#;
        let stamp = build_stamp(&sk_hex, &pk_hex, body).unwrap();

        let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(stamp.as_bytes())
            .unwrap();
        let env: serde_json::Value = serde_json::from_slice(&raw).unwrap();
        assert_eq!(env["scheme"], "SIGNATURE_SCHEME_TK_API_P256");
        assert_eq!(env["publicKey"], pk_hex);

        let sig_hex = env["signature"].as_str().unwrap();
        let der = hex::decode(sig_hex).unwrap();
        let sig = Signature::from_der(&der).unwrap();
        vk.verify(body, &sig).unwrap();
    }

    #[test]
    fn rejects_bad_secret_hex() {
        let err = build_stamp("not-hex", "deadbeef", b"x").unwrap_err();
        matches!(err, StampError::InvalidSecret(_));
    }
}
