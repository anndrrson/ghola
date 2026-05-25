use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Extension;
use axum::Json;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use base64::Engine;

use crate::auth::Claims;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

// ── Request Types ──

#[derive(Debug, Deserialize)]
pub struct GrantRequest {
    pub audience_did: String,
    pub capabilities: Vec<String>,
    pub expires_in_seconds: i64,
    pub parent_token: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct RevokeRequest {
    pub token_hash: String,
    pub reason: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CheckQuery {
    pub token_hash: String,
}

#[derive(Debug, Deserialize)]
pub struct VerifyChainRequest {
    pub ucan_token: String,
}

#[derive(Debug, Deserialize)]
pub struct GrantsQuery {
    pub page: Option<i64>,
    pub limit: Option<i64>,
    pub active_only: Option<bool>,
}

// ── Response Types ──

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct GrantResponse {
    pub id: Uuid,
    pub issuer_did: String,
    pub audience_did: String,
    pub capabilities: Vec<String>,
    pub token_hash: String,
    pub parent_token_hash: Option<String>,
    pub expires_at: chrono::DateTime<chrono::Utc>,
    pub revoked: bool,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Serialize)]
pub struct GrantCreatedResponse {
    pub id: Uuid,
    pub token_hash: String,
    pub audience_did: String,
    pub capabilities: Vec<String>,
    pub expires_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Serialize)]
pub struct ChainVerifyResponse {
    pub valid: bool,
    pub issuer_did: Option<String>,
    pub audience_did: Option<String>,
    pub capabilities: Vec<String>,
    pub chain_length: usize,
    pub revoked_at_level: Option<usize>,
    pub error: Option<String>,
}

fn sha256_hex(input: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    hex::encode(hasher.finalize())
}

// ── Handlers ──

/// POST /v1/delegation/grant (JWT protected)
pub async fn create_grant(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Json(req): Json<GrantRequest>,
) -> AppResult<(StatusCode, Json<GrantCreatedResponse>)> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("Invalid token".into()))?;

    // Get issuer DID
    let issuer_did: String = sqlx::query_scalar(
        "SELECT COALESCE(
            (SELECT did FROM business_profiles WHERE user_id = $1),
            (SELECT did FROM public_profiles WHERE user_id = $1),
            ''
        )",
    )
    .bind(user_id)
    .fetch_one(&state.db)
    .await?;

    if issuer_did.is_empty() {
        return Err(AppError::BadRequest(
            "No DID found. Create a profile first.".into(),
        ));
    }

    // Validate capabilities
    if req.capabilities.is_empty() {
        return Err(AppError::BadRequest(
            "At least one capability required".into(),
        ));
    }

    // Validate expiry
    if req.expires_in_seconds <= 0 || req.expires_in_seconds > 365 * 24 * 3600 {
        return Err(AppError::BadRequest(
            "expires_in_seconds must be between 1 and 31536000 (1 year)".into(),
        ));
    }

    let expires_at = chrono::Utc::now() + chrono::Duration::seconds(req.expires_in_seconds);

    // Generate a deterministic token hash (represents this grant)
    let token_content = format!(
        "{}:{}:{}:{}",
        issuer_did,
        req.audience_did,
        req.capabilities.join(","),
        expires_at.timestamp()
    );
    let token_hash = sha256_hex(&token_content);

    let parent_hash = req.parent_token.as_ref().map(|t| sha256_hex(t));

    // If there's a parent token, verify it's not revoked
    if let Some(ref ph) = parent_hash {
        let is_revoked: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM ucan_revocations WHERE token_hash = $1)",
        )
        .bind(ph)
        .fetch_one(&state.db)
        .await?;

        if is_revoked {
            return Err(AppError::BadRequest("Parent token has been revoked".into()));
        }

        // Verify parent grant exists and is active
        let parent_active: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM delegation_grants WHERE token_hash = $1 AND NOT revoked AND expires_at > NOW())",
        )
        .bind(ph)
        .fetch_one(&state.db)
        .await?;

        if !parent_active {
            return Err(AppError::BadRequest(
                "Parent grant not found or expired".into(),
            ));
        }
    }

    // Record the grant
    let id: Uuid = sqlx::query_scalar(
        r#"INSERT INTO delegation_grants
            (issuer_did, audience_did, capabilities, token_hash, parent_token_hash, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id"#,
    )
    .bind(&issuer_did)
    .bind(&req.audience_did)
    .bind(&req.capabilities)
    .bind(&token_hash)
    .bind(&parent_hash)
    .bind(expires_at)
    .fetch_one(&state.db)
    .await?;

    // Emit reputation event
    sqlx::query(
        r#"INSERT INTO reputation_events (entity_did, event_type, counterparty_did, details)
        VALUES ($1, 'delegation_granted', $2, $3)"#,
    )
    .bind(&issuer_did)
    .bind(&req.audience_did)
    .bind(serde_json::json!({
        "capabilities": req.capabilities,
        "expires_at": expires_at.to_rfc3339(),
    }))
    .execute(&state.db)
    .await
    .ok();

    Ok((
        StatusCode::CREATED,
        Json(GrantCreatedResponse {
            id,
            token_hash,
            audience_did: req.audience_did,
            capabilities: req.capabilities,
            expires_at,
        }),
    ))
}

/// POST /v1/delegation/revoke (JWT protected)
pub async fn revoke_grant(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Json(req): Json<RevokeRequest>,
) -> AppResult<Json<serde_json::Value>> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("Invalid token".into()))?;

    // Get issuer DID
    let issuer_did: String = sqlx::query_scalar(
        "SELECT COALESCE(
            (SELECT did FROM business_profiles WHERE user_id = $1),
            (SELECT did FROM public_profiles WHERE user_id = $1),
            ''
        )",
    )
    .bind(user_id)
    .fetch_one(&state.db)
    .await?;

    if issuer_did.is_empty() {
        return Err(AppError::BadRequest("No DID found".into()));
    }

    // Verify the grant belongs to this issuer
    let grant_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM delegation_grants WHERE token_hash = $1 AND issuer_did = $2)",
    )
    .bind(&req.token_hash)
    .bind(&issuer_did)
    .fetch_one(&state.db)
    .await?;

    if !grant_exists {
        return Err(AppError::NotFound(
            "Grant not found or not issued by you".into(),
        ));
    }

    // Add to revocation registry
    sqlx::query(
        r#"INSERT INTO ucan_revocations (issuer_did, token_hash, reason)
        VALUES ($1, $2, $3)
        ON CONFLICT (token_hash) DO NOTHING"#,
    )
    .bind(&issuer_did)
    .bind(&req.token_hash)
    .bind(&req.reason)
    .execute(&state.db)
    .await?;

    // Mark grant as revoked
    sqlx::query("UPDATE delegation_grants SET revoked = true WHERE token_hash = $1")
        .bind(&req.token_hash)
        .execute(&state.db)
        .await?;

    // Also revoke all child grants (cascade revocation)
    let child_count = cascade_revoke(&state, &issuer_did, &req.token_hash, &req.reason).await;

    Ok(Json(serde_json::json!({
        "revoked": true,
        "token_hash": req.token_hash,
        "children_revoked": child_count,
    })))
}

/// Recursively revoke all child delegations of a parent token.
async fn cascade_revoke(
    state: &AppState,
    issuer_did: &str,
    parent_hash: &str,
    reason: &Option<String>,
) -> i64 {
    // Find all children
    let children: Vec<(String,)> = sqlx::query_as(
        "SELECT token_hash FROM delegation_grants WHERE parent_token_hash = $1 AND NOT revoked",
    )
    .bind(parent_hash)
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();

    let mut count = children.len() as i64;

    for (child_hash,) in &children {
        // Revoke child
        sqlx::query(
            "INSERT INTO ucan_revocations (issuer_did, token_hash, reason) VALUES ($1, $2, $3) ON CONFLICT (token_hash) DO NOTHING",
        )
        .bind(issuer_did)
        .bind(child_hash)
        .bind(reason.as_deref().unwrap_or("parent_revoked"))
        .execute(&state.db)
        .await
        .ok();

        sqlx::query("UPDATE delegation_grants SET revoked = true WHERE token_hash = $1")
            .bind(child_hash)
            .execute(&state.db)
            .await
            .ok();

        // Recurse
        count += Box::pin(cascade_revoke(state, issuer_did, child_hash, reason)).await;
    }

    count
}

/// GET /v1/delegation/grants (JWT protected)
pub async fn list_my_grants(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Query(params): Query<GrantsQuery>,
) -> AppResult<Json<serde_json::Value>> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("Invalid token".into()))?;

    let issuer_did: String = sqlx::query_scalar(
        "SELECT COALESCE(
            (SELECT did FROM business_profiles WHERE user_id = $1),
            (SELECT did FROM public_profiles WHERE user_id = $1),
            ''
        )",
    )
    .bind(user_id)
    .fetch_one(&state.db)
    .await?;

    let page = params.page.unwrap_or(1).max(1);
    let limit = params.limit.unwrap_or(50).min(200);
    let offset = (page - 1) * limit;
    let active_only = params.active_only.unwrap_or(false);

    let grants = if active_only {
        sqlx::query_as::<_, GrantResponse>(
            r#"SELECT id, issuer_did, audience_did, capabilities, token_hash,
                      parent_token_hash, expires_at, revoked, created_at
            FROM delegation_grants
            WHERE issuer_did = $1 AND NOT revoked AND expires_at > NOW()
            ORDER BY created_at DESC LIMIT $2 OFFSET $3"#,
        )
        .bind(&issuer_did)
        .bind(limit)
        .bind(offset)
        .fetch_all(&state.db)
        .await?
    } else {
        sqlx::query_as::<_, GrantResponse>(
            r#"SELECT id, issuer_did, audience_did, capabilities, token_hash,
                      parent_token_hash, expires_at, revoked, created_at
            FROM delegation_grants
            WHERE issuer_did = $1
            ORDER BY created_at DESC LIMIT $2 OFFSET $3"#,
        )
        .bind(&issuer_did)
        .bind(limit)
        .bind(offset)
        .fetch_all(&state.db)
        .await?
    };

    Ok(Json(serde_json::json!({
        "grants": grants,
        "page": page,
        "limit": limit,
    })))
}

/// GET /v1/delegation/grants/{did} (public)
pub async fn list_grants_for_did(
    State(state): State<Arc<AppState>>,
    Path(did): Path<String>,
    Query(params): Query<GrantsQuery>,
) -> AppResult<Json<serde_json::Value>> {
    let page = params.page.unwrap_or(1).max(1);
    let limit = params.limit.unwrap_or(20).min(100);
    let offset = (page - 1) * limit;

    // Show only active, non-revoked, non-expired grants
    let grants = sqlx::query_as::<_, GrantResponse>(
        r#"SELECT id, issuer_did, audience_did, capabilities, token_hash,
                  parent_token_hash, expires_at, revoked, created_at
        FROM delegation_grants
        WHERE audience_did = $1 AND NOT revoked AND expires_at > NOW()
        ORDER BY created_at DESC LIMIT $2 OFFSET $3"#,
    )
    .bind(&did)
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(serde_json::json!({
        "grants": grants,
        "page": page,
        "limit": limit,
    })))
}

/// GET /v1/delegation/check?token_hash=... (public)
pub async fn check_revocation(
    State(state): State<Arc<AppState>>,
    Query(params): Query<CheckQuery>,
) -> AppResult<Json<serde_json::Value>> {
    let revocation: Option<(String, Option<String>, chrono::DateTime<chrono::Utc>)> =
        sqlx::query_as(
            "SELECT issuer_did, reason, revoked_at FROM ucan_revocations WHERE token_hash = $1",
        )
        .bind(&params.token_hash)
        .fetch_optional(&state.db)
        .await?;

    match revocation {
        Some((issuer, reason, revoked_at)) => Ok(Json(serde_json::json!({
            "revoked": true,
            "token_hash": params.token_hash,
            "issuer_did": issuer,
            "reason": reason,
            "revoked_at": revoked_at,
        }))),
        None => Ok(Json(serde_json::json!({
            "revoked": false,
            "token_hash": params.token_hash,
        }))),
    }
}

/// POST /v1/delegation/verify-chain (service key auth)
pub async fn verify_chain(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Json(req): Json<VerifyChainRequest>,
) -> AppResult<Json<ChainVerifyResponse>> {
    // Validate service API key
    let service_key = headers
        .get("X-Service-Key")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| AppError::Unauthorized("Missing X-Service-Key header".into()))?;

    let key_hash = sha256_hex(service_key);
    let key_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM service_api_keys WHERE key_hash = $1 AND active = true)",
    )
    .bind(&key_hash)
    .fetch_one(&state.db)
    .await?;

    if !key_exists {
        return Err(AppError::Unauthorized("Invalid API key".into()));
    }

    // Parse the UCAN token to extract the chain
    let token_hash = sha256_hex(&req.ucan_token);

    // Check if this specific token is revoked
    let is_revoked: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM ucan_revocations WHERE token_hash = $1)")
            .bind(&token_hash)
            .fetch_one(&state.db)
            .await?;

    if is_revoked {
        return Ok(Json(ChainVerifyResponse {
            valid: false,
            issuer_did: None,
            audience_did: None,
            capabilities: vec![],
            chain_length: 0,
            revoked_at_level: Some(0),
            error: Some("Token has been revoked".into()),
        }));
    }

    // Inline UCAN token parsing (reuse the pattern from verify.rs)
    let parts: Vec<&str> = req.ucan_token.splitn(3, '.').collect();
    if parts.len() != 3 {
        return Ok(Json(ChainVerifyResponse {
            valid: false,
            issuer_did: None,
            audience_did: None,
            capabilities: vec![],
            chain_length: 0,
            revoked_at_level: None,
            error: Some("Invalid JWT format".into()),
        }));
    }

    let payload_bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(parts[1])
        .map_err(|e| AppError::BadRequest(format!("Payload decode error: {e}")))?;

    #[derive(Deserialize)]
    struct UcanPayload {
        iss: String,
        aud: String,
        exp: i64,
        att: Vec<UcanAtt>,
        #[serde(default)]
        prf: Vec<String>,
    }

    #[derive(Deserialize)]
    struct UcanAtt {
        can: String,
    }

    let payload: UcanPayload = serde_json::from_slice(&payload_bytes)
        .map_err(|e| AppError::BadRequest(format!("Payload parse error: {e}")))?;

    // Check expiry
    let now = chrono::Utc::now().timestamp();
    if payload.exp <= now {
        return Ok(Json(ChainVerifyResponse {
            valid: false,
            issuer_did: Some(payload.iss),
            audience_did: Some(payload.aud),
            capabilities: vec![],
            chain_length: 1 + payload.prf.len(),
            revoked_at_level: None,
            error: Some("Token expired".into()),
        }));
    }

    let capabilities: Vec<String> = payload.att.iter().map(|a| a.can.clone()).collect();

    // Check parent chain for revocations
    let mut chain_length = 1;
    for (i, parent_token) in payload.prf.iter().enumerate() {
        chain_length += 1;
        let parent_hash = sha256_hex(parent_token);
        let parent_revoked: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM ucan_revocations WHERE token_hash = $1)",
        )
        .bind(&parent_hash)
        .fetch_one(&state.db)
        .await?;

        if parent_revoked {
            return Ok(Json(ChainVerifyResponse {
                valid: false,
                issuer_did: Some(payload.iss),
                audience_did: Some(payload.aud),
                capabilities,
                chain_length,
                revoked_at_level: Some(i + 1),
                error: Some(format!("Parent token at level {} has been revoked", i + 1)),
            }));
        }
    }

    Ok(Json(ChainVerifyResponse {
        valid: true,
        issuer_did: Some(payload.iss),
        audience_did: Some(payload.aud),
        capabilities,
        chain_length,
        revoked_at_level: None,
        error: None,
    }))
}
