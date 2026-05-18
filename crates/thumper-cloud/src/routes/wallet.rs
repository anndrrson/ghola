use axum::extract::State;
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::auth::AuthUser;
use crate::error::CloudError;
use crate::privacy::{NetworkScope, PrivacyApproval};
use crate::services::private_settlement_service;
use crate::services::wallet_service;
use crate::state::AppState;

/// POST /api/wallet/provision — Create a Solana wallet for the authenticated user.
pub async fn provision_wallet(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Json(approval): Json<PrivacyApproval>,
) -> Result<Json<wallet_service::WalletInfo>, CloudError> {
    approval.require_for(NetworkScope::WalletProvision)?;
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

/// POST /api/wallet/private/intent — create an approved private USDCx transfer intent.
pub async fn create_private_transfer_intent(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Json(req): Json<private_settlement_service::CreatePrivateTransferIntentRequest>,
) -> Result<Json<private_settlement_service::PrivateTransferIntentResponse>, CloudError> {
    let intent =
        private_settlement_service::create_private_transfer_intent(&state, claims.sub, req).await?;
    Ok(Json(intent))
}

/// POST /api/wallet/private/submit-proof — verify a signed Aleo USDCx proof.
pub async fn submit_private_transfer_proof(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Json(req): Json<private_settlement_service::SubmitPrivateTransferProofRequest>,
) -> Result<Json<private_settlement_service::PrivateTransferProofResponse>, CloudError> {
    let result =
        private_settlement_service::submit_private_transfer_proof(&state, claims.sub, req).await?;
    Ok(Json(result))
}

/// POST /api/wallet/private/submit-signed-transfer — verify a user-held signed Aleo USDCx transfer.
pub async fn submit_signed_private_transfer(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Json(req): Json<private_settlement_service::SubmitSignedPrivateTransferRequest>,
) -> Result<Json<private_settlement_service::PrivateTransferProofResponse>, CloudError> {
    let result =
        private_settlement_service::submit_signed_private_transfer(&state, claims.sub, req, false)
            .await?;
    Ok(Json(result))
}

/// GET /api/wallet/private/recipient — authenticated private USDCx recipient config.
pub async fn get_private_rail_recipient(
    AuthUser(_claims): AuthUser,
) -> Result<Json<private_settlement_service::PrivateRailRecipientResponse>, CloudError> {
    Ok(Json(
        private_settlement_service::private_rail_recipient_status(),
    ))
}

#[derive(Deserialize)]
pub struct PrivateHistoryQuery {
    pub limit: Option<i64>,
}

/// GET /api/wallet/private/history — private settlement history with redacted recipients.
pub async fn get_private_transfer_history(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    axum::extract::Query(query): axum::extract::Query<PrivateHistoryQuery>,
) -> Result<Json<Vec<private_settlement_service::PrivateTransferHistoryEntry>>, CloudError> {
    let limit = query.limit.unwrap_or(25).min(100);
    let history =
        private_settlement_service::private_transfer_history(&state, claims.sub, limit).await?;
    Ok(Json(history))
}

/// GET /api/wallet/private/receipts/:id — redacted private settlement receipt metadata.
pub async fn get_private_transfer_receipt(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    axum::extract::Path(id): axum::extract::Path<uuid::Uuid>,
) -> Result<Json<private_settlement_service::PrivateTransferReceiptResponse>, CloudError> {
    let receipt =
        private_settlement_service::private_transfer_receipt(&state, claims.sub, id).await?;
    Ok(Json(receipt))
}

/// POST /api/wallet/private/receipts/:id/export — user-approved selective disclosure export.
pub async fn export_private_transfer_receipt(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    axum::extract::Path(id): axum::extract::Path<uuid::Uuid>,
    Json(req): Json<private_settlement_service::ExportPrivateTransferReceiptRequest>,
) -> Result<Json<private_settlement_service::PrivateTransferReceiptExportResponse>, CloudError> {
    let export =
        private_settlement_service::export_private_transfer_receipt(&state, claims.sub, id, req)
            .await?;
    Ok(Json(export))
}

#[derive(Deserialize)]
pub struct WithdrawEarningsRequest {
    pub to_address: String,
    pub amount_usdc: Option<i64>,
    #[serde(flatten)]
    pub approval: PrivacyApproval,
}

#[derive(Serialize)]
pub struct WithdrawEarningsResponse {
    pub payout_id: uuid::Uuid,
    pub amount_usdc: i64,
    pub to_address: String,
    pub signature: Option<String>,
    pub status: String,
}

/// GET /api/wallet/earnings — Check earned and withdrawn balances.
pub async fn get_earnings(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
) -> Result<Json<serde_json::Value>, CloudError> {
    let row = sqlx::query_as::<_, (Option<i64>, Option<i64>)>(
        "SELECT earned_usdc, withdrawn_usdc FROM user_wallets WHERE user_id = $1",
    )
    .bind(claims.sub)
    .fetch_optional(&state.db)
    .await?
    .ok_or(CloudError::NotFound("wallet not provisioned".to_string()))?;

    let earned = row.0.unwrap_or(0);
    let withdrawn = row.1.unwrap_or(0);
    let available = earned - withdrawn;

    Ok(Json(serde_json::json!({
        "earned_usdc": earned,
        "withdrawn_usdc": withdrawn,
        "available_usdc": available,
    })))
}

const MIN_WITHDRAWAL_USDC: i64 = 100_000; // $0.10

/// POST /api/wallet/withdraw-earnings — Withdraw earned bounty USDC to
/// an external Solana wallet.
pub async fn withdraw_earnings(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Json(req): Json<WithdrawEarningsRequest>,
) -> Result<Json<WithdrawEarningsResponse>, CloudError> {
    req.approval.require_for(NetworkScope::WalletTransfer)?;

    let mnemonic = state.config.treasury_mnemonic.as_deref().ok_or_else(|| {
        CloudError::ServiceUnavailable("withdrawals not configured yet".to_string())
    })?;

    // Validate address
    let to_bytes = bs58::decode(&req.to_address)
        .into_vec()
        .map_err(|_| CloudError::BadRequest("invalid Solana address".to_string()))?;
    if to_bytes.len() != 32 {
        return Err(CloudError::BadRequest(
            "invalid Solana address length".to_string(),
        ));
    }

    // Fetch earned balance
    let row = sqlx::query_as::<_, (Option<i64>, Option<i64>)>(
        "SELECT earned_usdc, withdrawn_usdc FROM user_wallets WHERE user_id = $1",
    )
    .bind(claims.sub)
    .fetch_optional(&state.db)
    .await?
    .ok_or(CloudError::NotFound("wallet not provisioned".to_string()))?;

    let earned = row.0.unwrap_or(0);
    let withdrawn = row.1.unwrap_or(0);
    let available = earned - withdrawn;

    let amount = req.amount_usdc.unwrap_or(available);

    if amount <= 0 {
        return Err(CloudError::BadRequest(
            "amount must be positive".to_string(),
        ));
    }
    if amount < MIN_WITHDRAWAL_USDC {
        return Err(CloudError::BadRequest(format!(
            "minimum withdrawal is ${:.2}",
            MIN_WITHDRAWAL_USDC as f64 / 1_000_000.0
        )));
    }
    if amount > available {
        return Err(CloudError::BadRequest(format!(
            "insufficient balance: ${:.6} available",
            available as f64 / 1_000_000.0
        )));
    }

    // Check no pending payouts
    let pending: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM bounty_payouts WHERE user_id = $1 AND status = 'pending'",
    )
    .bind(claims.sub)
    .fetch_one(&state.db)
    .await?;

    if pending > 0 {
        return Err(CloudError::BadRequest(
            "you have a pending withdrawal — wait for it to complete".to_string(),
        ));
    }

    // Insert pending payout
    let payout_id: uuid::Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO bounty_payouts (user_id, amount_usdc, to_address, status)
        VALUES ($1, $2, $3, 'pending')
        RETURNING id
        "#,
    )
    .bind(claims.sub)
    .bind(amount)
    .bind(&req.to_address)
    .fetch_one(&state.db)
    .await?;

    // Send USDC via intermediate wallet
    let rpc_url = &state.config.solana_rpc_url;
    // Use a fixed index for bounty payouts (offset from provider indices)
    let payout_index = 900_000u32 + (claims.sub.as_u128() % 100_000) as u32;

    match wallet_service::send_via_intermediate(
        mnemonic,
        payout_index,
        &req.to_address,
        amount as u64,
        rpc_url,
    )
    .await
    {
        Ok(tx) => {
            sqlx::query(
                "UPDATE bounty_payouts SET status = 'confirmed', signature = $1, completed_at = now() WHERE id = $2",
            )
            .bind(&tx.signature)
            .bind(payout_id)
            .execute(&state.db)
            .await?;

            sqlx::query(
                "UPDATE user_wallets SET withdrawn_usdc = COALESCE(withdrawn_usdc, 0) + $1 WHERE user_id = $2",
            )
            .bind(amount)
            .bind(claims.sub)
            .execute(&state.db)
            .await?;

            Ok(Json(WithdrawEarningsResponse {
                payout_id,
                amount_usdc: amount,
                to_address: req.to_address,
                signature: Some(tx.signature),
                status: "confirmed".to_string(),
            }))
        }
        Err(e) => {
            sqlx::query(
                "UPDATE bounty_payouts SET status = 'failed', error_message = $1, completed_at = now() WHERE id = $2",
            )
            .bind(e.to_string())
            .bind(payout_id)
            .execute(&state.db)
            .await?;

            Err(e)
        }
    }
}
