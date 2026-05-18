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
pub const INSTITUTIONAL_READINESS_VERSION: &str = "institutional-usdcx-v1";
pub const SIGNING_MODE_TURNKEY_USER: &str = "turnkey_user";
pub const SIGNING_MODE_ALEO_DEVICE: &str = "aleo_device";
const SIGNING_MODE_MANUAL_PROOF: &str = "manual_proof";
const SELECTIVE_DISCLOSURE_TEXT: &str = "Selective disclosure export includes redacted receipt metadata, amount, policy hash, verification time, and approval summary. Raw shielded recipient and proof payload are not exported by default.";

#[derive(Debug, Deserialize)]
pub struct CreatePrivateTransferIntentRequest {
    #[serde(alias = "to", alias = "recipient")]
    pub to_shielded_address: String,
    #[serde(alias = "amount")]
    pub amount_micro_usdc: i64,
    #[serde(default)]
    pub rail: Option<String>,
    pub signing_mode: Option<String>,
    pub signer_key_id: Option<String>,
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

#[derive(Debug, Deserialize)]
pub struct SubmitSignedPrivateTransferRequest {
    pub intent_id: Uuid,
    #[serde(alias = "to", alias = "recipient")]
    pub to_shielded_address: String,
    pub proof: PaymentProof,
    pub signing_mode: String,
    pub signer_key_id: String,
    pub signer_attestation: Option<String>,
    #[serde(flatten)]
    pub approval: PrivacyApproval,
}

#[derive(Debug, Deserialize)]
pub struct ExportPrivateTransferReceiptRequest {
    pub reason: Option<String>,
    pub audience: Option<String>,
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
    pub signing_mode: String,
    pub signer_key_id: String,
    pub policy_hash: String,
    pub institutional_readiness_version: &'static str,
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
    pub signing_mode: Option<String>,
    pub signer_key_id: Option<String>,
    pub policy_hash: Option<String>,
    pub selective_disclosure_receipt_hash: Option<String>,
    pub institutional_readiness_version: Option<String>,
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
    pub signing_mode: String,
    pub signer_key_id: String,
    pub policy_hash: String,
    pub selective_disclosure_receipt_hash: String,
    pub institutional_readiness_version: &'static str,
}

#[derive(Debug, Serialize)]
pub struct PrivateTransferReceiptResponse {
    pub id: Uuid,
    pub rail: String,
    pub provider: String,
    pub network: String,
    pub asset: String,
    pub amount_micro_usdc: i64,
    pub recipient_preview: String,
    pub status: String,
    pub adapter_receipt_ref: Option<String>,
    pub signing_mode: Option<String>,
    pub signer_key_id: Option<String>,
    pub policy_hash: Option<String>,
    pub selective_disclosure_receipt_hash: Option<String>,
    pub institutional_readiness_version: Option<String>,
    pub verified_at: Option<chrono::DateTime<Utc>>,
    pub privacy_disclosure: &'static str,
}

#[derive(Debug, Serialize)]
pub struct PrivateTransferReceiptExportResponse {
    pub export_id: Uuid,
    pub transfer: PrivateTransferReceiptResponse,
    pub export_disclosure: &'static str,
    pub created_at: chrono::DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct InstitutionalReadinessResponse {
    pub ready: bool,
    pub version: &'static str,
    pub claim: &'static str,
    pub private_rail_ready: bool,
    pub verifier_ready: bool,
    pub signer_ready: bool,
    pub funded_smoke_test_passed: bool,
    pub server_held_signing_disabled: bool,
    pub audit_export_enabled: bool,
    pub open_high_critical_findings: i64,
    pub last_canary_at: Option<String>,
    pub blocking_reasons: Vec<String>,
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

fn env_flag(name: &str) -> bool {
    std::env::var(name)
        .map(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes"))
        .unwrap_or(false)
}

fn env_i64(name: &str) -> i64 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.trim().parse::<i64>().ok())
        .unwrap_or(0)
}

fn normalize_signing_mode(
    raw: Option<&str>,
    allow_manual: bool,
) -> Result<&'static str, CloudError> {
    let raw = raw
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            CloudError::BadRequest(
                "private USDCx transfer requires user-held signing_mode".to_string(),
            )
        })?;

    match raw {
        SIGNING_MODE_TURNKEY_USER => Ok(SIGNING_MODE_TURNKEY_USER),
        SIGNING_MODE_ALEO_DEVICE => Ok(SIGNING_MODE_ALEO_DEVICE),
        SIGNING_MODE_MANUAL_PROOF if allow_manual => Ok(SIGNING_MODE_MANUAL_PROOF),
        SIGNING_MODE_MANUAL_PROOF => Err(CloudError::BadRequest(
            "manual private proof submission is disabled outside debug builds".to_string(),
        )),
        other => Err(CloudError::BadRequest(format!(
            "unsupported private USDCx signing mode '{other}'"
        ))),
    }
}

fn normalize_signer_key_id(raw: Option<&str>) -> Result<String, CloudError> {
    let key_id = raw
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            CloudError::BadRequest("private USDCx transfer requires signer_key_id".to_string())
        })?;
    if key_id.len() < 6 || key_id.len() > 256 {
        return Err(CloudError::BadRequest(
            "signer_key_id must be between 6 and 256 characters".to_string(),
        ));
    }
    Ok(key_id.to_string())
}

fn manual_private_proof_allowed(
    env_value: Option<&str>,
    ghola_env: Option<&str>,
    debug_build: bool,
) -> bool {
    if debug_build {
        return true;
    }
    let flag = env_value
        .map(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes"))
        .unwrap_or(false);
    let development = ghola_env
        .map(|v| {
            matches!(
                v.trim().to_ascii_lowercase().as_str(),
                "dev" | "development" | "local"
            )
        })
        .unwrap_or(false);
    flag && development
}

fn manual_private_proof_enabled() -> bool {
    manual_private_proof_allowed(
        std::env::var("GHOLA_ALLOW_MANUAL_PRIVATE_PROOF")
            .ok()
            .as_deref(),
        std::env::var("GHOLA_ENV").ok().as_deref(),
        cfg!(debug_assertions),
    )
}

fn server_held_signing_disabled() -> bool {
    !env_flag("TURNKEY_SERVER_SIGNING_ENABLED")
        && !env_flag("TURNKEY_SERVER_CONTROLLED_WALLETS_ENABLED")
}

fn funded_smoke_test_passed() -> bool {
    env_flag("GHOLA_INSTITUTIONAL_FUNDED_SMOKE_PASSED")
        || env_flag("GHOLA_PRIVATE_USDCX_FUNDED_SMOKE_PASSED")
}

fn private_signer_ready() -> bool {
    env_flag("GHOLA_PRIVATE_USDCX_SIGNER_READY")
}

fn hash_text(raw: &str) -> String {
    hex::encode(Sha256::digest(raw.as_bytes()))
}

fn private_policy_hash(
    amount_micro_usdc: i64,
    recipient_hash: &str,
    network: &str,
    asset: &str,
    signing_mode: &str,
    signer_key_id: &str,
    approval: &PrivacyApproval,
) -> String {
    hash_text(&format!(
        "v={INSTITUTIONAL_READINESS_VERSION}\namount={amount_micro_usdc}\nrecipient_hash={recipient_hash}\nnetwork={network}\nasset={asset}\nsigning_mode={signing_mode}\nsigner_key_id={signer_key_id}\napproval_nonce={}\napproval_summary={}",
        approval.approval_nonce.as_deref().unwrap_or_default(),
        approval.approval_summary.as_deref().unwrap_or_default()
    ))
}

fn selective_disclosure_receipt_hash(
    transfer_id: Uuid,
    amount_micro_usdc: i64,
    recipient_hash: &str,
    receipt_ref: &str,
    proof_digest: &str,
    policy_hash: &str,
) -> String {
    hash_text(&format!(
        "v={INSTITUTIONAL_READINESS_VERSION}\ntransfer_id={transfer_id}\namount={amount_micro_usdc}\nrecipient_hash={recipient_hash}\nreceipt_ref={receipt_ref}\nproof_digest={proof_digest}\npolicy_hash={policy_hash}"
    ))
}

fn optional_hash(raw: Option<&str>) -> Option<String> {
    raw.map(str::trim).filter(|s| !s.is_empty()).map(hash_text)
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

async fn insert_private_transfer_audit_event(
    state: &AppState,
    user_id: Uuid,
    transfer_id: Uuid,
    event_type: &str,
    policy_hash: Option<&str>,
    receipt_hash: Option<&str>,
    recipient_preview: &str,
) -> Result<(), CloudError> {
    sqlx::query(
        r#"
        INSERT INTO private_wallet_transfer_audit_events
            (user_id, transfer_id, event_type, policy_hash, receipt_hash, recipient_preview)
        VALUES ($1, $2, $3, $4, $5, $6)
        "#,
    )
    .bind(user_id)
    .bind(transfer_id)
    .bind(event_type)
    .bind(policy_hash)
    .bind(receipt_hash)
    .bind(recipient_preview)
    .execute(&state.db)
    .await?;
    Ok(())
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
    let signing_mode =
        normalize_signing_mode(req.signing_mode.as_deref(), manual_private_proof_enabled())?;
    let signer_key_id = normalize_signer_key_id(req.signer_key_id.as_deref())?;

    if req.amount_micro_usdc <= 0 {
        return Err(CloudError::BadRequest(
            "amount_micro_usdc must be greater than zero".to_string(),
        ));
    }

    let recipient = validate_aleo_recipient(&req.to_shielded_address)?;
    let recipient_hash = recipient_hash(&recipient);
    let recipient_preview = recipient_preview(&recipient);
    let expires_at = Utc::now() + Duration::minutes(INTENT_TTL_MINUTES);
    let policy_hash = private_policy_hash(
        req.amount_micro_usdc,
        &recipient_hash,
        &status.network,
        &status.asset,
        signing_mode,
        &signer_key_id,
        &req.approval,
    );

    let id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO private_wallet_transfers
            (user_id, rail, provider, network, asset, amount_micro_usdc,
             recipient_hash, recipient_preview, status, privacy_mode, network_scope,
             user_approved_at, approval_nonce, approval_summary, expires_at,
             signing_mode, signer_key_id, policy_hash, institutional_readiness_version)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'intent_pending',
                $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
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
    .bind(signing_mode)
    .bind(&signer_key_id)
    .bind(&policy_hash)
    .bind(INSTITUTIONAL_READINESS_VERSION)
    .fetch_one(&state.db)
    .await?;

    insert_private_transfer_audit_event(
        state,
        user_id,
        id,
        "intent_created",
        Some(&policy_hash),
        None,
        &recipient_preview,
    )
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
        signing_mode: signing_mode.to_string(),
        signer_key_id,
        policy_hash,
        institutional_readiness_version: INSTITUTIONAL_READINESS_VERSION,
    })
}

pub async fn submit_private_transfer_proof(
    state: &AppState,
    user_id: Uuid,
    req: SubmitPrivateTransferProofRequest,
) -> Result<PrivateTransferProofResponse, CloudError> {
    if !manual_private_proof_enabled() {
        return Err(CloudError::BadRequest(
            "manual private proof submission is disabled outside debug builds; use signed transfer submission"
                .to_string(),
        ));
    }
    submit_signed_private_transfer(
        state,
        user_id,
        SubmitSignedPrivateTransferRequest {
            intent_id: req.intent_id,
            to_shielded_address: req.to_shielded_address,
            proof: req.proof,
            signing_mode: SIGNING_MODE_MANUAL_PROOF.to_string(),
            signer_key_id: "debug-manual-proof".to_string(),
            signer_attestation: None,
            approval: req.approval,
        },
        true,
    )
    .await
}

pub async fn submit_signed_private_transfer(
    state: &AppState,
    user_id: Uuid,
    req: SubmitSignedPrivateTransferRequest,
    allow_manual: bool,
) -> Result<PrivateTransferProofResponse, CloudError> {
    req.approval.require_for(NetworkScope::WalletTransfer)?;
    let signing_mode = normalize_signing_mode(Some(&req.signing_mode), allow_manual)?;
    let signer_key_id = normalize_signer_key_id(Some(&req.signer_key_id))?;
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
            Option<String>,
            Option<String>,
            Option<String>,
        ),
    >(
        r#"
        SELECT amount_micro_usdc, recipient_hash, recipient_preview, status,
               provider, network, asset, expires_at, signing_mode, signer_key_id, policy_hash
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
        stored_signing_mode,
        stored_signer_key_id,
        stored_policy_hash,
    ) = row;
    if stored_signing_mode.as_deref() != Some(signing_mode) {
        return Err(CloudError::BadRequest(
            "signed transfer signing_mode does not match the approved private transfer intent"
                .to_string(),
        ));
    }
    if stored_signer_key_id.as_deref() != Some(signer_key_id.as_str()) {
        return Err(CloudError::BadRequest(
            "signed transfer signer_key_id does not match the approved private transfer intent"
                .to_string(),
        ));
    }
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

    let policy_hash = stored_policy_hash.ok_or_else(|| {
        CloudError::BadRequest("private transfer intent is missing policy_hash".to_string())
    })?;
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
    let receipt_hash = selective_disclosure_receipt_hash(
        req.intent_id,
        amount,
        &stored_recipient_hash,
        &verified.receipt_ref,
        &verified.proof_digest,
        &policy_hash,
    );
    let signer_attestation_hash = optional_hash(req.signer_attestation.as_deref());

    sqlx::query(
        r#"
        UPDATE private_wallet_transfers
        SET status = 'verified',
            adapter_receipt_ref = $1,
            proof_digest = $2,
            verified_at = now(),
            updated_at = now(),
            signing_mode = $3,
            signer_key_id = $4,
            signer_attestation_hash = $5,
            selective_disclosure_receipt_hash = $6,
            institutional_readiness_version = $7
        WHERE id = $8 AND user_id = $9
        "#,
    )
    .bind(&verified.receipt_ref)
    .bind(&verified.proof_digest)
    .bind(signing_mode)
    .bind(&signer_key_id)
    .bind(signer_attestation_hash.as_deref())
    .bind(&receipt_hash)
    .bind(INSTITUTIONAL_READINESS_VERSION)
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

    insert_private_transfer_audit_event(
        state,
        user_id,
        req.intent_id,
        "receipt_verified",
        Some(&policy_hash),
        Some(&receipt_hash),
        &stored_preview,
    )
    .await?;

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
        signing_mode: signing_mode.to_string(),
        signer_key_id,
        policy_hash,
        selective_disclosure_receipt_hash: receipt_hash,
        institutional_readiness_version: INSTITUTIONAL_READINESS_VERSION,
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
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            chrono::DateTime<Utc>,
            Option<chrono::DateTime<Utc>>,
        ),
    >(
        r#"
        SELECT id, rail, provider, network, asset, amount_micro_usdc,
               recipient_preview, status, adapter_receipt_ref, signing_mode, signer_key_id,
               policy_hash, selective_disclosure_receipt_hash, institutional_readiness_version,
               created_at, verified_at
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
                signing_mode,
                signer_key_id,
                policy_hash,
                selective_disclosure_receipt_hash,
                institutional_readiness_version,
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
                signing_mode,
                signer_key_id,
                policy_hash,
                selective_disclosure_receipt_hash,
                institutional_readiness_version,
                created_at,
                verified_at,
            },
        )
        .collect())
}

pub async fn private_transfer_receipt(
    state: &AppState,
    user_id: Uuid,
    transfer_id: Uuid,
) -> Result<PrivateTransferReceiptResponse, CloudError> {
    fetch_private_transfer_receipt(state, user_id, transfer_id).await
}

pub async fn export_private_transfer_receipt(
    state: &AppState,
    user_id: Uuid,
    transfer_id: Uuid,
    req: ExportPrivateTransferReceiptRequest,
) -> Result<PrivateTransferReceiptExportResponse, CloudError> {
    req.approval.require_for(NetworkScope::WalletTransfer)?;
    let transfer = fetch_private_transfer_receipt(state, user_id, transfer_id).await?;
    if transfer.status != "verified" {
        return Err(CloudError::BadRequest(
            "selective disclosure export requires a verified private transfer".to_string(),
        ));
    }
    let receipt_hash = transfer
        .selective_disclosure_receipt_hash
        .as_deref()
        .ok_or_else(|| {
            CloudError::BadRequest("verified transfer is missing receipt hash".to_string())
        })?;
    let reason = req.reason.as_deref().unwrap_or("user_export").trim();
    let audience = req.audience.as_deref().unwrap_or("user").trim();
    let (export_id, created_at): (Uuid, chrono::DateTime<Utc>) = sqlx::query_as(
        r#"
        INSERT INTO private_wallet_receipt_exports
            (user_id, transfer_id, receipt_hash, export_reason, export_audience,
             approval_nonce, approval_summary)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id, created_at
        "#,
    )
    .bind(user_id)
    .bind(transfer_id)
    .bind(receipt_hash)
    .bind(reason)
    .bind(audience)
    .bind(req.approval.approval_nonce.as_deref())
    .bind(req.approval.approval_summary.as_deref())
    .fetch_one(&state.db)
    .await?;

    insert_private_transfer_audit_event(
        state,
        user_id,
        transfer_id,
        "receipt_exported",
        transfer.policy_hash.as_deref(),
        Some(receipt_hash),
        &transfer.recipient_preview,
    )
    .await?;

    Ok(PrivateTransferReceiptExportResponse {
        export_id,
        transfer,
        export_disclosure: SELECTIVE_DISCLOSURE_TEXT,
        created_at,
    })
}

async fn fetch_private_transfer_receipt(
    state: &AppState,
    user_id: Uuid,
    transfer_id: Uuid,
) -> Result<PrivateTransferReceiptResponse, CloudError> {
    let row = sqlx::query_as::<
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
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<chrono::DateTime<Utc>>,
        ),
    >(
        r#"
        SELECT id, rail, provider, network, asset, amount_micro_usdc,
               recipient_preview, status, adapter_receipt_ref, signing_mode, signer_key_id,
               policy_hash, selective_disclosure_receipt_hash,
               institutional_readiness_version, verified_at
        FROM private_wallet_transfers
        WHERE id = $1 AND user_id = $2
        "#,
    )
    .bind(transfer_id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| CloudError::NotFound("private transfer receipt not found".to_string()))?;

    let (
        id,
        rail,
        provider,
        network,
        asset,
        amount_micro_usdc,
        recipient_preview,
        status,
        adapter_receipt_ref,
        signing_mode,
        signer_key_id,
        policy_hash,
        selective_disclosure_receipt_hash,
        institutional_readiness_version,
        verified_at,
    ) = row;

    Ok(PrivateTransferReceiptResponse {
        id,
        rail,
        provider,
        network,
        asset,
        amount_micro_usdc,
        recipient_preview,
        status,
        adapter_receipt_ref,
        signing_mode,
        signer_key_id,
        policy_hash,
        selective_disclosure_receipt_hash,
        institutional_readiness_version,
        verified_at,
        privacy_disclosure: SHIELDED_STABLECOIN_DISCLOSURE,
    })
}

pub fn institutional_readiness() -> InstitutionalReadinessResponse {
    let shielded = x402_service::shielded_stablecoin_runtime_status();
    let funded_smoke_test_passed = funded_smoke_test_passed();
    let server_held_signing_disabled = server_held_signing_disabled();
    let signer_ready = private_signer_ready();
    let open_high_critical_findings = env_i64("GHOLA_OPEN_HIGH_CRITICAL_FINDINGS");
    let audit_export_enabled = true;
    let last_canary_at = std::env::var("GHOLA_PRIVATE_USDCX_LAST_CANARY_AT")
        .ok()
        .filter(|s| !s.trim().is_empty());

    let mut blocking_reasons = Vec::new();
    if !shielded.ready {
        blocking_reasons.push("private Aleo USDCx rail is not ready".to_string());
    }
    if !shielded.verifier_ready {
        blocking_reasons.push("shielded verifier is not marked ready".to_string());
    }
    if !signer_ready {
        blocking_reasons.push("user-held private signer is not marked ready".to_string());
    }
    if !funded_smoke_test_passed {
        blocking_reasons.push("real funded USDCx smoke test has not passed".to_string());
    }
    if !server_held_signing_disabled {
        blocking_reasons
            .push("server-controlled Turnkey signing or wallet creation is enabled".to_string());
    }
    if open_high_critical_findings > 0 {
        blocking_reasons.push("open High/Critical security findings remain".to_string());
    }

    let ready = shielded.ready
        && shielded.verifier_ready
        && signer_ready
        && funded_smoke_test_passed
        && server_held_signing_disabled
        && audit_export_enabled
        && open_high_critical_findings == 0;

    InstitutionalReadinessResponse {
        ready,
        version: INSTITUTIONAL_READINESS_VERSION,
        claim: "Designed for institutional pilots: fail-closed private USDCx settlement, user-held signing, explicit approvals, and selective disclosure receipts.",
        private_rail_ready: shielded.ready,
        verifier_ready: shielded.verifier_ready,
        signer_ready,
        funded_smoke_test_passed,
        server_held_signing_disabled,
        audit_export_enabled,
        open_high_critical_findings,
        last_canary_at,
        blocking_reasons,
    }
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

    #[test]
    fn private_signing_mode_requires_user_held_mode() {
        let err = normalize_signing_mode(None, false).unwrap_err().to_string();
        assert!(err.contains("signing_mode"));
        normalize_signing_mode(Some(SIGNING_MODE_TURNKEY_USER), false).unwrap();
        normalize_signing_mode(Some(SIGNING_MODE_ALEO_DEVICE), false).unwrap();
        let err = normalize_signing_mode(Some(SIGNING_MODE_MANUAL_PROOF), false)
            .unwrap_err()
            .to_string();
        assert!(err.contains("manual private proof"));
    }

    #[test]
    fn manual_private_proof_is_debug_or_local_only() {
        assert!(!manual_private_proof_allowed(None, None, false));
        assert!(!manual_private_proof_allowed(
            Some("true"),
            Some("production"),
            false
        ));
        assert!(manual_private_proof_allowed(
            Some("true"),
            Some("development"),
            false
        ));
        assert!(manual_private_proof_allowed(None, None, true));
    }

    #[test]
    fn policy_and_receipt_hashes_do_not_embed_recipient() {
        let recipient = "aleo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";
        let recipient_hash = recipient_hash(recipient);
        let approval = PrivacyApproval {
            privacy_mode: Some(crate::privacy::STRICT_LOCAL.to_string()),
            network_scope: Some(NetworkScope::WalletTransfer.as_str().to_string()),
            user_approved_at: Some(Utc::now()),
            approval_nonce: Some("nonce-123456789012345".to_string()),
            approval_summary: Some("Approve private transfer".to_string()),
        };
        let policy = private_policy_hash(
            1_000_000,
            &recipient_hash,
            "aleo:mainnet",
            "USDCx",
            SIGNING_MODE_ALEO_DEVICE,
            "device-key-1",
            &approval,
        );
        let receipt = selective_disclosure_receipt_hash(
            Uuid::nil(),
            1_000_000,
            &recipient_hash,
            "receipt-1",
            "proof-1",
            &policy,
        );
        assert_ne!(policy, recipient);
        assert_ne!(receipt, recipient);
        assert_eq!(policy.len(), 64);
        assert_eq!(receipt.len(), 64);
    }
}
