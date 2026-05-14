//! WebSocket connector that speaks to the relay as a `GpuProvider`.
//!
//! Lifecycle (matches `thumper-relay/src/handlers.rs::handle_ws`):
//!
//! 1. Open `wss://relay/ws`.
//! 2. Send `AuthPayload` (Ed25519-signed canonical bytes, role=gpu_provider).
//! 3. Wait for `{"authenticated": true, "role": "gpu_provider"}`.
//! 4. Send `Envelope { message: ProviderAdvertise(...) }`.
//! 5. Wait for `Envelope { message: ProviderAdvertiseAck { accepted: true } }`.
//! 6. Send `Envelope { message: ProviderAttest(...) }`.
//! 7. Loop: receive envelopes, dispatch `InferenceRequestSealed`.
//!
//! Steps 1–5 mirror what `thumper-cli`'s provider mode does today. Step 6
//! is new for v2 and the relay's `dispatch_inference_sealed` path needs it
//! before it will route sealed requests to this provider.

use std::sync::Arc;

use anyhow::{Context, Result};
use base64::Engine;
use ed25519_dalek::Signer;
use futures::stream::{SplitSink, SplitStream};
use futures::{SinkExt, StreamExt};
use sha2::{Digest, Sha256};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use uuid::Uuid;

use said_envelope::{open as envelope_open, seal as envelope_seal, RecipientKind, SealParams};
use thumper_types::{
    AuthMessage, AuthPayload, ConnectionRole, Envelope, EnclaveKeyId, InferenceRequestPayload,
    MessageType, ProviderAdvertisePayload, ProviderAttestPayload, ProviderModelInfo,
    SealedInferenceRequestPayload, SealedInferenceResponsePayload, TeeKind,
};
use x25519_dalek::PublicKey as X25519Public;

use crate::enclave::EnclaveKeys;
use crate::receipt::{self, InferenceResponseWithReceipt, ReceiptInputs};
use crate::ProviderConfig;

/// Strategy for actually running inference. Boxed so tests can inject
/// a stub (returns canned text) instead of hitting a real Ollama server.
#[async_trait::async_trait]
pub trait InferenceRunner: Send + Sync {
    async fn run(&self, req: &InferenceRequestPayload) -> Result<String>;
}

#[async_trait::async_trait]
impl InferenceRunner for crate::inference::InferenceClient {
    async fn run(&self, req: &InferenceRequestPayload) -> Result<String> {
        self.run(req).await
    }
}

/// All the state a long-lived provider connection holds between the
/// initial handshake and an inference request. Clone is cheap — the
/// keys/runner are Arc-wrapped and the quote/sig are small byte
/// vectors. The reconnect loop in `connect_and_serve` relies on this.
#[derive(Clone)]
pub struct Provider {
    pub cfg: ProviderConfig,
    pub keys: Arc<EnclaveKeys>,
    pub quote: Vec<u8>,
    pub allowlist_sig: Vec<u8>,
    pub runner: Arc<dyn InferenceRunner>,
}

type WsSink = SplitSink<WebSocketStream<MaybeTlsStream<TcpStream>>, Message>;
type WsStream = SplitStream<WebSocketStream<MaybeTlsStream<TcpStream>>>;

impl Provider {
    /// Run the provider forever, reconnecting on any disconnect.
    ///
    /// Render's WS proxy closes idle connections after some interval,
    /// which used to leave the provider's process alive but with a
    /// dead WS — `gpu_providers: 0` on /health and Private mode falls
    /// back to relay-plain until the systemd unit was manually
    /// restarted. The reconnect loop here makes the provider
    /// self-heal: clean disconnect or error, sleep with exponential
    /// backoff (capped at 60s), reconnect, re-attest, keep serving.
    ///
    /// The enclave keypair is stable across reconnects (allocated
    /// once at process start) so `enclave_key_id` and the receipt
    /// signing key stay consistent — clients that cached the
    /// previous enclave info don't need to refetch.
    pub async fn connect_and_serve(self) -> Result<()> {
        let mut backoff = std::time::Duration::from_secs(1);
        let max_backoff = std::time::Duration::from_secs(60);
        loop {
            match self.attempt_once().await {
                Ok(()) => {
                    tracing::info!("provider session ended cleanly; reconnecting in 1s");
                    backoff = std::time::Duration::from_secs(1);
                    tokio::time::sleep(backoff).await;
                }
                Err(err) => {
                    tracing::warn!(
                        error = %err,
                        backoff_ms = backoff.as_millis() as u64,
                        "provider session ended with error; reconnecting after backoff"
                    );
                    tokio::time::sleep(backoff).await;
                    backoff = (backoff * 2).min(max_backoff);
                }
            }
        }
    }

    /// One round of connect + handshake + serve. Returns Ok when the
    /// WS closes cleanly, Err on any handshake or transport failure.
    /// The caller (`connect_and_serve`) loops on either outcome.
    async fn attempt_once(&self) -> Result<()> {
        let (ws_stream, _) = tokio_tungstenite::connect_async(&self.cfg.relay_url)
            .await
            .with_context(|| format!("connecting to {}", self.cfg.relay_url))?;
        tracing::info!(url = %self.cfg.relay_url, "ws connected");

        let (write, read) = ws_stream.split();
        let write = Arc::new(Mutex::new(write));
        let read = Arc::new(Mutex::new(read));

        self.handshake(write.clone(), read.clone()).await?;
        // serve_loop takes `self` by value (it wraps in Arc internally
        // for fan-out to the recv/send tasks). Cheap clone — the heavy
        // state is Arc-wrapped, only the quote/sig get copied.
        self.clone().serve_loop(write, read).await
    }

    async fn handshake(
        &self,
        write: Arc<Mutex<WsSink>>,
        read: Arc<Mutex<WsStream>>,
    ) -> Result<()> {
        // 1. Auth.
        let pubkey_b58 = bs58::encode(self.cfg.auth_signing.verifying_key().as_bytes())
            .into_string();
        let nonce = Uuid::new_v4().to_string();
        let timestamp = (chrono::Utc::now().timestamp_millis() / 1000) as u64;
        let auth_msg = AuthMessage {
            pubkey: pubkey_b58.clone(),
            timestamp,
            nonce,
            role: ConnectionRole::GpuProvider,
        };
        let sig = self.cfg.auth_signing.sign(&auth_msg.canonical_bytes());
        let auth = AuthPayload {
            message: auth_msg,
            signature: base64::engine::general_purpose::STANDARD.encode(sig.to_bytes()),
        };
        send_text(&write, serde_json::to_string(&auth)?).await?;

        // Auth ack — relay sends `{"authenticated": true, "role": ...}` or
        // an `{"error": ...}` frame.
        let ack = recv_text(&read).await?;
        if !ack.contains("\"authenticated\":true") {
            anyhow::bail!("auth rejected: {ack}");
        }
        tracing::info!("authenticated as gpu_provider");

        // 2. Advertise.
        let models: Vec<ProviderModelInfo> = self
            .cfg
            .models
            .iter()
            .map(|m| ProviderModelInfo {
                model_id: m.clone(),
                context_length: 8192,
                price_per_1k_input: 0,
                price_per_1k_output: 0,
            })
            .collect();
        let advertise = Envelope::new(MessageType::ProviderAdvertise(ProviderAdvertisePayload {
            name: self.cfg.provider_name.clone(),
            models,
            vram_mb: 0,
            max_concurrent: self.cfg.max_concurrent,
            wallet_address: self.cfg.wallet_address.clone(),
        }));
        send_text(&write, serde_json::to_string(&advertise)?).await?;

        // Advertise ack.
        let adv_ack = recv_text(&read).await?;
        let env: Envelope = serde_json::from_str(&adv_ack)
            .with_context(|| format!("decoding advertise ack: {adv_ack}"))?;
        match env.message {
            MessageType::ProviderAdvertiseAck(a) if a.accepted => {
                tracing::info!(message = ?a.message, "advertise accepted");
            }
            other => anyhow::bail!("advertise rejected: {:?}", other),
        }

        // 3. Attest.
        let attest = Envelope::new(MessageType::ProviderAttest(ProviderAttestPayload {
            tee_kind: self.cfg.tee_kind,
            enclave_x25519_pub_hex: self.keys.x25519_pub_hex(),
            enclave_ed25519_pub_hex: self.keys.ed25519_pub_hex(),
            vendor_quote_b64: base64::engine::general_purpose::STANDARD.encode(&self.quote),
            ghola_allowlist_sig_b64: base64::engine::general_purpose::STANDARD
                .encode(&self.allowlist_sig),
        }));
        send_text(&write, serde_json::to_string(&attest)?).await?;
        tracing::info!(
            enclave_key_id = %self.keys.enclave_key_id().0,
            "attest sent"
        );
        // We don't block on `ProviderAttestAck` here — the relay can
        // reject the attest later via a typed error envelope; the serve
        // loop logs any non-ack frame that arrives.

        Ok(())
    }

    async fn serve_loop(
        self,
        write: Arc<Mutex<WsSink>>,
        read: Arc<Mutex<WsStream>>,
    ) -> Result<()> {
        // Outbound funnel — keeps sealed responses + heartbeats off the
        // same `Mutex<WsSink>` and lets us drop the lock between sends.
        let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

        let write_for_send = write.clone();
        let send_task = tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                let mut w = write_for_send.lock().await;
                if w.send(msg).await.is_err() {
                    break;
                }
            }
        });

        // Receive task.
        let provider = Arc::new(self);
        let recv_task = {
            let provider = provider.clone();
            let tx = tx.clone();
            tokio::spawn(async move {
                let mut read = read.lock().await;
                while let Some(Ok(msg)) = read.next().await {
                    match msg {
                        Message::Text(text) => {
                            if let Err(e) =
                                provider.clone().handle_text(text.to_string(), tx.clone()).await
                            {
                                tracing::warn!(error = %e, "handle_text failed");
                            }
                        }
                        Message::Ping(p) => {
                            let _ = tx.send(Message::Pong(p));
                        }
                        Message::Close(_) => break,
                        _ => {}
                    }
                }
            })
        };

        let _ = tokio::join!(send_task, recv_task);
        Ok(())
    }

    async fn handle_text(
        self: Arc<Self>,
        text: String,
        tx: mpsc::UnboundedSender<Message>,
    ) -> Result<()> {
        let env: Envelope = serde_json::from_str(&text)?;
        match env.message {
            MessageType::InferenceRequestSealed(p) => {
                let provider = self.clone();
                tokio::spawn(async move {
                    if let Err(e) = provider.handle_sealed(p, tx).await {
                        tracing::warn!(error = %e, "sealed inference failed");
                    }
                });
            }
            MessageType::ProviderAttestAck(ack) => {
                if !ack.accepted {
                    tracing::warn!(reason = ?ack.reason, "attest rejected");
                } else {
                    tracing::info!(
                        enclave_key_id = ?ack.enclave_key_id,
                        expires_at = ?ack.expires_at,
                        "attest accepted"
                    );
                }
            }
            MessageType::Ping => {
                let pong = Envelope::new(MessageType::Pong);
                let _ = tx.send(Message::Text(serde_json::to_string(&pong)?.into()));
            }
            other => {
                tracing::debug!(?other, "ignoring unhandled inbound message");
            }
        }
        Ok(())
    }

    async fn handle_sealed(
        self: Arc<Self>,
        payload: SealedInferenceRequestPayload,
        tx: mpsc::UnboundedSender<Message>,
    ) -> Result<()> {
        let wire = base64::engine::general_purpose::STANDARD
            .decode(&payload.ciphertext_b64)
            .context("base64 decode ciphertext")?;
        let opened = envelope_open(&wire, &self.keys.x25519_secret)
            .context("open sealed inference request")?;

        let req: InferenceRequestPayload = serde_json::from_slice(&opened.plaintext)
            .context("decoding InferenceRequestPayload plaintext")?;

        // The client must address the request to this enclave's key.
        if payload.enclave_key_id != self.keys.enclave_key_id() {
            anyhow::bail!(
                "sealed request enclave_key_id mismatch (got {}, ours {})",
                payload.enclave_key_id.0,
                self.keys.enclave_key_id().0
            );
        }

        // 1. Run inference.
        let response_text = self.runner.run(&req).await.context("running inference")?;

        // 2. Mint receipt.
        let attestation_hash = hex::encode(Sha256::digest(&self.quote));
        // For Nitro the measurement is PCR0||PCR1||PCR2 — under
        // mock-nitro we don't have a real measurement, so use the
        // first 96 hex chars of the attestation hash as a stable
        // placeholder. The relay's TeeKind::None path doesn't validate
        // it; production runs swap to the real measurement extracted
        // by the verifier.
        let measurement = format!("{:0<96}", &attestation_hash);
        let receipt_v1 = receipt::build(
            ReceiptInputs {
                job_id: payload.job_id.clone(),
                provider_id: self.provider_id(),
                req: &req,
                response_text: &response_text,
                enclave_key_id: self.keys.enclave_key_id(),
                attestation_hash,
                measurement,
                issued_at_ms: chrono::Utc::now().timestamp_millis(),
            },
            &self.keys.ed25519_signing,
        )?;

        // 3. Seal the response back to the requester's ephemeral
        // X25519 pub. The request envelope's `ephem_pub` field carries
        // it implicitly — `said-envelope::open` doesn't expose that
        // directly today, so we mirror what the web client does on its
        // side: seal to the requester's *long-lived* X25519, derived
        // from their DID. For peer-DID requests (the production path)
        // that's exactly what said-envelope's `seal_to_peer` provides.
        let response_payload = serde_json::to_vec(&InferenceResponseWithReceipt {
            text: response_text,
            receipt: receipt_v1,
        })?;

        let sealed_bytes = seal_response(
            &self.keys,
            &opened.sender_did,
            &payload.job_id,
            &response_payload,
        )?;

        let response = Envelope::new(MessageType::InferenceResponseSealed(
            SealedInferenceResponsePayload {
                job_id: payload.job_id,
                ciphertext_b64: base64::engine::general_purpose::STANDARD.encode(&sealed_bytes),
                is_final: true,
            },
        ));
        let _ = tx.send(Message::Text(serde_json::to_string(&response)?.into()));
        Ok(())
    }

    fn provider_id(&self) -> String {
        bs58::encode(self.cfg.auth_signing.verifying_key().as_bytes()).into_string()
    }
}

/// Seal a response payload back to the requester. Uses the requester's
/// DID (extracted from the original envelope's `sender_did`) to derive
/// the X25519 recipient key — this mirrors `said-envelope::seal_to_peer`
/// but signs with the enclave's *Ed25519 enclave key* (used for both
/// transport signing and receipt signing in v2) instead of a wallet key.
fn seal_response(
    keys: &EnclaveKeys,
    requester_did: &str,
    job_id: &str,
    plaintext: &[u8],
) -> Result<Vec<u8>> {
    let requester_vk = said_envelope::verifying_from_did_key(requester_did)
        .context("decoding requester DID")?;
    let requester_x25519 =
        said_envelope::ed25519_verifying_to_x25519(&requester_vk).context("Ed25519→X25519")?;

    let ad = associated_data(job_id);
    let sealed = envelope_seal(SealParams {
        sender: &keys.ed25519_signing,
        kind: RecipientKind::PeerDid,
        recipient_id: requester_did,
        recipient_x25519: requester_x25519,
        associated_data: &ad,
        plaintext,
    })
    .context("sealing response envelope")?;
    Ok(sealed)
}

pub fn associated_data(job_id: &str) -> Vec<u8> {
    format!("ghola-sealed-inference-v1;job={job_id}").into_bytes()
}

async fn send_text(write: &Arc<Mutex<WsSink>>, text: String) -> Result<()> {
    let mut w = write.lock().await;
    w.send(Message::Text(text.into())).await?;
    Ok(())
}

async fn recv_text(read: &Arc<Mutex<WsStream>>) -> Result<String> {
    let mut r = read.lock().await;
    loop {
        match r.next().await {
            Some(Ok(Message::Text(t))) => return Ok(t.to_string()),
            Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
            Some(Ok(Message::Close(_))) | None => anyhow::bail!("ws closed"),
            Some(Err(e)) => return Err(anyhow::anyhow!("ws recv: {e}")),
            _ => continue,
        }
    }
}

// Re-exports used by tests & callers that don't want to depend on
// said-envelope directly.
pub use thumper_types::TeeKind as ProviderTeeKind;

/// Helper exposed for tests: hex sha256 of the X25519 pub of a key id.
pub fn enclave_key_id_from_x25519(pub_bytes: &[u8; 32]) -> EnclaveKeyId {
    let mut h = Sha256::new();
    h.update(pub_bytes);
    EnclaveKeyId(hex::encode(h.finalize()))
}

#[allow(dead_code)]
fn _assert_x25519_size(pk: X25519Public) {
    let _: [u8; 32] = *pk.as_bytes();
}

/// Drop-in tee_kind default for the mock build.
pub const DEFAULT_TEE_KIND: TeeKind = TeeKind::None;
