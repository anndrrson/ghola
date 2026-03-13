use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Extension, Json,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::Claims;
use crate::db::{DbAgentWallet, DbMerchantConfig, DbPaymentTransaction};
use crate::error::AppError;
use crate::state::AppState;

// ── Request / Response Types ──

#[derive(Deserialize)]
pub struct CreateAgentRequest {
    pub label: String,
    pub spending_policy: Option<serde_json::Value>,
}

#[derive(Deserialize)]
pub struct UpdateAgentRequest {
    pub spending_policy: Option<serde_json::Value>,
    pub active: Option<bool>,
}

#[derive(Deserialize)]
pub struct SyncTransactionRequest {
    pub transactions: Vec<SyncTransaction>,
}

#[derive(Deserialize)]
pub struct SyncTransaction {
    pub agent_label: String,
    pub direction: String,
    pub currency: String,
    pub amount: i64,
    pub recipient: String,
    pub sender: String,
    pub signature: String,
    pub memo: Option<String>,
    pub status: String,
}

#[derive(Deserialize)]
pub struct HistoryQuery {
    pub agent_id: Option<Uuid>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

#[derive(Deserialize)]
pub struct MerchantConfigRequest {
    pub did: String,
    pub receive_address: String,
    pub accepted_currencies: Option<serde_json::Value>,
    pub webhook_url: Option<String>,
}

#[derive(Serialize)]
pub struct SpendingSummary {
    pub agent_id: Uuid,
    pub agent_label: String,
    pub daily_sol_spent: i64,
    pub daily_usdc_spent: i64,
    pub policy: serde_json::Value,
}

// ── Handlers ──

/// GET /v1/pay/agents — list agent wallets
pub async fn list_agents(
    Extension(claims): Extension<Claims>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<DbAgentWallet>>, AppError> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("invalid user id".into()))?;

    let wallets = sqlx::query_as::<_, DbAgentWallet>(
        "SELECT * FROM agent_wallets WHERE user_id = $1 ORDER BY created_at",
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?;

    Ok(Json(wallets))
}

/// POST /v1/pay/agents — create agent wallet
pub async fn create_agent(
    Extension(claims): Extension<Claims>,
    State(state): State<Arc<AppState>>,
    Json(req): Json<CreateAgentRequest>,
) -> Result<(StatusCode, Json<DbAgentWallet>), AppError> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("invalid user id".into()))?;

    // Get next HD index
    let max_index: Option<i32> =
        sqlx::query_scalar("SELECT MAX(hd_index) FROM agent_wallets WHERE user_id = $1")
            .bind(user_id)
            .fetch_one(&state.db)
            .await
            .map_err(|e| AppError::Internal(e.to_string()))?;

    let next_index = max_index.map_or(0, |m| m + 1);
    let policy = req.spending_policy.unwrap_or(serde_json::json!({}));

    let wallet = sqlx::query_as::<_, DbAgentWallet>(
        "INSERT INTO agent_wallets (user_id, label, hd_index, solana_address, spending_policy) \
         VALUES ($1, $2, $3, $4, $5) RETURNING *",
    )
    .bind(user_id)
    .bind(&req.label)
    .bind(next_index)
    .bind("") // Address will be derived client-side
    .bind(&policy)
    .fetch_one(&state.db)
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?;

    Ok((StatusCode::CREATED, Json(wallet)))
}

/// PUT /v1/pay/agents/{id} — update agent spending policy
pub async fn update_agent(
    Extension(claims): Extension<Claims>,
    State(state): State<Arc<AppState>>,
    Path(id): Path<Uuid>,
    Json(req): Json<UpdateAgentRequest>,
) -> Result<Json<DbAgentWallet>, AppError> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("invalid user id".into()))?;

    if let Some(policy) = &req.spending_policy {
        sqlx::query("UPDATE agent_wallets SET spending_policy = $1 WHERE id = $2 AND user_id = $3")
            .bind(policy)
            .bind(id)
            .bind(user_id)
            .execute(&state.db)
            .await
            .map_err(|e| AppError::Internal(e.to_string()))?;
    }

    if let Some(active) = req.active {
        sqlx::query("UPDATE agent_wallets SET active = $1 WHERE id = $2 AND user_id = $3")
            .bind(active)
            .bind(id)
            .bind(user_id)
            .execute(&state.db)
            .await
            .map_err(|e| AppError::Internal(e.to_string()))?;
    }

    let wallet = sqlx::query_as::<_, DbAgentWallet>(
        "SELECT * FROM agent_wallets WHERE id = $1 AND user_id = $2",
    )
    .bind(id)
    .bind(user_id)
    .fetch_one(&state.db)
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?;

    Ok(Json(wallet))
}

/// DELETE /v1/pay/agents/{id} — deactivate agent
pub async fn deactivate_agent(
    Extension(claims): Extension<Claims>,
    State(state): State<Arc<AppState>>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, AppError> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("invalid user id".into()))?;

    sqlx::query("UPDATE agent_wallets SET active = false WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(user_id)
        .execute(&state.db)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;

    Ok(StatusCode::NO_CONTENT)
}

/// GET /v1/pay/history — transaction history
pub async fn history(
    Extension(claims): Extension<Claims>,
    State(state): State<Arc<AppState>>,
    Query(query): Query<HistoryQuery>,
) -> Result<Json<Vec<DbPaymentTransaction>>, AppError> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("invalid user id".into()))?;
    let limit = query.limit.unwrap_or(50).min(200);
    let offset = query.offset.unwrap_or(0);

    let txs = if let Some(agent_id) = query.agent_id {
        sqlx::query_as::<_, DbPaymentTransaction>(
            "SELECT * FROM payment_transactions WHERE user_id = $1 AND agent_wallet_id = $2 \
             ORDER BY created_at DESC LIMIT $3 OFFSET $4",
        )
        .bind(user_id)
        .bind(agent_id)
        .bind(limit)
        .bind(offset)
        .fetch_all(&state.db)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
    } else {
        sqlx::query_as::<_, DbPaymentTransaction>(
            "SELECT * FROM payment_transactions WHERE user_id = $1 \
             ORDER BY created_at DESC LIMIT $2 OFFSET $3",
        )
        .bind(user_id)
        .bind(limit)
        .bind(offset)
        .fetch_all(&state.db)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
    };

    Ok(Json(txs))
}

/// POST /v1/pay/sync — sync local transactions to cloud
pub async fn sync_transactions(
    Extension(claims): Extension<Claims>,
    State(state): State<Arc<AppState>>,
    Json(req): Json<SyncTransactionRequest>,
) -> Result<(StatusCode, Json<serde_json::Value>), AppError> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("invalid user id".into()))?;
    let mut synced = 0u32;

    for tx in &req.transactions {
        // Look up the agent wallet by label
        let wallet = sqlx::query_as::<_, DbAgentWallet>(
            "SELECT * FROM agent_wallets WHERE user_id = $1 AND label = $2",
        )
        .bind(user_id)
        .bind(&tx.agent_label)
        .fetch_optional(&state.db)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;

        if let Some(wallet) = wallet {
            // Upsert by signature to avoid duplicates
            sqlx::query(
                "INSERT INTO payment_transactions \
                 (user_id, agent_wallet_id, agent_label, direction, currency, amount, recipient, sender, signature, memo, status) \
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) \
                 ON CONFLICT (signature) DO NOTHING",
            )
            .bind(user_id)
            .bind(wallet.id)
            .bind(&tx.agent_label)
            .bind(&tx.direction)
            .bind(&tx.currency)
            .bind(tx.amount)
            .bind(&tx.recipient)
            .bind(&tx.sender)
            .bind(&tx.signature)
            .bind(&tx.memo)
            .bind(&tx.status)
            .execute(&state.db)
            .await
            .map_err(|e| AppError::Internal(e.to_string()))?;

            synced += 1;
        }
    }

    Ok((
        StatusCode::OK,
        Json(serde_json::json!({ "synced": synced })),
    ))
}

/// GET /v1/pay/spending/{id} — spending summary
pub async fn spending_summary(
    Extension(claims): Extension<Claims>,
    State(state): State<Arc<AppState>>,
    Path(id): Path<Uuid>,
) -> Result<Json<SpendingSummary>, AppError> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("invalid user id".into()))?;

    let wallet = sqlx::query_as::<_, DbAgentWallet>(
        "SELECT * FROM agent_wallets WHERE id = $1 AND user_id = $2",
    )
    .bind(id)
    .bind(user_id)
    .fetch_one(&state.db)
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?;

    // Sum last 24h sends
    let sol_spent: Option<i64> = sqlx::query_scalar(
        "SELECT COALESCE(SUM(amount), 0) FROM payment_transactions \
         WHERE agent_wallet_id = $1 AND direction = 'send' AND currency = 'sol' \
         AND created_at > now() - interval '24 hours'",
    )
    .bind(id)
    .fetch_one(&state.db)
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?;

    let usdc_spent: Option<i64> = sqlx::query_scalar(
        "SELECT COALESCE(SUM(amount), 0) FROM payment_transactions \
         WHERE agent_wallet_id = $1 AND direction = 'send' AND currency = 'usdc' \
         AND created_at > now() - interval '24 hours'",
    )
    .bind(id)
    .fetch_one(&state.db)
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?;

    Ok(Json(SpendingSummary {
        agent_id: wallet.id,
        agent_label: wallet.label,
        daily_sol_spent: sol_spent.unwrap_or(0),
        daily_usdc_spent: usdc_spent.unwrap_or(0),
        policy: wallet.spending_policy,
    }))
}

/// GET /v1/pay/merchant/{did} — public merchant info
pub async fn get_merchant(
    State(state): State<Arc<AppState>>,
    Path(did): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let config = sqlx::query_as::<_, DbMerchantConfig>(
        "SELECT * FROM merchant_configs WHERE did = $1 AND active = true",
    )
    .bind(&did)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?;

    match config {
        Some(c) => Ok(Json(serde_json::json!({
            "did": c.did,
            "receive_address": c.receive_address,
            "accepted_currencies": c.accepted_currencies,
        }))),
        None => Err(AppError::NotFound("merchant not found".into())),
    }
}

/// POST /v1/pay/merchant — register/update merchant config
pub async fn upsert_merchant(
    Extension(claims): Extension<Claims>,
    State(state): State<Arc<AppState>>,
    Json(req): Json<MerchantConfigRequest>,
) -> Result<Json<DbMerchantConfig>, AppError> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("invalid user id".into()))?;
    let currencies = req
        .accepted_currencies
        .unwrap_or(serde_json::json!(["usdc"]));

    let config = sqlx::query_as::<_, DbMerchantConfig>(
        "INSERT INTO merchant_configs (user_id, did, receive_address, accepted_currencies, webhook_url) \
         VALUES ($1, $2, $3, $4, $5) \
         ON CONFLICT (user_id) DO UPDATE SET \
         did = EXCLUDED.did, receive_address = EXCLUDED.receive_address, \
         accepted_currencies = EXCLUDED.accepted_currencies, webhook_url = EXCLUDED.webhook_url \
         RETURNING *",
    )
    .bind(user_id)
    .bind(&req.did)
    .bind(&req.receive_address)
    .bind(&currencies)
    .bind(&req.webhook_url)
    .fetch_one(&state.db)
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?;

    Ok(Json(config))
}
