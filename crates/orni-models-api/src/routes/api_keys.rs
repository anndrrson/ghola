use std::sync::Arc;

use axum::extract::{Path, State};
use axum::Json;
use uuid::Uuid;

use crate::auth::Claims;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use orni_models_types::{ApiKey, ApiKeyInfo, CreateApiKeyRequest, CreateApiKeyResponse};

/// POST /api/keys — Generate a new API key for a model
pub async fn create_api_key(
    State(state): State<Arc<AppState>>,
    claims: axum::Extension<Claims>,
    Json(req): Json<CreateApiKeyRequest>,
) -> AppResult<Json<CreateApiKeyResponse>> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("Invalid token".into()))?;

    // Verify model exists and is live
    let model_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM models WHERE id = $1 AND status = 'live')",
    )
    .bind(req.model_id)
    .fetch_one(&state.db)
    .await?;

    if !model_exists {
        return Err(AppError::NotFound("Model not found or not live".into()));
    }

    // Generate a random API key: orn_ + 32 random hex chars
    let raw_key = format!(
        "orn_{}",
        hex::encode(rand::random::<[u8; 16]>())
    );
    let key_prefix = &raw_key[..12];

    // Hash the key for storage
    use sha2::{Digest, Sha256};
    let key_hash = hex::encode(Sha256::digest(raw_key.as_bytes()));

    let api_key = sqlx::query_as::<_, ApiKey>(
        r#"
        INSERT INTO api_keys (id, user_id, model_id, key_hash, key_prefix, name)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *
        "#,
    )
    .bind(Uuid::new_v4())
    .bind(user_id)
    .bind(req.model_id)
    .bind(&key_hash)
    .bind(key_prefix)
    .bind(&req.name)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(CreateApiKeyResponse {
        id: api_key.id,
        key: raw_key,
        key_prefix: api_key.key_prefix,
        name: api_key.name,
        model_id: api_key.model_id,
        created_at: api_key.created_at,
    }))
}

/// GET /api/keys — List user's API keys
pub async fn list_api_keys(
    State(state): State<Arc<AppState>>,
    claims: axum::Extension<Claims>,
) -> AppResult<Json<Vec<ApiKeyInfo>>> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("Invalid token".into()))?;

    let keys = sqlx::query_as::<_, ApiKeyInfo>(
        r#"
        SELECT ak.id, ak.key_prefix, ak.name, ak.model_id,
               m.name as model_name, m.slug as model_slug,
               ak.created_at, ak.last_used_at, ak.is_active
        FROM api_keys ak
        JOIN models m ON m.id = ak.model_id
        WHERE ak.user_id = $1
        ORDER BY ak.created_at DESC
        "#,
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(keys))
}

/// DELETE /api/keys/{id} — Revoke an API key
pub async fn revoke_api_key(
    State(state): State<Arc<AppState>>,
    claims: axum::Extension<Claims>,
    Path(id): Path<Uuid>,
) -> AppResult<Json<serde_json::Value>> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("Invalid token".into()))?;

    let result = sqlx::query(
        "UPDATE api_keys SET is_active = false WHERE id = $1 AND user_id = $2",
    )
    .bind(id)
    .bind(user_id)
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("API key not found".into()));
    }

    Ok(Json(serde_json::json!({ "status": "revoked" })))
}
