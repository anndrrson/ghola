use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Extension;
use axum::Json;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::Claims;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

// ── Request Types ──

#[derive(Debug, Deserialize)]
pub struct ShareCredentialRequest {
    pub recipient_did: String,
    pub encrypted_payload: String,
    pub label: String,
    pub capability_required: Option<String>,
    pub expires_in_seconds: i64,
    pub max_accesses: Option<i32>,
}

#[derive(Debug, Deserialize)]
pub struct AcceptCredentialRequest {
    pub ucan_token: Option<String>,
}

// ── Response Types ──

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct SharedCredentialResponse {
    pub id: Uuid,
    pub owner_did: String,
    pub recipient_did: String,
    pub label: String,
    pub capability_required: String,
    pub expires_at: chrono::DateTime<chrono::Utc>,
    pub accessed_count: i32,
    pub max_accesses: Option<i32>,
    pub revoked: bool,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Serialize)]
pub struct AcceptedCredentialResponse {
    pub id: Uuid,
    pub label: String,
    pub encrypted_payload: String,
    pub owner_did: String,
}

// ── Helpers ──

fn get_user_did_query() -> &'static str {
    "SELECT COALESCE(
        (SELECT did FROM business_profiles WHERE user_id = $1),
        (SELECT did FROM public_profiles WHERE user_id = $1),
        ''
    )"
}

// ── Handlers ──

/// POST /v1/credentials/share (JWT protected)
pub async fn share_credential(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Json(req): Json<ShareCredentialRequest>,
) -> AppResult<(StatusCode, Json<SharedCredentialResponse>)> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("Invalid token".into()))?;

    let owner_did: String = sqlx::query_scalar(get_user_did_query())
        .bind(user_id)
        .fetch_one(&state.db)
        .await?;

    if owner_did.is_empty() {
        return Err(AppError::BadRequest("No DID found".into()));
    }

    if req.expires_in_seconds <= 0 || req.expires_in_seconds > 365 * 24 * 3600 {
        return Err(AppError::BadRequest(
            "expires_in_seconds must be 1 to 31536000".into(),
        ));
    }

    let expires_at = chrono::Utc::now() + chrono::Duration::seconds(req.expires_in_seconds);
    let cap = req
        .capability_required
        .unwrap_or_else(|| "said/read_secrets".into());

    let cred = sqlx::query_as::<_, SharedCredentialResponse>(
        r#"INSERT INTO shared_credentials
            (owner_did, recipient_did, encrypted_payload, label, capability_required, expires_at, max_accesses)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id, owner_did, recipient_did, label, capability_required, expires_at, accessed_count, max_accesses, revoked, created_at"#,
    )
    .bind(&owner_did)
    .bind(&req.recipient_did)
    .bind(&req.encrypted_payload)
    .bind(&req.label)
    .bind(&cap)
    .bind(expires_at)
    .bind(req.max_accesses)
    .fetch_one(&state.db)
    .await?;

    Ok((StatusCode::CREATED, Json(cred)))
}

/// GET /v1/credentials/inbox (JWT protected)
pub async fn inbox(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
) -> AppResult<Json<Vec<SharedCredentialResponse>>> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("Invalid token".into()))?;

    let my_did: String = sqlx::query_scalar(get_user_did_query())
        .bind(user_id)
        .fetch_one(&state.db)
        .await?;

    let creds = sqlx::query_as::<_, SharedCredentialResponse>(
        r#"SELECT id, owner_did, recipient_did, label, capability_required, expires_at,
                  accessed_count, max_accesses, revoked, created_at
        FROM shared_credentials
        WHERE recipient_did = $1 AND NOT revoked AND expires_at > NOW()
        ORDER BY created_at DESC"#,
    )
    .bind(&my_did)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(creds))
}

/// POST /v1/credentials/accept/{id} (JWT protected)
pub async fn accept_credential(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<Uuid>,
    Json(_req): Json<AcceptCredentialRequest>,
) -> AppResult<Json<AcceptedCredentialResponse>> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("Invalid token".into()))?;

    let my_did: String = sqlx::query_scalar(get_user_did_query())
        .bind(user_id)
        .fetch_one(&state.db)
        .await?;

    // Fetch the credential
    let cred: Option<(Uuid, String, String, String, i32, Option<i32>, bool)> = sqlx::query_as(
        r#"SELECT id, owner_did, label, encrypted_payload, accessed_count, max_accesses, revoked
        FROM shared_credentials WHERE id = $1 AND recipient_did = $2"#,
    )
    .bind(id)
    .bind(&my_did)
    .fetch_optional(&state.db)
    .await?;

    let (cred_id, owner_did, label, encrypted_payload, accessed, max, revoked) = cred
        .ok_or_else(|| AppError::NotFound("Credential not found or not shared with you".into()))?;

    if revoked {
        return Err(AppError::BadRequest("Credential has been revoked".into()));
    }

    if let Some(max_accesses) = max {
        if accessed >= max_accesses {
            return Err(AppError::BadRequest("Maximum access count reached".into()));
        }
    }

    // Increment access count
    sqlx::query("UPDATE shared_credentials SET accessed_count = accessed_count + 1 WHERE id = $1")
        .bind(cred_id)
        .execute(&state.db)
        .await?;

    Ok(Json(AcceptedCredentialResponse {
        id: cred_id,
        label,
        encrypted_payload,
        owner_did,
    }))
}

/// POST /v1/credentials/revoke/{id} (JWT protected)
pub async fn revoke_credential(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<Uuid>,
) -> AppResult<StatusCode> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("Invalid token".into()))?;

    let my_did: String = sqlx::query_scalar(get_user_did_query())
        .bind(user_id)
        .fetch_one(&state.db)
        .await?;

    let result = sqlx::query(
        "UPDATE shared_credentials SET revoked = true WHERE id = $1 AND owner_did = $2",
    )
    .bind(id)
    .bind(&my_did)
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(
            "Credential not found or not owned by you".into(),
        ));
    }

    Ok(StatusCode::NO_CONTENT)
}
