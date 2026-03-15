use std::pin::Pin;

use futures::StreamExt;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::CloudError;
use crate::state::AppState;

// ---------------------------------------------------------------------------
// Provider enum & config
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum LlmProvider {
    Anthropic,
    OpenAI,
    Google,
    Groq,
    Together,
    Ollama,
}

impl LlmProvider {
    pub fn default_base_url(&self) -> &str {
        match self {
            LlmProvider::Anthropic => "https://api.anthropic.com",
            LlmProvider::OpenAI => "https://api.openai.com",
            LlmProvider::Google => "https://generativelanguage.googleapis.com",
            LlmProvider::Groq => "https://api.groq.com/openai",
            LlmProvider::Together => "https://api.together.xyz",
            LlmProvider::Ollama => "http://localhost:11434",
        }
    }

    pub fn default_model(&self) -> &str {
        match self {
            LlmProvider::Anthropic => "claude-sonnet-4-20250514",
            LlmProvider::OpenAI => "gpt-4o",
            LlmProvider::Google => "gemini-2.0-flash",
            LlmProvider::Groq => "llama-3.3-70b-versatile",
            LlmProvider::Together => "meta-llama/Llama-3.3-70B-Instruct-Turbo",
            LlmProvider::Ollama => "llama3.2",
        }
    }

    pub fn from_str_loose(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "anthropic" | "claude" => LlmProvider::Anthropic,
            "openai" | "gpt" => LlmProvider::OpenAI,
            "google" | "gemini" => LlmProvider::Google,
            "groq" => LlmProvider::Groq,
            "together" => LlmProvider::Together,
            "ollama" => LlmProvider::Ollama,
            _ => LlmProvider::Anthropic,
        }
    }

    pub fn available_models(&self) -> Vec<&str> {
        match self {
            LlmProvider::Anthropic => vec![
                "claude-sonnet-4-20250514",
                "claude-opus-4-20250514",
                "claude-haiku-4-20250514",
            ],
            LlmProvider::OpenAI => vec![
                "gpt-4o",
                "gpt-4o-mini",
                "gpt-4.1",
                "gpt-4.1-mini",
                "o4-mini",
            ],
            LlmProvider::Google => vec![
                "gemini-2.0-flash",
                "gemini-2.5-pro",
                "gemini-2.5-flash",
            ],
            LlmProvider::Groq => vec![
                "llama-3.3-70b-versatile",
                "llama-3.1-8b-instant",
                "mixtral-8x7b-32768",
            ],
            LlmProvider::Together => vec![
                "meta-llama/Llama-3.3-70B-Instruct-Turbo",
                "meta-llama/Llama-3.1-8B-Instruct-Turbo",
                "mistralai/Mixtral-8x7B-Instruct-v0.1",
            ],
            LlmProvider::Ollama => vec!["llama3.2", "llama3.1", "mistral", "gemma2"],
        }
    }
}

pub struct UserLlmConfig {
    pub provider: LlmProvider,
    pub model: String,
    pub api_key: Option<String>,
    pub base_url: String,
}

/// Chat message for multi-turn streaming conversations.
#[derive(Clone)]
pub struct ChatMsg {
    pub role: String,
    pub content: String,
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

/// Resolve the LLM config for a given user (DB override → server default).
pub async fn get_user_llm_config(
    state: &AppState,
    user_id: Uuid,
) -> Result<UserLlmConfig, CloudError> {
    let row = sqlx::query_as::<_, (Option<String>, Option<String>, Option<Vec<u8>>, Option<String>)>(
        "SELECT llm_provider, llm_model, llm_api_key_encrypted, llm_base_url FROM users WHERE id = $1",
    )
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?;

    if let Some((provider_str, model, encrypted_key, base_url)) = row {
        let provider = provider_str
            .map(|p| LlmProvider::from_str_loose(&p))
            .unwrap_or(LlmProvider::Anthropic);

        let api_key = if let Some(encrypted) = encrypted_key {
            match decrypt_api_key(&encrypted, &state.config.encryption_key) {
                Ok(key) => Some(key),
                Err(e) => {
                    // Decryption failed (e.g. THUMPER_ENCRYPTION_KEY changed on redeploy).
                    // Fall back to server default key so chat still works if CLAUDE_API_KEY is set.
                    tracing::warn!(
                        "failed to decrypt BYOM key for user {user_id}: {e} — falling back to server default"
                    );
                    match provider {
                        LlmProvider::Anthropic => state.config.claude_api_key.clone(),
                        _ => None,
                    }
                }
            }
        } else {
            // Fall back to server key for Anthropic
            match provider {
                LlmProvider::Anthropic => state.config.claude_api_key.clone(),
                _ => None,
            }
        };

        let model = model.unwrap_or_else(|| provider.default_model().to_string());
        let base_url = base_url.unwrap_or_else(|| provider.default_base_url().to_string());

        Ok(UserLlmConfig {
            provider,
            model,
            api_key,
            base_url,
        })
    } else {
        Ok(UserLlmConfig {
            provider: LlmProvider::Anthropic,
            model: "claude-sonnet-4-20250514".to_string(),
            api_key: state.config.claude_api_key.clone(),
            base_url: "https://api.anthropic.com".to_string(),
        })
    }
}

// ---------------------------------------------------------------------------
// Non-streaming generation
// ---------------------------------------------------------------------------

/// Generate text using the user's configured LLM provider.
pub async fn generate(
    state: &AppState,
    user_id: Uuid,
    prompt: &str,
    response_format: Option<&str>,
) -> Result<String, CloudError> {
    let config = get_user_llm_config(state, user_id).await?;

    match config.provider {
        LlmProvider::Anthropic => generate_anthropic(&config, prompt, response_format).await,
        LlmProvider::Google => generate_google(&config, prompt, response_format).await,
        _ => generate_openai_compat(&config, prompt, response_format).await,
    }
}

async fn generate_anthropic(
    config: &UserLlmConfig,
    prompt: &str,
    response_format: Option<&str>,
) -> Result<String, CloudError> {
    let api_key = config
        .api_key
        .as_deref()
        .ok_or(CloudError::ServiceUnavailable("Anthropic API key not configured".into()))?;

    let system = if response_format == Some("json") {
        "You are a helpful assistant. Always respond with valid JSON only, no markdown or extra text."
    } else {
        "You are a helpful assistant. Be concise and direct."
    };

    let body = serde_json::json!({
        "model": &config.model,
        "max_tokens": 4096,
        "system": system,
        "messages": [{ "role": "user", "content": prompt }],
    });

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{}/v1/messages", config.base_url))
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| CloudError::Internal(format!("Anthropic API request failed: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let error_body = resp.text().await.unwrap_or_default();
        return Err(CloudError::Internal(format!(
            "Anthropic API returned {status}: {error_body}"
        )));
    }

    let resp_body: serde_json::Value = resp.json().await.map_err(|e| {
        CloudError::Internal(format!("Anthropic response parse failed: {e}"))
    })?;

    extract_anthropic_text(&resp_body)
}

fn extract_anthropic_text(body: &serde_json::Value) -> Result<String, CloudError> {
    let content = body["content"]
        .as_array()
        .ok_or(CloudError::Internal("no content in Anthropic response".into()))?;

    let text: String = content
        .iter()
        .filter_map(|block| {
            if block["type"].as_str() == Some("text") {
                block["text"].as_str().map(|s| s.to_string())
            } else {
                None
            }
        })
        .collect::<Vec<_>>()
        .join("");

    Ok(text)
}

async fn generate_openai_compat(
    config: &UserLlmConfig,
    prompt: &str,
    response_format: Option<&str>,
) -> Result<String, CloudError> {
    let api_key = config.api_key.as_deref().unwrap_or("");

    let system_msg = if response_format == Some("json") {
        "You are a helpful assistant. Always respond with valid JSON only, no markdown or extra text."
    } else {
        "You are a helpful assistant. Be concise and direct."
    };

    let mut body = serde_json::json!({
        "model": &config.model,
        "messages": [
            { "role": "system", "content": system_msg },
            { "role": "user", "content": prompt },
        ],
        "max_tokens": 4096,
    });

    if response_format == Some("json") {
        body["response_format"] = serde_json::json!({ "type": "json_object" });
    }

    // Ollama doesn't need auth header
    let needs_auth = config.provider != LlmProvider::Ollama;

    let url = if config.provider == LlmProvider::Ollama {
        format!("{}/v1/chat/completions", config.base_url)
    } else {
        format!("{}/v1/chat/completions", config.base_url)
    };

    let client = reqwest::Client::new();
    let mut req = client
        .post(&url)
        .header("content-type", "application/json")
        .json(&body);

    if needs_auth {
        req = req.header("Authorization", format!("Bearer {api_key}"));
    }

    let resp = req
        .send()
        .await
        .map_err(|e| CloudError::Internal(format!("LLM API request failed: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let error_body = resp.text().await.unwrap_or_default();
        return Err(CloudError::Internal(format!(
            "LLM API returned {status}: {error_body}"
        )));
    }

    let resp_body: serde_json::Value = resp.json().await.map_err(|e| {
        CloudError::Internal(format!("LLM response parse failed: {e}"))
    })?;

    resp_body["choices"][0]["message"]["content"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or(CloudError::Internal("no content in LLM response".into()))
}

async fn generate_google(
    config: &UserLlmConfig,
    prompt: &str,
    response_format: Option<&str>,
) -> Result<String, CloudError> {
    let api_key = config
        .api_key
        .as_deref()
        .ok_or(CloudError::ServiceUnavailable("Google API key not configured".into()))?;

    let system_instruction = if response_format == Some("json") {
        Some("Always respond with valid JSON only, no markdown or extra text.")
    } else {
        None
    };

    let mut body = serde_json::json!({
        "contents": [{ "parts": [{ "text": prompt }] }],
        "generationConfig": { "maxOutputTokens": 4096 },
    });

    if let Some(sys) = system_instruction {
        body["systemInstruction"] = serde_json::json!({
            "parts": [{ "text": sys }]
        });
    }

    if response_format == Some("json") {
        body["generationConfig"]["responseMimeType"] = serde_json::json!("application/json");
    }

    let url = format!(
        "{}/v1/models/{}:generateContent?key={}",
        config.base_url, config.model, api_key
    );

    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| CloudError::Internal(format!("Gemini API request failed: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let error_body = resp.text().await.unwrap_or_default();
        return Err(CloudError::Internal(format!(
            "Gemini API returned {status}: {error_body}"
        )));
    }

    let resp_body: serde_json::Value = resp.json().await.map_err(|e| {
        CloudError::Internal(format!("Gemini response parse failed: {e}"))
    })?;

    resp_body["candidates"][0]["content"]["parts"][0]["text"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or(CloudError::Internal("no text in Gemini response".into()))
}

// ---------------------------------------------------------------------------
// Streaming generation (for SSE chat)
// ---------------------------------------------------------------------------

pub type TextStream = Pin<Box<dyn futures::stream::Stream<Item = Result<String, CloudError>> + Send>>;

/// Stream text deltas from the user's configured LLM provider.
pub async fn generate_stream(
    state: &AppState,
    user_id: Uuid,
    messages: &[ChatMsg],
    system: Option<&str>,
) -> Result<TextStream, CloudError> {
    let config = get_user_llm_config(state, user_id).await?;

    match config.provider {
        LlmProvider::Anthropic => stream_anthropic(&config, messages, system).await,
        LlmProvider::Google => stream_google(&config, messages, system).await,
        _ => stream_openai_compat(&config, messages, system).await,
    }
}

async fn stream_anthropic(
    config: &UserLlmConfig,
    messages: &[ChatMsg],
    system: Option<&str>,
) -> Result<TextStream, CloudError> {
    let api_key = config
        .api_key
        .as_deref()
        .ok_or(CloudError::ServiceUnavailable("Anthropic API key not configured".into()))?
        .to_string();

    let msgs: Vec<serde_json::Value> = messages
        .iter()
        .map(|m| serde_json::json!({ "role": &m.role, "content": &m.content }))
        .collect();

    let mut body = serde_json::json!({
        "model": &config.model,
        "max_tokens": 4096,
        "stream": true,
        "messages": msgs,
    });

    if let Some(sys) = system {
        body["system"] = serde_json::Value::String(sys.to_string());
    }

    let base_url = config.base_url.clone();

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{base_url}/v1/messages"))
        .header("x-api-key", &api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| CloudError::Internal(format!("Anthropic stream request failed: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let error_body = resp.text().await.unwrap_or_default();
        return Err(CloudError::Internal(format!(
            "Anthropic API returned {status}: {error_body}"
        )));
    }

    let stream = async_stream::stream! {
        let mut byte_stream = resp.bytes_stream();
        let mut buffer = String::new();

        while let Some(chunk) = byte_stream.next().await {
            match chunk {
                Ok(bytes) => {
                    buffer.push_str(&String::from_utf8_lossy(&bytes));

                    while let Some(pos) = buffer.find("\n\n") {
                        let event_block = buffer[..pos].to_string();
                        buffer = buffer[pos + 2..].to_string();

                        for line in event_block.lines() {
                            if let Some(data) = line.strip_prefix("data: ") {
                                if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                                    if json["type"] == "content_block_delta" {
                                        if let Some(text) = json["delta"]["text"].as_str() {
                                            yield Ok(text.to_string());
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                Err(e) => {
                    yield Err(CloudError::Internal(format!("stream error: {e}")));
                    break;
                }
            }
        }
    };

    Ok(Box::pin(stream))
}

async fn stream_openai_compat(
    config: &UserLlmConfig,
    messages: &[ChatMsg],
    system: Option<&str>,
) -> Result<TextStream, CloudError> {
    let api_key = config.api_key.clone().unwrap_or_default();
    let needs_auth = config.provider != LlmProvider::Ollama;

    let mut msgs: Vec<serde_json::Value> = Vec::new();
    if let Some(sys) = system {
        msgs.push(serde_json::json!({ "role": "system", "content": sys }));
    }
    for m in messages {
        msgs.push(serde_json::json!({ "role": &m.role, "content": &m.content }));
    }

    let body = serde_json::json!({
        "model": &config.model,
        "messages": msgs,
        "max_tokens": 4096,
        "stream": true,
    });

    let url = format!("{}/v1/chat/completions", config.base_url);

    let client = reqwest::Client::new();
    let mut req = client
        .post(&url)
        .header("content-type", "application/json")
        .json(&body);

    if needs_auth {
        req = req.header("Authorization", format!("Bearer {api_key}"));
    }

    let resp = req
        .send()
        .await
        .map_err(|e| CloudError::Internal(format!("LLM stream request failed: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let error_body = resp.text().await.unwrap_or_default();
        return Err(CloudError::Internal(format!(
            "LLM API returned {status}: {error_body}"
        )));
    }

    let stream = async_stream::stream! {
        let mut byte_stream = resp.bytes_stream();
        let mut buffer = String::new();

        while let Some(chunk) = byte_stream.next().await {
            match chunk {
                Ok(bytes) => {
                    buffer.push_str(&String::from_utf8_lossy(&bytes));

                    while let Some(pos) = buffer.find("\n") {
                        let line = buffer[..pos].trim().to_string();
                        buffer = buffer[pos + 1..].to_string();

                        if line == "data: [DONE]" {
                            break;
                        }

                        if let Some(data) = line.strip_prefix("data: ") {
                            if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                                if let Some(text) = json["choices"][0]["delta"]["content"].as_str() {
                                    if !text.is_empty() {
                                        yield Ok(text.to_string());
                                    }
                                }
                            }
                        }
                    }
                }
                Err(e) => {
                    yield Err(CloudError::Internal(format!("stream error: {e}")));
                    break;
                }
            }
        }
    };

    Ok(Box::pin(stream))
}

async fn stream_google(
    config: &UserLlmConfig,
    messages: &[ChatMsg],
    system: Option<&str>,
) -> Result<TextStream, CloudError> {
    let api_key = config
        .api_key
        .as_deref()
        .ok_or(CloudError::ServiceUnavailable("Google API key not configured".into()))?
        .to_string();

    let contents: Vec<serde_json::Value> = messages
        .iter()
        .map(|m| {
            let role = if m.role == "assistant" { "model" } else { "user" };
            serde_json::json!({ "role": role, "parts": [{ "text": &m.content }] })
        })
        .collect();

    let mut body = serde_json::json!({
        "contents": contents,
        "generationConfig": { "maxOutputTokens": 4096 },
    });

    if let Some(sys) = system {
        body["systemInstruction"] = serde_json::json!({
            "parts": [{ "text": sys }]
        });
    }

    let url = format!(
        "{}/v1/models/{}:streamGenerateContent?alt=sse&key={}",
        config.base_url, config.model, api_key
    );

    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| CloudError::Internal(format!("Gemini stream request failed: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let error_body = resp.text().await.unwrap_or_default();
        return Err(CloudError::Internal(format!(
            "Gemini API returned {status}: {error_body}"
        )));
    }

    let stream = async_stream::stream! {
        let mut byte_stream = resp.bytes_stream();
        let mut buffer = String::new();

        while let Some(chunk) = byte_stream.next().await {
            match chunk {
                Ok(bytes) => {
                    buffer.push_str(&String::from_utf8_lossy(&bytes));

                    while let Some(pos) = buffer.find("\n\n") {
                        let event_block = buffer[..pos].to_string();
                        buffer = buffer[pos + 2..].to_string();

                        for line in event_block.lines() {
                            if let Some(data) = line.strip_prefix("data: ") {
                                if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                                    if let Some(text) = json["candidates"][0]["content"]["parts"][0]["text"].as_str() {
                                        if !text.is_empty() {
                                            yield Ok(text.to_string());
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                Err(e) => {
                    yield Err(CloudError::Internal(format!("stream error: {e}")));
                    break;
                }
            }
        }
    };

    Ok(Box::pin(stream))
}

// ---------------------------------------------------------------------------
// Intent classification
// ---------------------------------------------------------------------------

pub struct IntentClassification {
    pub category: String,
    pub confidence: f64,
    pub template_id: Option<String>,
    pub extracted_params: serde_json::Value,
}

/// Classify user input to determine the task type.
pub async fn classify_intent(
    state: &AppState,
    user_id: Uuid,
    user_input: &str,
) -> Result<IntentClassification, CloudError> {
    let prompt = format!(
        r#"Classify this user request into one of these categories:

Request: "{user_input}"

Categories:
- "call" — user wants to make a phone call (book restaurant, schedule appointment, call customer service)
- "email" — user wants to send or draft an email (request refund, follow up, complain, cancel)
- "calendar" — user wants to manage calendar events
- "search" — user wants to search the web
- "device" — user wants to control their phone (open app, tap, type, navigate)
- "chat" — general conversation, question, or request that doesn't fit other categories

Return a JSON object with:
- "category": one of the above
- "confidence": 0.0-1.0
- "template_id": matching template ID if applicable (book_restaurant, schedule_appointment, customer_service, cancel_service, request_refund, follow_up, complaint, cancel_subscription), or null
- "extracted_params": any parameters extracted from the request

Only return JSON, no other text."#
    );

    let result = generate(state, user_id, &prompt, Some("json")).await?;

    let parsed: serde_json::Value = serde_json::from_str(&result).unwrap_or_else(|_| {
        serde_json::json!({
            "category": "chat",
            "confidence": 0.5,
            "template_id": null,
            "extracted_params": {}
        })
    });

    Ok(IntentClassification {
        category: parsed["category"]
            .as_str()
            .unwrap_or("chat")
            .to_string(),
        confidence: parsed["confidence"].as_f64().unwrap_or(0.5),
        template_id: parsed["template_id"].as_str().map(|s| s.to_string()),
        extracted_params: parsed["extracted_params"].clone(),
    })
}

// ---------------------------------------------------------------------------
// Encryption helpers (for user API keys)
// ---------------------------------------------------------------------------

pub fn encrypt_api_key(plaintext: &str, key: &[u8; 32]) -> Result<Vec<u8>, CloudError> {
    use aes_gcm::{
        aead::{Aead, KeyInit},
        Aes256Gcm, Nonce,
    };
    use rand::RngCore;

    let cipher = Aes256Gcm::new(key.into());
    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|e| CloudError::Internal(format!("encryption failed: {e}")))?;

    let mut result = nonce_bytes.to_vec();
    result.extend(ciphertext);
    Ok(result)
}

fn decrypt_api_key(data: &[u8], key: &[u8; 32]) -> Result<String, CloudError> {
    use aes_gcm::{
        aead::{Aead, KeyInit},
        Aes256Gcm, Nonce,
    };

    if data.len() < 12 {
        return Err(CloudError::Internal("encrypted data too short".into()));
    }

    let (nonce_bytes, ciphertext) = data.split_at(12);
    let cipher = Aes256Gcm::new(key.into());
    let nonce = Nonce::from_slice(nonce_bytes);

    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| CloudError::Internal(format!("decryption failed: {e}")))?;

    String::from_utf8(plaintext)
        .map_err(|e| CloudError::Internal(format!("invalid UTF-8 after decrypt: {e}")))
}
