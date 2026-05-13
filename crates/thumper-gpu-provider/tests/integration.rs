//! End-to-end sealed inference round-trip under `--features mock-nitro`.
//!
//! Spins up a tiny stub relay over `tokio-tungstenite` that:
//!
//! 1. Accepts the provider's auth frame and replies `{"authenticated":true,...}`.
//! 2. Consumes `ProviderAdvertise` and replies with `ProviderAdvertiseAck`.
//! 3. Consumes `ProviderAttest` and remembers the enclave X25519 + Ed25519
//!    pubs so the test client can address sealed requests to them.
//! 4. As a test client, seals an `InferenceRequestPayload` with
//!    `said-envelope` and sends it as `InferenceRequestSealed`.
//! 5. Awaits the provider's `InferenceResponseSealed`, opens it, and
//!    asserts the receipt verifies + the response text matches the
//!    stub inference runner's canned output.
//!
//! No real Nitro hardware, no real Ollama server — just the wire
//! contract between the provider and the relay.

use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use base64::Engine;
use ed25519_dalek::{SigningKey, Verifier, VerifyingKey};
use futures::{SinkExt, StreamExt};
use rand::RngCore;
use serde_json::json;
use sha2::Digest;
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio_tungstenite::tungstenite::Message;

use said_envelope::{
    did_key_from_verifying, ed25519_signing_to_x25519, ed25519_verifying_to_x25519,
    open as envelope_open, seal as envelope_seal, RecipientKind, SealParams,
};
use thumper_gpu_provider::{relay_ws::associated_data, InferenceRunner, ProviderConfig};
use thumper_types::{
    EnclaveKeyId, Envelope, InferenceChatMessage, InferenceRequestPayload, MessageType,
    ProviderAdvertiseAck, ProviderAttestAckPayload, SealedInferenceRequestPayload,
    SealedInferenceResponsePayload, TeeKind,
};

const STUB_RESPONSE_TEXT: &str = "the answer is 42";

struct StubRunner;

#[async_trait::async_trait]
impl InferenceRunner for StubRunner {
    async fn run(&self, _req: &InferenceRequestPayload) -> Result<String> {
        Ok(STUB_RESPONSE_TEXT.to_string())
    }
}

/// Captured by the stub relay so the test body can address a sealed
/// request at the right enclave keys.
#[derive(Debug, Clone)]
struct CapturedAttest {
    x25519_pub: [u8; 32],
    ed25519_pub: [u8; 32],
}

#[tokio::test]
async fn sealed_round_trip_mock_nitro() -> Result<()> {
    // Bind a TCP listener on an ephemeral port for the stub relay.
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();

    // Channel for the relay to surface what it captured + what it
    // received back as a sealed response.
    let (attest_tx, attest_rx) = oneshot::channel::<CapturedAttest>();
    let (resp_tx, resp_rx) = oneshot::channel::<SealedInferenceResponsePayload>();

    // Test-side wallet — this is who the provider seals its response
    // *back* to. We need its keypair to open the response.
    let mut requester_seed = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut requester_seed);
    let requester_signing = SigningKey::from_bytes(&requester_seed);
    let requester_did = did_key_from_verifying(&requester_signing.verifying_key());

    // Spawn the stub relay.
    let requester_did_for_relay = requester_did.clone();
    let requester_signing_for_relay = requester_signing.clone();
    let relay_handle = tokio::spawn(async move {
        run_stub_relay(
            listener,
            attest_tx,
            resp_tx,
            requester_did_for_relay,
            requester_signing_for_relay,
        )
        .await
        .expect("stub relay loop");
    });

    // Build the provider's config and runtime.
    let mut auth_seed = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut auth_seed);
    let auth_signing = SigningKey::from_bytes(&auth_seed);

    let cfg = ProviderConfig {
        relay_url: format!("ws://127.0.0.1:{port}/ws"),
        auth_signing,
        provider_name: "test-provider".into(),
        models: vec!["llama3:8b".into()],
        max_concurrent: 1,
        wallet_address: "test-wallet".into(),
        allowlist_sig: b"mock-allowlist-sig".to_vec(),
        ollama_url: "http://127.0.0.1:1".into(), // never hit — stub runner used
        tee_kind: TeeKind::None,
    };

    let runner: Arc<dyn InferenceRunner> = Arc::new(StubRunner);

    // Spawn the provider — it runs forever (handshake then serve loop).
    let provider_handle = tokio::spawn({
        let cfg = cfg.clone();
        let runner = runner.clone();
        async move {
            // Ignore the result: the stub relay drops the socket once
            // it has captured the sealed response, which will cause
            // the provider's recv loop to exit.
            let _ = thumper_gpu_provider::run_with_runner(cfg, runner).await;
        }
    });

    // Pull the captured attest, then the sealed response.
    let captured = tokio::time::timeout(Duration::from_secs(10), attest_rx)
        .await
        .expect("timed out waiting for attest")
        .expect("relay dropped attest channel");
    let sealed_resp = tokio::time::timeout(Duration::from_secs(10), resp_rx)
        .await
        .expect("timed out waiting for sealed response")
        .expect("relay dropped response channel");

    // Open the response with the requester's X25519 secret.
    let wire = base64::engine::general_purpose::STANDARD.decode(&sealed_resp.ciphertext_b64)?;
    let requester_x25519_secret = ed25519_signing_to_x25519(&requester_signing);
    let opened = envelope_open(&wire, &requester_x25519_secret)?;

    let parsed: thumper_gpu_provider::InferenceResponseWithReceipt =
        serde_json::from_slice(&opened.plaintext)?;

    assert_eq!(parsed.text, STUB_RESPONSE_TEXT);
    assert!(sealed_resp.is_final);

    // Receipt invariants.
    let r = &parsed.receipt;
    assert_eq!(r.version, 1);
    assert_eq!(r.mode, "private");
    assert_eq!(r.model_id.as_deref(), Some("llama3:8b"));
    assert_eq!(
        r.input_token_hash,
        hex::encode(sha2::Sha256::digest(b"system:you are helpful\nuser:hello\n"))
    );
    assert_eq!(
        r.output_token_hash,
        hex::encode(sha2::Sha256::digest(STUB_RESPONSE_TEXT.as_bytes()))
    );

    // Signature verifies against the enclave Ed25519 pub the relay
    // captured during attest.
    let enclave_vk = VerifyingKey::from_bytes(&captured.ed25519_pub)?;
    let body = canonical_body_json(r);
    let digest = sha2::Sha256::digest(body.as_bytes());
    let sig_bytes = base64::engine::general_purpose::STANDARD.decode(&r.signature)?;
    let sig = ed25519_dalek::Signature::from_slice(&sig_bytes)?;
    enclave_vk
        .verify(&digest, &sig)
        .expect("receipt signature must verify against captured enclave Ed25519 pub");

    // signer_did matches captured Ed25519 pub.
    let signer_vk = said_envelope::verifying_from_did_key(&r.signer_did)?;
    assert_eq!(signer_vk.as_bytes(), &captured.ed25519_pub);

    // enclave_key_id matches the sha256 of the captured X25519 pub.
    let want_key_id = {
        let mut h = sha2::Sha256::new();
        h.update(captured.x25519_pub);
        hex::encode(h.finalize())
    };
    assert_eq!(r.enclave_key_id.as_deref(), Some(want_key_id.as_str()));

    // Clean shutdown.
    provider_handle.abort();
    relay_handle.abort();
    Ok(())
}

/// Re-derive the canonical body JSON the receipt commits to. Must match
/// `receipt::canonical_body_json` exactly — duplicated here so the test
/// is independent of internal serialization helpers.
fn canonical_body_json(r: &thumper_gpu_provider::ReceiptV1) -> String {
    fn esc(s: &str) -> String {
        serde_json::Value::String(s.to_string()).to_string()
    }
    fn maybe(s: &Option<String>) -> String {
        match s {
            Some(v) => esc(v),
            None => "null".into(),
        }
    }
    format!(
        "{{\"version\":1,\"job_id\":{job_id},\"mode\":{mode},\"provider_id\":{provider_id},\
\"model_id\":{model_id},\"input_token_hash\":{ih},\"output_token_hash\":{oh},\
\"issued_at\":{at},\"enclave_key_id\":{eki},\"attestation_hash\":{ah},\
\"measurement\":{ms}}}",
        job_id = esc(&r.job_id),
        mode = esc(&r.mode),
        provider_id = esc(&r.provider_id),
        model_id = match &r.model_id {
            Some(m) => esc(m),
            None => "null".into(),
        },
        ih = esc(&r.input_token_hash),
        oh = esc(&r.output_token_hash),
        at = r.issued_at,
        eki = maybe(&r.enclave_key_id),
        ah = maybe(&r.attestation_hash),
        ms = maybe(&r.measurement),
    )
}

/// Stub relay: accepts the WS upgrade, walks the provider through the
/// handshake, then constructs and sends a sealed inference request.
async fn run_stub_relay(
    listener: TcpListener,
    attest_tx: oneshot::Sender<CapturedAttest>,
    resp_tx: oneshot::Sender<SealedInferenceResponsePayload>,
    requester_did: String,
    requester_signing: SigningKey,
) -> Result<()> {
    let (tcp, _) = listener.accept().await?;
    let ws_stream = tokio_tungstenite::accept_async(tcp).await?;
    let (mut write, mut read) = ws_stream.split();

    // 1. Receive auth payload (we don't bother verifying it — the
    // production relay does, but the round-trip test doesn't care).
    let _auth_frame = read.next().await.ok_or_else(|| anyhow::anyhow!("no auth frame"))??;
    write
        .send(Message::Text(
            json!({"authenticated": true, "role": "gpu_provider"})
                .to_string()
                .into(),
        ))
        .await?;

    // 2. Receive advertise envelope.
    let adv_frame = read.next().await.ok_or_else(|| anyhow::anyhow!("no advertise frame"))??;
    let adv_text = adv_frame.into_text()?;
    let adv_env: Envelope = serde_json::from_str(&adv_text)?;
    match adv_env.message {
        MessageType::ProviderAdvertise(_) => {}
        other => anyhow::bail!("expected ProviderAdvertise, got {other:?}"),
    }
    let ack = Envelope::new(MessageType::ProviderAdvertiseAck(ProviderAdvertiseAck {
        accepted: true,
        message: Some("ok".into()),
    }));
    write
        .send(Message::Text(serde_json::to_string(&ack)?.into()))
        .await?;

    // 3. Receive attest envelope.
    let att_frame = read.next().await.ok_or_else(|| anyhow::anyhow!("no attest frame"))??;
    let att_text = att_frame.into_text()?;
    let att_env: Envelope = serde_json::from_str(&att_text)?;
    let attest = match att_env.message {
        MessageType::ProviderAttest(p) => p,
        other => anyhow::bail!("expected ProviderAttest, got {other:?}"),
    };

    let mut x25519_pub = [0u8; 32];
    x25519_pub.copy_from_slice(&hex::decode(&attest.enclave_x25519_pub_hex)?);
    let mut ed25519_pub = [0u8; 32];
    ed25519_pub.copy_from_slice(&hex::decode(&attest.enclave_ed25519_pub_hex)?);

    let _ = attest_tx.send(CapturedAttest {
        x25519_pub,
        ed25519_pub,
    });

    // Optimistic attest ack (tested code doesn't block on it but the
    // production relay sends one).
    let attest_ack = Envelope::new(MessageType::ProviderAttestAck(ProviderAttestAckPayload {
        accepted: true,
        enclave_key_id: Some(EnclaveKeyId({
            let mut h = sha2::Sha256::new();
            h.update(x25519_pub);
            hex::encode(h.finalize())
        })),
        expires_at: Some((chrono::Utc::now().timestamp()) + 86_400),
        reason: None,
    }));
    write
        .send(Message::Text(serde_json::to_string(&attest_ack)?.into()))
        .await?;

    // 4. Build a sealed inference request to the enclave's X25519 pub.
    let req = InferenceRequestPayload {
        job_id: "test-job".into(),
        model_id: "llama3:8b".into(),
        messages: vec![InferenceChatMessage {
            role: "user".into(),
            content: "hello".into(),
        }],
        system: Some("you are helpful".into()),
        max_tokens: 64,
        stream: false,
        temperature: None,
    };
    let plaintext = serde_json::to_vec(&req)?;

    let enclave_key_id = {
        let mut h = sha2::Sha256::new();
        h.update(x25519_pub);
        EnclaveKeyId(hex::encode(h.finalize()))
    };

    // The provider's `recipient_id` for sealed inference requests is
    // the enclave_key_id (string form). The wire format uses this for
    // HKDF info; the provider opens with its X25519 secret. We seal
    // *from* the requester wallet so the response signer-DID dance has
    // someone to address back to.
    let _ = ed25519_verifying_to_x25519(&requester_signing.verifying_key())?;
    let wire = envelope_seal(SealParams {
        sender: &requester_signing,
        kind: RecipientKind::PeerDid,
        recipient_id: &requester_did, // mirrors the response addressing
        recipient_x25519: x25519_pub.into(),
        associated_data: &associated_data("test-job"),
        plaintext: &plaintext,
    })?;

    // Sanity check: requester can re-open (no, requester is the sender;
    // only the enclave can open). Skip the round-trip self-check.
    let _ = &requester_did;

    let sealed = Envelope::new(MessageType::InferenceRequestSealed(
        SealedInferenceRequestPayload {
            job_id: "test-job".into(),
            enclave_key_id,
            ciphertext_b64: base64::engine::general_purpose::STANDARD.encode(&wire),
        },
    ));
    write
        .send(Message::Text(serde_json::to_string(&sealed)?.into()))
        .await?;

    // Drop write half: we no longer need to send anything. Drain reads
    // until we see the sealed response.
    drop(write);

    while let Some(Ok(msg)) = read.next().await {
        if let Message::Text(text) = msg {
            if let Ok(env) = serde_json::from_str::<Envelope>(&text) {
                if let MessageType::InferenceResponseSealed(p) = env.message {
                    let _ = resp_tx.send(p);
                    return Ok(());
                }
            }
        }
    }
    anyhow::bail!("relay stream closed before sealed response arrived")
}

// `said_envelope::seal` requires the sender to address the recipient by
// X25519 pub directly. The provider's response uses the requester's DID
// for `recipient_id` and derives X25519 from the Ed25519 DID — which
// means the requester DID has to be valid `did:key:zEd25519`. The block
// above already constructs it that way; this comment is a sanity note
// for future maintainers.
