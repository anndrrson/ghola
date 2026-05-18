//! Agentic commerce intent routes.

use axum::extract::{Path, State};
use axum::Json;
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::error::CloudError;
use crate::services::commerce_service::{
    self, CommerceExecution, CommerceIntent, CommerceOffer, CommerceQuote, CreateIntentRequest,
    CreateQuoteRequest, ExecuteQuoteRequest,
};
use crate::state::AppState;

pub async fn create_intent(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Json(req): Json<CreateIntentRequest>,
) -> Result<Json<CommerceIntent>, CloudError> {
    let intent = commerce_service::create_intent(&state.db, claims.sub, req).await?;
    Ok(Json(intent))
}

pub async fn get_intent(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Path(intent_id): Path<Uuid>,
) -> Result<Json<CommerceIntent>, CloudError> {
    let intent = commerce_service::get_intent(&state.db, claims.sub, intent_id).await?;
    Ok(Json(intent))
}

pub async fn list_offers(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Path(intent_id): Path<Uuid>,
) -> Result<Json<Vec<CommerceOffer>>, CloudError> {
    let offers = commerce_service::list_offers(&state, claims.sub, intent_id).await?;
    Ok(Json(offers))
}

pub async fn create_quote(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Path(intent_id): Path<Uuid>,
    Json(req): Json<CreateQuoteRequest>,
) -> Result<Json<CommerceQuote>, CloudError> {
    let quote = commerce_service::create_quote(&state, claims.sub, intent_id, req).await?;
    Ok(Json(quote))
}

pub async fn execute_quote(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Path(intent_id): Path<Uuid>,
    Json(req): Json<ExecuteQuoteRequest>,
) -> Result<Json<CommerceExecution>, CloudError> {
    let execution = commerce_service::execute_quote(&state, claims.sub, intent_id, req).await?;
    Ok(Json(execution))
}
