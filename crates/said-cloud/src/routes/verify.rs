use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Extension;
use axum::Json;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

// ── UCAN Verification (inline — avoids heavy said-core dependency) ──

const ED25519_MULTICODEC: [u8; 2] = [0xed, 0x01];

#[derive(Deserialize)]
struct UcanHeader {
    alg: String,
}

#[derive(Clone, Debug, Deserialize)]
struct UcanPayload {
    iss: String,
    #[allow(dead_code)]
    aud: String,
    exp: i64,
    #[allow(dead_code)]
    iat: i64,
    att: Vec<UcanAttenuation>,
}

#[derive(Clone, Debug, Deserialize)]
struct UcanAttenuation {
    #[allow(dead_code)]
    with: String,
    can: String,
}

fn pub_key_from_did(did: &str) -> Result<VerifyingKey, String> {
    let z_part = did
        .strip_prefix("did:key:z")
        .ok_or("invalid did:key format")?;
    let bytes = bs58::decode(z_part)
        .into_vec()
        .map_err(|e| format!("base58 decode error: {e}"))?;
    if bytes.len() < 34 || bytes[0..2] != ED25519_MULTICODEC {
        return Err("invalid did:key payload".into());
    }
    let key_bytes: [u8; 32] = bytes[2..34]
        .try_into()
        .map_err(|_| "invalid key length")?;
    VerifyingKey::from_bytes(&key_bytes).map_err(|e| format!("invalid ed25519 key: {e}"))
}

/// Verify a UCAN token, extracting issuer from the token's `iss` field.
/// Returns the payload if valid, or an error string.
fn verify_ucan_token(token: &str) -> Result<UcanPayload, String> {
    let parts: Vec<&str> = token.splitn(3, '.').collect();
    if parts.len() != 3 {
        return Err("invalid JWT: expected 3 parts".into());
    }

    let (header_b64, payload_b64, sig_b64) = (parts[0], parts[1], parts[2]);

    // Verify header
    let header_bytes = URL_SAFE_NO_PAD
        .decode(header_b64)
        .map_err(|e| format!("header decode: {e}"))?;
    let header: UcanHeader =
        serde_json::from_slice(&header_bytes).map_err(|e| format!("header parse: {e}"))?;
    if header.alg != "EdDSA" {
        return Err(format!("unsupported algorithm: {}", header.alg));
    }

    // Parse payload
    let payload_bytes = URL_SAFE_NO_PAD
        .decode(payload_b64)
        .map_err(|e| format!("payload decode: {e}"))?;
    let payload: UcanPayload =
        serde_json::from_slice(&payload_bytes).map_err(|e| format!("payload parse: {e}"))?;

    // Derive issuer key from DID and verify signature
    let issuer_key = pub_key_from_did(&payload.iss)?;
    let message = format!("{}.{}", header_b64, payload_b64);
    let sig_bytes = URL_SAFE_NO_PAD
        .decode(sig_b64)
        .map_err(|e| format!("sig decode: {e}"))?;
    let sig_array: [u8; 64] = sig_bytes
        .try_into()
        .map_err(|_| "invalid signature length")?;
    let signature = Signature::from_bytes(&sig_array);
    issuer_key
        .verify(message.as_bytes(), &signature)
        .map_err(|_| "signature verification failed")?;

    // Check expiry
    let now = chrono::Utc::now().timestamp();
    if payload.exp <= now {
        return Err("token expired".into());
    }

    Ok(payload)
}

// ── Request/Response Types ──

#[derive(Debug, Deserialize)]
pub struct VerifyAgentRequest {
    pub agent_did: String,
    pub ucan_token: Option<String>,
    pub required_capabilities: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
pub struct VerifyAgentResponse {
    pub valid: bool,
    pub agent_did: String,
    pub display_name: Option<String>,
    pub profile_type: Option<String>,
    pub on_chain_registered: bool,
    pub verified_badge: bool,
    pub capabilities: Vec<String>,
    pub trust_score: f32,
    pub spending_summary: Option<AgentSpendingSummary>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct AgentSpendingSummary {
    pub total_transactions: i64,
    pub total_spent_micro_usdc: i64,
    pub avg_transaction_micro_usdc: i64,
    pub first_transaction_at: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Debug, Deserialize)]
pub struct VerifyCapabilityRequest {
    pub agent_did: String,
    pub ucan_token: String,
    pub capability: String,
}

#[derive(Debug, Serialize)]
pub struct VerifyCapabilityResponse {
    pub granted: bool,
    pub capability: String,
    pub agent_did: String,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct DidLookupResponse {
    pub did: String,
    pub found: bool,
    pub profile_type: Option<String>,
    pub display_name: Option<String>,
    pub on_chain_registered: bool,
    pub verified_badge: bool,
}

// ── Service API Key Auth ──

/// Extract and validate service API key from X-Service-Key header.
/// Returns (service_id, owner_id) if valid.
async fn validate_service_key(
    state: &AppState,
    key: &str,
) -> Result<(Uuid, Uuid), AppError> {
    let key_hash = sha256_hex(key);

    let row: Option<(Uuid, Uuid, bool)> = sqlx::query_as(
        "SELECT service_id, owner_id, active FROM service_api_keys WHERE key_hash = $1",
    )
    .bind(&key_hash)
    .fetch_optional(&state.db)
    .await?;

    match row {
        Some((service_id, owner_id, true)) => {
            // Update last_used_at
            sqlx::query("UPDATE service_api_keys SET last_used_at = NOW() WHERE key_hash = $1")
                .bind(&key_hash)
                .execute(&state.db)
                .await
                .ok();
            Ok((service_id, owner_id))
        }
        Some((_, _, false)) => Err(AppError::Unauthorized("API key is deactivated".into())),
        None => Err(AppError::Unauthorized("Invalid API key".into())),
    }
}

fn sha256_hex(input: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    hex::encode(hasher.finalize())
}

fn extract_service_key(headers: &axum::http::HeaderMap) -> Result<String, AppError> {
    headers
        .get("X-Service-Key")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .ok_or_else(|| AppError::Unauthorized("Missing X-Service-Key header".into()))
}

// ── Handlers ──

/// POST /v1/verify/agent (service API key auth)
/// Merchants call this to verify an agent's identity and capabilities.
pub async fn verify_agent(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Json(req): Json<VerifyAgentRequest>,
) -> AppResult<Json<VerifyAgentResponse>> {
    let start = std::time::Instant::now();

    // Authenticate the merchant
    let service_key = extract_service_key(&headers)?;
    let (service_id, _owner_id) = validate_service_key(&state, &service_key).await?;

    // Rate limit: 100 req/min per service key
    let rate_key = format!("svc_verify:{}", service_id);
    if let Err(retry_after) = state.rate_limiter.check(&rate_key, 100) {
        return Err(AppError::TooManyRequests(retry_after));
    }

    // Get merchant DID for audit logging
    let merchant_did: String = sqlx::query_scalar(
        "SELECT owner_did FROM service_listings WHERE id = $1",
    )
    .bind(service_id)
    .fetch_optional(&state.db)
    .await?
    .unwrap_or_default();

    // Look up agent profile
    let (profile_type, display_name, on_chain_registered) =
        lookup_agent_profile(&state, &req.agent_did).await;

    // Check verified badge
    let verified_badge = check_verified_badge(&state, &req.agent_did).await;

    // Verify UCAN token if provided
    let (ucan_valid, capabilities, ucan_error) = if let Some(ref token) = req.ucan_token {
        // Check revocation registry first
        let token_hash = {
            use sha2::{Digest, Sha256};
            let mut h = Sha256::new();
            h.update(token.as_bytes());
            hex::encode(h.finalize())
        };
        let is_revoked: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM ucan_revocations WHERE token_hash = $1)",
        )
        .bind(&token_hash)
        .fetch_one(&state.db)
        .await
        .unwrap_or(false);

        if is_revoked {
            (false, vec![], Some("Token has been revoked".to_string()))
        } else {
        match verify_ucan_token(token) {
            Ok(payload) => {
                // Verify the issuer DID matches the claimed agent_did
                if payload.iss != req.agent_did {
                    (false, vec![], Some("UCAN issuer does not match agent_did".to_string()))
                } else {
                    let caps: Vec<String> = payload.att.iter().map(|a| a.can.clone()).collect();

                    // Check required capabilities if specified
                    if let Some(ref required) = req.required_capabilities {
                        let has_all = required.iter().all(|req_cap| {
                            caps.iter().any(|c| c == req_cap || c == "said/*")
                        });
                        if !has_all {
                            (false, caps, Some("Insufficient capabilities".to_string()))
                        } else {
                            (true, caps, None)
                        }
                    } else {
                        (true, caps, None)
                    }
                }
            }
            Err(e) => (false, vec![], Some(e)),
        }
        }
    } else {
        // No UCAN token — identity-only verification
        (profile_type.is_some(), vec![], None)
    };

    // Compute trust score (prefer cached reputation_scores, fall back to ad-hoc)
    let trust_score = match get_cached_trust_score(&state, &req.agent_did).await {
        Some(score) => score,
        None => {
            compute_trust_score(
                profile_type.is_some(),
                on_chain_registered,
                verified_badge,
                &state,
                &req.agent_did,
            )
            .await
        }
    };

    // Fetch spending summary
    let spending_summary = fetch_spending_summary(&state, &req.agent_did).await;

    let valid = ucan_valid && ucan_error.is_none();
    let result_str = if valid {
        "valid"
    } else if ucan_error.as_deref() == Some("token expired") {
        "expired"
    } else if ucan_error.as_deref() == Some("Insufficient capabilities") {
        "insufficient_capability"
    } else if profile_type.is_none() {
        "unknown_agent"
    } else {
        "invalid"
    };

    let latency_ms = start.elapsed().as_millis() as i32;

    // Log the verification
    sqlx::query(
        r#"INSERT INTO auth_verifications
            (service_id, merchant_did, agent_did, requested_capabilities, result, trust_score, latency_ms)
        VALUES ($1, $2, $3, $4, $5, $6, $7)"#,
    )
    .bind(service_id)
    .bind(&merchant_did)
    .bind(&req.agent_did)
    .bind(
        req.required_capabilities
            .as_deref()
            .unwrap_or(&[]),
    )
    .bind(result_str)
    .bind(trust_score)
    .bind(latency_ms)
    .execute(&state.db)
    .await
    .ok(); // Don't fail the request if logging fails

    Ok(Json(VerifyAgentResponse {
        valid,
        agent_did: req.agent_did,
        display_name,
        profile_type,
        on_chain_registered,
        verified_badge,
        capabilities,
        trust_score,
        spending_summary,
        error: ucan_error,
    }))
}

/// POST /v1/verify/capability (service API key auth)
/// Quick check: does this agent's UCAN grant a specific capability?
pub async fn verify_capability(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Json(req): Json<VerifyCapabilityRequest>,
) -> AppResult<Json<VerifyCapabilityResponse>> {
    let service_key = extract_service_key(&headers)?;
    let _ids = validate_service_key(&state, &service_key).await?;

    match verify_ucan_token(&req.ucan_token) {
        Ok(payload) => {
            if payload.iss != req.agent_did {
                return Ok(Json(VerifyCapabilityResponse {
                    granted: false,
                    capability: req.capability,
                    agent_did: req.agent_did,
                    error: Some("UCAN issuer does not match agent_did".into()),
                }));
            }

            let granted = payload
                .att
                .iter()
                .any(|a| a.can == req.capability || a.can == "said/*");

            Ok(Json(VerifyCapabilityResponse {
                granted,
                capability: req.capability,
                agent_did: req.agent_did,
                error: None,
            }))
        }
        Err(e) => Ok(Json(VerifyCapabilityResponse {
            granted: false,
            capability: req.capability,
            agent_did: req.agent_did,
            error: Some(e),
        })),
    }
}

/// GET /v1/verify/did/{did} (public)
/// Simple DID lookup — does this identity exist in SAID?
pub async fn lookup_did(
    State(state): State<Arc<AppState>>,
    Path(did): Path<String>,
) -> AppResult<Json<DidLookupResponse>> {
    let (profile_type, display_name, on_chain_registered) =
        lookup_agent_profile(&state, &did).await;
    let verified_badge = check_verified_badge(&state, &did).await;

    Ok(Json(DidLookupResponse {
        did,
        found: profile_type.is_some(),
        profile_type,
        display_name,
        on_chain_registered,
        verified_badge,
    }))
}

// ── Service API Key Management (JWT protected) ──

#[derive(Debug, Deserialize)]
pub struct CreateServiceKeyRequest {
    pub service_id: Uuid,
    pub name: Option<String>,
    pub scopes: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
pub struct CreateServiceKeyResponse {
    pub id: Uuid,
    pub service_id: Uuid,
    pub name: String,
    pub key: String, // Only returned on creation
    pub scopes: Vec<String>,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

/// POST /v1/service-keys (JWT protected)
pub async fn create_service_key(
    State(state): State<Arc<AppState>>,
    Extension(claims): axum::Extension<crate::auth::Claims>,
    Json(req): Json<CreateServiceKeyRequest>,
) -> AppResult<(StatusCode, Json<CreateServiceKeyResponse>)> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("Invalid token".into()))?;

    // Verify user owns the service
    let owner_id: Option<Uuid> =
        sqlx::query_scalar("SELECT owner_id FROM service_listings WHERE id = $1")
            .bind(req.service_id)
            .fetch_optional(&state.db)
            .await?;

    match owner_id {
        None => return Err(AppError::NotFound("Service not found".into())),
        Some(oid) if oid != user_id => {
            return Err(AppError::Unauthorized("Not your service".into()))
        }
        _ => {}
    }

    // Generate a random API key
    let raw_key = format!("sk_{}", generate_random_key());
    let key_hash = sha256_hex(&raw_key);
    let name = req.name.unwrap_or_else(|| "default".into());
    let scopes: Vec<String> = req.scopes.unwrap_or_else(|| vec!["verify".into()]);

    let (id, created_at): (Uuid, chrono::DateTime<chrono::Utc>) = sqlx::query_as(
        r#"INSERT INTO service_api_keys (service_id, owner_id, key_hash, name, scopes)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, created_at"#,
    )
    .bind(req.service_id)
    .bind(user_id)
    .bind(&key_hash)
    .bind(&name)
    .bind(&scopes)
    .fetch_one(&state.db)
    .await?;

    Ok((
        StatusCode::CREATED,
        Json(CreateServiceKeyResponse {
            id,
            service_id: req.service_id,
            name,
            key: raw_key, // Only returned once
            scopes,
            created_at,
        }),
    ))
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct ServiceKeyInfo {
    pub id: Uuid,
    pub service_id: Uuid,
    pub name: String,
    pub scopes: Vec<String>,
    pub active: bool,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub last_used_at: Option<chrono::DateTime<chrono::Utc>>,
}

/// GET /v1/service-keys (JWT protected)
pub async fn list_service_keys(
    State(state): State<Arc<AppState>>,
    Extension(claims): axum::Extension<crate::auth::Claims>,
) -> AppResult<Json<Vec<ServiceKeyInfo>>> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("Invalid token".into()))?;

    let keys = sqlx::query_as::<_, ServiceKeyInfo>(
        "SELECT id, service_id, name, scopes, active, created_at, last_used_at \
         FROM service_api_keys WHERE owner_id = $1 ORDER BY created_at DESC",
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(keys))
}

/// DELETE /v1/service-keys/{id} (JWT protected)
pub async fn revoke_service_key(
    State(state): State<Arc<AppState>>,
    Extension(claims): axum::Extension<crate::auth::Claims>,
    Path(id): Path<Uuid>,
) -> AppResult<StatusCode> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("Invalid token".into()))?;

    let result =
        sqlx::query("UPDATE service_api_keys SET active = false WHERE id = $1 AND owner_id = $2")
            .bind(id)
            .bind(user_id)
            .execute(&state.db)
            .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("API key not found".into()));
    }

    Ok(StatusCode::NO_CONTENT)
}

// ── Helper Functions ──

async fn lookup_agent_profile(
    state: &AppState,
    did: &str,
) -> (Option<String>, Option<String>, bool) {
    // Check business profiles first
    let biz: Option<(String, bool)> = sqlx::query_as(
        "SELECT business_name, COALESCE((SELECT true FROM verified_badges WHERE profile_id = bp.id LIMIT 1), false) \
         FROM business_profiles bp WHERE did = $1",
    )
    .bind(did)
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten();

    if let Some((name, _)) = biz {
        return (Some("business".into()), Some(name), false);
    }

    // Check consumer profiles
    let consumer: Option<(String, bool)> = sqlx::query_as(
        "SELECT display_name, on_chain_registered FROM public_profiles WHERE did = $1",
    )
    .bind(did)
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten();

    if let Some((name, on_chain)) = consumer {
        return (Some("consumer".into()), Some(name), on_chain);
    }

    (None, None, false)
}

async fn check_verified_badge(state: &AppState, did: &str) -> bool {
    let result: Option<bool> = sqlx::query_scalar(
        r#"SELECT EXISTS(
            SELECT 1 FROM verified_badges vb
            JOIN business_profiles bp ON bp.id = vb.profile_id
            WHERE bp.did = $1 AND vb.expires_at > NOW()
        )"#,
    )
    .bind(did)
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten();

    result.unwrap_or(false)
}

async fn compute_trust_score(
    has_profile: bool,
    on_chain: bool,
    verified_badge: bool,
    state: &AppState,
    did: &str,
) -> f32 {
    let mut score: f32 = 0.0;

    // Identity component (0.0 - 0.4)
    if has_profile {
        score += 0.2;
    }
    if on_chain {
        score += 0.1;
    }
    if verified_badge {
        score += 0.1;
    }

    // Transaction history component (0.0 - 0.3)
    let tx_count: Option<i64> = sqlx::query_scalar(
        r#"SELECT COUNT(*) FROM payment_transactions pt
        JOIN agent_wallets aw ON aw.id = pt.agent_wallet_id
        JOIN users u ON u.id = aw.user_id
        WHERE (SELECT did FROM public_profiles WHERE user_id = u.id) = $1
           OR (SELECT did FROM business_profiles WHERE user_id = u.id) = $1"#,
    )
    .bind(did)
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten();

    let tx_count = tx_count.unwrap_or(0);
    if tx_count > 0 {
        score += 0.1;
    }
    if tx_count > 10 {
        score += 0.1;
    }
    if tx_count > 50 {
        score += 0.1;
    }

    // Account age component (0.0 - 0.2)
    let age_days: Option<f64> = sqlx::query_scalar(
        r#"SELECT EXTRACT(EPOCH FROM (NOW() - COALESCE(
            (SELECT created_at FROM public_profiles WHERE did = $1),
            (SELECT created_at FROM business_profiles WHERE did = $1),
            NOW()
        ))) / 86400.0"#,
    )
    .bind(did)
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten();

    let age_days = age_days.unwrap_or(0.0);
    if age_days > 7.0 {
        score += 0.1;
    }
    if age_days > 30.0 {
        score += 0.1;
    }

    score.min(1.0)
}

async fn fetch_spending_summary(
    state: &AppState,
    did: &str,
) -> Option<AgentSpendingSummary> {
    #[derive(sqlx::FromRow)]
    struct SpendingRow {
        total_transactions: Option<i64>,
        total_spent: Option<i64>,
        avg_amount: Option<i64>,
        first_tx: Option<chrono::DateTime<chrono::Utc>>,
    }

    let row: Option<SpendingRow> = sqlx::query_as(
        r#"SELECT
            COUNT(*) as total_transactions,
            COALESCE(SUM(sp.amount_micro_usdc), 0) as total_spent,
            COALESCE(AVG(sp.amount_micro_usdc)::BIGINT, 0) as avg_amount,
            MIN(sp.created_at) as first_tx
        FROM service_payments sp
        WHERE sp.payer_did = $1"#,
    )
    .bind(did)
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten();

    row.and_then(|r| {
        let total = r.total_transactions.unwrap_or(0);
        if total == 0 {
            return None;
        }
        Some(AgentSpendingSummary {
            total_transactions: total,
            total_spent_micro_usdc: r.total_spent.unwrap_or(0),
            avg_transaction_micro_usdc: r.avg_amount.unwrap_or(0),
            first_transaction_at: r.first_tx,
        })
    })
}

/// GET /v1/verify/x402/{address} (public)
/// Assess a Solana address for trust — used by agents before x402 payments.
pub async fn verify_x402_merchant(
    State(state): State<Arc<AppState>>,
    Path(address): Path<String>,
) -> AppResult<Json<serde_json::Value>> {
    // Look up by Solana address — check if any registered service has this receive_address
    let service: Option<(String, String, Option<f32>, f32)> = sqlx::query_as(
        r#"SELECT owner_did, name, avg_rating, uptime_percent
        FROM service_listings
        WHERE receive_address = $1 AND status::text = 'active'
        LIMIT 1"#,
    )
    .bind(&address)
    .fetch_optional(&state.db)
    .await?;

    let (identity_found, owner_did, display_name, rating, uptime) = match service {
        Some((did, name, r, u)) => (true, did, Some(name), r, u),
        None => (false, String::new(), None, None, 0.0),
    };

    // Get reputation if identity found
    let (trust_score, confidence) = if identity_found {
        let score: Option<f32> = sqlx::query_scalar(
            "SELECT overall_score FROM reputation_scores WHERE entity_did = $1",
        )
        .bind(&owner_did)
        .fetch_optional(&state.db)
        .await?;

        let conf: Option<f32> = sqlx::query_scalar(
            "SELECT confidence FROM reputation_scores WHERE entity_did = $1",
        )
        .bind(&owner_did)
        .fetch_optional(&state.db)
        .await?;

        (score.unwrap_or(0.0), conf.unwrap_or(0.0))
    } else {
        (0.0, 0.0)
    };

    let (recommendation, reason) = if !identity_found {
        ("caution", "Address not found in Ghola registry. Unverified merchant.")
    } else if trust_score >= 0.7 {
        ("pay", "Verified merchant with good trust score.")
    } else if trust_score >= 0.3 {
        ("caution", "Merchant found but trust score is moderate.")
    } else {
        ("reject", "Merchant has low trust score.")
    };

    Ok(Json(serde_json::json!({
        "address": address,
        "identity_found": identity_found,
        "owner_did": if identity_found { Some(&owner_did) } else { None },
        "display_name": display_name,
        "trust_score": trust_score,
        "confidence": confidence,
        "avg_rating": rating,
        "uptime_percent": uptime,
        "recommendation": recommendation,
        "reason": reason,
        "protocol": "x402",
    })))
}

/// Look up cached reputation score from the reputation_scores table.
/// Returns None if no reputation has been computed yet.
async fn get_cached_trust_score(state: &AppState, did: &str) -> Option<f32> {
    sqlx::query_scalar(
        "SELECT overall_score FROM reputation_scores WHERE entity_did = $1",
    )
    .bind(did)
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten()
}

fn generate_random_key() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}
