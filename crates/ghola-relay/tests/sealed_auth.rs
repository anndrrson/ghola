//! # Sealed-envelope auth middleware — integration tests
//!
//! Phase 3 of the v3.5 privacy rollout. Exercises
//! `ghola_relay::auth::require_sealed_envelope_auth` against an axum
//! Router that mounts the middleware in front of a no-op echo handler.
//!
//! Test matrix:
//!   - happy path: known DID + fresh nonce → 200
//!   - replay:     same envelope posted twice → 200 then 429
//!   - unknown:    envelope from a DID not in the set → 401

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::routing::post;
use axum::Router;
use ed25519_dalek::SigningKey;
use http_body_util::BodyExt;
use rand::rngs::OsRng;
use rand::RngCore;
use serde_json::json;
use tower::ServiceExt;

use said_envelope::{
    did_key_from_verifying, ed25519_verifying_to_x25519, seal, RecipientKind, SealParams,
};
use ghola_relay::auth::require_sealed_envelope_auth;
use ghola_relay::config::RelayConfig;
use ghola_relay::did_set::DidSet;
use ghola_relay::state::AppState;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

fn fresh_signing_key() -> SigningKey {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    SigningKey::from_bytes(&bytes)
}

/// Build a Router that mounts the sealed-auth middleware in front of a
/// trivial handler that always returns 200. This is the same wiring
/// pattern `lib.rs` uses for `/inference/sealed`, with the real
/// dispatcher replaced by an echo to keep the test independent of
/// attestation / provider state.
fn build_test_app(state: AppState) -> Router {
    async fn ok_handler() -> &'static str {
        "ok"
    }

    Router::new()
        .route("/inference/sealed", post(ok_handler))
        .route_layer(axum::middleware::from_fn_with_state(
            state.clone(),
            require_sealed_envelope_auth,
        ))
        .with_state(state)
}

/// Configuration suitable for unit-style tests: refresh task is not
/// spawned (we drive the DidSet directly).
fn test_config() -> RelayConfig {
    RelayConfig {
        bind_addr: "127.0.0.1:0".parse().unwrap(),
        rate_limit_per_second: 1000,
        max_message_size_bytes: 1_048_576,
        auth_timeout_secs: 300,
        dev_mode: false,
        tls_cert_path: None,
        tls_key_path: None,
        ohttp_key_secret_hex: None,
        ohttp_key_id: ghola_relay::config::DEFAULT_OHTTP_KEY_ID,
        did_set_url: None,
        did_set_api_key: None,
        did_set_max_staleness_secs: 300,
        sealed_rate_limit_per_did: 1000,
        max_body_size_bytes: 1_048_576,
        max_sealed_body_size_bytes: 4 * 1_048_576,
        cors_allowed_origins: vec!["https://ghola.xyz".to_string()],
        ghola_cloud_base_url: "https://thumper-cloud.example".to_string(),
    }
}

/// Build a sealed envelope from `sender` to a model-bridge recipient
/// (the enclave's X25519 pubkey). For test purposes the "enclave" key
/// is a freshly generated Ed25519 key whose verifying half we convert
/// to X25519. The relay never opens the envelope so the recipient
/// secret is irrelevant to the auth middleware.
fn build_sealed_request_body(sender: &SigningKey) -> (Vec<u8>, String) {
    // Pretend recipient is an enclave at some X25519 pubkey.
    let recipient_signing = fresh_signing_key();
    let recipient_x25519 = ed25519_verifying_to_x25519(&recipient_signing.verifying_key()).unwrap();

    let recipient_id = "test-enclave-id";
    let ad = b"ghola-inference-v1|test-session|test-job";
    let pt = br#"{"job_id":"test-job","messages":[]}"#;

    let envelope = seal(SealParams {
        sender,
        kind: RecipientKind::ModelBridge,
        recipient_id,
        recipient_x25519,
        associated_data: ad,
        plaintext: pt,
    })
    .expect("seal");

    let sealed_b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &envelope);

    let body = json!({
        "enclave_key_id": recipient_id,
        "job_id": "test-job",
        "sealed_request_b64": sealed_b64,
        "mode_hint": "private",
    });
    let body_bytes = serde_json::to_vec(&body).unwrap();
    let sender_did = did_key_from_verifying(&sender.verifying_key());
    (body_bytes, sender_did)
}

async fn post_to(app: &Router, body_bytes: Vec<u8>) -> (StatusCode, Vec<u8>) {
    let req = Request::builder()
        .method("POST")
        .uri("/inference/sealed")
        .header("Content-Type", "application/json")
        .body(Body::from(body_bytes))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let body = resp
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes()
        .to_vec();
    (status, body)
}

/// Pre-populate the DidSet via the public test-only constructor. We
/// reach into the internal API by re-using `replace_from_snapshot`'s
/// effect: we can't call it from outside the crate, but we can use the
/// did_set's public API by simulating a refresh. Since `DidSet::new()`
/// is empty and we need a concrete entry, we use a small helper from
/// the crate's public surface — namely a fresh DidSet plus a forced
/// fetch from a local stub server.
///
/// In practice this is overkill for an integration test. Instead we
/// expose a small dev-only path: construct a `DidSet`, then run the
/// production `spawn_refresh_task` against a wiremock'd HTTP server,
/// OR we use `replace_from_snapshot_for_test` if exposed.
///
/// We'll add a small test-only helper on `DidSet` rather than reach
/// for wiremock. (See `did_set::DidSet::insert_for_test`.)

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn happy_path_known_did_returns_200() {
    let sender = fresh_signing_key();
    let sender_did = did_key_from_verifying(&sender.verifying_key());

    let did_set = DidSet::new();
    did_set.insert_for_test(sender_did.clone());

    let state = AppState::new_with_did_set(test_config(), did_set);
    let app = build_test_app(state);

    let (body, _did) = build_sealed_request_body(&sender);
    let (status, _b) = post_to(&app, body).await;
    assert_eq!(status, StatusCode::OK, "known DID should succeed");
}

#[tokio::test]
async fn replay_returns_429() {
    let sender = fresh_signing_key();
    let sender_did = did_key_from_verifying(&sender.verifying_key());

    let did_set = DidSet::new();
    did_set.insert_for_test(sender_did.clone());

    let state = AppState::new_with_did_set(test_config(), did_set);
    let app = build_test_app(state);

    let (body, _did) = build_sealed_request_body(&sender);

    let (status1, _b) = post_to(&app, body.clone()).await;
    assert_eq!(status1, StatusCode::OK);

    let (status2, _b) = post_to(&app, body).await;
    assert_eq!(
        status2,
        StatusCode::TOO_MANY_REQUESTS,
        "replay should be rejected with 429"
    );
}

#[tokio::test]
async fn unknown_did_returns_401() {
    // The DID set is populated with a *different* signer.
    let known = fresh_signing_key();
    let known_did = did_key_from_verifying(&known.verifying_key());

    let did_set = DidSet::new();
    did_set.insert_for_test(known_did.clone());

    let state = AppState::new_with_did_set(test_config(), did_set);
    let app = build_test_app(state);

    // ...but the request is signed by a stranger.
    let stranger = fresh_signing_key();
    let (body, _did) = build_sealed_request_body(&stranger);
    let (status, _b) = post_to(&app, body).await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "DID not in set should be 401"
    );
}

// Suppress unused warnings for helpers above when only a subset of
// tests are compiled.
#[allow(dead_code)]
fn _ensure_arc_used() {
    let _ = Arc::new(());
}
