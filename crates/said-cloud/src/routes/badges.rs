use std::sync::Arc;

use axum::extract::{Path, State};
use axum::Extension;
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::Claims;
use crate::db::DbVerifiedBadge;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

// ---------------------------------------------------------------------------
// GET /v1/badges/:did  (public)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum BadgeCheckResponse {
    Verified {
        verified: bool,
        verified_by: String,
        attestation_tx: Option<String>,
        created_at: DateTime<Utc>,
        expires_at: DateTime<Utc>,
    },
    NotVerified {
        verified: bool,
    },
}

pub async fn check_badge(
    State(state): State<Arc<AppState>>,
    Path(did): Path<String>,
) -> AppResult<Json<BadgeCheckResponse>> {
    // Look up the profile by DID
    let profile: Option<(Uuid,)> =
        sqlx::query_as("SELECT id FROM business_profiles WHERE did = $1")
            .bind(&did)
            .fetch_optional(&state.db)
            .await?;

    let profile_id = match profile {
        Some((id,)) => id,
        None => return Ok(Json(BadgeCheckResponse::NotVerified { verified: false })),
    };

    // Check for an active (non-expired) badge
    let badge: Option<DbVerifiedBadge> = sqlx::query_as(
        "SELECT id, profile_id, verified_by, attestation_tx, created_at, expires_at \
         FROM verified_badges \
         WHERE profile_id = $1 AND expires_at > now() \
         ORDER BY created_at DESC \
         LIMIT 1",
    )
    .bind(profile_id)
    .fetch_optional(&state.db)
    .await?;

    match badge {
        Some(b) => Ok(Json(BadgeCheckResponse::Verified {
            verified: true,
            verified_by: b.verified_by,
            attestation_tx: b.attestation_tx,
            created_at: b.created_at,
            expires_at: b.expires_at,
        })),
        None => Ok(Json(BadgeCheckResponse::NotVerified { verified: false })),
    }
}

// ---------------------------------------------------------------------------
// POST /v1/badges/request  (protected, business tier)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct BadgeRequestBody {
    pub notes: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct BadgeRequestResponse {
    pub status: String,
    pub message: String,
}

pub async fn request_badge(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Json(body): Json<BadgeRequestBody>,
) -> AppResult<Json<BadgeRequestResponse>> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Internal("Invalid user ID in token".into()))?;

    // Check that user has a Stripe customer (i.e. has purchased something)
    let has_billing: Option<(Option<String>,)> = sqlx::query_as(
        "SELECT stripe_customer_id FROM users WHERE id = $1",
    )
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?;

    let has_stripe = has_billing
        .and_then(|(c,)| c)
        .filter(|s| !s.is_empty())
        .is_some();

    if !has_stripe {
        return Err(AppError::BadRequest(
            "Please purchase the verified badge before requesting review".into(),
        ));
    }

    // Get profile
    let profile: Option<(Uuid,)> =
        sqlx::query_as("SELECT id FROM business_profiles WHERE user_id = $1")
            .bind(user_id)
            .fetch_optional(&state.db)
            .await?;

    let profile_id = match profile {
        Some((id,)) => id,
        None => {
            return Err(AppError::BadRequest(
                "You must create a business profile before requesting a badge".into(),
            ));
        }
    };

    // Log the badge request as an agent_interaction
    sqlx::query(
        "INSERT INTO agent_interactions (profile_id, tool_used, query_text) \
         VALUES ($1, 'badge_request', $2)",
    )
    .bind(profile_id)
    .bind(body.notes.as_deref())
    .execute(&state.db)
    .await?;

    Ok(Json(BadgeRequestResponse {
        status: "pending".to_string(),
        message: "Your verification request has been submitted. We'll review within 5 business days.".to_string(),
    }))
}

// ---------------------------------------------------------------------------
// POST /v1/admin/badges/grant  (admin placeholder)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct GrantBadgeBody {
    pub did: String,
    pub attestation_tx: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct GrantBadgeResponse {
    pub badge_id: Uuid,
    pub profile_id: Uuid,
    pub expires_at: DateTime<Utc>,
}

pub async fn grant_badge(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Json(body): Json<GrantBadgeBody>,
) -> AppResult<Json<GrantBadgeResponse>> {
    // Admin check
    if !state.config.admin_emails.contains(&claims.email) {
        return Err(AppError::Unauthorized("Admin access required".into()));
    }

    // Look up profile by DID
    let profile: Option<(Uuid,)> =
        sqlx::query_as("SELECT id FROM business_profiles WHERE did = $1")
            .bind(&body.did)
            .fetch_optional(&state.db)
            .await?;

    let profile_id = match profile {
        Some((id,)) => id,
        None => {
            return Err(AppError::NotFound(
                "No business profile found for the given DID".into(),
            ));
        }
    };

    // Insert the badge
    let badge: (Uuid, DateTime<Utc>) = sqlx::query_as(
        "INSERT INTO verified_badges (profile_id, verified_by, attestation_tx) \
         VALUES ($1, 'manual', $2) \
         RETURNING id, expires_at",
    )
    .bind(profile_id)
    .bind(body.attestation_tx.as_deref())
    .fetch_one(&state.db)
    .await?;

    Ok(Json(GrantBadgeResponse {
        badge_id: badge.0,
        profile_id,
        expires_at: badge.1,
    }))
}
