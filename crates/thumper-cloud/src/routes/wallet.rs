use axum::extract::State;
use axum::Json;
use serde::Deserialize;

use crate::auth::AuthUser;
use crate::error::CloudError;
use crate::services::wallet_service;
use crate::state::AppState;

/// POST /api/wallet/provision — Create a Solana wallet for the authenticated user.
pub async fn provision_wallet(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
) -> Result<Json<wallet_service::WalletInfo>, CloudError> {
    let info = wallet_service::generate_wallet(&state, claims.sub).await?;
    Ok(Json(info))
}

/// GET /api/wallet/address — Get the user's Solana address.
pub async fn get_address(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
) -> Result<Json<wallet_service::WalletInfo>, CloudError> {
    let info = wallet_service::get_address(&state, claims.sub).await?;
    Ok(Json(info))
}

/// GET /api/wallet/balances — Get SOL + USDC balances.
pub async fn get_balances(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
) -> Result<Json<wallet_service::Balances>, CloudError> {
    let balances = wallet_service::get_balances(&state, claims.sub).await?;
    Ok(Json(balances))
}

/// POST /api/wallet/transfer — Send SOL or USDC.
pub async fn transfer(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Json(req): Json<wallet_service::TransferRequest>,
) -> Result<Json<wallet_service::TxResult>, CloudError> {
    let result = wallet_service::transfer(&state, claims.sub, &req).await?;
    Ok(Json(result))
}

#[derive(Deserialize)]
pub struct HistoryQuery {
    pub limit: Option<i64>,
}

/// GET /api/wallet/history — Transaction history.
pub async fn get_history(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    axum::extract::Query(query): axum::extract::Query<HistoryQuery>,
) -> Result<Json<Vec<wallet_service::TxHistoryEntry>>, CloudError> {
    let limit = query.limit.unwrap_or(50).min(100);
    let history = wallet_service::get_history(&state, claims.sub, limit).await?;
    Ok(Json(history))
}
