use axum::extract::{Path, State};
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::{generate_api_key, hash_api_key, AuthUser};
use crate::error::CloudError;
use crate::state::AppState;

#[derive(Deserialize)]
pub struct CreateKeyRequest {
    pub name: Option<String>,
    pub scopes: Option<Vec<String>>,
}

#[derive(Serialize)]
pub struct CreateKeyResponse {
    pub id: Uuid,
    pub key: String,
    pub key_prefix: String,
    pub name: String,
    pub scopes: Vec<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Serialize)]
pub struct ApiKeyInfo {
    pub id: Uuid,
    pub key_prefix: String,
    pub name: String,
    pub scopes: Vec<String>,
    pub rate_limit_per_min: Option<i32>,
    pub created_at: DateTime<Utc>,
    pub last_used_at: Option<DateTime<Utc>>,
    pub revoked_at: Option<DateTime<Utc>>,
}

/// POST /api/keys — Create a new API key.
pub async fn create_key(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Json(req): Json<CreateKeyRequest>,
) -> Result<Json<CreateKeyResponse>, CloudError> {
    let name = req.name.unwrap_or_else(|| "Default".to_string());
    let scopes = req.scopes.unwrap_or_else(|| vec!["all".to_string()]);

    let key = generate_api_key();
    let key_hash = hash_api_key(&key);
    let key_prefix = format!("{}...{}", &key[..12], &key[key.len() - 4..]);

    let row = sqlx::query_as::<_, (Uuid, DateTime<Utc>)>(
        r#"
        INSERT INTO api_keys (user_id, key_hash, key_prefix, name, scopes)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, created_at
        "#,
    )
    .bind(claims.sub)
    .bind(&key_hash)
    .bind(&key_prefix)
    .bind(&name)
    .bind(&scopes)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(CreateKeyResponse {
        id: row.0,
        key,
        key_prefix,
        name,
        scopes,
        created_at: row.1,
    }))
}

/// GET /api/keys — List all API keys for the user.
pub async fn list_keys(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
) -> Result<Json<Vec<ApiKeyInfo>>, CloudError> {
    let rows = sqlx::query_as::<_, (Uuid, String, String, Vec<String>, Option<i32>, DateTime<Utc>, Option<DateTime<Utc>>, Option<DateTime<Utc>>)>(
        r#"
        SELECT id, key_prefix, name, scopes, rate_limit_per_min, created_at, last_used_at, revoked_at
        FROM api_keys WHERE user_id = $1
        ORDER BY created_at DESC
        "#,
    )
    .bind(claims.sub)
    .fetch_all(&state.db)
    .await?;

    let keys: Vec<ApiKeyInfo> = rows
        .into_iter()
        .map(|r| ApiKeyInfo {
            id: r.0,
            key_prefix: r.1,
            name: r.2,
            scopes: r.3,
            rate_limit_per_min: r.4,
            created_at: r.5,
            last_used_at: r.6,
            revoked_at: r.7,
        })
        .collect();

    Ok(Json(keys))
}

/// DELETE /api/keys/{id} — Revoke an API key.
pub async fn revoke_key(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Path(key_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, CloudError> {
    let result = sqlx::query(
        "UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL",
    )
    .bind(key_id)
    .bind(claims.sub)
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(CloudError::NotFound("API key not found or already revoked".to_string()));
    }

    Ok(Json(serde_json::json!({ "revoked": true })))
}
