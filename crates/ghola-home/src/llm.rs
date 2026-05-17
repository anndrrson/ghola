use std::pin::Pin;

use futures::StreamExt;

use crate::error::HomeError;

/// Chat message for multi-turn conversations.
#[derive(Clone)]
pub struct ChatMsg {
    pub role: String,
    pub content: String,
}

pub type TextStream =
    Pin<Box<dyn futures::stream::Stream<Item = Result<String, HomeError>> + Send>>;

const OLLAMA_BASE: &str = "http://localhost:11434";

/// Non-streaming generation via Ollama.
pub async fn generate(
    model: &str,
    prompt: &str,
    system: Option<&str>,
) -> Result<String, HomeError> {
    let system_msg = system.unwrap_or("You are a helpful assistant. Be concise and direct.");

    let body = serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system_msg },
            { "role": "user", "content": prompt },
        ],
        "max_tokens": 4096,
    });

    let url = format!("{OLLAMA_BASE}/v1/chat/completions");

    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| HomeError::Internal(format!("Ollama request failed: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let error_body = resp.text().await.unwrap_or_default();
        return Err(HomeError::Internal(format!(
            "Ollama returned {status}: {error_body}"
        )));
    }

    let resp_body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| HomeError::Internal(format!("response parse failed: {e}")))?;

    resp_body["choices"][0]["message"]["content"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or(HomeError::Internal("no content in Ollama response".into()))
}

/// Streaming generation via Ollama (OpenAI-compatible SSE).
pub async fn generate_stream(
    model: &str,
    messages: &[ChatMsg],
    system: Option<&str>,
) -> Result<TextStream, HomeError> {
    let mut msgs: Vec<serde_json::Value> = Vec::new();
    if let Some(sys) = system {
        msgs.push(serde_json::json!({ "role": "system", "content": sys }));
    }
    for m in messages {
        msgs.push(serde_json::json!({ "role": &m.role, "content": &m.content }));
    }

    let body = serde_json::json!({
        "model": model,
        "messages": msgs,
        "max_tokens": 4096,
        "stream": true,
    });

    let url = format!("{OLLAMA_BASE}/v1/chat/completions");

    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| HomeError::Internal(format!("Ollama stream request failed: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let error_body = resp.text().await.unwrap_or_default();
        return Err(HomeError::Internal(format!(
            "Ollama returned {status}: {error_body}"
        )));
    }

    let stream = async_stream::stream! {
        let mut byte_stream = resp.bytes_stream();
        let mut buffer = String::new();

        while let Some(chunk) = byte_stream.next().await {
            match chunk {
                Ok(bytes) => {
                    buffer.push_str(&String::from_utf8_lossy(&bytes));

                    while let Some(pos) = buffer.find('\n') {
                        let line = buffer[..pos].trim().to_string();
                        buffer = buffer[pos + 1..].to_string();

                        if line == "data: [DONE]" {
                            break;
                        }

                        if let Some(data) = line.strip_prefix("data: ") {
                            if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                                if let Some(text) = json["choices"][0]["delta"]["content"].as_str()
                                {
                                    if !text.is_empty() {
                                        yield Ok(text.to_string());
                                    }
                                }
                            }
                        }
                    }
                }
                Err(e) => {
                    yield Err(HomeError::Internal(format!("stream error: {e}")));
                    break;
                }
            }
        }
    };

    Ok(Box::pin(stream))
}
