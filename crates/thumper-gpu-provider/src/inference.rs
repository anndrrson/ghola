//! Local inference runner.
//!
//! Calls an Ollama-compatible chat endpoint over HTTP. The enclave
//! reaches its companion model server via a vsock-forwarded TCP port,
//! so from this crate's perspective it's just `http://localhost:11434`
//! (or whatever `OLLAMA_URL` points at).
//!
//! Streaming is deliberately not wired up for the first cut — we accumulate
//! the full response, then seal it back as a single envelope. Track H on
//! the web side already shows an incremental UI, but it does so off the
//! relay's existing SSE channel; sealed streaming chunks are a follow-up
//! once we've measured the per-frame overhead of `seal()`.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use thumper_types::InferenceRequestPayload;

#[derive(Clone)]
pub struct InferenceClient {
    base_url: String,
    http: reqwest::Client,
}

impl InferenceClient {
    pub fn new(base_url: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into(),
            http: reqwest::Client::new(),
        }
    }

    /// Translate an `InferenceRequestPayload` into an Ollama
    /// `/api/chat` request, hit the endpoint, and return the assistant
    /// text. Errors propagate up to the WS dispatcher which will reply
    /// with a sealed error frame (TODO once the relay routes errors —
    /// for now they become `tracing::warn!` log lines).
    pub async fn run(&self, req: &InferenceRequestPayload) -> Result<String> {
        let mut messages: Vec<OllamaMessage> = Vec::with_capacity(req.messages.len() + 1);
        if let Some(sys) = req.system.as_deref() {
            messages.push(OllamaMessage {
                role: "system".to_string(),
                content: sys.to_string(),
            });
        }
        for m in &req.messages {
            messages.push(OllamaMessage {
                role: m.role.clone(),
                content: m.content.clone(),
            });
        }

        let body = OllamaChatRequest {
            model: req.model_id.clone(),
            messages,
            stream: false,
            options: OllamaOptions {
                num_predict: req.max_tokens as i32,
                temperature: req.temperature,
            },
        };

        let url = format!("{}/api/chat", self.base_url.trim_end_matches('/'));
        let resp = self
            .http
            .post(&url)
            .json(&body)
            .send()
            .await
            .with_context(|| format!("inference POST to {url}"))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            anyhow::bail!("inference HTTP {status}: {text}");
        }
        let parsed: OllamaChatResponse = resp
            .json()
            .await
            .with_context(|| "decoding Ollama chat response")?;
        Ok(parsed.message.content)
    }
}

#[derive(Serialize)]
struct OllamaChatRequest {
    model: String,
    messages: Vec<OllamaMessage>,
    stream: bool,
    options: OllamaOptions,
}

#[derive(Serialize)]
struct OllamaOptions {
    num_predict: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f64>,
}

#[derive(Serialize, Deserialize)]
struct OllamaMessage {
    role: String,
    content: String,
}

#[derive(Deserialize)]
struct OllamaChatResponse {
    message: OllamaMessage,
}
