//! Integration tests for `TurnkeyVault::{encrypt, decrypt}` against a
//! `wiremock` mock of the Turnkey API.
//!
//! The test strategy:
//! 1. Stand up a mock server.
//! 2. Pre-decide a DEK that the mock will "unwrap" back to.
//! 3. Have `wrap_private_key` capture the incoming `privateKey` (hex DEK)
//!    via a custom responder, return a fixed `wrappedPrivateKey` handle.
//! 4. Have `unwrap_private_key` return the captured DEK hex so round-trip
//!    decryption actually works.

use said_turnkey::{AuthMode, StoredCredential, TurnkeyVault, Vault, VaultError};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use wiremock::matchers::{header_exists, method, path};
use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

/// P-256 private scalar = 1 (valid). Used only for testing.
const TEST_API_SECRET_HEX: &str =
    "0000000000000000000000000000000000000000000000000000000000000001";
/// Public-key field is opaque to our code path; any non-empty hex works.
const TEST_API_PUBLIC_HEX: &str = "deadbeef";
const TEST_ORG_ID: &str = "test-org";
const TEST_KEK_ID: &str = "test-kek-private-key-id";
const FIXED_WRAPPED_HANDLE: &str = "wrapped-handle-abc123";

/// Captures the DEK hex submitted to wrap, and serves it back from unwrap.
#[derive(Clone, Default)]
struct DekRelay {
    last_dek_hex: Arc<Mutex<Option<String>>>,
}

struct WrapResponder {
    relay: DekRelay,
}

impl Respond for WrapResponder {
    fn respond(&self, request: &Request) -> ResponseTemplate {
        let body: Value = match serde_json::from_slice(&request.body) {
            Ok(v) => v,
            Err(_) => return ResponseTemplate::new(400).set_body_string("bad json"),
        };
        if let Some(pk) = body
            .pointer("/parameters/privateKey")
            .and_then(|v| v.as_str())
        {
            *self.relay.last_dek_hex.lock().unwrap() = Some(pk.to_string());
        }
        ResponseTemplate::new(200).set_body_json(json!({
            "activity": {
                "result": {
                    "wrapPrivateKeyResult": {
                        "wrappedPrivateKey": FIXED_WRAPPED_HANDLE,
                    }
                }
            }
        }))
    }
}

struct UnwrapResponder {
    relay: DekRelay,
}

impl Respond for UnwrapResponder {
    fn respond(&self, _request: &Request) -> ResponseTemplate {
        let dek_hex = self
            .relay
            .last_dek_hex
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_else(|| "00".repeat(32));
        ResponseTemplate::new(200).set_body_json(json!({
            "activity": {
                "result": {
                    "unwrapPrivateKeyResult": {
                        "privateKey": dek_hex,
                    }
                }
            }
        }))
    }
}

async fn setup_mock_with_relay() -> (MockServer, DekRelay) {
    let server = MockServer::start().await;
    let relay = DekRelay::default();

    Mock::given(method("POST"))
        .and(path("/public/v1/submit/wrap_private_key"))
        .and(header_exists("X-Stamp"))
        .respond_with(WrapResponder {
            relay: relay.clone(),
        })
        .mount(&server)
        .await;

    Mock::given(method("POST"))
        .and(path("/public/v1/submit/unwrap_private_key"))
        .and(header_exists("X-Stamp"))
        .respond_with(UnwrapResponder {
            relay: relay.clone(),
        })
        .mount(&server)
        .await;

    (server, relay)
}

fn build_vault(base_url: &str) -> TurnkeyVault {
    TurnkeyVault::new(
        TEST_API_SECRET_HEX,
        TEST_API_PUBLIC_HEX,
        TEST_ORG_ID,
        Some(TEST_KEK_ID.to_string()),
    )
    .unwrap()
    .with_base_url(base_url)
}

#[tokio::test]
async fn encrypt_returns_handle_and_ciphertext() {
    let (server, _relay) = setup_mock_with_relay().await;
    let vault = build_vault(&server.uri());

    let stored = vault
        .encrypt(AuthMode::Bearer, "hello world")
        .await
        .expect("encrypt should succeed");

    assert_eq!(stored.backend, "turnkey");
    assert_eq!(
        stored.key_ref.as_deref(),
        Some(FIXED_WRAPPED_HANDLE),
        "key_ref should contain the wrapped handle from Turnkey"
    );
    assert!(
        stored.ciphertext.len() > 12,
        "ciphertext must include 12-byte nonce + at least AEAD tag"
    );
    // Plaintext must NOT appear verbatim in the blob.
    assert!(!stored.ciphertext.windows(11).any(|w| w == b"hello world"));
}

#[tokio::test]
async fn round_trip_recovers_plaintext() {
    let (server, _relay) = setup_mock_with_relay().await;
    let vault = build_vault(&server.uri());

    let plaintext = "sk-merchant-super-secret-token-42";
    let stored = vault
        .encrypt(AuthMode::Bearer, plaintext)
        .await
        .expect("encrypt should succeed");

    let recovered = vault.decrypt(&stored).await.expect("decrypt should succeed");
    assert_eq!(recovered, plaintext);
}

#[tokio::test]
async fn outbound_requests_carry_x_stamp_header() {
    let server = MockServer::start().await;

    // Strict mock: only matches if X-Stamp header is present.
    Mock::given(method("POST"))
        .and(path("/public/v1/submit/wrap_private_key"))
        .and(header_exists("X-Stamp"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "activity": {
                "result": {
                    "wrapPrivateKeyResult": {
                        "wrappedPrivateKey": FIXED_WRAPPED_HANDLE,
                    }
                }
            }
        })))
        .expect(1)
        .mount(&server)
        .await;

    let vault = build_vault(&server.uri());
    vault
        .encrypt(AuthMode::Bearer, "x")
        .await
        .expect("encrypt with stamp should succeed");

    // Drop forces verification of `.expect(1)`.
    drop(server);
}

#[tokio::test]
async fn unauthorized_response_surfaces_as_backend_error() {
    let server = MockServer::start().await;

    Mock::given(method("POST"))
        .and(path("/public/v1/submit/wrap_private_key"))
        .respond_with(ResponseTemplate::new(401).set_body_string("unauthorized"))
        .mount(&server)
        .await;

    let vault = build_vault(&server.uri());
    let err = vault
        .encrypt(AuthMode::Bearer, "x")
        .await
        .expect_err("401 should surface as error");

    match err {
        VaultError::Backend(msg) => {
            assert!(
                msg.contains("401") || msg.to_lowercase().contains("unauthorized"),
                "expected 401/unauthorized in error message, got: {msg}"
            );
        }
        other => panic!("expected VaultError::Backend, got {other:?}"),
    }
}

#[tokio::test]
async fn encrypt_without_kek_id_is_not_configured() {
    // No KEK ID set → encrypt must refuse.
    let vault = TurnkeyVault::new(
        TEST_API_SECRET_HEX,
        TEST_API_PUBLIC_HEX,
        TEST_ORG_ID,
        None,
    )
    .unwrap();

    let err = vault
        .encrypt(AuthMode::Bearer, "x")
        .await
        .expect_err("should require KEK id");
    assert!(matches!(err, VaultError::NotConfigured(_)));
}

#[tokio::test]
async fn decrypt_rejects_wrong_backend() {
    let (server, _relay) = setup_mock_with_relay().await;
    let vault = build_vault(&server.uri());
    let bogus = StoredCredential {
        backend: "local",
        key_version: 1,
        key_ref: Some("ignored".into()),
        ciphertext: vec![0u8; 40],
        auth_mode: AuthMode::Bearer,
    };
    assert!(vault.decrypt(&bogus).await.is_err());
}
