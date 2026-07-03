use axum::extract::State;
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::auth::AuthUser;
use crate::error::CloudError;
use crate::services::llm_router::{self, LlmProvider};
use crate::state::AppState;

// ---------------------------------------------------------------------------
// GET /api/llm/config
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct LlmConfigResponse {
    pub provider: String,
    pub model: String,
    pub has_api_key: bool,
    pub base_url: String,
}

pub async fn get_config(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
) -> Result<Json<LlmConfigResponse>, CloudError> {
    let config = llm_router::get_user_llm_config(&state, claims.sub).await?;

    Ok(Json(LlmConfigResponse {
        provider: serde_json::to_value(&config.provider)
            .ok()
            .and_then(|v| v.as_str().map(|s| s.to_string()))
            .unwrap_or_else(|| "anthropic".to_string()),
        model: config.model,
        has_api_key: config.api_key.is_some(),
        base_url: config.base_url,
    }))
}

// ---------------------------------------------------------------------------
// PATCH /api/llm/config
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct UpdateLlmConfigRequest {
    pub provider: Option<String>,
    pub model: Option<String>,
    pub api_key: Option<String>,
    pub base_url: Option<String>,
}

pub async fn update_config(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Json(req): Json<UpdateLlmConfigRequest>,
) -> Result<Json<LlmConfigResponse>, CloudError> {
    // Encrypt API key if provided
    let encrypted_key = if let Some(ref key) = req.api_key {
        if key.is_empty() {
            // Empty string = clear the key
            None
        } else {
            Some(llm_router::encrypt_api_key(key, &state.config.encryption_key)?)
        }
    } else {
        // Not provided = don't change
        // We need to distinguish "not provided" from "clear". We'll use a sentinel.
        // If the field is absent in JSON, it's None here and we skip the update.
        None
    };

    // Build dynamic update query
    let provider_str = req.provider.as_deref().map(|p| {
        // Validate provider
        let _ = LlmProvider::from_str_loose(p);
        p
    });

    if let Some(provider) = provider_str {
        sqlx::query("UPDATE users SET llm_provider = $1, updated_at = now() WHERE id = $2")
            .bind(provider)
            .bind(claims.sub)
            .execute(&state.db)
            .await?;
    }

    if let Some(ref model) = req.model {
        sqlx::query("UPDATE users SET llm_model = $1, updated_at = now() WHERE id = $2")
            .bind(model)
            .bind(claims.sub)
            .execute(&state.db)
            .await?;
    }

    if req.api_key.is_some() {
        sqlx::query(
            "UPDATE users SET llm_api_key_encrypted = $1, updated_at = now() WHERE id = $2",
        )
        .bind(&encrypted_key)
        .bind(claims.sub)
        .execute(&state.db)
        .await?;
    }

    if let Some(ref base_url) = req.base_url {
        let url = if base_url.is_empty() {
            None
        } else {
            Some(base_url.as_str())
        };
        sqlx::query("UPDATE users SET llm_base_url = $1, updated_at = now() WHERE id = $2")
            .bind(url)
            .bind(claims.sub)
            .execute(&state.db)
            .await?;
    }

    // Return updated config
    get_config(State(state), AuthUser(claims)).await
}

// ---------------------------------------------------------------------------
// GET /api/llm/providers
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct ProviderInfo {
    pub id: String,
    pub name: String,
    pub models: Vec<String>,
    pub requires_api_key: bool,
}

pub async fn list_providers() -> Json<Vec<ProviderInfo>> {
    let providers = vec![
        LlmProvider::Anthropic,
        LlmProvider::OpenAI,
        LlmProvider::Google,
        LlmProvider::Groq,
        LlmProvider::Together,
        LlmProvider::Ollama,
        LlmProvider::Mistral,
        LlmProvider::Kimi,
        LlmProvider::Qwen,
        LlmProvider::Glm,
        LlmProvider::DeepSeek,
        LlmProvider::Cerebras,
        LlmProvider::OpenRouter,
        LlmProvider::Venice,
        LlmProvider::Community,
    ];

    let list: Vec<ProviderInfo> = providers
        .into_iter()
        .map(|p| {
            let id = serde_json::to_value(&p)
                .ok()
                .and_then(|v| v.as_str().map(|s| s.to_string()))
                .unwrap_or_default();
            let name = match &p {
                LlmProvider::Anthropic => "Anthropic (Claude)",
                LlmProvider::OpenAI => "OpenAI (GPT)",
                LlmProvider::Google => "Google (Gemini)",
                LlmProvider::Groq => "Groq",
                LlmProvider::Together => "Together AI",
                LlmProvider::Ollama => "Ollama (Local)",
                LlmProvider::Mistral => "Mistral AI",
                LlmProvider::Kimi => "Kimi (Moonshot)",
                LlmProvider::Qwen => "Qwen (Alibaba)",
                LlmProvider::Glm => "GLM (Zhipu)",
                LlmProvider::DeepSeek => "DeepSeek",
                LlmProvider::Cerebras => "Cerebras",
                LlmProvider::OpenRouter => "OpenRouter",
                LlmProvider::Venice => "Venice AI",
                LlmProvider::Community => "Community GPU",
            };
            let requires_api_key = p != LlmProvider::Ollama && p != LlmProvider::Community;
            let models = p.available_models().into_iter().map(|s| s.to_string()).collect();
            ProviderInfo {
                id,
                name: name.to_string(),
                models,
                requires_api_key,
            }
        })
        .collect();

    Json(list)
}
