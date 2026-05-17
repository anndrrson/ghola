use std::sync::Arc;

use axum::extract::{Path, State};
use axum::Extension;
use axum::Json;
use serde_json::json;

use crate::auth::Claims;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use orni_models_types::{CreatorProfile, LinkDidRequest};

/// POST /api/identity/link — link a SAID DID to the authenticated Orni user.
pub async fn link_did(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Json(req): Json<LinkDidRequest>,
) -> AppResult<Json<serde_json::Value>> {
    let said_cloud_url = &state.config.said_cloud_url;

    // 1. Verify the DID exists by resolving it through the SAID cloud API.
    let resolve_url = format!("{said_cloud_url}/v1/resolve/{}", req.did);
    let resolve_res = state
        .http_client
        .get(&resolve_url)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("Failed to reach SAID cloud: {e}")))?;

    if !resolve_res.status().is_success() {
        return Err(AppError::BadRequest(format!(
            "DID '{}' could not be resolved",
            req.did
        )));
    }

    // 2. Validate ownership by verifying the SAID token against the business profile endpoint.
    let profile_url = format!("{said_cloud_url}/v1/business/profile");
    let profile_res = state
        .http_client
        .get(&profile_url)
        .header("Authorization", format!("Bearer {}", req.said_token))
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("Failed to verify SAID token: {e}")))?;

    if !profile_res.status().is_success() {
        return Err(AppError::Unauthorized(
            "SAID token is invalid or expired".into(),
        ));
    }

    // 3. Construct the public profile URL.
    let profile_url = format!("{said_cloud_url}/v1/resolve/{}", req.did);

    // 4. Update the Orni user with the verified DID.
    let user_id: uuid::Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Internal("Invalid user ID in token".into()))?;

    sqlx::query(
        "UPDATE users SET did = $1, said_verified = true, said_profile_url = $2 WHERE id = $3",
    )
    .bind(&req.did)
    .bind(&profile_url)
    .bind(user_id)
    .execute(&state.db)
    .await?;

    tracing::info!(user_id = %claims.sub, did = %req.did, "DID linked to Orni account");

    Ok(Json(json!({
        "message": "DID linked successfully",
        "did": req.did,
        "said_verified": true,
        "said_profile_url": profile_url,
    })))
}

/// GET /api/creator/{did}/profile — public creator profile lookup by DID.
pub async fn get_creator_profile(
    State(state): State<Arc<AppState>>,
    Path(did): Path<String>,
) -> AppResult<Json<CreatorProfile>> {
    let profile = sqlx::query_as::<_, CreatorProfile>(
        r#"
        SELECT
            u.wallet_address,
            u.display_name,
            u.avatar_url,
            u.did,
            u.said_verified,
            u.said_profile_url,
            (SELECT COUNT(*) FROM models WHERE creator_id = u.id AND status = 'live') as model_count,
            (SELECT COALESCE(SUM(total_queries), 0) FROM models WHERE creator_id = u.id) as total_queries
        FROM users u
        WHERE u.did = $1
        "#,
    )
    .bind(&did)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("No creator found with DID '{did}'")))?;

    Ok(Json(profile))
}
