use axum::extract::State;
use axum::Json;

use crate::auth::AuthUser;
use crate::error::CloudError;
use crate::services::seeker_service;
use crate::state::AppState;

/// POST /api/seeker/verify — verify the SIWS wallet owns a Seeker Genesis Token.
pub async fn verify(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Json(req): Json<seeker_service::VerifySeekerRequest>,
) -> Result<Json<seeker_service::VerifySeekerResponse>, CloudError> {
    let result = seeker_service::verify_seeker_wallet(&state, claims.sub, req).await?;
    Ok(Json(result))
}
