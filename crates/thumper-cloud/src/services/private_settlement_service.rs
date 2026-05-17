use chrono::{Duration, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::error::CloudError;
use crate::privacy::{NetworkScope, PrivacyApproval};
use crate::services::x402_service::{
    self, PaymentProof, ShieldedSettlementContext, ALEO_USDCX_SHIELDED_RAIL,
    SHIELDED_STABLECOIN_DISCLOSURE, SHIELDED_STABLECOIN_RAIL,
};
use crate::state::AppState;

const INTENT_TTL_MINUTES: i64 = 10;

#[derive(Debug, Deserialize)]
pub struct CreatePrivateTransferIntentRequest {
    #[serde(alias = "to", alias = "recipient")]
    pub to_shielded_address: String,
    #[serde(alias = "amount")]
    pub amount_micro_usdc: i64,
    #[serde(default)]
    pub rail: Option<String>,
    #[serde(flatten)]
    pub approval: PrivacyApproval,
}

#[derive(Debug, Deserialize)]
pub struct SubmitPrivateTransferProofRequest {
    pub intent_id: Uuid,
    #[serde(alias = "to", alias = "recipient")]
    pub to_shielded_address: String,
    pub proof: PaymentProof,
    #[serde(flatten)]
    pub approval: PrivacyApproval,
}

#[derive(Debug, Serialize)]
pub struct PrivateTransferIntentResponse {
    pub id: Uuid,
    pub rail: &'static str,
    pub canonical_rail: &'static str,
    pub provider: String,
    pub network: String,
    pub asset: String,
    pub amount_micro_usdc: i64,
    pub recipient_preview: String,
    pub status: String,
    pub expires_at: chrono::DateTime<Utc>,
    pub privacy_disclosure: &'static str,
    pub fallback_allowed: bool,
}

#[derive(Debug, Serialize)]
pub struct PrivateTransferHistoryEntry {
    pub id: Uuid,
    pub rail: String,
    pub provider: String,
    pub network: String,
    pub asset: String,
    pub amount_micro_usdc: i64,
    pub recipient_preview: String,
    pub status: String,
    pub adapter_receipt_ref: Option<String>,
    pub created_at: chrono::DateTime<Utc>,
    pub verified_at: Option<chrono::DateTime<Utc>>,
}

#[derive(Debug, Serialize)]
pub struct PrivateTransferProofResponse {
    pub id: Uuid,
    pub rail: &'static str,
    pub canonical_rail: &'static str,
    pub provider: String,
    pub network: String,
    pub asset: String,
    pub amount_micro_usdc: i64,
    pub recipient_preview: String,
    pub adapter_receipt_ref: String,
    pub status: String,
    pub privacy_disclosure: &'static str,
}

fn assert_private_rail_ready() -> Result<x402_service::ShieldedStablecoinRuntimeStatus, CloudError>
{
    let status = x402_service::shielded_stablecoin_runtime_status();
    if !status.ready {
        return Err(CloudError::PaymentRequired(
            "private USDCx settlement is not configured; refusing public fallback".to_string(),
        ));
    }
    Ok(status)
}

fn normalize_private_rail(raw: Option<&str>) -> Result<(), CloudError> {
    match raw.unwrap_or(ALEO_USDCX_SHIELDED_RAIL).trim() {
        ALEO_USDCX_SHIELDED_RAIL | SHIELDED_STABLECOIN_RAIL | "shielded" => Ok(()),
        other => Err(CloudError::BadRequest(format!(
            "unsupported private settlement rail '{other}'"
        ))),
    }
}

fn validate_aleo_recipient(raw: &str) -> Result<String, CloudError> {
    let value = raw.trim();
    if value.len() < 32 || !value.starts_with("aleo1") {
        return Err(CloudError::BadRequest(
            "enter a valid Aleo shielded recipient address".to_string(),
        ));
    }
    Ok(value.to_string())
}

fn recipient_hash(recipient: &str) -> String {
    hex::encode(Sha256::digest(recipient.as_bytes()))
}

fn recipient_preview(recipient: &str) -> String {
    if recipient.len() > 18 {
        format!(
            "{}...{}",
            &recipient[..8],
            &recipient[recipient.len() - 6..]
        )
    } else {
        "aleo1...".to_string()
    }
}

pub async fn create_private_transfer_intent(
    state: &AppState,
    user_id: Uuid,
    req: CreatePrivateTransferIntentRequest,
) -> Result<PrivateTransferIntentResponse, CloudError> {
    req.approval.require_for(NetworkScope::WalletTransfer)?;
    normalize_private_rail(req.rail.as_deref())?;
    let status = assert_private_rail_ready()?;

    if req.amount_micro_usdc <= 0 {
        return Err(CloudError::BadRequest(
            "amount_micro_usdc must be greater than zero".to_string(),
        ));
    }

    let recipient = validate_aleo_recipient(&req.to_shielded_address)?;
    let recipient_hash = recipient_hash(&recipient);
    let recipient_preview = recipient_preview(&recipient);
    let expires_at = Utc::now() + Duration::minutes(INTENT_TTL_MINUTES);

    let id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO private_wallet_transfers
            (user_id, rail, provider, network, asset, amount_micro_usdc,
             recipient_hash, recipient_preview, status, privacy_mode, network_scope,
             user_approved_at, approval_nonce, approval_summary, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'intent_pending',
                $9, $10, $11, $12, $13, $14)
        RETURNING id
        "#,
    )
    .bind(user_id)
    .bind(ALEO_USDCX_SHIELDED_RAIL)
    .bind(&status.provider)
    .bind(&status.network)
    .bind(&status.asset)
    .bind(req.amount_micro_usdc)
    .bind(&recipient_hash)
    .bind(&recipient_preview)
    .bind(req.approval.privacy_mode.as_deref())
    .bind(req.approval.network_scope.as_deref())
    .bind(req.approval.user_approved_at)
    .bind(req.approval.approval_nonce.as_deref())
    .bind(req.approval.approval_summary.as_deref())
    .bind(expires_at)
    .fetch_one(&state.db)
    .await?;

    Ok(PrivateTransferIntentResponse {
        id,
        rail: SHIELDED_STABLECOIN_RAIL,
        canonical_rail: ALEO_USDCX_SHIELDED_RAIL,
        provider: status.provider,
        network: status.network,
        asset: status.asset,
        amount_micro_usdc: req.amount_micro_usdc,
        recipient_preview,
        status: "intent_pending".to_string(),
        expires_at,
        privacy_disclosure: SHIELDED_STABLECOIN_DISCLOSURE,
        fallback_allowed: false,
    })
}

pub async fn submit_private_transfer_proof(
    state: &AppState,
    user_id: Uuid,
    req: SubmitPrivateTransferProofRequest,
) -> Result<PrivateTransferProofResponse, CloudError> {
    req.approval.require_for(NetworkScope::WalletTransfer)?;
    let recipient = validate_aleo_recipient(&req.to_shielded_address)?;
    let expected_recipient_hash = recipient_hash(&recipient);

    let row = sqlx::query_as::<
        _,
        (
            i64,
            String,
            String,
            String,
            String,
            String,
            String,
            chrono::DateTime<Utc>,
        ),
    >(
        r#"
        SELECT amount_micro_usdc, recipient_hash, recipient_preview, status,
               provider, network, asset, expires_at
        FROM private_wallet_transfers
        WHERE id = $1 AND user_id = $2
        "#,
    )
    .bind(req.intent_id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| CloudError::NotFound("private transfer intent not found".to_string()))?;

    let (
        amount,
        stored_recipient_hash,
        stored_preview,
        status,
        provider,
        network,
        asset,
        expires_at,
    ) = row;
    if stored_recipient_hash != expected_recipient_hash {
        return Err(CloudError::BadRequest(
            "proof recipient does not match the approved private transfer intent".to_string(),
        ));
    }
    if status != "intent_pending" && status != "submitted" {
        return Err(CloudError::BadRequest(
            "private transfer intent is no longer pending".to_string(),
        ));
    }
    if expires_at <= Utc::now() {
        sqlx::query("UPDATE private_wallet_transfers SET status = 'expired', updated_at = now() WHERE id = $1")
            .bind(req.intent_id)
            .execute(&state.db)
            .await?;
        return Err(CloudError::PaymentRequired(
            "private transfer approval expired".to_string(),
        ));
    }

    let verified = x402_service::verify_shielded_stablecoin_settlement(
        state,
        &req.proof,
        ShieldedSettlementContext {
            required_amount: amount,
            purpose: "wallet_private_transfer",
            destination: Some(&recipient),
            intent_id: Some(req.intent_id),
            agent_id: None,
            provider_id: None,
            model_id: None,
        },
    )
    .await?;

    sqlx::query(
        r#"
        UPDATE private_wallet_transfers
        SET status = 'verified',
            adapter_receipt_ref = $1,
            proof_digest = $2,
            verified_at = now(),
            updated_at = now()
        WHERE id = $3 AND user_id = $4
        "#,
    )
    .bind(&verified.receipt_ref)
    .bind(&verified.proof_digest)
    .bind(req.intent_id)
    .bind(user_id)
    .execute(&state.db)
    .await
    .map_err(|e| {
        if e.to_string().contains("unique") || e.to_string().contains("duplicate") {
            CloudError::PaymentRequired(
                "shielded payment already used (replay rejected)".to_string(),
            )
        } else {
            CloudError::Database(e)
        }
    })?;

    tracing::info!(
        user = %crate::privacy::log_id(&user_id),
        rail = ALEO_USDCX_SHIELDED_RAIL,
        "private USDCx transfer verified"
    );

    Ok(PrivateTransferProofResponse {
        id: req.intent_id,
        rail: SHIELDED_STABLECOIN_RAIL,
        canonical_rail: ALEO_USDCX_SHIELDED_RAIL,
        provider,
        network,
        asset,
        amount_micro_usdc: amount,
        recipient_preview: stored_preview,
        adapter_receipt_ref: verified.receipt_ref,
        status: "verified".to_string(),
        privacy_disclosure: SHIELDED_STABLECOIN_DISCLOSURE,
    })
}

pub async fn private_transfer_history(
    state: &AppState,
    user_id: Uuid,
    limit: i64,
) -> Result<Vec<PrivateTransferHistoryEntry>, CloudError> {
    let rows = sqlx::query_as::<
        _,
        (
            Uuid,
            String,
            String,
            String,
            String,
            i64,
            String,
            String,
            Option<String>,
            chrono::DateTime<Utc>,
            Option<chrono::DateTime<Utc>>,
        ),
    >(
        r#"
        SELECT id, rail, provider, network, asset, amount_micro_usdc,
               recipient_preview, status, adapter_receipt_ref, created_at, verified_at
        FROM private_wallet_transfers
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT $2
        "#,
    )
    .bind(user_id)
    .bind(limit.clamp(1, 100))
    .fetch_all(&state.db)
    .await?;

    Ok(rows
        .into_iter()
        .map(
            |(
                id,
                rail,
                provider,
                network,
                asset,
                amount_micro_usdc,
                recipient_preview,
                status,
                adapter_receipt_ref,
                created_at,
                verified_at,
            )| PrivateTransferHistoryEntry {
                id,
                rail,
                provider,
                network,
                asset,
                amount_micro_usdc,
                recipient_preview,
                status,
                adapter_receipt_ref,
                created_at,
                verified_at,
            },
        )
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_rail_accepts_canonical_and_legacy_names() {
        normalize_private_rail(None).unwrap();
        normalize_private_rail(Some(ALEO_USDCX_SHIELDED_RAIL)).unwrap();
        normalize_private_rail(Some(SHIELDED_STABLECOIN_RAIL)).unwrap();
        normalize_private_rail(Some("shielded")).unwrap();
    }

    #[test]
    fn private_rail_rejects_public_usdc() {
        let err = normalize_private_rail(Some("solana_public_usdc"))
            .unwrap_err()
            .to_string();
        assert!(err.contains("unsupported private settlement rail"));
    }

    #[test]
    fn aleo_recipient_validation_masks_without_storing_full_address() {
        let recipient = "aleo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";
        assert_eq!(validate_aleo_recipient(recipient).unwrap(), recipient);
        assert_eq!(recipient_preview(recipient), "aleo1qqq...qqqqqq");
        assert_ne!(recipient_hash(recipient), recipient);
    }

    #[test]
    fn aleo_recipient_validation_rejects_public_solana_address_shape() {
        let err = validate_aleo_recipient("11111111111111111111111111111111")
            .unwrap_err()
            .to_string();
        assert!(err.contains("valid Aleo shielded recipient"));
    }
}
