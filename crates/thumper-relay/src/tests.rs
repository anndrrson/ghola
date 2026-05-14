use ed25519_dalek::{Signer, SigningKey};
use rand::rngs::OsRng;

use thumper_types::{
    AuthMessage, AuthPayload, ConnectionRole, EnclaveKeyId, Envelope, MessageType,
    ProviderAttestPayload, SealedInferenceResponsePayload, TeeKind,
};

use crate::auth::{verify_auth, NonceCache};
use crate::config::RelayConfig;
use crate::handlers::handle_provider_attest;
use crate::state::{AppState, RateLimiter};

// -- NonceCache tests --

#[test]
fn nonce_cache_detects_replay() {
    let cache = NonceCache::new(300);
    assert!(!cache.check_and_insert("nonce-1")); // first time: not a replay
    assert!(cache.check_and_insert("nonce-1")); // second time: replay detected
}

#[test]
fn nonce_cache_allows_different_nonces() {
    let cache = NonceCache::new(300);
    assert!(!cache.check_and_insert("nonce-1"));
    assert!(!cache.check_and_insert("nonce-2"));
    assert!(!cache.check_and_insert("nonce-3"));
}

#[test]
fn nonce_cache_prune_is_safe() {
    let cache = NonceCache::new(300);
    cache.check_and_insert("nonce-1");
    cache.prune(); // should not panic, nonce is recent so it stays
    assert!(cache.check_and_insert("nonce-1")); // still there
}

// -- verify_auth tests --

fn make_auth_payload(
    pubkey: &str,
    timestamp: u64,
    nonce: &str,
    role: ConnectionRole,
) -> AuthPayload {
    AuthPayload {
        message: AuthMessage {
            pubkey: pubkey.into(),
            timestamp,
            nonce: nonce.into(),
            role,
        },
        signature: String::new(),
    }
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

#[test]
fn verify_auth_dev_mode_accepts_any_pubkey() {
    let payload = make_auth_payload("fake_key", now_secs(), "nonce-1", ConnectionRole::Device);

    let result = verify_auth(&payload, 300, true, None);
    assert!(result.is_ok());
    assert_eq!(result.unwrap(), "fake_key");
}

#[test]
fn verify_auth_expired_timestamp() {
    let old_time = now_secs() - 600; // 10 minutes ago, exceeds 300s timeout
    let payload = make_auth_payload("key", old_time, "nonce-1", ConnectionRole::Device);

    let result = verify_auth(&payload, 300, true, None);
    assert!(result.is_err());
    assert!(result.unwrap_err().to_string().contains("expired"));
}

#[test]
fn verify_auth_future_timestamp() {
    let future_time = now_secs() + 60; // 60 seconds in the future (>30s threshold)
    let payload = make_auth_payload("key", future_time, "nonce-1", ConnectionRole::Device);

    let result = verify_auth(&payload, 300, true, None);
    assert!(result.is_err());
    assert!(result.unwrap_err().to_string().contains("future"));
}

#[test]
fn verify_auth_replayed_nonce() {
    let cache = NonceCache::new(300);
    let payload = make_auth_payload("key", now_secs(), "same-nonce", ConnectionRole::Device);

    // First attempt should succeed
    let result = verify_auth(&payload, 300, true, Some(&cache));
    assert!(result.is_ok());

    // Second attempt with same nonce should fail
    let result = verify_auth(&payload, 300, true, Some(&cache));
    assert!(result.is_err());
    assert!(result.unwrap_err().to_string().contains("replay"));
}

#[test]
fn verify_auth_valid_ed25519_signature() {
    let signing_key = SigningKey::generate(&mut OsRng);
    let verifying_key = signing_key.verifying_key();
    let pubkey_bytes = verifying_key.as_bytes();

    // Base58 encode the pubkey
    let pubkey_b58 = bs58_encode(pubkey_bytes);

    let message = AuthMessage {
        pubkey: pubkey_b58.clone(),
        timestamp: now_secs(),
        nonce: "valid-nonce".into(),
        role: ConnectionRole::McpClient,
    };

    let canonical = message.canonical_bytes();
    let signature = signing_key.sign(&canonical);
    let sig_b64 =
        base64::Engine::encode(&base64::engine::general_purpose::STANDARD, signature.to_bytes());

    let payload = AuthPayload {
        message,
        signature: sig_b64,
    };

    // Production mode (dev_mode = false)
    let result = verify_auth(&payload, 300, false, None);
    assert!(result.is_ok());
    assert_eq!(result.unwrap(), pubkey_b58);
}

#[test]
fn verify_auth_invalid_signature_rejected() {
    let signing_key = SigningKey::generate(&mut OsRng);
    let verifying_key = signing_key.verifying_key();
    let pubkey_bytes = verifying_key.as_bytes();
    let pubkey_b58 = bs58_encode(pubkey_bytes);

    let message = AuthMessage {
        pubkey: pubkey_b58,
        timestamp: now_secs(),
        nonce: "nonce-invalid-sig".into(),
        role: ConnectionRole::Device,
    };

    // Sign with a DIFFERENT key
    let wrong_key = SigningKey::generate(&mut OsRng);
    let canonical = message.canonical_bytes();
    let bad_sig = wrong_key.sign(&canonical);
    let sig_b64 =
        base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bad_sig.to_bytes());

    let payload = AuthPayload {
        message,
        signature: sig_b64,
    };

    let result = verify_auth(&payload, 300, false, None);
    assert!(result.is_err());
    assert!(result
        .unwrap_err()
        .to_string()
        .contains("signature verification failed"));
}

#[test]
fn verify_auth_invalid_pubkey_encoding() {
    let payload = AuthPayload {
        message: AuthMessage {
            pubkey: "not-valid-base58!!!".into(),
            timestamp: now_secs(),
            nonce: "nonce-bad-key".into(),
            role: ConnectionRole::Device,
        },
        signature: "AAAA".into(), // some base64
    };

    let result = verify_auth(&payload, 300, false, None);
    assert!(result.is_err());
}

// -- RateLimiter tests --

#[test]
fn rate_limiter_allows_burst_up_to_max() {
    let mut limiter = RateLimiter::new(5);
    for _ in 0..5 {
        assert!(limiter.try_consume());
    }
    // 6th should fail
    assert!(!limiter.try_consume());
}

#[test]
fn rate_limiter_refills_over_time() {
    let mut limiter = RateLimiter::new(10);
    // Consume all tokens
    for _ in 0..10 {
        limiter.try_consume();
    }
    assert!(!limiter.try_consume());

    // Wait a bit for refill
    std::thread::sleep(std::time::Duration::from_millis(200));
    assert!(limiter.try_consume());
}

// -- bs58 helper --

fn bs58_encode(input: &[u8]) -> String {
    const ALPHABET: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

    if input.is_empty() {
        return String::new();
    }

    let mut digits: Vec<u8> = Vec::new();
    for &byte in input {
        let mut carry = byte as u32;
        for d in digits.iter_mut() {
            let val = (*d as u32) * 256 + carry;
            *d = (val % 58) as u8;
            carry = val / 58;
        }
        while carry > 0 {
            digits.push((carry % 58) as u8);
            carry /= 58;
        }
    }

    // Leading zeros
    for &byte in input {
        if byte == 0 {
            digits.push(0);
        } else {
            break;
        }
    }

    digits.reverse();
    digits
        .into_iter()
        .map(|d| ALPHABET[d as usize] as char)
        .collect()
}

#[test]
fn bs58_encode_decode_roundtrip() {
    let original = [1, 2, 3, 4, 5, 6, 7, 8];
    let encoded = bs58_encode(&original);
    let decoded = crate::auth::bs58_decode(&encoded).unwrap();
    assert_eq!(decoded, original);
}

// -- Attested-enclave + sealed-inference tests --

fn test_config() -> RelayConfig {
    RelayConfig {
        bind_addr: "127.0.0.1:0".parse().unwrap(),
        rate_limit_per_second: 30,
        max_message_size_bytes: 1_048_576,
        auth_timeout_secs: 300,
        dev_mode: true,
        tls_cert_path: None,
        tls_key_path: None,
        ohttp_key_secret_hex: None,
        ohttp_key_id: crate::config::DEFAULT_OHTTP_KEY_ID,
        did_set_url: None,
        did_set_api_key: None,
        did_set_max_staleness_secs: 300,
    }
}

fn mock_attest_payload() -> ProviderAttestPayload {
    // Two distinct 32-byte hex pubkeys.
    let x25519_hex = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
    let ed25519_hex = "ffeeddccbbaa9988776655443322110000112233445566778899aabbccddeeff";
    ProviderAttestPayload {
        tee_kind: TeeKind::None,
        enclave_x25519_pub_hex: x25519_hex.into(),
        enclave_ed25519_pub_hex: ed25519_hex.into(),
        vendor_quote_b64: base64_encode(b"mock-vendor-quote-bytes"),
        ghola_allowlist_sig_b64: base64_encode(b"mock-allowlist-sig"),
    }
}

fn base64_encode(data: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(data)
}

/// Guard that sets/unsets env vars for a single test. Tests touching env
/// vars must be serialized (cargo runs tests in parallel by default), so
/// we route them through this lock.
struct EnvGuard {
    keys: Vec<(&'static str, Option<String>)>,
}

impl EnvGuard {
    fn set(keys: &[(&'static str, Option<&str>)]) -> Self {
        let mut saved = Vec::new();
        for (k, v) in keys {
            saved.push((*k, std::env::var(*k).ok()));
            match v {
                Some(val) => std::env::set_var(k, val),
                None => std::env::remove_var(k),
            }
        }
        Self { keys: saved }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        for (k, v) in &self.keys {
            match v {
                Some(val) => std::env::set_var(k, val),
                None => std::env::remove_var(k),
            }
        }
    }
}

static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[test]
fn provider_attest_dev_path_accepts_when_allow_unattested_set() {
    let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _env = EnvGuard::set(&[
        ("THUMPER_ALLOW_UNATTESTED", Some("1")),
        ("GHOLA_ATTEST_SIGNING_PUB", None),
    ]);

    let state = AppState::new(test_config());
    let ack = handle_provider_attest(&state, "provider-pubkey-1", mock_attest_payload());

    assert!(ack.accepted, "ack should be accepted: {:?}", ack.reason);
    let key_id = ack.enclave_key_id.expect("ack must carry enclave_key_id");
    assert!(state.get_attested_enclave(&key_id).is_some());
    let listed = state.list_attested_enclaves();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].provider_id, "provider-pubkey-1");
}

#[test]
fn provider_attest_rejects_when_unattested_disabled() {
    let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _env = EnvGuard::set(&[
        ("THUMPER_ALLOW_UNATTESTED", None),
        ("GHOLA_ATTEST_SIGNING_PUB", None),
    ]);

    let state = AppState::new(test_config());
    let ack = handle_provider_attest(&state, "provider-pubkey-1", mock_attest_payload());

    assert!(!ack.accepted);
    assert!(ack.enclave_key_id.is_none());
    assert!(ack.reason.is_some());
    assert!(state.list_attested_enclaves().is_empty());
}

#[test]
fn prune_expired_enclaves_removes_old_entries() {
    let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _env = EnvGuard::set(&[
        ("THUMPER_ALLOW_UNATTESTED", Some("1")),
        ("GHOLA_ATTEST_SIGNING_PUB", None),
    ]);

    let state = AppState::new(test_config());
    let ack = handle_provider_attest(&state, "provider-x", mock_attest_payload());
    let _key_id = ack.enclave_key_id.unwrap();

    // expires_at is set to now + 24h via the dev path; pruning at "way in
    // the future" should drop everything.
    let future = chrono::Utc::now().timestamp() + 100 * 24 * 3600;
    let removed = state.prune_expired_enclaves(future);
    assert_eq!(removed, 1);
    assert!(state.list_attested_enclaves().is_empty());

    // Pruning at present should be a no-op now.
    let now = chrono::Utc::now().timestamp();
    let removed2 = state.prune_expired_enclaves(now);
    assert_eq!(removed2, 0);
}

#[test]
fn find_attestation_by_hash_serves_cached_quote() {
    let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _env = EnvGuard::set(&[
        ("THUMPER_ALLOW_UNATTESTED", Some("1")),
        ("GHOLA_ATTEST_SIGNING_PUB", None),
    ]);

    let state = AppState::new(test_config());
    let payload = mock_attest_payload();
    let vendor_quote_b64 = payload.vendor_quote_b64.clone();
    let ack = handle_provider_attest(&state, "provider-x", payload);
    assert!(ack.accepted);

    let hash = AppState::compute_attestation_hash(&vendor_quote_b64);
    let (enclave, served_quote) = state
        .find_attestation_by_hash(&hash)
        .expect("attestation should be findable by hash");
    assert_eq!(served_quote, vendor_quote_b64);
    assert_eq!(enclave.provider_id, "provider-x");

    // Unknown hash returns None.
    let missing = state.find_attestation_by_hash("deadbeef");
    assert!(missing.is_none());
}

#[tokio::test(flavor = "current_thread")]
async fn dispatch_inference_sealed_forwards_opaque_bytes() {
    // Provider mock: we plug an mpsc into the AppState gpu_providers map
    // directly, then call dispatch_inference_sealed and assert the
    // ciphertext_b64 forwarded verbatim. We also resolve the pending
    // oneshot to emulate the provider's sealed reply.
    let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _env = EnvGuard::set(&[
        ("THUMPER_ALLOW_UNATTESTED", Some("1")),
        ("GHOLA_ATTEST_SIGNING_PUB", None),
    ]);

    let state = AppState::new(test_config());

    // Register a mock provider.
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<axum::extract::ws::Message>();
    let provider_pubkey = "mock-provider-pubkey".to_string();
    state.add_gpu_provider(&provider_pubkey, tx, Vec::new(), 4, "wallet".to_string());

    // Attest the provider via the dev path.
    let ack = handle_provider_attest(&state, &provider_pubkey, mock_attest_payload());
    assert!(ack.accepted, "dev attest failed: {:?}", ack.reason);
    let enclave_key_id: EnclaveKeyId = ack.enclave_key_id.unwrap();

    let job_id = "job-1".to_string();
    let sealed_b64 = base64_encode(b"<opaque sealed envelope bytes>");

    // Spawn the dispatcher in the background — it will register the
    // oneshot, send to the provider, and then await the reply.
    let dispatch_state = state.clone();
    let dispatch_job = job_id.clone();
    let dispatch_seal = sealed_b64.clone();
    let dispatch_key = enclave_key_id.clone();
    let dispatcher = tokio::spawn(async move {
        use crate::handlers::{dispatch_inference_sealed, SealedInferenceDispatchRequest};
        use axum::extract::State;
        use axum::Json;
        use axum::response::IntoResponse;
        let resp = dispatch_inference_sealed(
            State(dispatch_state),
            Json(SealedInferenceDispatchRequest {
                enclave_key_id: dispatch_key,
                job_id: dispatch_job,
                sealed_request_b64: dispatch_seal,
                mode_hint: Some("private".into()),
            }),
        )
        .await
        .into_response();
        resp
    });

    // Receive the message the dispatcher sent to the provider.
    let forwarded = tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv())
        .await
        .expect("provider should receive forwarded message within 5s")
        .expect("channel open");
    let forwarded_text = match forwarded {
        axum::extract::ws::Message::Text(t) => t.to_string(),
        other => panic!("unexpected msg variant: {:?}", other),
    };
    let env: Envelope = serde_json::from_str(&forwarded_text).expect("valid envelope");
    match env.message {
        MessageType::InferenceRequestSealed(p) => {
            assert_eq!(p.job_id, job_id);
            // Opaque bytes forwarded verbatim.
            assert_eq!(p.ciphertext_b64, sealed_b64);
            assert_eq!(p.enclave_key_id, enclave_key_id);
        }
        other => panic!("expected InferenceRequestSealed, got {:?}", other),
    }

    // Now emulate the provider's sealed reply.
    let reply_b64 = base64_encode(b"<opaque sealed reply bytes>");
    let reply = Envelope::new(MessageType::InferenceResponseSealed(
        SealedInferenceResponsePayload {
            job_id: job_id.clone(),
            ciphertext_b64: reply_b64.clone(),
            is_final: true,
        },
    ));
    state.resolve_pending_inference(&job_id, reply);

    let response = dispatcher.await.expect("dispatcher join");
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    let body_bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
        .await
        .expect("read body");
    let body: serde_json::Value = serde_json::from_slice(&body_bytes).unwrap();
    assert_eq!(body["job_id"], job_id);
    assert_eq!(body["ciphertext_b64"], reply_b64);
    assert_eq!(body["is_final"], true);
}

#[tokio::test(flavor = "current_thread")]
async fn list_attested_providers_returns_inserted_enclaves() {
    let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _env = EnvGuard::set(&[
        ("THUMPER_ALLOW_UNATTESTED", Some("1")),
        ("GHOLA_ATTEST_SIGNING_PUB", None),
    ]);

    let state = AppState::new(test_config());
    let ack = handle_provider_attest(&state, "p1", mock_attest_payload());
    assert!(ack.accepted);

    use crate::handlers::{list_attested_providers, ListAttestedQuery};
    use axum::extract::{Query, State};
    use axum::response::IntoResponse;
    let response = list_attested_providers(State(state.clone()), Query(ListAttestedQuery { model: None }))
        .await
        .into_response();
    let body = axum::body::to_bytes(response.into_body(), 64 * 1024)
        .await
        .unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let arr = json.as_array().expect("array");
    assert_eq!(arr.len(), 1);
    assert_eq!(arr[0]["provider_id"], "p1");
}

#[tokio::test(flavor = "current_thread")]
async fn get_attestation_returns_404_on_unknown_hash() {
    let state = AppState::new(test_config());
    use crate::handlers::get_attestation;
    use axum::extract::{Path, State};
    use axum::response::IntoResponse;
    let response = get_attestation(State(state), Path("not-a-real-hash".to_string()))
        .await
        .into_response();
    assert_eq!(response.status(), axum::http::StatusCode::NOT_FOUND);
}
