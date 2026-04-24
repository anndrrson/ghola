use std::collections::HashMap;
use std::pin::Pin;
use std::sync::Arc;

use futures::StreamExt;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::config::CloudConfig;
use crate::error::CloudError;
use crate::state::AppState;

// ---------------------------------------------------------------------------
// Provider enum & config
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum LlmProvider {
    Anthropic,
    OpenAI,
    Google,
    Groq,
    Together,
    Ollama,
    Mistral,
    Kimi,
    Qwen,
    Glm,
    DeepSeek,
    Cerebras,
    OpenRouter,
    Community,
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
            LlmProvider::Mistral => "https://api.mistral.ai",
            LlmProvider::Kimi => "https://api.moonshot.cn",
            LlmProvider::Qwen => "https://dashscope.aliyuncs.com/compatible-mode",
            LlmProvider::Glm => "https://open.bigmodel.cn/api/paas",
            LlmProvider::DeepSeek => "https://api.deepseek.com",
            LlmProvider::Cerebras => "https://api.cerebras.ai",
            LlmProvider::OpenRouter => "https://openrouter.ai/api",
            LlmProvider::Community => "",
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
            LlmProvider::Mistral => "mistral-large-latest",
            LlmProvider::Kimi => "moonshot-v1-128k",
            LlmProvider::Qwen => "qwen-max",
            LlmProvider::Glm => "glm-4-plus",
            LlmProvider::DeepSeek => "deepseek-chat",
            LlmProvider::Cerebras => "llama-3.3-70b",
            LlmProvider::OpenRouter => "meta-llama/llama-3.3-70b-instruct:free",
            LlmProvider::Community => "community",
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
            "mistral" => LlmProvider::Mistral,
            "kimi" | "moonshot" => LlmProvider::Kimi,
            "qwen" | "alibaba" | "dashscope" => LlmProvider::Qwen,
            "glm" | "zhipu" | "chatglm" => LlmProvider::Glm,
            "deepseek" => LlmProvider::DeepSeek,
            "cerebras" => LlmProvider::Cerebras,
            "openrouter" => LlmProvider::OpenRouter,
            "community" => LlmProvider::Community,
            _ => LlmProvider::Anthropic,
        }
    }

    /// Whether this provider uses the OpenAI-compatible API format.
    pub fn is_openai_compat(&self) -> bool {
        matches!(
            self,
            LlmProvider::OpenAI
                | LlmProvider::Groq
                | LlmProvider::Together
                | LlmProvider::Ollama
                | LlmProvider::Mistral
                | LlmProvider::Kimi
                | LlmProvider::Qwen
                | LlmProvider::Glm
                | LlmProvider::DeepSeek
                | LlmProvider::Cerebras
                | LlmProvider::OpenRouter
        )
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
            LlmProvider::Google => vec!["gemini-2.0-flash", "gemini-2.5-pro", "gemini-2.5-flash"],
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
            LlmProvider::Mistral => vec![
                "mistral-large-latest",
                "mistral-medium-latest",
                "mistral-small-latest",
                "codestral-latest",
            ],
            LlmProvider::Kimi => vec!["moonshot-v1-128k", "moonshot-v1-32k", "moonshot-v1-8k"],
            LlmProvider::Qwen => vec!["qwen-max", "qwen-plus", "qwen-turbo", "qwen-long"],
            LlmProvider::Glm => vec!["glm-4-plus", "glm-4", "glm-4-flash"],
            LlmProvider::DeepSeek => vec!["deepseek-chat", "deepseek-reasoner"],
            LlmProvider::Cerebras => vec!["llama-3.3-70b", "llama-3.1-8b"],
            LlmProvider::OpenRouter => vec![
                "meta-llama/llama-3.3-70b-instruct:free",
                "google/gemma-2-9b-it:free",
                "mistralai/mistral-7b-instruct:free",
            ],
            LlmProvider::Community => vec![],
        }
    }
}

pub struct UserLlmConfig {
    pub provider: LlmProvider,
    pub model: String,
    pub api_key: Option<String>,
    pub base_url: String,
    /// True when config was selected by the free cascade (enables 429 retry).
    pub is_cascade: bool,
}

/// Chat message for multi-turn streaming conversations.
#[derive(Clone)]
pub struct ChatMsg {
    pub role: String,
    pub content: String,
}

// ---------------------------------------------------------------------------
// Free inference cascade
// ---------------------------------------------------------------------------

/// Cascade order: Groq → Cerebras → Google Gemini → OpenRouter.
const CASCADE_ORDER: &[LlmProvider] = &[
    LlmProvider::Groq,
    LlmProvider::Cerebras,
    LlmProvider::Google,
    LlmProvider::OpenRouter,
];

struct FreeCascadeInner {
    /// Providers that have API keys configured (subset of CASCADE_ORDER).
    available: Vec<LlmProvider>,
    /// Daily request counts per provider.
    counts: HashMap<LlmProvider, u32>,
    /// Daily request limits per provider.
    limits: HashMap<LlmProvider, u32>,
    /// Date of last counter reset (UTC).
    last_reset: chrono::NaiveDate,
}

impl FreeCascadeInner {
    fn maybe_reset(&mut self) {
        let today = chrono::Utc::now().date_naive();
        if today > self.last_reset {
            self.counts.clear();
            self.last_reset = today;
        }
    }
}

/// In-memory tracker that rotates free-tier LLM requests across providers.
#[derive(Clone)]
pub struct FreeCascade {
    inner: Arc<Mutex<FreeCascadeInner>>,
}

impl FreeCascade {
    pub fn new(config: &CloudConfig) -> Self {
        let mut available = Vec::new();
        for &provider in CASCADE_ORDER {
            let has_key = match provider {
                LlmProvider::Groq => config.groq_api_key.is_some(),
                LlmProvider::Cerebras => config.cerebras_api_key.is_some(),
                LlmProvider::Google => config.google_gemini_api_key.is_some(),
                LlmProvider::OpenRouter => config.openrouter_api_key.is_some(),
                _ => false,
            };
            if has_key {
                available.push(provider);
            }
        }

        let mut limits = HashMap::new();
        limits.insert(LlmProvider::Groq, 900);
        limits.insert(LlmProvider::Cerebras, 950);
        limits.insert(LlmProvider::Google, 450);
        limits.insert(LlmProvider::OpenRouter, 180);

        Self {
            inner: Arc::new(Mutex::new(FreeCascadeInner {
                available,
                counts: HashMap::new(),
                limits,
                last_reset: chrono::Utc::now().date_naive(),
            })),
        }
    }

    /// Pick the next available free provider under its daily limit.
    pub async fn pick_provider(&self) -> Option<LlmProvider> {
        let mut inner = self.inner.lock().await;
        inner.maybe_reset();

        // Find first provider under its daily limit (immutable scan)
        let found = inner.available.iter().find_map(|&provider| {
            let count = inner.counts.get(&provider).copied().unwrap_or(0);
            let limit = inner.limits.get(&provider).copied().unwrap_or(0);
            if count < limit {
                Some(provider)
            } else {
                None
            }
        });

        // Increment count (mutable, after immutable borrow released)
        if let Some(provider) = found {
            *inner.counts.entry(provider).or_insert(0) += 1;
        }

        found
    }

    /// Mark a provider as exhausted (e.g. after a 429 response).
    pub async fn mark_exhausted(&self, provider: &LlmProvider) {
        let mut inner = self.inner.lock().await;
        if let Some(&limit) = inner.limits.get(provider) {
            inner.counts.insert(provider.clone(), limit);
        }
    }

    /// Return usage stats: provider_name → (used, limit).
    pub async fn stats(&self) -> HashMap<String, (u32, u32)> {
        let inner = self.inner.lock().await;
        let mut out = HashMap::new();
        for &provider in CASCADE_ORDER {
            let count = inner.counts.get(&provider).copied().unwrap_or(0);
            let limit = inner.limits.get(&provider).copied().unwrap_or(0);
            let name = match provider {
                LlmProvider::Groq => "groq",
                LlmProvider::Cerebras => "cerebras",
                LlmProvider::Google => "gemini",
                LlmProvider::OpenRouter => "openrouter",
                _ => continue,
            };
            out.insert(name.to_string(), (count, limit));
        }
        out
    }
}

/// Look up the server-side free-tier API key for a cascade provider.
fn cascade_provider_key(config: &CloudConfig, provider: &LlmProvider) -> Option<String> {
    match provider {
        LlmProvider::Groq => config.groq_api_key.clone(),
        LlmProvider::Cerebras => config.cerebras_api_key.clone(),
        LlmProvider::Google => config.google_gemini_api_key.clone(),
        LlmProvider::OpenRouter => config.openrouter_api_key.clone(),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

/// Resolve the LLM config for a given user (BYOM → free cascade → Claude fallback).
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

        // Try to decrypt BYOM key
        let byom_key = encrypted_key.and_then(|enc| {
            match decrypt_api_key(&enc, &state.config.encryption_key) {
                Ok(key) => Some(key),
                Err(e) => {
                    tracing::warn!(
                        "failed to decrypt BYOM key for user {user_id}: {e} — falling back"
                    );
                    None
                }
            }
        });

        // BYOM user — has their own key, use it as-is
        if byom_key.is_some() {
            return Ok(UserLlmConfig {
                model: model.unwrap_or_else(|| provider.default_model().to_string()),
                base_url: base_url.unwrap_or_else(|| provider.default_base_url().to_string()),
                provider,
                api_key: byom_key,
                is_cascade: false,
            });
        }

        // No BYOM key — only cascade for the default Anthropic fallback path
        match provider {
            LlmProvider::Anthropic => resolve_cascade_or_claude(state, model, base_url).await,
            _ => {
                // Non-Anthropic with no key — BYOM user who hasn't entered key yet
                Ok(UserLlmConfig {
                    model: model.unwrap_or_else(|| provider.default_model().to_string()),
                    base_url: base_url.unwrap_or_else(|| provider.default_base_url().to_string()),
                    provider,
                    api_key: None,
                    is_cascade: false,
                })
            }
        }
    } else {
        // No user row — new user
        resolve_cascade_or_claude(state, None, None).await
    }
}

/// Try free cascade providers, then fall back to CLAUDE_API_KEY.
async fn resolve_cascade_or_claude(
    state: &AppState,
    model: Option<String>,
    base_url: Option<String>,
) -> Result<UserLlmConfig, CloudError> {
    // Try free cascade
    if let Some(cascade_provider) = state.free_cascade.pick_provider().await {
        if let Some(key) = cascade_provider_key(&state.config, &cascade_provider) {
            tracing::debug!(provider = ?cascade_provider, "using free cascade provider");
            return Ok(UserLlmConfig {
                model: cascade_provider.default_model().to_string(),
                base_url: cascade_provider.default_base_url().to_string(),
                provider: cascade_provider,
                api_key: Some(key),
                is_cascade: true,
            });
        }
    }

    // Try community GPU providers
    {
        let cache = state.compute_cache.lock().await;
        if !cache.is_empty() {
            // There are online community providers — use Community provider
            // The actual provider selection happens in generate_community/stream_community
            return Ok(UserLlmConfig {
                provider: LlmProvider::Community,
                model: "community".to_string(),
                api_key: None,
                base_url: String::new(),
                is_cascade: false,
            });
        }
    }

    // Cascade exhausted or unavailable — fall back to CLAUDE_API_KEY
    if let Some(ref claude_key) = state.config.claude_api_key {
        return Ok(UserLlmConfig {
            provider: LlmProvider::Anthropic,
            model: model.unwrap_or_else(|| "claude-sonnet-4-20250514".to_string()),
            api_key: Some(claude_key.clone()),
            base_url: base_url.unwrap_or_else(|| "https://api.anthropic.com".to_string()),
            is_cascade: false,
        });
    }

    Err(CloudError::ServiceUnavailable(
        "No AI model configured".into(),
    ))
}

// ---------------------------------------------------------------------------
// Non-streaming generation
// ---------------------------------------------------------------------------

fn is_rate_limit_error(e: &CloudError) -> bool {
    let msg = e.to_string();
    msg.contains("429") || msg.contains("529") || msg.contains("rate limit")
}

fn dispatch_generate<'a>(
    config: &'a UserLlmConfig,
    prompt: &'a str,
    response_format: Option<&'a str>,
) -> Pin<Box<dyn std::future::Future<Output = Result<String, CloudError>> + Send + 'a>> {
    match config.provider {
        LlmProvider::Anthropic => Box::pin(generate_anthropic(config, prompt, response_format)),
        LlmProvider::Google => Box::pin(generate_google(config, prompt, response_format)),
        _ => Box::pin(generate_openai_compat(config, prompt, response_format)),
    }
}

/// Generate text using the user's configured LLM provider.
/// Automatically retries once with the next cascade provider on 429/529.
pub async fn generate(
    state: &AppState,
    user_id: Uuid,
    prompt: &str,
    response_format: Option<&str>,
) -> Result<String, CloudError> {
    let config = get_user_llm_config(state, user_id).await?;

    // Community provider — special path
    if config.provider == LlmProvider::Community {
        let messages = vec![ChatMsg {
            role: "user".to_string(),
            content: prompt.to_string(),
        }];
        let (text, _model) = generate_community(state, user_id, &messages, None).await?;
        return Ok(text);
    }

    let result = dispatch_generate(&config, prompt, response_format).await;

    // 429 retry for cascade requests
    if config.is_cascade {
        if let Err(ref e) = result {
            if is_rate_limit_error(e) {
                tracing::warn!(provider = ?config.provider, "cascade 429 — marking exhausted and retrying");
                state.free_cascade.mark_exhausted(&config.provider).await;
                if let Some(next) = state.free_cascade.pick_provider().await {
                    if let Some(key) = cascade_provider_key(&state.config, &next) {
                        let retry = UserLlmConfig {
                            model: next.default_model().to_string(),
                            base_url: next.default_base_url().to_string(),
                            provider: next,
                            api_key: Some(key),
                            is_cascade: true,
                        };
                        return dispatch_generate(&retry, prompt, response_format).await;
                    }
                }
            }
        }
    }

    result
}

async fn generate_anthropic(
    config: &UserLlmConfig,
    prompt: &str,
    response_format: Option<&str>,
) -> Result<String, CloudError> {
    let api_key = config
        .api_key
        .as_deref()
        .ok_or(CloudError::ServiceUnavailable(
            "Anthropic API key not configured".into(),
        ))?;

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
        let request_id = upstream_request_id(&resp);
        let error_body = resp.text().await.unwrap_or_default();
        return Err(CloudError::Internal(format!(
            "Anthropic API returned {status}{}: {error_body}",
            request_id
                .map(|id| format!(" (request_id={id})"))
                .unwrap_or_default()
        )));
    }

    let resp_body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| CloudError::Internal(format!("Anthropic response parse failed: {e}")))?;

    extract_anthropic_text(&resp_body)
}

fn extract_anthropic_text(body: &serde_json::Value) -> Result<String, CloudError> {
    let content = body["content"].as_array().ok_or(CloudError::Internal(
        "no content in Anthropic response".into(),
    ))?;

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

fn upstream_request_id(resp: &reqwest::Response) -> Option<String> {
    resp.headers()
        .get("request-id")
        .or_else(|| resp.headers().get("x-request-id"))
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
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

    // OpenRouter requires referrer headers
    if config.provider == LlmProvider::OpenRouter {
        req = req
            .header("HTTP-Referer", "https://ghola.xyz")
            .header("X-Title", "Ghola");
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

    let resp_body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| CloudError::Internal(format!("LLM response parse failed: {e}")))?;

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
        .ok_or(CloudError::ServiceUnavailable(
            "Google API key not configured".into(),
        ))?;

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

    let resp_body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| CloudError::Internal(format!("Gemini response parse failed: {e}")))?;

    resp_body["candidates"][0]["content"]["parts"][0]["text"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or(CloudError::Internal("no text in Gemini response".into()))
}

// ---------------------------------------------------------------------------
// Streaming generation (for SSE chat)
// ---------------------------------------------------------------------------

pub type TextStream =
    Pin<Box<dyn futures::stream::Stream<Item = Result<String, CloudError>> + Send>>;

async fn dispatch_stream(
    config: &UserLlmConfig,
    messages: &[ChatMsg],
    system: Option<&str>,
) -> Result<TextStream, CloudError> {
    match config.provider {
        LlmProvider::Anthropic => stream_anthropic(config, messages, system).await,
        LlmProvider::Google => stream_google(config, messages, system).await,
        _ => stream_openai_compat(config, messages, system).await,
    }
}

/// Stream text deltas from the user's configured LLM provider.
/// Automatically retries once with the next cascade provider on 429/529.
pub async fn generate_stream(
    state: &AppState,
    user_id: Uuid,
    messages: &[ChatMsg],
    system: Option<&str>,
) -> Result<TextStream, CloudError> {
    let config = get_user_llm_config(state, user_id).await?;

    // Community provider — special path
    if config.provider == LlmProvider::Community {
        let (stream, _model) = stream_community(state, user_id, messages, system).await?;
        return Ok(stream);
    }

    let result = dispatch_stream(&config, messages, system).await;

    // 429 retry for cascade requests
    if config.is_cascade {
        if let Err(ref e) = result {
            if is_rate_limit_error(e) {
                tracing::warn!(provider = ?config.provider, "cascade stream 429 — marking exhausted and retrying");
                state.free_cascade.mark_exhausted(&config.provider).await;
                if let Some(next) = state.free_cascade.pick_provider().await {
                    if let Some(key) = cascade_provider_key(&state.config, &next) {
                        let retry = UserLlmConfig {
                            model: next.default_model().to_string(),
                            base_url: next.default_base_url().to_string(),
                            provider: next,
                            api_key: Some(key),
                            is_cascade: true,
                        };
                        return dispatch_stream(&retry, messages, system).await;
                    }
                }
            }
        }
    }

    result
}

async fn stream_anthropic(
    config: &UserLlmConfig,
    messages: &[ChatMsg],
    system: Option<&str>,
) -> Result<TextStream, CloudError> {
    let api_key = config
        .api_key
        .as_deref()
        .ok_or(CloudError::ServiceUnavailable(
            "Anthropic API key not configured".into(),
        ))?
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
        let request_id = upstream_request_id(&resp);
        let error_body = resp.text().await.unwrap_or_default();
        return Err(CloudError::Internal(format!(
            "Anthropic API returned {status}{}: {error_body}",
            request_id
                .map(|id| format!(" (request_id={id})"))
                .unwrap_or_default()
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

    // OpenRouter requires referrer headers
    if config.provider == LlmProvider::OpenRouter {
        req = req
            .header("HTTP-Referer", "https://ghola.xyz")
            .header("X-Title", "Ghola");
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
        .ok_or(CloudError::ServiceUnavailable(
            "Google API key not configured".into(),
        ))?
        .to_string();

    let contents: Vec<serde_json::Value> = messages
        .iter()
        .map(|m| {
            let role = if m.role == "assistant" {
                "model"
            } else {
                "user"
            };
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
- "crypto" — user wants to check wallet balance, send crypto (SOL/USDC), or get their wallet address
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
        category: parsed["category"].as_str().unwrap_or("chat").to_string(),
        confidence: parsed["confidence"].as_f64().unwrap_or(0.5),
        template_id: parsed["template_id"].as_str().map(|s| s.to_string()),
        extracted_params: parsed["extracted_params"].clone(),
    })
}

// ---------------------------------------------------------------------------
// Tool-use generation (for chat with wallet tools)
// ---------------------------------------------------------------------------

/// Result of a non-streaming tool-use generation round.
pub struct ToolUseResult {
    /// Final assistant text to display.
    pub text: String,
    /// Tool calls that were made during the conversation (for SSE events).
    pub tool_calls: Vec<ToolCallEvent>,
}

pub struct ToolCallEvent {
    pub tool_name: String,
    pub status: String,
    pub result: Option<serde_json::Value>,
}

/// Generate a response with tool-use support. Works across all providers:
/// - Anthropic: native tool-use format
/// - OpenAI-compatible (OpenAI, Mistral, Kimi, Qwen, GLM, DeepSeek, Groq, Together, Ollama): OpenAI function calling format
/// - Google: falls back to non-tool text generation with tool descriptions in system prompt
pub async fn generate_with_tools(
    state: &AppState,
    user_id: Uuid,
    messages: &[ChatMsg],
    system: Option<&str>,
    tools: &[serde_json::Value],
) -> Result<ToolUseResult, CloudError> {
    let config = get_user_llm_config(state, user_id).await?;

    match config.provider {
        LlmProvider::Anthropic => {
            generate_with_tools_anthropic(state, user_id, &config, messages, system, tools).await
        }
        LlmProvider::Google => {
            generate_with_tools_google(state, user_id, &config, messages, system, tools).await
        }
        LlmProvider::Community => {
            // Community providers don't support tool-use; fall back to plain generation
            let (text, _model) = generate_community(state, user_id, messages, system).await?;
            Ok(ToolUseResult {
                text,
                tool_calls: vec![],
            })
        }
        _ => generate_with_tools_openai(state, user_id, &config, messages, system, tools).await,
    }
}

/// Anthropic tool-use loop.
async fn generate_with_tools_anthropic(
    state: &AppState,
    user_id: Uuid,
    config: &UserLlmConfig,
    messages: &[ChatMsg],
    system: Option<&str>,
    tools: &[serde_json::Value],
) -> Result<ToolUseResult, CloudError> {
    let api_key = config
        .api_key
        .as_deref()
        .ok_or(CloudError::ServiceUnavailable(
            "API key not configured".into(),
        ))?;

    let mut conversation: Vec<serde_json::Value> = messages
        .iter()
        .map(|m| serde_json::json!({ "role": &m.role, "content": &m.content }))
        .collect();

    let mut tool_calls = Vec::new();

    for _ in 0..5 {
        let mut body = serde_json::json!({
            "model": &config.model,
            "max_tokens": 4096,
            "messages": conversation,
            "tools": tools,
        });
        if let Some(sys) = system {
            body["system"] = serde_json::Value::String(sys.to_string());
        }

        let resp = reqwest::Client::new()
            .post(format!("{}/v1/messages", config.base_url))
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| CloudError::Internal(format!("Anthropic request failed: {e}")))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let request_id = upstream_request_id(&resp);
            let error_body = resp.text().await.unwrap_or_default();
            return Err(CloudError::Internal(format!(
                "Anthropic {status}{}: {error_body}",
                request_id
                    .map(|id| format!(" (request_id={id})"))
                    .unwrap_or_default()
            )));
        }

        let resp_body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| CloudError::Internal(format!("parse failed: {e}")))?;

        let stop_reason = resp_body["stop_reason"].as_str().unwrap_or("");
        let content = resp_body["content"].as_array().cloned().unwrap_or_default();

        if stop_reason == "tool_use" {
            conversation.push(serde_json::json!({ "role": "assistant", "content": content }));

            let mut tool_results = Vec::new();
            for block in &content {
                if block["type"].as_str() == Some("tool_use") {
                    let tool_id = block["id"].as_str().unwrap_or("");
                    let tool_name = block["name"].as_str().unwrap_or("");
                    let tool_input = &block["input"];

                    tool_calls.push(ToolCallEvent {
                        tool_name: tool_name.to_string(),
                        status: "executing".to_string(),
                        result: None,
                    });

                    let result = crate::services::wallet_service::execute_tool(
                        state, user_id, tool_name, tool_input,
                    )
                    .await;

                    match result {
                        Ok(value) => {
                            tool_calls.push(ToolCallEvent {
                                tool_name: tool_name.to_string(),
                                status: "success".to_string(),
                                result: Some(value.clone()),
                            });
                            tool_results.push(serde_json::json!({
                                "type": "tool_result",
                                "tool_use_id": tool_id,
                                "content": serde_json::to_string(&value).unwrap_or_default(),
                            }));
                        }
                        Err(e) => {
                            tool_calls.push(ToolCallEvent {
                                tool_name: tool_name.to_string(),
                                status: "error".to_string(),
                                result: Some(serde_json::json!({ "error": e.to_string() })),
                            });
                            tool_results.push(serde_json::json!({
                                "type": "tool_result",
                                "tool_use_id": tool_id,
                                "is_error": true,
                                "content": e.to_string(),
                            }));
                        }
                    }
                }
            }

            conversation.push(serde_json::json!({ "role": "user", "content": tool_results }));
        } else {
            let text: String = content
                .iter()
                .filter_map(|b| {
                    if b["type"].as_str() == Some("text") {
                        b["text"].as_str().map(|s| s.to_string())
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>()
                .join("");
            return Ok(ToolUseResult { text, tool_calls });
        }
    }

    Err(CloudError::Internal(
        "tool-use loop exceeded max rounds".into(),
    ))
}

/// OpenAI-compatible tool-use loop.
/// Works with: OpenAI, Mistral, Kimi/Moonshot, Qwen, GLM/Zhipu, DeepSeek, Groq, Together, Ollama.
async fn generate_with_tools_openai(
    state: &AppState,
    user_id: Uuid,
    config: &UserLlmConfig,
    messages: &[ChatMsg],
    system: Option<&str>,
    tools: &[serde_json::Value],
) -> Result<ToolUseResult, CloudError> {
    let api_key = config.api_key.clone().unwrap_or_default();
    let needs_auth = config.provider != LlmProvider::Ollama;

    // Convert Anthropic tool format → OpenAI function calling format
    let openai_tools: Vec<serde_json::Value> = tools
        .iter()
        .map(|t| {
            serde_json::json!({
                "type": "function",
                "function": {
                    "name": t["name"],
                    "description": t["description"],
                    "parameters": t["input_schema"],
                }
            })
        })
        .collect();

    let mut conversation: Vec<serde_json::Value> = Vec::new();
    if let Some(sys) = system {
        conversation.push(serde_json::json!({ "role": "system", "content": sys }));
    }
    for m in messages {
        conversation.push(serde_json::json!({ "role": &m.role, "content": &m.content }));
    }

    let mut tool_calls_out = Vec::new();

    for _ in 0..5 {
        let body = serde_json::json!({
            "model": &config.model,
            "messages": conversation,
            "tools": openai_tools,
            "max_tokens": 4096,
        });

        let url = format!("{}/v1/chat/completions", config.base_url);
        let mut req = reqwest::Client::new()
            .post(&url)
            .header("content-type", "application/json")
            .json(&body);

        if needs_auth {
            req = req.header("Authorization", format!("Bearer {api_key}"));
        }

        // OpenRouter requires referrer headers
        if config.provider == LlmProvider::OpenRouter {
            req = req
                .header("HTTP-Referer", "https://ghola.xyz")
                .header("X-Title", "Ghola");
        }

        let resp = req
            .send()
            .await
            .map_err(|e| CloudError::Internal(format!("LLM request failed: {e}")))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let error_body = resp.text().await.unwrap_or_default();
            return Err(CloudError::Internal(format!("LLM {status}: {error_body}")));
        }

        let resp_body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| CloudError::Internal(format!("parse failed: {e}")))?;

        let choice = &resp_body["choices"][0];
        let message = &choice["message"];
        let finish_reason = choice["finish_reason"].as_str().unwrap_or("");

        // Check for tool calls
        let has_tool_calls = message
            .get("tool_calls")
            .and_then(|tc| tc.as_array())
            .map_or(false, |tc| !tc.is_empty());

        if has_tool_calls || finish_reason == "tool_calls" {
            // Add assistant message with tool_calls to conversation
            conversation.push(message.clone());

            let tc_array = message["tool_calls"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            for tc in &tc_array {
                let call_id = tc["id"].as_str().unwrap_or("");
                let func = &tc["function"];
                let tool_name = func["name"].as_str().unwrap_or("");
                let arguments_str = func["arguments"].as_str().unwrap_or("{}");

                tool_calls_out.push(ToolCallEvent {
                    tool_name: tool_name.to_string(),
                    status: "executing".to_string(),
                    result: None,
                });

                let tool_input: serde_json::Value =
                    serde_json::from_str(arguments_str).unwrap_or(serde_json::json!({}));

                let result = crate::services::wallet_service::execute_tool(
                    state,
                    user_id,
                    tool_name,
                    &tool_input,
                )
                .await;

                match result {
                    Ok(value) => {
                        tool_calls_out.push(ToolCallEvent {
                            tool_name: tool_name.to_string(),
                            status: "success".to_string(),
                            result: Some(value.clone()),
                        });
                        conversation.push(serde_json::json!({
                            "role": "tool",
                            "tool_call_id": call_id,
                            "content": serde_json::to_string(&value).unwrap_or_default(),
                        }));
                    }
                    Err(e) => {
                        tool_calls_out.push(ToolCallEvent {
                            tool_name: tool_name.to_string(),
                            status: "error".to_string(),
                            result: Some(serde_json::json!({ "error": e.to_string() })),
                        });
                        conversation.push(serde_json::json!({
                            "role": "tool",
                            "tool_call_id": call_id,
                            "content": format!("Error: {e}"),
                        }));
                    }
                }
            }
        } else {
            // Final text response
            let text = message["content"].as_str().unwrap_or("").to_string();
            return Ok(ToolUseResult {
                text,
                tool_calls: tool_calls_out,
            });
        }
    }

    Err(CloudError::Internal(
        "tool-use loop exceeded max rounds".into(),
    ))
}

/// Google Gemini tool-use loop.
async fn generate_with_tools_google(
    state: &AppState,
    user_id: Uuid,
    config: &UserLlmConfig,
    messages: &[ChatMsg],
    system: Option<&str>,
    tools: &[serde_json::Value],
) -> Result<ToolUseResult, CloudError> {
    let api_key = config
        .api_key
        .as_deref()
        .ok_or(CloudError::ServiceUnavailable(
            "Google API key not configured".into(),
        ))?;

    // Convert Anthropic tool format → Gemini function declarations
    let function_declarations: Vec<serde_json::Value> = tools
        .iter()
        .map(|t| {
            serde_json::json!({
                "name": t["name"],
                "description": t["description"],
                "parameters": t["input_schema"],
            })
        })
        .collect();

    let contents: Vec<serde_json::Value> = messages
        .iter()
        .map(|m| {
            let role = if m.role == "assistant" {
                "model"
            } else {
                "user"
            };
            serde_json::json!({ "role": role, "parts": [{ "text": &m.content }] })
        })
        .collect();

    let mut conversation = contents;
    let mut tool_calls_out = Vec::new();

    for _ in 0..5 {
        let mut body = serde_json::json!({
            "contents": conversation,
            "tools": [{ "functionDeclarations": function_declarations }],
            "generationConfig": { "maxOutputTokens": 4096 },
        });

        if let Some(sys) = system {
            body["systemInstruction"] = serde_json::json!({ "parts": [{ "text": sys }] });
        }

        let url = format!(
            "{}/v1/models/{}:generateContent?key={}",
            config.base_url, config.model, api_key
        );

        let resp = reqwest::Client::new()
            .post(&url)
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| CloudError::Internal(format!("Gemini request failed: {e}")))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let error_body = resp.text().await.unwrap_or_default();
            return Err(CloudError::Internal(format!(
                "Gemini {status}: {error_body}"
            )));
        }

        let resp_body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| CloudError::Internal(format!("parse failed: {e}")))?;

        let parts = resp_body["candidates"][0]["content"]["parts"]
            .as_array()
            .cloned()
            .unwrap_or_default();

        // Check for function calls
        let function_calls: Vec<&serde_json::Value> = parts
            .iter()
            .filter(|p| p.get("functionCall").is_some())
            .collect();

        if !function_calls.is_empty() {
            // Add model response to conversation
            conversation.push(serde_json::json!({
                "role": "model",
                "parts": parts,
            }));

            let mut response_parts = Vec::new();
            for fc in &function_calls {
                let fc_obj = &fc["functionCall"];
                let tool_name = fc_obj["name"].as_str().unwrap_or("");
                let tool_args = &fc_obj["args"];

                tool_calls_out.push(ToolCallEvent {
                    tool_name: tool_name.to_string(),
                    status: "executing".to_string(),
                    result: None,
                });

                let result = crate::services::wallet_service::execute_tool(
                    state, user_id, tool_name, tool_args,
                )
                .await;

                match result {
                    Ok(value) => {
                        tool_calls_out.push(ToolCallEvent {
                            tool_name: tool_name.to_string(),
                            status: "success".to_string(),
                            result: Some(value.clone()),
                        });
                        response_parts.push(serde_json::json!({
                            "functionResponse": {
                                "name": tool_name,
                                "response": value,
                            }
                        }));
                    }
                    Err(e) => {
                        tool_calls_out.push(ToolCallEvent {
                            tool_name: tool_name.to_string(),
                            status: "error".to_string(),
                            result: Some(serde_json::json!({ "error": e.to_string() })),
                        });
                        response_parts.push(serde_json::json!({
                            "functionResponse": {
                                "name": tool_name,
                                "response": { "error": e.to_string() },
                            }
                        }));
                    }
                }
            }

            conversation.push(serde_json::json!({
                "role": "user",
                "parts": response_parts,
            }));
        } else {
            // Final text response
            let text: String = parts
                .iter()
                .filter_map(|p| p["text"].as_str())
                .collect::<Vec<_>>()
                .join("");
            return Ok(ToolUseResult {
                text,
                tool_calls: tool_calls_out,
            });
        }
    }

    Err(CloudError::Internal(
        "tool-use loop exceeded max rounds".into(),
    ))
}

// ---------------------------------------------------------------------------
// Community GPU provider generation
// ---------------------------------------------------------------------------

/// Generate text using a community GPU provider (non-streaming).
pub async fn generate_community(
    state: &AppState,
    user_id: Uuid,
    messages: &[ChatMsg],
    system: Option<&str>,
) -> Result<(String, String), CloudError> {
    // Returns (text, model_id) so chat.rs can emit provider info
    use crate::services::compute_service;

    // Select best provider
    let provider = compute_service::select_provider(state, "community", None).await?;

    // Create escrow
    let estimated_cost = 100; // 100 micro-USDC estimate
    let escrow_id = compute_service::create_escrow(
        &state.db,
        user_id,
        Some(provider.provider_id),
        estimated_cost,
    )
    .await?;

    // Create job
    let job_id = compute_service::create_job(
        &state.db,
        user_id,
        provider.provider_id,
        escrow_id,
        &provider.model_id,
    )
    .await?;

    // Build inference messages as JSON
    let inference_msgs: Vec<serde_json::Value> = messages
        .iter()
        .map(|m| {
            serde_json::json!({
                "role": m.role,
                "content": m.content,
            })
        })
        .collect();
    let messages_json = serde_json::Value::Array(inference_msgs);

    // Dispatch to relay
    let result = compute_service::dispatch_inference(
        state,
        &provider.relay_pubkey,
        &messages_json,
        system,
        &provider.model_id,
        2048,
        &job_id.to_string(),
    )
    .await;

    match result {
        Ok(inference_result) => {
            // Validate response
            let quality = compute_service::validate_response(&inference_result.text, 10);

            // Complete job
            let _ = compute_service::complete_job(
                &state.db,
                job_id,
                inference_result.input_tokens as i64,
                inference_result.output_tokens as i64,
                inference_result.latency_ms as i64,
                quality.score,
            )
            .await;

            // Settle escrow
            let settle_result = compute_service::settle_escrow(
                &state.db,
                &state.config.usage_receipt_secret,
                escrow_id,
                inference_result.input_tokens as i64,
                inference_result.output_tokens as i64,
                provider.price_per_1k_input,
                provider.price_per_1k_output,
            )
            .await;

            // Update daily stats
            if let Ok(ref settlement) = settle_result {
                let _ = compute_service::update_daily_stats(
                    &state.db,
                    provider.provider_id,
                    true,
                    inference_result.input_tokens as i64 + inference_result.output_tokens as i64,
                    settlement.provider_amount,
                    inference_result.latency_ms as f64,
                )
                .await;
            }

            // Update reputation
            let _ = compute_service::update_reputation(
                &state.db,
                provider.provider_id,
                true,
                Some(inference_result.latency_ms as i64),
            )
            .await;

            Ok((inference_result.text, provider.model_id))
        }
        Err(e) => {
            // Refund escrow on failure
            let _ = compute_service::refund_escrow(&state.db, escrow_id).await;
            let _ = compute_service::fail_job(&state.db, job_id, &e.to_string()).await;
            let _ =
                compute_service::update_reputation(&state.db, provider.provider_id, false, None)
                    .await;
            let _ = compute_service::update_daily_stats(
                &state.db,
                provider.provider_id,
                false,
                0,
                0,
                0.0,
            )
            .await;
            Err(e)
        }
    }
}

/// Stream text using a community GPU provider.
pub async fn stream_community(
    state: &AppState,
    user_id: Uuid,
    messages: &[ChatMsg],
    system: Option<&str>,
) -> Result<(TextStream, String), CloudError> {
    // Returns (stream, model_id)
    use crate::services::compute_service;

    let provider = compute_service::select_provider(state, "community", None).await?;
    let estimated_cost = 100;
    let escrow_id = compute_service::create_escrow(
        &state.db,
        user_id,
        Some(provider.provider_id),
        estimated_cost,
    )
    .await?;
    let job_id = compute_service::create_job(
        &state.db,
        user_id,
        provider.provider_id,
        escrow_id,
        &provider.model_id,
    )
    .await?;

    let inference_msgs: Vec<serde_json::Value> = messages
        .iter()
        .map(|m| {
            serde_json::json!({
                "role": m.role,
                "content": m.content,
            })
        })
        .collect();
    let messages_json = serde_json::Value::Array(inference_msgs);

    let text_stream = compute_service::dispatch_inference_stream(
        state,
        &provider.relay_pubkey,
        &messages_json,
        system,
        &provider.model_id,
        2048,
        &job_id.to_string(),
    )
    .await?;

    // Wrap the stream to handle escrow settlement on completion
    let model_id = provider.model_id.clone();
    let db = state.db.clone();
    let provider_id = provider.provider_id;
    let price_input = provider.price_per_1k_input;
    let price_output = provider.price_per_1k_output;
    let usage_receipt_secret = state.config.usage_receipt_secret.clone();

    // For streaming, we settle after the stream ends. We can't know exact token counts
    // from the stream, so we estimate. The relay's InferenceStreamEnd would have them
    // but that's not easily accessible from here. Use a rough estimate.
    let wrapped = async_stream::stream! {
        let mut char_count = 0u64;
        let mut had_error = false;
        let mut pinned = std::pin::Pin::from(text_stream);
        while let Some(chunk) = futures::StreamExt::next(&mut pinned).await {
            match &chunk {
                Ok(text) => char_count += text.len() as u64,
                Err(_) => had_error = true,
            }
            yield chunk;
        }

        if had_error {
            let _ = compute_service::fail_job(&db, job_id, "stream error").await;
            let _ = compute_service::refund_escrow(&db, escrow_id).await;
            let _ = compute_service::update_reputation(&db, provider_id, false, None).await;
            let _ = compute_service::update_daily_stats(
                &db, provider_id, false, 0, 0, 0.0,
            ).await;
        } else {
            // Estimate tokens from chars (rough: 4 chars per token)
            let est_output_tokens = (char_count / 4).max(1) as i64;
            let est_input_tokens = 500i64; // rough estimate

            let _ = compute_service::complete_job(
                &db, job_id, est_input_tokens, est_output_tokens, 0i64, 0.8,
            ).await;
            let settle_result = compute_service::settle_escrow(
                &db,
                &usage_receipt_secret,
                escrow_id,
                est_input_tokens,
                est_output_tokens,
                price_input,
                price_output,
            ).await;
            if let Ok(ref settlement) = settle_result {
                let _ = compute_service::update_daily_stats(
                    &db, provider_id, true,
                    est_input_tokens + est_output_tokens,
                    settlement.provider_amount,
                    0.0,
                ).await;
            } else {
                let _ = compute_service::update_daily_stats(
                    &db, provider_id, false, 0, 0, 0.0,
                ).await;
            }
            let _ = compute_service::update_reputation(&db, provider_id, true, None).await;
        }
    };

    Ok((Box::pin(wrapped), model_id))
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

pub fn decrypt_api_key(data: &[u8], key: &[u8; 32]) -> Result<String, CloudError> {
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
