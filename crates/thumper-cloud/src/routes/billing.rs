use axum::extract::State;
use axum::http::HeaderMap;
use axum::Json;
use chrono::{Datelike, TimeZone};
use serde::{Deserialize, Serialize};

use crate::auth::AuthUser;
use crate::error::CloudError;
use crate::state::AppState;

#[derive(Deserialize)]
pub struct CreateCheckoutRequest {
    pub tier: String,
}

#[derive(Serialize)]
pub struct CheckoutResponse {
    pub checkout_url: String,
}

#[derive(Deserialize)]
pub struct CreatePrivateBalanceTopUpRequest {
    pub amount_usdc: i64,
}

#[derive(Serialize)]
pub struct PrivateBalanceTopUpResponse {
    pub deposit_id: uuid::Uuid,
    pub checkout_url: String,
}

#[derive(Serialize)]
pub struct PrivateBalanceDeposit {
    pub id: uuid::Uuid,
    pub amount_usdc: i64,
    pub status: String,
    pub source: String,
    pub stripe_session_id: Option<String>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub paid_at: Option<chrono::DateTime<chrono::Utc>>,
    pub shielded_at: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Serialize)]
pub struct PrivateBalanceStatusResponse {
    pub available_micro_usdc: i64,
    pub paid_micro_usdc: i64,
    pub shielded_micro_usdc: i64,
    pub pending_micro_usdc: i64,
    pub deposits: Vec<PrivateBalanceDeposit>,
}

#[derive(Serialize)]
pub struct BillingStatusResponse {
    pub tier: String,
    pub expires_at: Option<String>,
    pub access_source: &'static str,
    pub access_state: &'static str,
    pub invite_state: &'static str,
    pub active_pass_id: Option<uuid::Uuid>,
    pub invite_expires_at: Option<String>,
    pub last_access_expires_at: Option<String>,
    pub stripe_customer_id: Option<String>,
    pub portal_url: Option<String>,
    pub limits: BillingLimits,
    pub private_agent_compute: Option<PrivateAgentComputeStatus>,
    pub private_agent_trading: Option<PrivateAgentTradingStatus>,
}

#[derive(Serialize)]
pub struct BillingLimits {
    pub calls_per_month: i64,
    pub emails_per_month: i64,
    pub private_compute_seconds: i64,
    pub active_private_agents: i64,
}

#[derive(Serialize)]
pub struct PrivateAgentComputeStatus {
    pub included_seconds: i64,
    pub reserved_seconds: i64,
    pub used_seconds: i64,
    pub remaining_seconds: i64,
    pub active_agent_limit: i64,
    pub active_agent_count: i64,
    pub period_start: String,
    pub period_end: String,
    pub metering_unit: &'static str,
}

#[derive(Clone, Copy)]
struct PrivateAgentTradingPlan {
    included_notional_micro_usd: i64,
    overage_fee_bps: i32,
    default_monthly_fee_cap_micro_usd: i64,
}

#[derive(Serialize)]
pub struct PrivateAgentTradingStatus {
    pub included_notional_micro_usd: i64,
    pub filled_notional_micro_usd: i64,
    pub remaining_included_notional_micro_usd: i64,
    pub overage_notional_micro_usd: i64,
    pub overage_fee_bps: i32,
    pub accrued_fee_micro_usd: i64,
    pub queued_fee_cents: i64,
    pub invoiced_fee_cents: i64,
    pub monthly_fee_cap_micro_usd: i64,
    pub cap_reached: bool,
    pub live_trading_allowed: bool,
    pub period_start: String,
    pub period_end: String,
    pub metering_unit: &'static str,
    pub billing_state: &'static str,
}

#[derive(Deserialize)]
pub struct MeterPrivateAgentTradingRequest {
    pub event_id: String,
    pub work_order_commitment: String,
    pub connector_result_commitment: String,
    pub platform_class: String,
    pub fill_count: i32,
    pub filled_notional_micro_usd: i64,
}

#[derive(Serialize)]
pub struct MeterPrivateAgentTradingResponse {
    pub ok: bool,
    pub duplicate: bool,
    pub status: PrivateAgentTradingStatus,
}

#[derive(Deserialize)]
pub struct UpdatePrivateAgentTradingCapRequest {
    pub monthly_fee_cap_micro_usd: i64,
}

#[derive(Deserialize)]
pub struct ReservePrivateAgentComputeRequest {
    pub session_id: String,
    pub seconds: i64,
    pub reason: Option<String>,
}

#[derive(Serialize)]
pub struct ReservePrivateAgentComputeResponse {
    pub ok: bool,
    pub reservation_id: uuid::Uuid,
    pub reserved_seconds: i64,
}

#[derive(Deserialize)]
pub struct ReleasePrivateAgentComputeRequest {
    pub session_id: String,
    pub status: String,
}

#[derive(Serialize)]
pub struct ReleasePrivateAgentComputeResponse {
    pub ok: bool,
}

#[derive(Deserialize)]
pub struct CreateAccessPassRequest {
    pub email: String,
    pub idempotency_key: String,
    pub tier: Option<String>,
    pub grant_days: Option<i64>,
    pub redeem_days: Option<i64>,
}

#[derive(Serialize)]
pub struct CreateAccessPassResponse {
    pub pass_id: uuid::Uuid,
    pub invite_url: String,
    pub tier: String,
    pub redeem_expires_at: String,
    pub grant_days: i64,
}

#[derive(Deserialize)]
pub struct RedeemAccessPassRequest {
    pub code: String,
}

#[derive(Serialize)]
pub struct RedeemAccessPassResponse {
    pub ok: bool,
    pub tier: String,
    pub expires_at: String,
    pub access_source: &'static str,
}

#[derive(Deserialize)]
pub struct RevokeAccessPassRequest {
    pub pass_id: uuid::Uuid,
}

#[derive(Serialize)]
pub struct RevokeAccessPassResponse {
    pub ok: bool,
    pub pass_id: uuid::Uuid,
    pub state: &'static str,
    pub revoked_at: String,
}

const PRIVATE_AGENT_TRIAL_PACK_INCLUDED_COMPUTE_SECONDS: i64 = 5 * 60 * 60;
const PRIVATE_AGENT_TRIAL_PACK_ACTIVE_AGENT_LIMIT: i64 = 1;
const PRIVATE_AGENT_TRIAL_PACK_DAYS: i64 = 14;
const PRIVATE_AGENT_STARTER_INCLUDED_COMPUTE_SECONDS: i64 = 20 * 60 * 60;
const PRIVATE_AGENT_STARTER_ACTIVE_AGENT_LIMIT: i64 = 1;
const PRIVATE_AGENT_INCLUDED_COMPUTE_SECONDS: i64 = 80 * 60 * 60;
const PRIVATE_AGENT_ACTIVE_AGENT_LIMIT: i64 = 1;
const ENTERPRISE_INCLUDED_COMPUTE_SECONDS: i64 = 31 * 24 * 60 * 60;
const ENTERPRISE_ACTIVE_AGENT_LIMIT: i64 = 10;
const PRIVATE_AGENT_TRIAL_INCLUDED_NOTIONAL_MICRO_USD: i64 = 10_000_000_000;
const PRIVATE_AGENT_STARTER_INCLUDED_NOTIONAL_MICRO_USD: i64 = 100_000_000_000;
const PRIVATE_AGENT_INCLUDED_NOTIONAL_MICRO_USD: i64 = 1_000_000_000_000;
const PRIVATE_AGENT_STARTER_OVERAGE_FEE_BPS: i32 = 3;
const PRIVATE_AGENT_OVERAGE_FEE_BPS: i32 = 2;
const PRIVATE_AGENT_STARTER_DEFAULT_FEE_CAP_MICRO_USD: i64 = 50_000_000;
const PRIVATE_AGENT_DEFAULT_FEE_CAP_MICRO_USD: i64 = 500_000_000;
const PRIVATE_AGENT_MAX_FEE_CAP_MICRO_USD: i64 = 10_000_000_000;

/// POST /api/billing/checkout
pub async fn create_checkout(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Json(req): Json<CreateCheckoutRequest>,
) -> Result<Json<CheckoutResponse>, CloudError> {
    let stripe_key =
        state
            .config
            .stripe_secret_key
            .as_deref()
            .ok_or(CloudError::ServiceUnavailable(
                "billing not configured".to_string(),
            ))?;

    let (price_id, mode, checkout_kind) = match req.tier.as_str() {
        "pro" => (
            state
                .config
                .stripe_price_pro
                .as_deref()
                .ok_or(CloudError::ServiceUnavailable(
                    "pro price not configured".to_string(),
                ))?,
            "subscription",
            "subscription",
        ),
        "trial_pack" => (
            state
                .config
                .stripe_price_private_agent_trial_pack
                .as_deref()
                .ok_or(CloudError::ServiceUnavailable(
                    "trial pack price not configured".to_string(),
                ))?,
            "payment",
            "private_agent_trial_pack",
        ),
        "starter" => (
            state
                .config
                .stripe_price_private_agent_starter
                .as_deref()
                .ok_or(CloudError::ServiceUnavailable(
                    "starter private-agent price not configured".to_string(),
                ))?,
            "subscription",
            "subscription",
        ),
        "private_agent" => (
            state.config.stripe_price_private_agent.as_deref().ok_or(
                CloudError::ServiceUnavailable("private-agent price not configured".to_string()),
            )?,
            "subscription",
            "subscription",
        ),
        "unlimited" => (
            state.config.stripe_price_unlimited.as_deref().ok_or(
                CloudError::ServiceUnavailable("unlimited price not configured".to_string()),
            )?,
            "subscription",
            "subscription",
        ),
        _ => {
            return Err(CloudError::BadRequest(
                "tier must be 'pro', 'trial_pack', 'starter', 'private_agent', or 'unlimited'"
                    .to_string(),
            ));
        }
    };

    // Get or create Stripe customer
    let row = sqlx::query_as::<_, (Option<String>, Option<String>)>(
        "SELECT email, stripe_customer_id FROM users WHERE id = $1",
    )
    .bind(claims.sub)
    .fetch_optional(&state.db)
    .await?
    .ok_or(CloudError::NotFound("user not found".to_string()))?;

    let client = reqwest::Client::new();

    // Create checkout session
    let mut form = vec![
        ("mode", mode.to_string()),
        ("line_items[0][price]", price_id.to_string()),
        ("line_items[0][quantity]", "1".to_string()),
        ("metadata[ghola_kind]", checkout_kind.to_string()),
        ("metadata[tier]", req.tier.clone()),
        ("metadata[price_id]", price_id.to_string()),
        (
            "success_url",
            format!("{}/billing/success", state.config.base_url),
        ),
        (
            "cancel_url",
            format!("{}/billing/cancel", state.config.base_url),
        ),
        ("client_reference_id", claims.sub.to_string()),
    ];

    if mode == "subscription" {
        form.push(("subscription_data[metadata][tier]", req.tier.clone()));
        form.push((
            "subscription_data[metadata][price_id]",
            price_id.to_string(),
        ));
    } else {
        form.push((
            "payment_intent_data[metadata][ghola_kind]",
            checkout_kind.to_string(),
        ));
        form.push(("payment_intent_data[metadata][tier]", req.tier.clone()));
    }

    if let Some(ref customer_id) = row.1 {
        form.push(("customer", customer_id.clone()));
    } else if mode == "payment" {
        form.push(("customer_creation", "always".to_string()));
        if let Some(ref email) = row.0 {
            form.push(("customer_email", email.clone()));
        }
    } else if let Some(ref email) = row.0 {
        form.push(("customer_email", email.clone()));
    }

    let resp = client
        .post("https://api.stripe.com/v1/checkout/sessions")
        .header("Authorization", format!("Bearer {stripe_key}"))
        .form(&form)
        .send()
        .await
        .map_err(|e| CloudError::Internal(format!("stripe request failed: {e}")))?;

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| CloudError::Internal(format!("stripe response parse failed: {e}")))?;

    let checkout_url = body["url"]
        .as_str()
        .ok_or(CloudError::Internal(
            "no checkout URL in Stripe response".to_string(),
        ))?
        .to_string();

    Ok(Json(CheckoutResponse { checkout_url }))
}

/// POST /api/billing/private-balance/checkout
pub async fn create_private_balance_top_up(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Json(req): Json<CreatePrivateBalanceTopUpRequest>,
) -> Result<Json<PrivateBalanceTopUpResponse>, CloudError> {
    let stripe_key =
        state
            .config
            .stripe_secret_key
            .as_deref()
            .ok_or(CloudError::ServiceUnavailable(
                "card top up is not configured".to_string(),
            ))?;

    if !(5..=500).contains(&req.amount_usdc) {
        return Err(CloudError::BadRequest(
            "amount_usdc must be between 5 and 500".to_string(),
        ));
    }

    let amount_micro_usdc = req.amount_usdc * 1_000_000;
    let amount_cents = req.amount_usdc * 100;

    let row = sqlx::query_as::<_, (Option<String>, Option<String>)>(
        "SELECT email, stripe_customer_id FROM users WHERE id = $1",
    )
    .bind(claims.sub)
    .fetch_optional(&state.db)
    .await?
    .ok_or(CloudError::NotFound("user not found".to_string()))?;

    let deposit_id: uuid::Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO private_balance_deposits (user_id, amount_usdc, metadata)
        VALUES ($1, $2, $3)
        RETURNING id
        "#,
    )
    .bind(claims.sub)
    .bind(amount_micro_usdc)
    .bind(serde_json::json!({
        "rail": "private_balance",
        "source": "stripe_checkout",
        "requested_amount_usdc": req.amount_usdc
    }))
    .fetch_one(&state.db)
    .await?;

    let client = reqwest::Client::new();
    let mut form = vec![
        ("mode", "payment".to_string()),
        ("line_items[0][price_data][currency]", "usd".to_string()),
        (
            "line_items[0][price_data][product_data][name]",
            "Ghola Private Balance".to_string(),
        ),
        (
            "line_items[0][price_data][product_data][description]",
            "Private AI spend balance".to_string(),
        ),
        (
            "line_items[0][price_data][unit_amount]",
            amount_cents.to_string(),
        ),
        ("line_items[0][quantity]", "1".to_string()),
        (
            "success_url",
            format!("{}/private-balance?topup=success", state.config.base_url),
        ),
        (
            "cancel_url",
            format!("{}/private-balance?topup=cancelled", state.config.base_url),
        ),
        ("client_reference_id", claims.sub.to_string()),
        ("metadata[ghola_kind]", "private_balance_top_up".to_string()),
        ("metadata[user_id]", claims.sub.to_string()),
        ("metadata[deposit_id]", deposit_id.to_string()),
        ("metadata[amount_micro_usdc]", amount_micro_usdc.to_string()),
        (
            "payment_intent_data[metadata][ghola_kind]",
            "private_balance_top_up".to_string(),
        ),
        (
            "payment_intent_data[metadata][deposit_id]",
            deposit_id.to_string(),
        ),
        (
            "payment_intent_data[metadata][user_id]",
            claims.sub.to_string(),
        ),
        (
            "payment_intent_data[metadata][amount_micro_usdc]",
            amount_micro_usdc.to_string(),
        ),
    ];

    if let Some(ref customer_id) = row.1 {
        form.push(("customer", customer_id.clone()));
    } else {
        form.push(("customer_creation", "always".to_string()));
        if let Some(ref email) = row.0 {
            form.push(("customer_email", email.clone()));
        }
    }

    let resp = client
        .post("https://api.stripe.com/v1/checkout/sessions")
        .header("Authorization", format!("Bearer {stripe_key}"))
        .form(&form)
        .send()
        .await
        .map_err(|e| CloudError::Internal(format!("stripe request failed: {e}")))?;

    let status = resp.status();
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| CloudError::Internal(format!("stripe response parse failed: {e}")))?;

    if !status.is_success() {
        sqlx::query(
            "UPDATE private_balance_deposits SET status = 'failed', metadata = metadata || $2, updated_at = now() WHERE id = $1",
        )
        .bind(deposit_id)
        .bind(serde_json::json!({ "stripe_error": body }))
        .execute(&state.db)
        .await?;
        return Err(CloudError::ServiceUnavailable(
            "Stripe checkout could not be created".to_string(),
        ));
    }

    let checkout_url = body["url"]
        .as_str()
        .ok_or(CloudError::Internal(
            "no checkout URL in Stripe response".to_string(),
        ))?
        .to_string();
    let stripe_session_id = body["id"].as_str().map(str::to_string);

    sqlx::query(
        r#"
        UPDATE private_balance_deposits
        SET stripe_session_id = $2, checkout_url = $3, updated_at = now()
        WHERE id = $1
        "#,
    )
    .bind(deposit_id)
    .bind(stripe_session_id)
    .bind(&checkout_url)
    .execute(&state.db)
    .await?;

    Ok(Json(PrivateBalanceTopUpResponse {
        deposit_id,
        checkout_url,
    }))
}

/// Verify Stripe webhook signature (HMAC-SHA256).
fn verify_stripe_signature(
    payload: &str,
    sig_header: &str,
    secret: &str,
) -> Result<(), CloudError> {
    // Parse Stripe-Signature header: "t=timestamp,v1=signature"
    let mut timestamp = None;
    let mut signatures = Vec::new();
    for part in sig_header.split(',') {
        let part = part.trim();
        if let Some(t) = part.strip_prefix("t=") {
            timestamp = Some(t.to_string());
        } else if let Some(v1) = part.strip_prefix("v1=") {
            signatures.push(v1.to_string());
        }
    }

    let timestamp = timestamp.ok_or(CloudError::BadRequest(
        "missing timestamp in Stripe signature".to_string(),
    ))?;

    if signatures.is_empty() {
        return Err(CloudError::BadRequest(
            "missing v1 signature in Stripe header".to_string(),
        ));
    }

    // Reject if timestamp is older than 5 minutes (replay protection).
    // A non-numeric timestamp must be REJECTED rather than silently skipping
    // the replay window (L1) — otherwise a malformed `t=` value would strip
    // replay protection while a valid signature still passes.
    let ts = timestamp
        .parse::<i64>()
        .map_err(|_| CloudError::BadRequest("invalid timestamp in Stripe signature".to_string()))?;
    let now = chrono::Utc::now().timestamp();
    if (now - ts).abs() > 300 {
        return Err(CloudError::BadRequest(
            "Stripe webhook timestamp too old".to_string(),
        ));
    }

    // Compute expected signature: HMAC-SHA256(secret, "timestamp.payload")
    let signed_payload = format!("{timestamp}.{payload}");
    let expected = hmac_sha256(secret.as_bytes(), signed_payload.as_bytes());
    let expected_hex: String = expected.iter().map(|b| format!("{b:02x}")).collect();

    // Constant-time comparison against any v1 signature
    let matched = signatures.iter().any(|sig| {
        if sig.len() != expected_hex.len() {
            return false;
        }
        // Constant-time compare
        let mut diff = 0u8;
        for (a, b) in sig.bytes().zip(expected_hex.bytes()) {
            diff |= a ^ b;
        }
        diff == 0
    });

    if !matched {
        return Err(CloudError::BadRequest(
            "invalid Stripe webhook signature".to_string(),
        ));
    }

    Ok(())
}

/// HMAC-SHA256 (manual — avoids adding hmac crate).
fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};

    let block_size = 64;
    let mut k = vec![0u8; block_size];
    if key.len() > block_size {
        let hash = Sha256::digest(key);
        k[..32].copy_from_slice(&hash);
    } else {
        k[..key.len()].copy_from_slice(key);
    }

    let mut ipad = vec![0x36u8; block_size];
    let mut opad = vec![0x5cu8; block_size];
    for i in 0..block_size {
        ipad[i] ^= k[i];
        opad[i] ^= k[i];
    }

    let mut inner = Sha256::new();
    inner.update(&ipad);
    inner.update(data);
    let inner_hash = inner.finalize();

    let mut outer = Sha256::new();
    outer.update(&opad);
    outer.update(&inner_hash);
    let result = outer.finalize();

    let mut out = [0u8; 32];
    out.copy_from_slice(&result);
    out
}

/// Determine tier from the Stripe price ID in the checkout session.
fn tier_from_price_id(event: &serde_json::Value, state: &AppState) -> &'static str {
    for tier in ["trial_pack", "starter", "private_agent", "unlimited", "pro"] {
        if event["data"]["object"]["metadata"]["tier"].as_str() == Some(tier) {
            return tier;
        }
        if event["data"]["object"]["subscription_details"]["metadata"]["tier"].as_str()
            == Some(tier)
        {
            return tier;
        }
    }

    // Try to extract price ID from line_items or metadata
    let price_id = event["data"]["object"]["line_items"]["data"][0]["price"]["id"]
        .as_str()
        .or_else(|| event["data"]["object"]["items"]["data"][0]["price"]["id"].as_str())
        .or_else(|| event["data"]["object"]["metadata"]["price_id"].as_str())
        .unwrap_or("");

    if let Some(ref trial_pack_price) = state.config.stripe_price_private_agent_trial_pack {
        if price_id == trial_pack_price {
            return "trial_pack";
        }
    }
    if let Some(ref starter_price) = state.config.stripe_price_private_agent_starter {
        if price_id == starter_price {
            return "starter";
        }
    }
    if let Some(ref private_agent_price) = state.config.stripe_price_private_agent {
        if price_id == private_agent_price {
            return "private_agent";
        }
    }
    if let Some(ref unlimited_price) = state.config.stripe_price_unlimited {
        if price_id == unlimited_price {
            return "unlimited";
        }
    }
    if let Some(ref pro_price) = state.config.stripe_price_pro {
        if price_id == pro_price {
            return "pro";
        }
    }

    // Fallback: check amount if price ID not available
    let amount = event["data"]["object"]["amount_total"]
        .as_i64()
        .unwrap_or(0);
    if amount >= 12900 {
        "private_agent"
    } else if amount >= 3900 {
        "starter"
    } else if amount >= 2999 {
        "unlimited"
    } else if amount >= 999 {
        "pro"
    } else if amount >= 900 {
        "trial_pack"
    } else {
        "pro"
    }
}

#[derive(Debug, Clone)]
struct EffectiveAccess {
    evaluated_at: chrono::DateTime<chrono::Utc>,
    tier: String,
    expires_at: Option<chrono::DateTime<chrono::Utc>>,
    source: &'static str,
    state: &'static str,
    invite_state: &'static str,
    active_pass_id: Option<uuid::Uuid>,
    invite_expires_at: Option<chrono::DateTime<chrono::Utc>>,
    last_access_expires_at: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AccessGrant {
    pass_id: uuid::Uuid,
    tier: String,
    expires_at: chrono::DateTime<chrono::Utc>,
    revoked_at: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Debug, Clone)]
struct InviteSnapshot {
    active: Option<AccessGrant>,
    state: &'static str,
    last_expires_at: Option<chrono::DateTime<chrono::Utc>>,
}

fn tier_rank(tier: &str) -> u8 {
    match tier {
        "enterprise" => 6,
        "private_agent" => 5,
        "starter" => 4,
        "trial_pack" => 3,
        "unlimited" => 2,
        "pro" => 1,
        _ => 0,
    }
}

fn resolve_effective_access(
    raw_tier: String,
    raw_expires_at: Option<chrono::DateTime<chrono::Utc>>,
    invite: InviteSnapshot,
    now: chrono::DateTime<chrono::Utc>,
) -> EffectiveAccess {
    let paid_tier = effective_tier_at(raw_tier, raw_expires_at, now);
    let subscription_expiry = if paid_tier == "trial_pack" {
        raw_expires_at
    } else {
        None
    };
    if let Some(grant) = invite.active {
        let tier = if tier_rank(&grant.tier) > tier_rank(&paid_tier) {
            grant.tier
        } else {
            paid_tier
        };
        return EffectiveAccess {
            evaluated_at: now,
            tier,
            expires_at: Some(grant.expires_at),
            source: "complimentary_pass",
            state: "active",
            invite_state: "active",
            active_pass_id: Some(grant.pass_id),
            invite_expires_at: Some(grant.expires_at),
            last_access_expires_at: invite.last_expires_at,
        };
    }
    let active = paid_tier != "free";
    EffectiveAccess {
        evaluated_at: now,
        source: if active { "stripe" } else { "free" },
        state: if active {
            "active"
        } else if invite.state != "none" {
            invite.state
        } else if raw_expires_at.is_some() {
            "expired"
        } else {
            "none"
        },
        tier: paid_tier,
        expires_at: subscription_expiry,
        invite_state: invite.state,
        active_pass_id: None,
        invite_expires_at: None,
        last_access_expires_at: invite.last_expires_at.or(raw_expires_at),
    }
}

fn effective_tier_at(
    tier: String,
    expires_at: Option<chrono::DateTime<chrono::Utc>>,
    now: chrono::DateTime<chrono::Utc>,
) -> String {
    if tier == "trial_pack" && expires_at.map(|expiry| expiry <= now).unwrap_or(true) {
        "free".to_string()
    } else {
        tier
    }
}

fn select_access_grant(
    grants: &[AccessGrant],
    now: chrono::DateTime<chrono::Utc>,
) -> InviteSnapshot {
    let active = grants
        .iter()
        .filter(|grant| grant.revoked_at.is_none() && grant.expires_at > now)
        .max_by_key(|grant| (tier_rank(&grant.tier), grant.expires_at))
        .cloned();
    let terminal = grants.iter().max_by_key(|grant| {
        grant.revoked_at.unwrap_or(grant.expires_at)
    });
    InviteSnapshot {
        state: if active.is_some() {
            "active"
        } else if terminal.and_then(|grant| grant.revoked_at).is_some() {
            "revoked"
        } else if terminal.is_some() {
            "expired"
        } else {
            "none"
        },
        active,
        last_expires_at: grants.iter().map(|grant| grant.expires_at).max(),
    }
}

async fn access_grants_for_user<'e, E>(
    executor: E,
    user_id: uuid::Uuid,
    lock_for_share: bool,
) -> Result<Vec<AccessGrant>, CloudError>
where
    E: sqlx::Executor<'e, Database = sqlx::Postgres>,
{
    let query = if lock_for_share {
        r#"
        SELECT pass_id, tier, grant_expires_at, revoked_at
        FROM complimentary_access_passes
        WHERE redeemed_by = $1
          AND redeemed_at IS NOT NULL
          AND grant_expires_at IS NOT NULL
        FOR SHARE
        "#
    } else {
        r#"
        SELECT pass_id, tier, grant_expires_at, revoked_at
        FROM complimentary_access_passes
        WHERE redeemed_by = $1
          AND redeemed_at IS NOT NULL
          AND grant_expires_at IS NOT NULL
        "#
    };
    let grants = sqlx::query_as::<_, (
        uuid::Uuid,
        String,
        chrono::DateTime<chrono::Utc>,
        Option<chrono::DateTime<chrono::Utc>>,
    )>(query)
    .bind(user_id)
    .fetch_all(executor)
    .await?;
    Ok(grants
        .into_iter()
        .map(|(pass_id, tier, expires_at, revoked_at)| AccessGrant {
            pass_id,
            tier,
            expires_at,
            revoked_at,
        })
        .collect())
}

async fn effective_access_for_user(
    state: &AppState,
    user_id: uuid::Uuid,
) -> Result<EffectiveAccess, CloudError> {
    let row = sqlx::query_as::<_, (
        String,
        Option<chrono::DateTime<chrono::Utc>>,
        chrono::DateTime<chrono::Utc>,
    )>(
        "SELECT tier, tier_expires_at, clock_timestamp() FROM users WHERE id = $1",
    )
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(CloudError::NotFound("user not found".to_string()))?;
    let grants = access_grants_for_user(&state.db, user_id, false).await?;
    Ok(resolve_effective_access(
        row.0,
        row.1,
        select_access_grant(&grants, row.2),
        row.2,
    ))
}

fn resolve_execution_access(
    raw_tier: String,
    raw_expires_at: Option<chrono::DateTime<chrono::Utc>>,
    invite: InviteSnapshot,
    now: chrono::DateTime<chrono::Utc>,
    canary_authorized: bool,
) -> EffectiveAccess {
    if canary_authorized && invite.active.is_some() {
        return resolve_effective_access(raw_tier, raw_expires_at, invite, now);
    }
    resolve_effective_access(
        raw_tier,
        raw_expires_at,
        InviteSnapshot {
            active: None,
            state: invite.state,
            last_expires_at: invite.last_expires_at,
        },
        now,
    )
}

async fn pause_inactive_complimentary_reservations(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_id: uuid::Uuid,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<(), CloudError> {
    sqlx::query(
        r#"
        UPDATE private_agent_compute_reservations AS reservation
        SET status = 'paused',
            released_at = COALESCE(reservation.released_at, $2),
            updated_at = $2
        WHERE reservation.user_id = $1
          AND reservation.access_source = 'complimentary_pass'
          AND reservation.status = 'reserved'
          AND (
              reservation.access_expires_at <= $2
              OR EXISTS (
                  SELECT 1
                  FROM complimentary_access_passes AS pass
                  WHERE pass.pass_id = reservation.access_pass_id
                    AND (pass.revoked_at IS NOT NULL OR pass.grant_expires_at <= $2)
              )
          )
        "#,
    )
    .bind(user_id)
    .bind(now)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn pause_expired_complimentary_reservations_once(
    db: &sqlx::PgPool,
) -> Result<u64, CloudError> {
    let result = sqlx::query(
        r#"
        UPDATE private_agent_compute_reservations AS reservation
        SET status = 'paused',
            released_at = COALESCE(reservation.released_at, clock_timestamp()),
            updated_at = clock_timestamp()
        WHERE reservation.access_source = 'complimentary_pass'
          AND reservation.status = 'reserved'
          AND (
              reservation.access_expires_at <= clock_timestamp()
              OR EXISTS (
                  SELECT 1
                  FROM complimentary_access_passes AS pass
                  WHERE pass.pass_id = reservation.access_pass_id
                    AND (
                        pass.revoked_at IS NOT NULL
                        OR pass.grant_expires_at <= clock_timestamp()
                    )
              )
          )
        "#,
    )
    .execute(db)
    .await?;
    Ok(result.rows_affected())
}

pub(crate) async fn complimentary_access_expiry_loop(db: sqlx::PgPool) {
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(30));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        interval.tick().await;
        match pause_expired_complimentary_reservations_once(&db).await {
            Ok(paused) if paused > 0 => {
                tracing::info!(paused, "paused expired complimentary reservations");
            }
            Ok(_) => {}
            Err(error) => {
                tracing::warn!(%error, "failed to pause expired complimentary reservations");
            }
        }
    }
}

fn private_agent_trading_plan_for_access(
    access: &EffectiveAccess,
) -> Option<PrivateAgentTradingPlan> {
    let plan = private_agent_trading_plan_for_tier(&access.tier)?;
    if access.source == "complimentary_pass" {
        return Some(PrivateAgentTradingPlan {
            included_notional_micro_usd: plan.included_notional_micro_usd,
            overage_fee_bps: 0,
            default_monthly_fee_cap_micro_usd: 0,
        });
    }
    Some(plan)
}

fn private_agent_allowance_for_tier(tier: &str) -> Option<(i64, i64)> {
    match tier {
        "trial_pack" => Some((
            PRIVATE_AGENT_TRIAL_PACK_INCLUDED_COMPUTE_SECONDS,
            PRIVATE_AGENT_TRIAL_PACK_ACTIVE_AGENT_LIMIT,
        )),
        "starter" => Some((
            PRIVATE_AGENT_STARTER_INCLUDED_COMPUTE_SECONDS,
            PRIVATE_AGENT_STARTER_ACTIVE_AGENT_LIMIT,
        )),
        "private_agent" => Some((
            PRIVATE_AGENT_INCLUDED_COMPUTE_SECONDS,
            PRIVATE_AGENT_ACTIVE_AGENT_LIMIT,
        )),
        "enterprise" => Some((
            ENTERPRISE_INCLUDED_COMPUTE_SECONDS,
            ENTERPRISE_ACTIVE_AGENT_LIMIT,
        )),
        _ => None,
    }
}

fn private_agent_trading_plan_for_tier(tier: &str) -> Option<PrivateAgentTradingPlan> {
    match tier {
        "trial_pack" => Some(PrivateAgentTradingPlan {
            included_notional_micro_usd: PRIVATE_AGENT_TRIAL_INCLUDED_NOTIONAL_MICRO_USD,
            overage_fee_bps: 0,
            default_monthly_fee_cap_micro_usd: 0,
        }),
        "starter" => Some(PrivateAgentTradingPlan {
            included_notional_micro_usd: PRIVATE_AGENT_STARTER_INCLUDED_NOTIONAL_MICRO_USD,
            overage_fee_bps: PRIVATE_AGENT_STARTER_OVERAGE_FEE_BPS,
            default_monthly_fee_cap_micro_usd: PRIVATE_AGENT_STARTER_DEFAULT_FEE_CAP_MICRO_USD,
        }),
        "private_agent" => Some(PrivateAgentTradingPlan {
            included_notional_micro_usd: PRIVATE_AGENT_INCLUDED_NOTIONAL_MICRO_USD,
            overage_fee_bps: PRIVATE_AGENT_OVERAGE_FEE_BPS,
            default_monthly_fee_cap_micro_usd: PRIVATE_AGENT_DEFAULT_FEE_CAP_MICRO_USD,
        }),
        "enterprise" => Some(PrivateAgentTradingPlan {
            included_notional_micro_usd: i64::MAX / 4,
            overage_fee_bps: 0,
            default_monthly_fee_cap_micro_usd: 0,
        }),
        _ => None,
    }
}

fn fee_for_overage_micro_usd(notional_micro_usd: i64, fee_bps: i32) -> i64 {
    if notional_micro_usd <= 0 || fee_bps <= 0 {
        return 0;
    }
    let numerator = i128::from(notional_micro_usd) * i128::from(fee_bps);
    ((numerator + 9_999) / 10_000).min(i128::from(i64::MAX)) as i64
}

fn valid_trading_meter_identifier(value: &str) -> bool {
    (8..=200).contains(&value.len())
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | ':'))
}

fn private_agent_trading_status_from_values(
    plan: PrivateAgentTradingPlan,
    filled_notional_micro_usd: i64,
    accrued_fee_micro_usd: i64,
    queued_fee_cents: i64,
    invoiced_fee_cents: i64,
    monthly_fee_cap_micro_usd: i64,
    period_start: chrono::DateTime<chrono::Utc>,
    period_end: chrono::DateTime<chrono::Utc>,
) -> PrivateAgentTradingStatus {
    let remaining = (plan.included_notional_micro_usd - filled_notional_micro_usd).max(0);
    let overage = (filled_notional_micro_usd - plan.included_notional_micro_usd).max(0);
    let hard_allowance_exhausted = plan.overage_fee_bps == 0 && remaining == 0;
    let cap_reached = plan.overage_fee_bps > 0
        && if monthly_fee_cap_micro_usd == 0 {
            remaining == 0
        } else {
            accrued_fee_micro_usd >= monthly_fee_cap_micro_usd
        };
    PrivateAgentTradingStatus {
        included_notional_micro_usd: plan.included_notional_micro_usd,
        filled_notional_micro_usd,
        remaining_included_notional_micro_usd: remaining,
        overage_notional_micro_usd: overage,
        overage_fee_bps: plan.overage_fee_bps,
        accrued_fee_micro_usd,
        queued_fee_cents,
        invoiced_fee_cents,
        monthly_fee_cap_micro_usd,
        cap_reached,
        live_trading_allowed: !hard_allowance_exhausted && !cap_reached,
        period_start: period_start.to_rfc3339(),
        period_end: period_end.to_rfc3339(),
        metering_unit: "filled_notional_micro_usd",
        billing_state: if queued_fee_cents > invoiced_fee_cents {
            "invoice_pending"
        } else {
            "current"
        },
    }
}

fn billing_limits_for_tier(tier: &str) -> BillingLimits {
    let (private_compute_seconds, active_private_agents) =
        private_agent_allowance_for_tier(tier).unwrap_or((0, 0));
    match tier {
        "trial_pack" => BillingLimits {
            calls_per_month: 10,
            emails_per_month: 15,
            private_compute_seconds,
            active_private_agents,
        },
        "starter" => BillingLimits {
            calls_per_month: 20,
            emails_per_month: 30,
            private_compute_seconds,
            active_private_agents,
        },
        "pro" => BillingLimits {
            calls_per_month: 30,
            emails_per_month: 50,
            private_compute_seconds,
            active_private_agents,
        },
        "private_agent" => BillingLimits {
            calls_per_month: 30,
            emails_per_month: 50,
            private_compute_seconds,
            active_private_agents,
        },
        "unlimited" => BillingLimits {
            calls_per_month: 999,
            emails_per_month: 999,
            private_compute_seconds,
            active_private_agents,
        },
        "enterprise" => BillingLimits {
            calls_per_month: 999,
            emails_per_month: 999,
            private_compute_seconds,
            active_private_agents,
        },
        _ => BillingLimits {
            calls_per_month: 5,
            emails_per_month: 10,
            private_compute_seconds,
            active_private_agents,
        },
    }
}

fn private_agent_period_at(
    now: chrono::DateTime<chrono::Utc>,
) -> Result<
    (
        chrono::NaiveDate,
        chrono::DateTime<chrono::Utc>,
        chrono::DateTime<chrono::Utc>,
    ),
    CloudError,
> {
    let start = chrono::Utc
        .with_ymd_and_hms(now.year(), now.month(), 1, 0, 0, 0)
        .single()
        .ok_or_else(|| CloudError::Internal("could not compute billing period".to_string()))?;
    let (end_year, end_month) = if now.month() == 12 {
        (now.year() + 1, 1)
    } else {
        (now.year(), now.month() + 1)
    };
    let end = chrono::Utc
        .with_ymd_and_hms(end_year, end_month, 1, 0, 0, 0)
        .single()
        .ok_or_else(|| CloudError::Internal("could not compute billing period".to_string()))?;
    Ok((start.date_naive(), start, end))
}

fn normalize_private_agent_reservation_reason(reason: Option<String>) -> String {
    match reason.as_deref().map(str::trim) {
        Some("live_trade_submit") => "live_trade_submit".to_string(),
        _ => "private_agent_session".to_string(),
    }
}

fn validate_private_agent_session_id(session_id: &str) -> Result<(), CloudError> {
    let valid = (4..=160).contains(&session_id.len())
        && session_id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | ':'));
    if !valid {
        return Err(CloudError::BadRequest(
            "session_id must be 4-160 URL-safe characters".to_string(),
        ));
    }
    Ok(())
}

async fn private_agent_compute_status_for_user(
    state: &AppState,
    user_id: uuid::Uuid,
    access: &EffectiveAccess,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<Option<PrivateAgentComputeStatus>, CloudError> {
    let Some((included_seconds, active_agent_limit)) =
        private_agent_allowance_for_tier(&access.tier)
    else {
        return Ok(None);
    };
    let (period_start, period_start_dt, period_end_dt) = private_agent_period_at(now)?;
    let (reserved_seconds, used_seconds, active_agent_count) =
        sqlx::query_as::<_, (i64, i64, i64)>(
            r#"
        SELECT
            COALESCE(SUM(seconds) FILTER (
                WHERE status = 'reserved' AND access_source = $3
            ), 0)::BIGINT,
            COALESCE(SUM(seconds) FILTER (
                WHERE status = 'completed' AND access_source = $3
            ), 0)::BIGINT,
            COALESCE(COUNT(*) FILTER (
                WHERE status = 'reserved' AND reason = 'private_agent_session'
            ), 0)::BIGINT
        FROM private_agent_compute_reservations
        WHERE user_id = $1 AND period_start = $2
        "#,
        )
        .bind(user_id)
        .bind(period_start)
        .bind(access.source)
        .fetch_one(&state.db)
        .await?;
    let remaining_seconds = (included_seconds - reserved_seconds - used_seconds).max(0);
    Ok(Some(PrivateAgentComputeStatus {
        included_seconds,
        reserved_seconds,
        used_seconds,
        remaining_seconds,
        active_agent_limit,
        active_agent_count,
        period_start: period_start_dt.to_rfc3339(),
        period_end: period_end_dt.to_rfc3339(),
        metering_unit: "agent_second",
    }))
}

async fn private_agent_trading_status_for_user(
    state: &AppState,
    user_id: uuid::Uuid,
    access: &EffectiveAccess,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<Option<PrivateAgentTradingStatus>, CloudError> {
    let Some(plan) = private_agent_trading_plan_for_access(access) else {
        return Ok(None);
    };
    if access.source == "complimentary_pass" {
        return private_agent_trading_status_for_user_read_only(state, user_id, access, now).await;
    }
    let (period_start, period_start_dt, period_end_dt) = private_agent_period_at(now)?;
    sqlx::query(
        r#"
        INSERT INTO private_agent_trading_usage_periods
            (user_id, period_start, tier, included_notional_micro_usd, overage_fee_bps,
             monthly_fee_cap_micro_usd)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (user_id, period_start) DO NOTHING
        "#,
    )
    .bind(user_id)
    .bind(period_start)
    .bind(&access.tier)
    .bind(plan.included_notional_micro_usd)
    .bind(plan.overage_fee_bps)
    .bind(plan.default_monthly_fee_cap_micro_usd)
    .execute(&state.db)
    .await?;
    let row = sqlx::query_as::<_, (i64, i32, i64, i64, i64, i64)>(
        r#"
        SELECT included_notional_micro_usd, overage_fee_bps, filled_notional_micro_usd,
               accrued_fee_micro_usd, queued_fee_cents, invoiced_fee_cents
        FROM private_agent_trading_usage_periods
        WHERE user_id = $1 AND period_start = $2
        "#,
    )
    .bind(user_id)
    .bind(period_start)
    .fetch_one(&state.db)
    .await?;
    let monthly_fee_cap_micro_usd: i64 = sqlx::query_scalar(
        "SELECT monthly_fee_cap_micro_usd FROM private_agent_trading_usage_periods WHERE user_id = $1 AND period_start = $2",
    )
    .bind(user_id)
    .bind(period_start)
    .fetch_one(&state.db)
    .await?;
    Ok(Some(private_agent_trading_status_from_values(
        PrivateAgentTradingPlan {
            included_notional_micro_usd: row.0,
            overage_fee_bps: row.1,
            default_monthly_fee_cap_micro_usd: monthly_fee_cap_micro_usd,
        },
        row.2,
        row.3,
        row.4,
        row.5,
        monthly_fee_cap_micro_usd,
        period_start_dt,
        period_end_dt,
    )))
}

async fn private_agent_trading_status_for_user_read_only(
    state: &AppState,
    user_id: uuid::Uuid,
    access: &EffectiveAccess,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<Option<PrivateAgentTradingStatus>, CloudError> {
    let Some(plan) = private_agent_trading_plan_for_access(access) else {
        return Ok(None);
    };
    let (period_start, period_start_dt, period_end_dt) = private_agent_period_at(now)?;
    if access.source == "complimentary_pass" {
        let filled_notional_micro_usd: i64 = sqlx::query_scalar(
            r#"
            SELECT filled_notional_micro_usd
            FROM complimentary_access_trading_usage_periods
            WHERE user_id = $1 AND period_start = $2
            "#,
        )
        .bind(user_id)
        .bind(period_start)
        .fetch_optional(&state.db)
        .await?
        .unwrap_or(0);
        return Ok(Some(private_agent_trading_status_from_values(
            plan,
            filled_notional_micro_usd,
            0,
            0,
            0,
            0,
            period_start_dt,
            period_end_dt,
        )));
    }
    let row = sqlx::query_as::<_, (i64, i32, i64, i64, i64, i64, i64)>(
        r#"
        SELECT included_notional_micro_usd, overage_fee_bps, filled_notional_micro_usd,
               accrued_fee_micro_usd, queued_fee_cents, invoiced_fee_cents,
               monthly_fee_cap_micro_usd
        FROM private_agent_trading_usage_periods
        WHERE user_id = $1 AND period_start = $2
        "#,
    )
    .bind(user_id)
    .bind(period_start)
    .fetch_optional(&state.db)
    .await?;
    let (stored_plan, filled, accrued, queued, invoiced, cap) = match row {
        Some(row) => (
            PrivateAgentTradingPlan {
                included_notional_micro_usd: row.0,
                overage_fee_bps: row.1,
                default_monthly_fee_cap_micro_usd: row.6,
            },
            row.2,
            row.3,
            row.4,
            row.5,
            row.6,
        ),
        None => (plan, 0, 0, 0, 0, plan.default_monthly_fee_cap_micro_usd),
    };
    Ok(Some(private_agent_trading_status_from_values(
        stored_plan,
        filled,
        accrued,
        queued,
        invoiced,
        cap,
        period_start_dt,
        period_end_dt,
    )))
}

async fn mark_private_balance_top_up_paid(
    event: &serde_json::Value,
    state: &AppState,
) -> Result<(), CloudError> {
    let session = &event["data"]["object"];
    let metadata = &session["metadata"];
    let deposit_id = metadata["deposit_id"]
        .as_str()
        .ok_or(CloudError::BadRequest(
            "private balance checkout missing deposit_id".to_string(),
        ))?
        .parse::<uuid::Uuid>()
        .map_err(|_| CloudError::BadRequest("invalid private balance deposit_id".to_string()))?;
    let user_id = session["client_reference_id"]
        .as_str()
        .ok_or(CloudError::BadRequest(
            "private balance checkout missing client_reference_id".to_string(),
        ))?
        .parse::<uuid::Uuid>()
        .map_err(|_| {
            CloudError::BadRequest("invalid private balance client_reference_id".to_string())
        })?;
    let expected_amount = metadata["amount_micro_usdc"]
        .as_str()
        .and_then(|v| v.parse::<i64>().ok())
        .ok_or(CloudError::BadRequest(
            "private balance checkout missing amount".to_string(),
        ))?;
    let amount_total_micro_usdc = session["amount_total"].as_i64().unwrap_or(0) * 10_000;
    if amount_total_micro_usdc < expected_amount {
        return Err(CloudError::BadRequest(
            "private balance checkout amount mismatch".to_string(),
        ));
    }

    let customer_id = session["customer"].as_str().unwrap_or("");
    let payment_intent_id = session["payment_intent"].as_str();
    let session_id = session["id"].as_str();

    let updated = sqlx::query(
        r#"
        UPDATE private_balance_deposits
        SET status = CASE
                WHEN status = 'checkout_pending' THEN 'paid'
                ELSE status
            END,
            stripe_session_id = COALESCE($4, stripe_session_id),
            stripe_payment_intent_id = COALESCE($5, stripe_payment_intent_id),
            stripe_customer_id = COALESCE(NULLIF($6, ''), stripe_customer_id),
            paid_at = COALESCE(paid_at, now()),
            updated_at = now()
        WHERE id = $1
          AND user_id = $2
          AND amount_usdc = $3
          AND status IN ('checkout_pending', 'paid', 'shield_pending', 'shielded')
        "#,
    )
    .bind(deposit_id)
    .bind(user_id)
    .bind(expected_amount)
    .bind(session_id)
    .bind(payment_intent_id)
    .bind(customer_id)
    .execute(&state.db)
    .await?;

    if updated.rows_affected() == 0 {
        return Err(CloudError::BadRequest(
            "private balance deposit was not found or already closed".to_string(),
        ));
    }

    if !customer_id.is_empty() {
        sqlx::query(
            "UPDATE users SET stripe_customer_id = COALESCE(stripe_customer_id, $1), updated_at = now() WHERE id = $2",
        )
        .bind(customer_id)
        .bind(user_id)
        .execute(&state.db)
        .await?;
    }

    tracing::info!(
        %user_id,
        %deposit_id,
        amount_micro_usdc = expected_amount,
        "private balance top up paid"
    );

    Ok(())
}

/// POST /api/billing/webhook — Stripe webhook
pub async fn billing_webhook(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: String,
) -> Result<Json<serde_json::Value>, CloudError> {
    // Verify Stripe webhook signature if secret is configured
    let webhook_secret = state.config.stripe_webhook_secret.as_ref().ok_or_else(|| {
        tracing::error!("STRIPE_WEBHOOK_SECRET not configured — rejecting webhook");
        CloudError::Internal("webhook verification unavailable".into())
    })?;

    let sig_header = headers
        .get("stripe-signature")
        .and_then(|v| v.to_str().ok())
        .ok_or(CloudError::BadRequest(
            "missing Stripe-Signature header".to_string(),
        ))?;
    verify_stripe_signature(&body, sig_header, webhook_secret)?;

    let event: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| CloudError::BadRequest(format!("invalid JSON: {e}")))?;

    let event_type = event["type"].as_str().unwrap_or("");

    match event_type {
        "checkout.session.completed" => {
            if event["data"]["object"]["metadata"]["ghola_kind"].as_str()
                == Some("private_balance_top_up")
            {
                mark_private_balance_top_up_paid(&event, &state).await?;
                return Ok(Json(serde_json::json!({ "ok": true })));
            }

            let user_id_str = event["data"]["object"]["client_reference_id"]
                .as_str()
                .unwrap_or("");
            let customer_id = event["data"]["object"]["customer"].as_str().unwrap_or("");
            let subscription_id = event["data"]["object"]["subscription"]
                .as_str()
                .unwrap_or("");

            if let Ok(user_id) = user_id_str.parse::<uuid::Uuid>() {
                // Determine tier from the checkout session's price ID
                let tier = tier_from_price_id(&event, &state);
                let expires_at = if tier == "trial_pack" {
                    Some(chrono::Utc::now() + chrono::Duration::days(PRIVATE_AGENT_TRIAL_PACK_DAYS))
                } else {
                    None
                };

                sqlx::query(
                    r#"
                    UPDATE users
                    SET tier = $1,
                        tier_expires_at = $2,
                        stripe_customer_id = COALESCE(NULLIF($3, ''), stripe_customer_id),
                        stripe_subscription_id = COALESCE(NULLIF($4, ''), stripe_subscription_id),
                        updated_at = now()
                    WHERE id = $5
                    "#,
                )
                .bind(tier)
                .bind(expires_at)
                .bind(customer_id)
                .bind(subscription_id)
                .bind(user_id)
                .execute(&state.db)
                .await?;

                tracing::info!(%user_id, tier, "subscription activated");
            }
        }
        "customer.subscription.deleted" => {
            let customer_id = event["data"]["object"]["customer"].as_str().unwrap_or("");

            sqlx::query(
                "UPDATE users SET tier = 'free', tier_expires_at = NULL, stripe_subscription_id = NULL, updated_at = now() WHERE stripe_customer_id = $1",
            )
            .bind(customer_id)
            .execute(&state.db)
            .await?;

            tracing::info!(customer_id, "subscription cancelled, reverted to free");
        }
        "customer.subscription.updated" => {
            let customer_id = event["data"]["object"]["customer"].as_str().unwrap_or("");
            let subscription_id = event["data"]["object"]["id"].as_str().unwrap_or("");
            let status = event["data"]["object"]["status"].as_str().unwrap_or("");
            if matches!(status, "active" | "trialing") {
                let tier = tier_from_price_id(&event, &state);
                sqlx::query(
                    "UPDATE users SET tier = $1, tier_expires_at = NULL, stripe_subscription_id = COALESCE(NULLIF($2, ''), stripe_subscription_id), updated_at = now() WHERE stripe_customer_id = $3",
                )
                .bind(tier)
                .bind(subscription_id)
                .bind(customer_id)
                .execute(&state.db)
                .await?;
                tracing::info!(customer_id, tier, "subscription tier updated");
            } else if matches!(status, "canceled" | "unpaid" | "incomplete_expired") {
                sqlx::query(
                    "UPDATE users SET tier = 'free', tier_expires_at = NULL, updated_at = now() WHERE stripe_customer_id = $1",
                )
                .bind(customer_id)
                .execute(&state.db)
                .await?;
                tracing::info!(customer_id, status, "subscription no longer active");
            }
        }
        "invoice.paid" => {
            let customer_id = event["data"]["object"]["customer"].as_str().unwrap_or("");
            sqlx::query(
                r#"
                UPDATE private_agent_trading_usage_periods p
                SET active_stripe_invoice_item_id = NULL,
                    active_stripe_invoice_item_base_cents = 0,
                    updated_at = now()
                FROM users u
                WHERE p.user_id = u.id AND u.stripe_customer_id = $1
                "#,
            )
            .bind(customer_id)
            .execute(&state.db)
            .await?;
            tracing::info!(customer_id, "trading overage invoice paid");
        }
        "invoice.payment_failed" => {
            let customer_id = event["data"]["object"]["customer"].as_str().unwrap_or("");
            tracing::warn!(customer_id, "trading overage invoice payment failed");
        }
        _ => {
            tracing::debug!(event_type, "unhandled Stripe event");
        }
    }

    Ok(Json(serde_json::json!({ "ok": true })))
}

/// GET /api/billing/private-balance
pub async fn private_balance_status(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
) -> Result<Json<PrivateBalanceStatusResponse>, CloudError> {
    let rows = sqlx::query_as::<
        _,
        (
            uuid::Uuid,
            i64,
            String,
            String,
            Option<String>,
            chrono::DateTime<chrono::Utc>,
            Option<chrono::DateTime<chrono::Utc>>,
            Option<chrono::DateTime<chrono::Utc>>,
        ),
    >(
        r#"
        SELECT id, amount_usdc, status, source, stripe_session_id, created_at, paid_at, shielded_at
        FROM private_balance_deposits
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 20
        "#,
    )
    .bind(claims.sub)
    .fetch_all(&state.db)
    .await?;

    let mut paid_micro_usdc = 0i64;
    let mut shielded_micro_usdc = 0i64;
    let mut pending_micro_usdc = 0i64;
    let deposits = rows
        .into_iter()
        .map(
            |(
                id,
                amount_usdc,
                status,
                source,
                stripe_session_id,
                created_at,
                paid_at,
                shielded_at,
            )| {
                match status.as_str() {
                    "paid" | "shield_pending" => paid_micro_usdc += amount_usdc,
                    "shielded" => shielded_micro_usdc += amount_usdc,
                    "checkout_pending" => pending_micro_usdc += amount_usdc,
                    _ => {}
                }
                PrivateBalanceDeposit {
                    id,
                    amount_usdc,
                    status,
                    source,
                    stripe_session_id,
                    created_at,
                    paid_at,
                    shielded_at,
                }
            },
        )
        .collect::<Vec<_>>();

    Ok(Json(PrivateBalanceStatusResponse {
        available_micro_usdc: paid_micro_usdc + shielded_micro_usdc,
        paid_micro_usdc,
        shielded_micro_usdc,
        pending_micro_usdc,
        deposits,
    }))
}

fn access_pass_hash(code: &str) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(code.as_bytes()))
}

fn normalize_access_pass_email(email: &str) -> String {
    email.trim().to_ascii_lowercase()
}

fn validate_access_pass_email(email: &str) -> Result<String, CloudError> {
    let email = normalize_access_pass_email(email);
    let mut parts = email.split('@');
    let local = parts.next().unwrap_or_default();
    let domain = parts.next().unwrap_or_default();
    let valid = email.len() <= 320
        && email.is_ascii()
        && !local.is_empty()
        && !domain.is_empty()
        && parts.next().is_none()
        && email
            .bytes()
            .all(|byte| !byte.is_ascii_whitespace() && !byte.is_ascii_control());
    if !valid {
        return Err(CloudError::BadRequest("email is invalid".to_string()));
    }
    Ok(email)
}

fn validate_access_pass_code(code: &str) -> Result<&str, CloudError> {
    let code = code.trim();
    if !(32..=128).contains(&code.len())
        || !code
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
    {
        return Err(CloudError::BadRequest("access pass is invalid".to_string()));
    }
    Ok(code)
}

fn validate_access_pass_idempotency_key(key: &str) -> Result<&str, CloudError> {
    let key = key.trim();
    if !(16..=128).contains(&key.len())
        || !key
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | ':'))
    {
        return Err(CloudError::BadRequest(
            "access_pass_idempotency_key_invalid".to_string(),
        ));
    }
    Ok(key)
}

fn constant_time_eq(left: &str, right: &str) -> bool {
    use sha2::{Digest, Sha256};
    let left = Sha256::digest(left.as_bytes());
    let right = Sha256::digest(right.as_bytes());
    left.iter()
        .zip(right.iter())
        .fold(0u8, |diff, (a, b)| diff | (a ^ b))
        == 0
}

fn authorize_access_pass_admin(
    state: &AppState,
    claims: &crate::auth::Claims,
    headers: &HeaderMap,
) -> Result<(), CloudError> {
    let configured_secret = state
        .config
        .investor_pass_admin_secret
        .as_deref()
        .filter(|secret| secret.len() >= 32)
        .ok_or_else(|| {
            CloudError::ServiceUnavailable("access_pass_admin_disabled".to_string())
        })?;
    let provided_secret = headers
        .get("x-ghola-admin-secret")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let operator_email = claims
        .email
        .as_deref()
        .map(normalize_access_pass_email)
        .unwrap_or_default();
    if !constant_time_eq(configured_secret, provided_secret)
        || !state.config.admin_emails.iter().any(|email| email == &operator_email)
    {
        return Err(CloudError::Forbidden(
            "access_pass_admin_forbidden".to_string(),
        ));
    }
    Ok(())
}


fn authorize_investor_canary(state: &AppState, headers: &HeaderMap) -> bool {
    let Some(configured) = state
        .config
        .investor_canary_secret
        .as_deref()
        .filter(|secret| secret.len() >= 32)
    else {
        return false;
    };
    let provided = headers
        .get("x-ghola-investor-canary-secret")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    constant_time_eq(configured, provided)
}

/// POST /api/billing/access-passes — operator-only, email-bound invite creation.
pub async fn create_access_pass(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    headers: HeaderMap,
    Json(req): Json<CreateAccessPassRequest>,
) -> Result<Json<CreateAccessPassResponse>, CloudError> {
    authorize_access_pass_admin(&state, &claims, &headers)?;

    let tier = req.tier.unwrap_or_else(|| "starter".to_string());
    if !matches!(tier.as_str(), "starter" | "private_agent") {
        return Err(CloudError::BadRequest(
            "tier must be starter or private_agent".to_string(),
        ));
    }
    let grant_days = req.grant_days.unwrap_or(14);
    let redeem_days = req.redeem_days.unwrap_or(7);
    if !(1..=90).contains(&grant_days) || !(1..=30).contains(&redeem_days) {
        return Err(CloudError::BadRequest(
            "grant_days must be 1-90 and redeem_days must be 1-30".to_string(),
        ));
    }
    let email = validate_access_pass_email(&req.email)?;
    let idempotency_key = validate_access_pass_idempotency_key(&req.idempotency_key)?;
    let issuance_fingerprint = access_pass_hash(&format!(
        "{email}\0{tier}\0{grant_days}\0{redeem_days}"
    ));

    use base64::Engine;
    use rand::RngCore;
    let mut random = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut random);
    let code = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(random);
    let code_encrypted = crate::services::email_service::encrypt_token(
        &code,
        &state.config.encryption_key,
    )?;
    let mut tx = state.db.begin().await?;
    sqlx::query(
        r#"
        INSERT INTO complimentary_access_passes
            (code_hash, email, tier, issuance_key, issuance_fingerprint, code_encrypted,
             redeem_expires_at, grant_days, created_by)
        VALUES ($1, $2, $3, $4, $5, $6,
                clock_timestamp() + make_interval(days => $7), $8, $9)
        ON CONFLICT (created_by, issuance_key) WHERE issuance_key IS NOT NULL DO NOTHING
        "#,
    )
    .bind(access_pass_hash(&code))
    .bind(&email)
    .bind(&tier)
    .bind(idempotency_key)
    .bind(&issuance_fingerprint)
    .bind(code_encrypted)
    .bind(redeem_days as i32)
    .bind(grant_days as i32)
    .bind(claims.sub)
    .execute(&mut *tx)
    .await?;

    let stored = sqlx::query_as::<_, (
        uuid::Uuid,
        String,
        String,
        chrono::DateTime<chrono::Utc>,
        i32,
        Vec<u8>,
        String,
    )>(
        r#"
        SELECT pass_id, tier, email, redeem_expires_at, grant_days,
               code_encrypted, issuance_fingerprint
        FROM complimentary_access_passes
        WHERE created_by = $1 AND issuance_key = $2
        FOR UPDATE
        "#,
    )
    .bind(claims.sub)
    .bind(idempotency_key)
    .fetch_one(&mut *tx)
    .await?;
    if stored.6 != issuance_fingerprint || stored.2 != email {
        return Err(CloudError::BadRequest(
            "access_pass_idempotency_conflict".to_string(),
        ));
    }
    let stored_code = crate::services::email_service::decrypt_token(
        &stored.5,
        &state.config.encryption_key,
    )?;
    if access_pass_hash(&stored_code)
        != sqlx::query_scalar::<_, String>(
            "SELECT code_hash FROM complimentary_access_passes WHERE pass_id = $1",
        )
        .bind(stored.0)
        .fetch_one(&mut *tx)
        .await?
    {
        return Err(CloudError::Internal(
            "stored access pass failed integrity check".to_string(),
        ));
    }
    tx.commit().await?;

    Ok(Json(CreateAccessPassResponse {
        pass_id: stored.0,
        // Fragments are not sent in HTTP requests, logs, or referrers. The web
        // client removes this value before redeeming it.
        invite_url: format!(
            "{}/account#access={stored_code}",
            state.config.investor_web_origin
        ),
        tier: stored.1,
        redeem_expires_at: stored.3.to_rfc3339(),
        grant_days: i64::from(stored.4),
    }))
}

/// POST /api/billing/access-passes/redeem — one-use, email-bound redemption.
pub async fn redeem_access_pass(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Json(req): Json<RedeemAccessPassRequest>,
) -> Result<Json<RedeemAccessPassResponse>, CloudError> {
    let code = validate_access_pass_code(&req.code)?;
    let code_hash = access_pass_hash(code);
    let mut tx = state.db.begin().await?;
    let pass = sqlx::query_as::<
        _,
        (
            String,
            String,
            chrono::DateTime<chrono::Utc>,
            i32,
            Option<uuid::Uuid>,
            Option<chrono::DateTime<chrono::Utc>>,
            Option<chrono::DateTime<chrono::Utc>>,
            chrono::DateTime<chrono::Utc>,
        ),
    >(
        r#"
        SELECT email, tier, redeem_expires_at, grant_days, redeemed_by, grant_expires_at,
               revoked_at, clock_timestamp()
        FROM complimentary_access_passes
        WHERE code_hash = $1
        FOR UPDATE
        "#,
    )
    .bind(&code_hash)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| CloudError::BadRequest("access pass is invalid".to_string()))?;

    let (
        bound_email,
        tier,
        redeem_expires_at,
        _grant_days,
        redeemed_by,
        existing_expiry,
        revoked_at,
        database_now,
    ) = pass;
    let account = sqlx::query_as::<_, (Option<String>, bool)>(
        r#"
        SELECT email, (google_id IS NOT NULL OR apple_id IS NOT NULL)
        FROM users
        WHERE id = $1
        "#,
    )
    .bind(claims.sub)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| CloudError::NotFound("user not found".to_string()))?;
    if !account.1 {
        return Err(CloudError::Forbidden(
            "investor_email_verification_required".to_string(),
        ));
    }
    if account
        .0
        .as_deref()
        .map(normalize_access_pass_email)
        .as_deref()
        != Some(bound_email.as_str())
    {
        return Err(CloudError::Forbidden(
            "investor_access_email_mismatch".to_string(),
        ));
    }
    if revoked_at.is_some() {
        return Err(CloudError::BadRequest(
            "access pass was revoked".to_string(),
        ));
    }
    if let Some(user_id) = redeemed_by {
        if user_id != claims.sub {
            return Err(CloudError::BadRequest(
                "access pass has already been redeemed".to_string(),
            ));
        }
        let expires_at = existing_expiry
            .filter(|expiry| *expiry > database_now)
            .ok_or_else(|| CloudError::BadRequest("access pass has expired".to_string()))?;
        tx.commit().await?;
        return Ok(Json(RedeemAccessPassResponse {
            ok: true,
            tier,
            expires_at: expires_at.to_rfc3339(),
            access_source: "complimentary_pass",
        }));
    }
    if redeem_expires_at <= database_now {
        return Err(CloudError::BadRequest(
            "access pass has expired".to_string(),
        ));
    }

    let grant_expires_at: Option<chrono::DateTime<chrono::Utc>> = sqlx::query_scalar(
        r#"
        WITH redemption_clock AS (
            SELECT clock_timestamp() AS current_time
        )
        UPDATE complimentary_access_passes AS pass
        SET redeemed_by = $2,
            redeemed_at = redemption_clock.current_time,
            grant_expires_at = redemption_clock.current_time
                + make_interval(days => pass.grant_days)
        FROM redemption_clock
        WHERE code_hash = $1
          AND redeemed_by IS NULL
          AND revoked_at IS NULL
          AND redeem_expires_at > redemption_clock.current_time
        RETURNING grant_expires_at
        "#,
    )
    .bind(&code_hash)
    .bind(claims.sub)
    .fetch_optional(&mut *tx)
    .await?;
    let grant_expires_at = grant_expires_at
        .ok_or_else(|| CloudError::BadRequest("access pass could not be redeemed".to_string()))?;
    tx.commit().await?;

    Ok(Json(RedeemAccessPassResponse {
        ok: true,
        tier,
        expires_at: grant_expires_at.to_rfc3339(),
        access_source: "complimentary_pass",
    }))
}

/// POST /api/billing/access-passes/revoke — operator-only, idempotent rollback.
pub async fn revoke_access_pass(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    headers: HeaderMap,
    Json(req): Json<RevokeAccessPassRequest>,
) -> Result<Json<RevokeAccessPassResponse>, CloudError> {
    authorize_access_pass_admin(&state, &claims, &headers)?;
    let mut tx = state.db.begin().await?;
    let revoked = sqlx::query_as::<_, (Option<uuid::Uuid>, chrono::DateTime<chrono::Utc>)>(
        r#"
        UPDATE complimentary_access_passes
        SET revoked_at = COALESCE(revoked_at, clock_timestamp())
        WHERE pass_id = $1
        RETURNING redeemed_by, revoked_at
        "#,
    )
    .bind(req.pass_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| CloudError::BadRequest("access pass is invalid".to_string()))?;

    if let Some(user_id) = revoked.0 {
        sqlx::query(
            r#"
            UPDATE private_agent_compute_reservations
            SET status = 'paused',
                released_at = COALESCE(released_at, clock_timestamp()),
                updated_at = clock_timestamp()
            WHERE user_id = $1
              AND access_pass_id = $2
              AND access_source = 'complimentary_pass'
              AND status = 'reserved'
            "#,
        )
        .bind(user_id)
        .bind(req.pass_id)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(Json(RevokeAccessPassResponse {
        ok: true,
        pass_id: req.pass_id,
        state: "revoked",
        revoked_at: revoked.1.to_rfc3339(),
    }))
}

/// POST /api/billing/private-agent/compute/reserve
pub async fn reserve_private_agent_compute(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    headers: HeaderMap,
    Json(req): Json<ReservePrivateAgentComputeRequest>,
) -> Result<Json<ReservePrivateAgentComputeResponse>, CloudError> {
    validate_private_agent_session_id(&req.session_id)?;
    if !(1..=24 * 60 * 60).contains(&req.seconds) {
        return Err(CloudError::BadRequest(
            "seconds must be between 1 and 86400".to_string(),
        ));
    }
    let reason = normalize_private_agent_reservation_reason(req.reason);

    let mut tx = state.db.begin().await?;
    let row = sqlx::query_as::<
        _,
        (
            String,
            Option<chrono::DateTime<chrono::Utc>>,
            chrono::DateTime<chrono::Utc>,
        ),
    >(
        "SELECT tier, tier_expires_at, clock_timestamp() FROM users WHERE id = $1 FOR UPDATE",
    )
    .bind(claims.sub)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(CloudError::NotFound("user not found".to_string()))?;
    let access_clock = row.2;
    let (period_start, _, _) = private_agent_period_at(access_clock)?;
    pause_inactive_complimentary_reservations(&mut tx, claims.sub, access_clock).await?;

    // A retry of an already accepted reservation is idempotent even if the
    // entitlement expired between the original response and the retry. It
    // cannot reserve additional capacity because the original row is reused.
    if let Some((reservation_id, reserved_seconds, status)) =
        sqlx::query_as::<_, (uuid::Uuid, i64, String)>(
            r#"
            SELECT id, seconds, status
            FROM private_agent_compute_reservations
            WHERE user_id = $1 AND session_id = $2
            "#,
        )
        .bind(claims.sub)
        .bind(&req.session_id)
        .fetch_optional(&mut *tx)
        .await?
    {
        if status == "reserved" || status == "completed" {
            tx.commit().await?;
            return Ok(Json(ReservePrivateAgentComputeResponse {
                ok: true,
                reservation_id,
                reserved_seconds,
            }));
        }
        return Err(CloudError::PaymentRequired(
            "private-agent compute reservation is closed".to_string(),
        ));
    }

    let grants = access_grants_for_user(&mut *tx, claims.sub, true).await?;
    let invite = select_access_grant(&grants, access_clock);
    let access = resolve_execution_access(
        row.0,
        row.1,
        invite,
        access_clock,
        authorize_investor_canary(&state, &headers),
    );

    let Some((included_seconds, active_agent_limit)) =
        private_agent_allowance_for_tier(&access.tier)
    else {
        tx.commit().await?;
        return Err(CloudError::PaymentRequired(
            "private-agent compute allowance required".to_string(),
        ));
    };

    let (reserved_seconds, used_seconds, active_agent_count) =
        sqlx::query_as::<_, (i64, i64, i64)>(
            r#"
            SELECT
                COALESCE(SUM(seconds) FILTER (
                    WHERE status = 'reserved' AND access_source = $3
                ), 0)::BIGINT,
                COALESCE(SUM(seconds) FILTER (
                    WHERE status = 'completed' AND access_source = $3
                ), 0)::BIGINT,
                COALESCE(COUNT(*) FILTER (
                    WHERE status = 'reserved' AND reason = 'private_agent_session'
                ), 0)::BIGINT
            FROM private_agent_compute_reservations
            WHERE user_id = $1 AND period_start = $2
            "#,
        )
        .bind(claims.sub)
        .bind(period_start)
        .bind(access.source)
        .fetch_one(&mut *tx)
        .await?;
    let remaining_seconds = (included_seconds - reserved_seconds - used_seconds).max(0);
    if remaining_seconds < req.seconds {
        return Err(CloudError::PaymentRequired(
            "private-agent compute allowance exhausted".to_string(),
        ));
    }
    if reason == "private_agent_session" && active_agent_count >= active_agent_limit {
        return Err(CloudError::PaymentRequired(
            "active private-agent limit reached".to_string(),
        ));
    }

    let reservation_id: uuid::Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO private_agent_compute_reservations
            (user_id, session_id, seconds, reason, access_source, access_pass_id,
             access_expires_at, status, period_start)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'reserved', $8)
        RETURNING id
        "#,
    )
    .bind(claims.sub)
    .bind(&req.session_id)
    .bind(req.seconds)
    .bind(&reason)
    .bind(access.source)
    .bind(access.active_pass_id)
    .bind(access.invite_expires_at)
    .bind(period_start)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;

    Ok(Json(ReservePrivateAgentComputeResponse {
        ok: true,
        reservation_id,
        reserved_seconds: req.seconds,
    }))
}

/// POST /api/billing/private-agent/compute/release
pub async fn release_private_agent_compute(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Json(req): Json<ReleasePrivateAgentComputeRequest>,
) -> Result<Json<ReleasePrivateAgentComputeResponse>, CloudError> {
    validate_private_agent_session_id(&req.session_id)?;
    let status = match req.status.as_str() {
        "failed" | "paused" | "completed" => req.status,
        _ => {
            return Err(CloudError::BadRequest(
                "status must be failed, paused, or completed".to_string(),
            ));
        }
    };
    sqlx::query(
        r#"
        UPDATE private_agent_compute_reservations
        SET status = $3,
            released_at = COALESCE(released_at, now()),
            updated_at = now()
        WHERE user_id = $1
          AND session_id = $2
          AND status = 'reserved'
        "#,
    )
    .bind(claims.sub)
    .bind(&req.session_id)
    .bind(status)
    .execute(&state.db)
    .await?;

    Ok(Json(ReleasePrivateAgentComputeResponse { ok: true }))
}

async fn process_private_agent_trading_invoice_outbox(
    state: &AppState,
    user_id: uuid::Uuid,
) -> Result<(), CloudError> {
    let Some(stripe_key) = state.config.stripe_secret_key.as_deref() else {
        return Ok(());
    };
    let customer = sqlx::query_as::<_, (Option<String>, Option<String>)>(
        "SELECT stripe_customer_id, stripe_subscription_id FROM users WHERE id = $1",
    )
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?;
    let Some((Some(customer_id), subscription_id)) = customer else {
        return Ok(());
    };
    let rows = sqlx::query_as::<_, (uuid::Uuid, chrono::NaiveDate, i64, i64)>(
        r#"
        SELECT id, period_start, amount_cents, target_queued_fee_cents
        FROM private_agent_trading_invoice_outbox
        WHERE user_id = $1
          AND (status IN ('pending', 'failed') OR (status = 'processing' AND updated_at < now() - interval '5 minutes'))
          AND attempts < 10
        ORDER BY created_at
        LIMIT 20
        "#,
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await?;
    let client = reqwest::Client::new();
    for (id, period_start, _amount_cents, target_queued_fee_cents) in rows {
        let claimed = sqlx::query(
            r#"
            UPDATE private_agent_trading_invoice_outbox
            SET status = 'processing', attempts = attempts + 1, updated_at = now()
            WHERE id = $1
              AND (status IN ('pending', 'failed') OR (status = 'processing' AND updated_at < now() - interval '5 minutes'))
            "#,
        )
        .bind(id)
        .execute(&state.db)
        .await?;
        if claimed.rows_affected() != 1 {
            continue;
        }
        let active = sqlx::query_as::<_, (Option<String>, i64, i64)>(
            r#"
            SELECT active_stripe_invoice_item_id, active_stripe_invoice_item_base_cents,
                   invoiced_fee_cents
            FROM private_agent_trading_usage_periods
            WHERE user_id = $1 AND period_start = $2
            "#,
        )
        .bind(user_id)
        .bind(period_start)
        .fetch_one(&state.db)
        .await?;
        let active_base_cents = if active.0.is_some() {
            active.1
        } else {
            active.2
        };
        let invoice_item_amount_cents = (target_queued_fee_cents - active_base_cents).max(0);
        if invoice_item_amount_cents <= 0 {
            sqlx::query(
                "UPDATE private_agent_trading_invoice_outbox SET status = 'succeeded', last_error = NULL, updated_at = now() WHERE id = $1",
            )
            .bind(id)
            .execute(&state.db)
            .await?;
            continue;
        }
        let updating_existing = active.0.is_some();
        let endpoint = active
            .0
            .as_ref()
            .map(|item_id| format!("https://api.stripe.com/v1/invoiceitems/{item_id}"))
            .unwrap_or_else(|| "https://api.stripe.com/v1/invoiceitems".to_string());
        let mut form = vec![("amount", invoice_item_amount_cents.to_string())];
        if !updating_existing {
            form.extend([
                ("customer", customer_id.clone()),
                ("currency", "usd".to_string()),
                (
                    "description",
                    format!("Ghola filled-notional overage for {period_start}"),
                ),
                (
                    "metadata[ghola_kind]",
                    "private_agent_trading_overage".to_string(),
                ),
                ("metadata[usage_period_start]", period_start.to_string()),
                ("metadata[outbox_id]", id.to_string()),
            ]);
            if let Some(ref subscription_id) = subscription_id {
                form.push(("subscription", subscription_id.clone()));
            }
        }
        let response = client
            .post(endpoint)
            .header("Authorization", format!("Bearer {stripe_key}"))
            .header("Idempotency-Key", format!("ghola-trading-overage-{id}"))
            .form(&form)
            .send()
            .await;
        match response {
            Ok(response) if response.status().is_success() => {
                let body: serde_json::Value = response.json().await.unwrap_or_default();
                let invoice_item_id = body["id"].as_str().map(str::to_string).or(active.0.clone());
                let mut tx = state.db.begin().await?;
                sqlx::query(
                    r#"
                    UPDATE private_agent_trading_invoice_outbox
                    SET status = 'succeeded', stripe_invoice_item_id = $2, last_error = NULL, updated_at = now()
                    WHERE id = $1
                    "#,
                )
                .bind(id)
                .bind(invoice_item_id.as_deref())
                .execute(&mut *tx)
                .await?;
                sqlx::query(
                    r#"
                    UPDATE private_agent_trading_usage_periods
                    SET invoiced_fee_cents = GREATEST(invoiced_fee_cents, $3),
                        active_stripe_invoice_item_id = COALESCE($4, active_stripe_invoice_item_id),
                        active_stripe_invoice_item_base_cents = $5,
                        updated_at = now()
                    WHERE user_id = $1 AND period_start = $2
                    "#,
                )
                .bind(user_id)
                .bind(period_start)
                .bind(target_queued_fee_cents)
                .bind(invoice_item_id.as_deref())
                .bind(active_base_cents)
                .execute(&mut *tx)
                .await?;
                tx.commit().await?;
            }
            Ok(response) => {
                let status = response.status().as_u16();
                sqlx::query(
                    "UPDATE private_agent_trading_invoice_outbox SET status = 'failed', last_error = $2, updated_at = now() WHERE id = $1",
                )
                .bind(id)
                .bind(format!("stripe_http_{status}"))
                .execute(&state.db)
                .await?;
            }
            Err(_) => {
                sqlx::query(
                    "UPDATE private_agent_trading_invoice_outbox SET status = 'failed', last_error = 'stripe_unavailable', updated_at = now() WHERE id = $1",
                )
                .bind(id)
                .execute(&state.db)
                .await?;
            }
        }
    }
    Ok(())
}

fn private_agent_period_from_start(
    start: chrono::NaiveDate,
) -> Result<(
    chrono::DateTime<chrono::Utc>,
    chrono::DateTime<chrono::Utc>,
), CloudError> {
    let start_at = chrono::Utc
        .from_local_datetime(
            &start
                .and_hms_opt(0, 0, 0)
                .ok_or_else(|| CloudError::Internal("invalid billing period".to_string()))?,
        )
        .single()
        .ok_or_else(|| CloudError::Internal("invalid billing period".to_string()))?;
    let (end_year, end_month) = if start.month() == 12 {
        (start.year() + 1, 1)
    } else {
        (start.year(), start.month() + 1)
    };
    let end_at = chrono::Utc
        .with_ymd_and_hms(end_year, end_month, 1, 0, 0, 0)
        .single()
        .ok_or_else(|| CloudError::Internal("invalid billing period".to_string()))?;
    Ok((start_at, end_at))
}

async fn existing_meter_response(
    state: &AppState,
    user_id: uuid::Uuid,
    req: &MeterPrivateAgentTradingRequest,
) -> Result<Option<MeterPrivateAgentTradingResponse>, CloudError> {
    let Some((period_start, source)) =
        sqlx::query_as::<_, (chrono::NaiveDate, String)>(
            r#"
            SELECT period_start, access_source
            FROM private_agent_trading_usage_events
            WHERE user_id = $1
              AND (event_id = $2 OR connector_result_commitment = $3)
            ORDER BY created_at
            LIMIT 1
            "#,
        )
        .bind(user_id)
        .bind(&req.event_id)
        .bind(&req.connector_result_commitment)
        .fetch_optional(&state.db)
        .await?
    else {
        return Ok(None);
    };
    let (period_start_dt, period_end_dt) = private_agent_period_from_start(period_start)?;
    let status = if source == "complimentary_pass" {
        let (tier, included, filled) = sqlx::query_as::<_, (String, i64, i64)>(
            r#"
            SELECT tier, included_notional_micro_usd, filled_notional_micro_usd
            FROM complimentary_access_trading_usage_periods
            WHERE user_id = $1 AND period_start = $2
            "#,
        )
        .bind(user_id)
        .bind(period_start)
        .fetch_one(&state.db)
        .await?;
        if private_agent_trading_plan_for_tier(&tier).is_none() {
            return Err(CloudError::Internal(
                "stored trading plan is invalid".to_string(),
            ));
        }
        private_agent_trading_status_from_values(
            PrivateAgentTradingPlan {
                included_notional_micro_usd: included,
                overage_fee_bps: 0,
                default_monthly_fee_cap_micro_usd: 0,
            },
            filled,
            0,
            0,
            0,
            0,
            period_start_dt,
            period_end_dt,
        )
    } else {
        let row = sqlx::query_as::<_, (i64, i32, i64, i64, i64, i64, i64)>(
            r#"
            SELECT included_notional_micro_usd, overage_fee_bps, filled_notional_micro_usd,
                   accrued_fee_micro_usd, queued_fee_cents, invoiced_fee_cents,
                   monthly_fee_cap_micro_usd
            FROM private_agent_trading_usage_periods
            WHERE user_id = $1 AND period_start = $2
            "#,
        )
        .bind(user_id)
        .bind(period_start)
        .fetch_one(&state.db)
        .await?;
        private_agent_trading_status_from_values(
            PrivateAgentTradingPlan {
                included_notional_micro_usd: row.0,
                overage_fee_bps: row.1,
                default_monthly_fee_cap_micro_usd: row.6,
            },
            row.2,
            row.3,
            row.4,
            row.5,
            row.6,
            period_start_dt,
            period_end_dt,
        )
    };
    Ok(Some(MeterPrivateAgentTradingResponse {
        ok: true,
        duplicate: true,
        status,
    }))
}

/// POST /api/billing/private-agent/trading/meter
pub async fn meter_private_agent_trading(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    headers: HeaderMap,
    Json(req): Json<MeterPrivateAgentTradingRequest>,
) -> Result<Json<MeterPrivateAgentTradingResponse>, CloudError> {
    if !valid_trading_meter_identifier(&req.event_id)
        || !valid_trading_meter_identifier(&req.work_order_commitment)
        || !valid_trading_meter_identifier(&req.connector_result_commitment)
    {
        return Err(CloudError::BadRequest(
            "trading meter identifiers must be 8-200 URL-safe characters".to_string(),
        ));
    }
    if !(1..=25).contains(&req.fill_count) || req.filled_notional_micro_usd <= 0 {
        return Err(CloudError::BadRequest(
            "positive reconciled fill_count and filled_notional_micro_usd are required".to_string(),
        ));
    }
    if req.platform_class.len() > 80
        || !req
            .platform_class
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
    {
        return Err(CloudError::BadRequest("invalid platform_class".to_string()));
    }
    if let Some(response) = existing_meter_response(&state, claims.sub, &req).await? {
        return Ok(Json(response));
    }
    let mut tx = state.db.begin().await?;
    let user = sqlx::query_as::<
        _,
        (
            String,
            Option<chrono::DateTime<chrono::Utc>>,
            chrono::DateTime<chrono::Utc>,
        ),
    >(
        "SELECT tier, tier_expires_at, clock_timestamp() FROM users WHERE id = $1 FOR UPDATE",
    )
    .bind(claims.sub)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(CloudError::NotFound("user not found".to_string()))?;
    if let Some(response) = existing_meter_response(&state, claims.sub, &req).await? {
        tx.commit().await?;
        return Ok(Json(response));
    }
    let access_clock = user.2;
    let (period_start, period_start_dt, period_end_dt) = private_agent_period_at(access_clock)?;
    pause_inactive_complimentary_reservations(&mut tx, claims.sub, access_clock).await?;
    let grants = access_grants_for_user(&mut *tx, claims.sub, true).await?;
    let access = resolve_execution_access(
        user.0,
        user.1,
        select_access_grant(&grants, access_clock),
        access_clock,
        authorize_investor_canary(&state, &headers),
    );
    let tier = access.tier.clone();
    let Some(plan) = private_agent_trading_plan_for_access(&access) else {
        tx.commit().await?;
        return Err(CloudError::PaymentRequired(
            "live trading plan required".to_string(),
        ));
    };

    if access.source == "complimentary_pass" {
        sqlx::query(
            r#"
            INSERT INTO complimentary_access_trading_usage_periods
                (user_id, period_start, tier, included_notional_micro_usd)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (user_id, period_start) DO UPDATE
            SET tier = EXCLUDED.tier,
                included_notional_micro_usd = EXCLUDED.included_notional_micro_usd,
                updated_at = now()
            "#,
        )
        .bind(claims.sub)
        .bind(period_start)
        .bind(&tier)
        .bind(plan.included_notional_micro_usd)
        .execute(&mut *tx)
        .await?;
        let filled_notional: i64 = sqlx::query_scalar(
            r#"
            SELECT filled_notional_micro_usd
            FROM complimentary_access_trading_usage_periods
            WHERE user_id = $1 AND period_start = $2
            FOR UPDATE
            "#,
        )
        .bind(claims.sub)
        .bind(period_start)
        .fetch_one(&mut *tx)
        .await?;
        let duplicate: bool = sqlx::query_scalar(
            r#"
            SELECT EXISTS(
                SELECT 1 FROM private_agent_trading_usage_events
                WHERE user_id = $1
                  AND (event_id = $2 OR connector_result_commitment = $3)
            )
            "#,
        )
        .bind(claims.sub)
        .bind(&req.event_id)
        .bind(&req.connector_result_commitment)
        .fetch_one(&mut *tx)
        .await?;
        let filled_notional = if duplicate {
            filled_notional
        } else {
            let new_filled = filled_notional
                .checked_add(req.filled_notional_micro_usd)
                .ok_or_else(|| CloudError::BadRequest("filled notional overflow".to_string()))?;
            sqlx::query(
                r#"
                INSERT INTO private_agent_trading_usage_events
                    (event_id, user_id, period_start, work_order_commitment,
                     connector_result_commitment, platform_class, fill_count,
                     filled_notional_micro_usd, incremental_fee_micro_usd, access_source)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, 'complimentary_pass')
                "#,
            )
            .bind(&req.event_id)
            .bind(claims.sub)
            .bind(period_start)
            .bind(&req.work_order_commitment)
            .bind(&req.connector_result_commitment)
            .bind(&req.platform_class)
            .bind(req.fill_count)
            .bind(req.filled_notional_micro_usd)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                r#"
                UPDATE complimentary_access_trading_usage_periods
                SET filled_notional_micro_usd = $3, updated_at = now()
                WHERE user_id = $1 AND period_start = $2
                "#,
            )
            .bind(claims.sub)
            .bind(period_start)
            .bind(new_filled)
            .execute(&mut *tx)
            .await?;
            new_filled
        };
        tx.commit().await?;
        return Ok(Json(MeterPrivateAgentTradingResponse {
            ok: true,
            duplicate,
            status: private_agent_trading_status_from_values(
                plan,
                filled_notional,
                0,
                0,
                0,
                0,
                period_start_dt,
                period_end_dt,
            ),
        }));
    }

    sqlx::query(
        r#"
        INSERT INTO private_agent_trading_usage_periods
            (user_id, period_start, tier, included_notional_micro_usd, overage_fee_bps,
             monthly_fee_cap_micro_usd)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (user_id, period_start) DO NOTHING
        "#,
    )
    .bind(claims.sub)
    .bind(period_start)
    .bind(&tier)
    .bind(plan.included_notional_micro_usd)
    .bind(plan.overage_fee_bps)
    .bind(plan.default_monthly_fee_cap_micro_usd)
    .execute(&mut *tx)
    .await?;
    let row = sqlx::query_as::<_, (i64, i32, i64, i64, i64, i64, i64)>(
        r#"
        SELECT included_notional_micro_usd, overage_fee_bps, filled_notional_micro_usd,
               accrued_fee_micro_usd, queued_fee_cents, invoiced_fee_cents,
               monthly_fee_cap_micro_usd
        FROM private_agent_trading_usage_periods
        WHERE user_id = $1 AND period_start = $2
        FOR UPDATE
        "#,
    )
    .bind(claims.sub)
    .bind(period_start)
    .fetch_one(&mut *tx)
    .await?;
    let stored_plan = PrivateAgentTradingPlan {
        included_notional_micro_usd: row.0,
        overage_fee_bps: row.1,
        default_monthly_fee_cap_micro_usd: row.6,
    };
    let effective_fee_cap = row.6;
    let duplicate: bool = sqlx::query_scalar(
        r#"
        SELECT EXISTS(
            SELECT 1 FROM private_agent_trading_usage_events
            WHERE user_id = $1
              AND (event_id = $2 OR connector_result_commitment = $3)
        )
        "#,
    )
    .bind(claims.sub)
    .bind(&req.event_id)
    .bind(&req.connector_result_commitment)
    .fetch_one(&mut *tx)
    .await?;
    let (filled_notional, accrued_fee, queued_fee_cents) = if duplicate {
        (row.2, row.3, row.4)
    } else {
        let new_filled = row
            .2
            .checked_add(req.filled_notional_micro_usd)
            .ok_or_else(|| CloudError::BadRequest("filled notional overflow".to_string()))?;
        let old_overage = (row.2 - stored_plan.included_notional_micro_usd).max(0);
        let new_overage = (new_filled - stored_plan.included_notional_micro_usd).max(0);
        let theoretical_old_fee =
            fee_for_overage_micro_usd(old_overage, stored_plan.overage_fee_bps);
        let theoretical_new_fee =
            fee_for_overage_micro_usd(new_overage, stored_plan.overage_fee_bps);
        let capped_new_fee = theoretical_new_fee.min(effective_fee_cap);
        let incremental_fee = (capped_new_fee - theoretical_old_fee.min(row.3)).max(0);
        let target_fee_cents = capped_new_fee / 10_000;
        let queue_delta_cents = (target_fee_cents - row.4).max(0);
        sqlx::query(
            r#"
            INSERT INTO private_agent_trading_usage_events
                (event_id, user_id, period_start, work_order_commitment,
                 connector_result_commitment, platform_class, fill_count,
                 filled_notional_micro_usd, incremental_fee_micro_usd, access_source)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'stripe')
            "#,
        )
        .bind(&req.event_id)
        .bind(claims.sub)
        .bind(period_start)
        .bind(&req.work_order_commitment)
        .bind(&req.connector_result_commitment)
        .bind(&req.platform_class)
        .bind(req.fill_count)
        .bind(req.filled_notional_micro_usd)
        .bind(incremental_fee)
        .execute(&mut *tx)
        .await?;
        if queue_delta_cents > 0 {
            sqlx::query(
                r#"
                INSERT INTO private_agent_trading_invoice_outbox
                    (user_id, period_start, amount_cents, target_queued_fee_cents)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (user_id, period_start, target_queued_fee_cents) DO NOTHING
                "#,
            )
            .bind(claims.sub)
            .bind(period_start)
            .bind(queue_delta_cents)
            .bind(target_fee_cents)
            .execute(&mut *tx)
            .await?;
        }
        sqlx::query(
            r#"
            UPDATE private_agent_trading_usage_periods
            SET filled_notional_micro_usd = $3,
                accrued_fee_micro_usd = $4,
                queued_fee_cents = GREATEST(queued_fee_cents, $5),
                updated_at = now()
            WHERE user_id = $1 AND period_start = $2
            "#,
        )
        .bind(claims.sub)
        .bind(period_start)
        .bind(new_filled)
        .bind(capped_new_fee)
        .bind(target_fee_cents)
        .execute(&mut *tx)
        .await?;
        (new_filled, capped_new_fee, target_fee_cents.max(row.4))
    };
    tx.commit().await?;
    process_private_agent_trading_invoice_outbox(&state, claims.sub).await?;
    let invoiced_fee_cents: i64 = sqlx::query_scalar(
        "SELECT invoiced_fee_cents FROM private_agent_trading_usage_periods WHERE user_id = $1 AND period_start = $2",
    )
    .bind(claims.sub)
    .bind(period_start)
    .fetch_one(&state.db)
    .await?;
    Ok(Json(MeterPrivateAgentTradingResponse {
        ok: true,
        duplicate,
        status: private_agent_trading_status_from_values(
            stored_plan,
            filled_notional,
            accrued_fee,
            queued_fee_cents,
            invoiced_fee_cents,
            effective_fee_cap,
            period_start_dt,
            period_end_dt,
        ),
    }))
}

/// PATCH /api/billing/private-agent/trading/cap
pub async fn update_private_agent_trading_cap(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Json(req): Json<UpdatePrivateAgentTradingCapRequest>,
) -> Result<Json<PrivateAgentTradingStatus>, CloudError> {
    if !(0..=PRIVATE_AGENT_MAX_FEE_CAP_MICRO_USD).contains(&req.monthly_fee_cap_micro_usd) {
        return Err(CloudError::BadRequest(
            "monthly fee cap must be between $0 and $10,000".to_string(),
        ));
    }
    let access = effective_access_for_user(&state, claims.sub).await?;
    let mut cleanup_tx = state.db.begin().await?;
    pause_inactive_complimentary_reservations(
        &mut cleanup_tx,
        claims.sub,
        access.evaluated_at,
    )
    .await?;
    cleanup_tx.commit().await?;
    let Some(plan) = private_agent_trading_plan_for_access(&access) else {
        return Err(CloudError::PaymentRequired(
            "live trading plan required".to_string(),
        ));
    };
    if plan.overage_fee_bps == 0 && req.monthly_fee_cap_micro_usd != 0 {
        return Err(CloudError::BadRequest(
            "this plan has no overage billing".to_string(),
        ));
    }
    if access.source == "complimentary_pass" {
        return private_agent_trading_status_for_user_read_only(
            &state,
            claims.sub,
            &access,
            access.evaluated_at,
        )
            .await?
            .ok_or_else(|| CloudError::Internal("trading status unavailable".to_string()))
            .map(Json);
    }
    let (period_start, _, _) = private_agent_period_at(access.evaluated_at)?;
    private_agent_trading_status_for_user(&state, claims.sub, &access, access.evaluated_at).await?;
    let accrued: i64 = sqlx::query_scalar(
        "SELECT accrued_fee_micro_usd FROM private_agent_trading_usage_periods WHERE user_id = $1 AND period_start = $2",
    )
    .bind(claims.sub)
    .bind(period_start)
    .fetch_one(&state.db)
    .await?;
    if req.monthly_fee_cap_micro_usd < accrued {
        return Err(CloudError::BadRequest(
            "monthly fee cap cannot be lower than already accrued fees".to_string(),
        ));
    }
    sqlx::query(
        "UPDATE private_agent_trading_usage_periods SET monthly_fee_cap_micro_usd = $3, updated_at = now() WHERE user_id = $1 AND period_start = $2",
    )
    .bind(claims.sub)
    .bind(period_start)
    .bind(req.monthly_fee_cap_micro_usd)
    .execute(&state.db)
    .await?;
    private_agent_trading_status_for_user(&state, claims.sub, &access, access.evaluated_at)
        .await?
        .ok_or_else(|| CloudError::Internal("trading status unavailable".to_string()))
        .map(Json)
}

/// GET /api/billing/status
pub async fn billing_status(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
) -> Result<Json<BillingStatusResponse>, CloudError> {
    let mut tx = state.db.begin().await?;
    sqlx::query("SET TRANSACTION READ ONLY")
        .execute(&mut *tx)
        .await?;
    let row = sqlx::query_as::<
        _,
        (
            String,
            Option<chrono::DateTime<chrono::Utc>>,
            Option<String>,
            chrono::DateTime<chrono::Utc>,
        ),
    >("SELECT tier, tier_expires_at, stripe_customer_id, clock_timestamp() FROM users WHERE id = $1")
    .bind(claims.sub)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(CloudError::NotFound("user not found".to_string()))?;

    let (raw_tier, tier_expires_at, stripe_customer_id, access_clock) = row;
    let grants = access_grants_for_user(&mut *tx, claims.sub, false).await?;
    tx.commit().await?;
    let access = resolve_effective_access(
        raw_tier,
        tier_expires_at,
        select_access_grant(&grants, access_clock),
        access_clock,
    );
    let expires_at = access.expires_at.map(|expiry| expiry.to_rfc3339());

    Ok(Json(BillingStatusResponse {
        limits: billing_limits_for_tier(&access.tier),
        private_agent_compute: private_agent_compute_status_for_user(
            &state,
            claims.sub,
            &access,
            access_clock,
        )
        .await?,
        private_agent_trading: private_agent_trading_status_for_user_read_only(
            &state,
            claims.sub,
            &access,
            access_clock,
        )
        .await?,
        tier: access.tier,
        expires_at,
        access_source: access.source,
        access_state: access.state,
        invite_state: access.invite_state,
        active_pass_id: access.active_pass_id,
        invite_expires_at: access
            .invite_expires_at
            .map(|expiry| expiry.to_rfc3339()),
        last_access_expires_at: access
            .last_access_expires_at
            .map(|expiry| expiry.to_rfc3339()),
        stripe_customer_id,
        // Portal creation is an explicit mutation and must not happen while
        // polling this read-only status route.
        portal_url: None,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_claims(user_id: uuid::Uuid, email: &str) -> crate::auth::Claims {
        crate::auth::Claims {
            sub: user_id,
            email: Some(email.to_string()),
            name: None,
            tier: "free".to_string(),
            exp: i64::MAX,
            iat: 0,
        }
    }

    fn test_config(database_url: String) -> crate::config::CloudConfig {
        crate::config::CloudConfig {
            bind_addr: "127.0.0.1:0".parse().unwrap(),
            database_url,
            jwt_secret: "test-jwt-secret".to_string(),
            bland_api_key: None,
            bland_webhook_url: None,
            claude_api_key: None,
            google_client_id: None,
            google_client_secret: None,
            apple_client_id: None,
            gmail_client_id: None,
            gmail_client_secret: None,
            stripe_secret_key: None,
            stripe_webhook_secret: None,
            stripe_price_pro: None,
            stripe_price_private_agent_starter: None,
            stripe_price_private_agent_trial_pack: None,
            stripe_price_private_agent: None,
            stripe_price_unlimited: None,
            investor_pass_admin_secret: Some(
                "local-test-investor-admin-secret-000000000000".to_string(),
            ),
            investor_canary_secret: Some(
                "local-test-investor-canary-secret-00000000000".to_string(),
            ),
            investor_web_origin: "https://ghola.xyz".to_string(),
            admin_emails: vec!["operator@ghola.test".to_string()],
            base_url: "https://ghola.test".to_string(),
            encryption_key: [0u8; 32],
            telegram_bot_token: None,
            solana_rpc_url: "http://localhost".to_string(),
            groq_api_key: None,
            cerebras_api_key: None,
            google_gemini_api_key: None,
            openrouter_api_key: None,
            relay_url: "http://localhost".to_string(),
            platform_wallet_address: None,
            treasury_mnemonic: None,
            min_provider_reputation: 0.0,
            max_escrow_age_secs: 0,
            provider_payout_interval_secs: 0,
        }
    }

    fn test_admin_headers() -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-ghola-admin-secret",
            "local-test-investor-admin-secret-000000000000"
                .parse()
                .unwrap(),
        );
        headers
    }

    fn test_canary_headers() -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-ghola-investor-canary-secret",
            "local-test-investor-canary-secret-00000000000"
                .parse()
                .unwrap(),
        );
        headers
    }

    /// Runs against a disposable database created beneath
    /// `GHOLA_TEST_DATABASE_URL`; never point that variable at production.
    #[tokio::test]
    #[ignore = "requires local GHOLA_TEST_DATABASE_URL with CREATE DATABASE permission"]
    async fn access_pass_db_concurrency_revocation_and_billing_isolation() {
        use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
        use std::str::FromStr;

        let admin_url = std::env::var("GHOLA_TEST_DATABASE_URL")
            .expect("GHOLA_TEST_DATABASE_URL must name a disposable local Postgres server");
        assert!(
            admin_url.starts_with("postgres://127.0.0.1:")
                || admin_url.starts_with("postgres://localhost:")
                || admin_url.starts_with("postgresql://127.0.0.1:")
                || admin_url.starts_with("postgresql://localhost:"),
            "DB integration test is restricted to localhost"
        );
        let admin_options = PgConnectOptions::from_str(&admin_url).unwrap();
        let admin_pool = PgPoolOptions::new()
            .max_connections(2)
            .connect_with(admin_options.clone())
            .await
            .unwrap();
        let database_name = format!("ghola_access_test_{}", uuid::Uuid::new_v4().simple());
        sqlx::query(&format!("CREATE DATABASE \"{database_name}\""))
            .execute(&admin_pool)
            .await
            .unwrap();
        let test_options = admin_options.database(&database_name);
        let pool = PgPoolOptions::new()
            .max_connections(12)
            .connect_with(test_options)
            .await
            .unwrap();
        crate::db::run_migrations(&pool).await.unwrap();
        let state = AppState::new(test_config(admin_url.clone()), pool.clone());

        let operator_id = uuid::Uuid::new_v4();
        let investor_id = uuid::Uuid::new_v4();
        let other_id = uuid::Uuid::new_v4();
        let password_only_id = uuid::Uuid::new_v4();
        for (id, email, google_id) in [
            (operator_id, "operator@ghola.test", Some("google-operator")),
            (investor_id, "investor@example.com", Some("google-investor")),
            (other_id, "other@example.com", Some("google-other")),
            (password_only_id, "password@example.com", None),
        ] {
            sqlx::query(
                "INSERT INTO users (id, email, google_id, tier) VALUES ($1, $2, $3, 'free')",
            )
                .bind(id)
                .bind(email)
                .bind(google_id)
                .execute(&pool)
                .await
                .unwrap();
        }
        let operator = AuthUser(test_claims(operator_id, "operator@ghola.test"));
        let investor = AuthUser(test_claims(investor_id, "investor@example.com"));
        let other = AuthUser(test_claims(other_id, "other@example.com"));

        let non_operator_issue = create_access_pass(
            State(state.clone()),
            investor.clone(),
            test_admin_headers(),
            Json(CreateAccessPassRequest {
                email: "investor@example.com".to_string(),
                idempotency_key: "non-operator-issuance-0001".to_string(),
                tier: Some("starter".to_string()),
                grant_days: Some(14),
                redeem_days: Some(7),
            }),
        )
        .await;
        assert!(matches!(
            non_operator_issue,
            Err(CloudError::Forbidden(message)) if message == "access_pass_admin_forbidden"
        ));

        let issue_request = || CreateAccessPassRequest {
            email: "  Investor@Example.COM ".to_string(),
            idempotency_key: "investor-pass-issuance-0001".to_string(),
            tier: Some("starter".to_string()),
            grant_days: Some(14),
            redeem_days: Some(7),
        };
        let (issued, replayed_issue) = tokio::join!(
            create_access_pass(
                State(state.clone()),
                operator.clone(),
                test_admin_headers(),
                Json(issue_request()),
            ),
            create_access_pass(
                State(state.clone()),
                operator.clone(),
                test_admin_headers(),
                Json(issue_request()),
            )
        );
        let issued = issued.unwrap().0;
        let replayed_issue = replayed_issue.unwrap().0;
        assert_eq!(issued.pass_id, replayed_issue.pass_id);
        assert_eq!(issued.invite_url, replayed_issue.invite_url);
        assert_eq!(issued.redeem_expires_at, replayed_issue.redeem_expires_at);
        let issuance_conflict = create_access_pass(
            State(state.clone()),
            operator.clone(),
            test_admin_headers(),
            Json(CreateAccessPassRequest {
                email: "investor@example.com".to_string(),
                idempotency_key: "investor-pass-issuance-0001".to_string(),
                tier: Some("private_agent".to_string()),
                grant_days: Some(14),
                redeem_days: Some(7),
            }),
        )
        .await;
        assert!(matches!(
            issuance_conflict,
            Err(CloudError::BadRequest(message)) if message == "access_pass_idempotency_conflict"
        ));
        let code = issued
            .invite_url
            .split_once("#access=")
            .unwrap()
            .1
            .to_string();
        let stored_email: String = sqlx::query_scalar(
            "SELECT email FROM complimentary_access_passes WHERE code_hash = $1",
        )
        .bind(access_pass_hash(&code))
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(stored_email, "investor@example.com");
        let stored_plaintext: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM complimentary_access_passes WHERE code_hash = $1)",
        )
        .bind(&code)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(!stored_plaintext);

        let wrong_email = redeem_access_pass(
            State(state.clone()),
            other.clone(),
            Json(RedeemAccessPassRequest { code: code.clone() }),
        )
        .await;
        assert!(matches!(wrong_email, Err(CloudError::Forbidden(_))));

        let password_pass = create_access_pass(
            State(state.clone()),
            operator.clone(),
            test_admin_headers(),
            Json(CreateAccessPassRequest {
                email: "password@example.com".to_string(),
                idempotency_key: "password-only-issuance-0001".to_string(),
                tier: Some("starter".to_string()),
                grant_days: Some(14),
                redeem_days: Some(7),
            }),
        )
        .await
        .unwrap()
        .0;
        let password_code = password_pass
            .invite_url
            .split_once("#access=")
            .unwrap()
            .1
            .to_string();
        let password_denied = redeem_access_pass(
            State(state.clone()),
            AuthUser(test_claims(password_only_id, "password@example.com")),
            Json(RedeemAccessPassRequest { code: password_code }),
        )
        .await;
        assert!(matches!(
            password_denied,
            Err(CloudError::Forbidden(message)) if message == "investor_email_verification_required"
        ));

        let first_state = state.clone();
        let first_investor = investor.clone();
        let first_code = code.clone();
        let second_state = state.clone();
        let second_investor = investor.clone();
        let second_code = code.clone();
        let (first, second) = tokio::join!(
            redeem_access_pass(
                State(first_state),
                first_investor,
                Json(RedeemAccessPassRequest { code: first_code }),
            ),
            redeem_access_pass(
                State(second_state),
                second_investor,
                Json(RedeemAccessPassRequest { code: second_code }),
            )
        );
        let first = first.unwrap().0;
        let second = second.unwrap().0;
        assert_eq!(first.expires_at, second.expires_at);
        let redeemed_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM complimentary_access_passes WHERE redeemed_by = $1",
        )
        .bind(investor_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(redeemed_count, 1);

        let stolen_retry = redeem_access_pass(
            State(state.clone()),
            AuthUser(test_claims(other_id, "investor@example.com")),
            Json(RedeemAccessPassRequest { code: code.clone() }),
        )
        .await;
        assert!(matches!(
            stolen_retry,
            Err(CloudError::Forbidden(message)) if message == "investor_access_email_mismatch"
        ));

        let compute_request = || ReservePrivateAgentComputeRequest {
            session_id: "investor-session-0001".to_string(),
            seconds: 600,
            reason: Some("private_agent_session".to_string()),
        };
        let untrusted_reserve = reserve_private_agent_compute(
            State(state.clone()),
            investor.clone(),
            HeaderMap::new(),
            Json(compute_request()),
        )
        .await;
        assert!(matches!(
            untrusted_reserve,
            Err(CloudError::PaymentRequired(_))
        ));
        let (reserve_one, reserve_two) = tokio::join!(
            reserve_private_agent_compute(
                State(state.clone()),
                investor.clone(),
                test_canary_headers(),
                Json(compute_request()),
            ),
            reserve_private_agent_compute(
                State(state.clone()),
                investor.clone(),
                test_canary_headers(),
                Json(compute_request()),
            )
        );
        let reserve_one = reserve_one.unwrap().0;
        let reserve_two = reserve_two.unwrap().0;
        assert_eq!(reserve_one.reservation_id, reserve_two.reservation_id);
        let compute_source: String = sqlx::query_scalar(
            "SELECT access_source FROM private_agent_compute_reservations WHERE id = $1",
        )
        .bind(reserve_one.reservation_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(compute_source, "complimentary_pass");
        sqlx::query(
            r#"
            INSERT INTO private_agent_compute_reservations
                (user_id, session_id, seconds, reason, access_source, status)
            VALUES ($1, 'investor-session-0001', 1, 'private_agent_session', 'stripe', 'failed')
            "#,
        )
        .bind(other_id)
        .execute(&pool)
        .await
        .unwrap();

        let meter_request = |event_id: &str| MeterPrivateAgentTradingRequest {
            event_id: event_id.to_string(),
            work_order_commitment: "work-order-commitment-0001".to_string(),
            connector_result_commitment: "connector-result-commitment-0001".to_string(),
            platform_class: "hyperliquid".to_string(),
            fill_count: 1,
            filled_notional_micro_usd: 11_000_000,
        };
        let (meter_one, meter_two) = tokio::join!(
            meter_private_agent_trading(
                State(state.clone()),
                investor.clone(),
                test_canary_headers(),
                Json(meter_request("complimentary-event-0001")),
            ),
            meter_private_agent_trading(
                State(state.clone()),
                investor.clone(),
                test_canary_headers(),
                Json(meter_request("complimentary-event-0002")),
            )
        );
        let meter_one = meter_one.unwrap().0;
        let meter_two = meter_two.unwrap().0;
        assert_ne!(meter_one.duplicate, meter_two.duplicate);
        assert_eq!(meter_one.status.filled_notional_micro_usd, 11_000_000);
        assert_eq!(meter_two.status.filled_notional_micro_usd, 11_000_000);
        assert_eq!(meter_one.status.overage_fee_bps, 0);
        assert_eq!(meter_two.status.accrued_fee_micro_usd, 0);
        let complimentary_filled: i64 = sqlx::query_scalar(
            "SELECT filled_notional_micro_usd FROM complimentary_access_trading_usage_periods WHERE user_id = $1",
        )
        .bind(investor_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(complimentary_filled, 11_000_000);
        let paid_periods: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM private_agent_trading_usage_periods WHERE user_id = $1",
        )
        .bind(investor_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        let invoice_rows: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM private_agent_trading_invoice_outbox WHERE user_id = $1",
        )
        .bind(investor_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!((paid_periods, invoice_rows), (0, 0));

        let capped = update_private_agent_trading_cap(
            State(state.clone()),
            investor.clone(),
            Json(UpdatePrivateAgentTradingCapRequest {
                monthly_fee_cap_micro_usd: 0,
            }),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(capped.monthly_fee_cap_micro_usd, 0);
        let paid_periods_after_cap: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM private_agent_trading_usage_periods WHERE user_id = $1",
        )
        .bind(investor_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(paid_periods_after_cap, 0);

        let before_status_reads: (i64, i64, i64, i64, i64) = sqlx::query_as(
            r#"
            SELECT
                (SELECT COUNT(*) FROM private_agent_compute_reservations),
                (SELECT COUNT(*) FROM private_agent_trading_usage_periods),
                (SELECT COUNT(*) FROM complimentary_access_trading_usage_periods),
                (SELECT COUNT(*) FROM private_agent_trading_usage_events),
                (SELECT COUNT(*) FROM private_agent_trading_invoice_outbox)
            "#,
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        for _ in 0..2 {
            let status = billing_status(State(state.clone()), investor.clone())
                .await
                .unwrap()
                .0;
            assert_eq!(status.access_source, "complimentary_pass");
            assert_eq!(status.access_state, "active");
            assert!(status.portal_url.is_none());
            assert_eq!(status.private_agent_compute.unwrap().reserved_seconds, 600);
            assert_eq!(
                status
                    .private_agent_trading
                    .unwrap()
                    .filled_notional_micro_usd,
                11_000_000
            );
        }
        let after_status_reads: (i64, i64, i64, i64, i64) = sqlx::query_as(
            r#"
            SELECT
                (SELECT COUNT(*) FROM private_agent_compute_reservations),
                (SELECT COUNT(*) FROM private_agent_trading_usage_periods),
                (SELECT COUNT(*) FROM complimentary_access_trading_usage_periods),
                (SELECT COUNT(*) FROM private_agent_trading_usage_events),
                (SELECT COUNT(*) FROM private_agent_trading_invoice_outbox)
            "#,
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(before_status_reads, after_status_reads);

        sqlx::query("UPDATE users SET tier = 'private_agent' WHERE id = $1")
            .bind(investor_id)
            .execute(&pool)
            .await
            .unwrap();
        let invited_paid_status = billing_status(State(state.clone()), investor.clone())
            .await
            .unwrap()
            .0;
        assert_eq!(invited_paid_status.tier, "private_agent");
        assert_eq!(invited_paid_status.access_source, "complimentary_pass");
        assert_eq!(invited_paid_status.invite_state, "active");
        let invited_paid_meter = meter_private_agent_trading(
            State(state.clone()),
            investor.clone(),
            test_canary_headers(),
            Json(MeterPrivateAgentTradingRequest {
                event_id: "invited-paid-event-0001".to_string(),
                work_order_commitment: "invited-paid-work-order-0001".to_string(),
                connector_result_commitment: "invited-paid-result-0001".to_string(),
                platform_class: "hyperliquid".to_string(),
                fill_count: 1,
                filled_notional_micro_usd: 11_000_000,
            }),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(invited_paid_meter.status.overage_fee_bps, 0);
        assert_eq!(invited_paid_meter.status.accrued_fee_micro_usd, 0);
        let invited_paid_billing_rows: (i64, i64) = sqlx::query_as(
            r#"
            SELECT
                (SELECT COUNT(*) FROM private_agent_trading_usage_periods WHERE user_id = $1),
                (SELECT COUNT(*) FROM private_agent_trading_invoice_outbox WHERE user_id = $1)
            "#,
        )
        .bind(investor_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(invited_paid_billing_rows, (0, 0));
        sqlx::query("UPDATE users SET tier = 'free' WHERE id = $1")
            .bind(investor_id)
            .execute(&pool)
            .await
            .unwrap();

        sqlx::query(
            "UPDATE complimentary_access_passes SET grant_expires_at = now() - interval '1 second' WHERE code_hash = $1",
        )
        .bind(access_pass_hash(&code))
        .execute(&pool)
        .await
        .unwrap();
        let expired = billing_status(State(state.clone()), investor.clone())
            .await
            .unwrap()
            .0;
        assert_eq!(expired.access_source, "free");
        assert_eq!(expired.access_state, "expired");
        assert_eq!(expired.invite_state, "expired");
        let duplicate_after_expiry = meter_private_agent_trading(
            State(state.clone()),
            investor.clone(),
            HeaderMap::new(),
            Json(meter_request("complimentary-retry-expired")),
        )
        .await
        .unwrap()
        .0;
        assert!(duplicate_after_expiry.duplicate);
        assert_eq!(duplicate_after_expiry.status.overage_fee_bps, 0);
        let paused_on_expiry = pause_expired_complimentary_reservations_once(&pool)
            .await
            .unwrap();
        assert_eq!(paused_on_expiry, 1);
        let reservation_after_sweeper: String = sqlx::query_scalar(
            "SELECT status FROM private_agent_compute_reservations WHERE id = $1",
        )
        .bind(reserve_one.reservation_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(reservation_after_sweeper, "paused");
        let denied_after_expiry = reserve_private_agent_compute(
            State(state.clone()),
            investor.clone(),
            test_canary_headers(),
            Json(ReservePrivateAgentComputeRequest {
                session_id: "investor-session-0002".to_string(),
                seconds: 1,
                reason: None,
            }),
        )
        .await;
        assert!(matches!(
            denied_after_expiry,
            Err(CloudError::PaymentRequired(_))
        ));
        let reservation_after_expiry: String = sqlx::query_scalar(
            "SELECT status FROM private_agent_compute_reservations WHERE id = $1",
        )
        .bind(reserve_one.reservation_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(reservation_after_expiry, "paused");
        sqlx::query(
            "UPDATE complimentary_access_passes SET grant_expires_at = now() + interval '14 days' WHERE code_hash = $1",
        )
        .bind(access_pass_hash(&code))
        .execute(&pool)
        .await
        .unwrap();

        let reservation_before_revoke = reserve_private_agent_compute(
            State(state.clone()),
            investor.clone(),
            test_canary_headers(),
            Json(ReservePrivateAgentComputeRequest {
                session_id: "investor-session-0003".to_string(),
                seconds: 1,
                reason: None,
            }),
        )
        .await
        .unwrap()
        .0;

        let revoked_once = revoke_access_pass(
            State(state.clone()),
            operator.clone(),
            test_admin_headers(),
            Json(RevokeAccessPassRequest {
                pass_id: issued.pass_id,
            }),
        )
        .await
        .unwrap()
        .0;
        let revoked_twice = revoke_access_pass(
            State(state.clone()),
            operator,
            test_admin_headers(),
            Json(RevokeAccessPassRequest {
                pass_id: issued.pass_id,
            }),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(revoked_once.revoked_at, revoked_twice.revoked_at);
        assert_eq!(revoked_once.pass_id, issued.pass_id);
        assert_eq!(revoked_once.state, "revoked");
        let revoked_status = billing_status(State(state.clone()), investor.clone())
            .await
            .unwrap()
            .0;
        assert_eq!(revoked_status.access_state, "revoked");
        assert_eq!(revoked_status.invite_state, "revoked");
        assert_eq!(revoked_status.access_source, "free");
        let reservation_status: String = sqlx::query_scalar(
            "SELECT status FROM private_agent_compute_reservations WHERE id = $1",
        )
        .bind(reservation_before_revoke.reservation_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(reservation_status, "paused");
        let duplicate_after_revoke = meter_private_agent_trading(
            State(state.clone()),
            investor.clone(),
            HeaderMap::new(),
            Json(meter_request("complimentary-retry-revoked")),
        )
        .await
        .unwrap()
        .0;
        assert!(duplicate_after_revoke.duplicate);

        sqlx::query("UPDATE users SET tier = 'starter' WHERE id = $1")
            .bind(investor_id)
            .execute(&pool)
            .await
            .unwrap();
        let paid = meter_private_agent_trading(
            State(state.clone()),
            investor.clone(),
            HeaderMap::new(),
            Json(MeterPrivateAgentTradingRequest {
                event_id: "paid-event-00000001".to_string(),
                work_order_commitment: "paid-work-order-0001".to_string(),
                connector_result_commitment: "paid-connector-result-0001".to_string(),
                platform_class: "hyperliquid".to_string(),
                fill_count: 1,
                filled_notional_micro_usd: 101_000_000_000,
            }),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(paid.status.filled_notional_micro_usd, 101_000_000_000);
        assert_eq!(paid.status.accrued_fee_micro_usd, 300_000);
        let paid_filled: i64 = sqlx::query_scalar(
            "SELECT filled_notional_micro_usd FROM private_agent_trading_usage_periods WHERE user_id = $1",
        )
        .bind(investor_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        let final_outbox_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM private_agent_trading_invoice_outbox WHERE user_id = $1",
        )
        .bind(investor_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(paid_filled, 101_000_000_000);
        assert_eq!(complimentary_filled, 11_000_000);
        assert_eq!(final_outbox_count, 1);

        pool.close().await;
        sqlx::query(&format!("DROP DATABASE \"{database_name}\" WITH (FORCE)"))
            .execute(&admin_pool)
            .await
            .unwrap();
        admin_pool.close().await;
    }

    #[test]
    fn complimentary_access_is_active_expiring_and_non_billable() {
        let now = chrono::Utc
            .with_ymd_and_hms(2026, 8, 19, 12, 0, 0)
            .single()
            .unwrap();
        let expiry = now + chrono::Duration::days(14);
        let grant = AccessGrant {
            pass_id: uuid::Uuid::new_v4(),
            tier: "starter".to_string(),
            expires_at: expiry,
            revoked_at: None,
        };
        let access = resolve_effective_access(
            "free".to_string(),
            None,
            select_access_grant(&[grant], now),
            now,
        );
        assert_eq!(access.tier, "starter");
        assert_eq!(access.source, "complimentary_pass");
        assert_eq!(access.state, "active");
        assert_eq!(access.expires_at, Some(expiry));
        let plan = private_agent_trading_plan_for_access(&access).unwrap();
        assert_eq!(plan.overage_fee_bps, 0);
        assert_eq!(plan.default_monthly_fee_cap_micro_usd, 0);
    }

    #[test]
    fn expired_grant_is_visible_but_not_entitled() {
        let now = chrono::Utc
            .with_ymd_and_hms(2026, 8, 19, 12, 0, 0)
            .single()
            .unwrap();
        let expiry = now;
        let grant = AccessGrant {
            pass_id: uuid::Uuid::new_v4(),
            tier: "starter".to_string(),
            expires_at: expiry,
            revoked_at: None,
        };
        let access = resolve_effective_access(
            "free".to_string(),
            None,
            select_access_grant(&[grant], now),
            now,
        );
        assert_eq!(access.tier, "free");
        assert_eq!(access.source, "free");
        assert_eq!(access.state, "expired");
        assert_eq!(access.last_access_expires_at, Some(expiry));
    }

    #[test]
    fn complimentary_access_never_downgrades_paid_access() {
        let now = chrono::Utc
            .with_ymd_and_hms(2026, 8, 19, 12, 0, 0)
            .single()
            .unwrap();
        let grant = AccessGrant {
            pass_id: uuid::Uuid::new_v4(),
            tier: "starter".to_string(),
            expires_at: now + chrono::Duration::days(14),
            revoked_at: None,
        };
        let invite = select_access_grant(&[grant], now);
        let access = resolve_effective_access(
            "private_agent".to_string(),
            None,
            invite.clone(),
            now,
        );
        assert_eq!(access.tier, "private_agent");
        assert_eq!(access.source, "complimentary_pass");
        assert_eq!(access.state, "active");
        let normal_paid_access = resolve_execution_access(
            "private_agent".to_string(),
            None,
            invite,
            now,
            false,
        );
        assert_eq!(normal_paid_access.tier, "private_agent");
        assert_eq!(normal_paid_access.source, "stripe");
    }

    #[test]
    fn overlapping_grants_choose_best_active_then_latest_expired() {
        let now = chrono::Utc
            .with_ymd_and_hms(2026, 8, 19, 12, 0, 0)
            .single()
            .unwrap();
        let grant = |tier: &str, expires_at, revoked_at| AccessGrant {
            pass_id: uuid::Uuid::new_v4(),
            tier: tier.to_string(),
            expires_at,
            revoked_at,
        };
        let starter_later = grant("starter", now + chrono::Duration::days(20), None);
        let private_sooner = grant("private_agent", now + chrono::Duration::days(10), None);
        let selected = select_access_grant(&[starter_later.clone(), private_sooner.clone()], now);
        assert_eq!(selected.active, Some(private_sooner));
        assert_eq!(selected.state, "active");

        let revoked = grant(
            "private_agent",
            now + chrono::Duration::days(30),
            Some(now - chrono::Duration::minutes(1)),
        );
        let selected = select_access_grant(&[revoked], now);
        assert!(selected.active.is_none());
        assert_eq!(selected.state, "revoked");
    }

    #[test]
    fn access_pass_secret_comparison_is_exact() {
        assert!(constant_time_eq(
            "abcdefghijklmnopqrstuvwxyz123456",
            "abcdefghijklmnopqrstuvwxyz123456"
        ));
        assert!(!constant_time_eq(
            "abcdefghijklmnopqrstuvwxyz123456",
            "abcdefghijklmnopqrstuvwxyz123457"
        ));
        assert!(!constant_time_eq("short", "longer"));
    }

    #[test]
    fn access_pass_email_is_canonical_and_unambiguous() {
        assert_eq!(
            validate_access_pass_email("  Investor+Canary@Example.COM ").unwrap(),
            "investor+canary@example.com"
        );
        for invalid in [
            "missing-at",
            "a@@example.com",
            "a b@example.com",
            "@example.com",
        ] {
            assert!(validate_access_pass_email(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn overage_fee_rounds_once_at_cumulative_precision() {
        let first = fee_for_overage_micro_usd(16_667, 3);
        let second_total = fee_for_overage_micro_usd(33_334, 3);
        assert_eq!(first, 6);
        assert_eq!(second_total, 11);
        assert_eq!(second_total - first, 5);
    }

    #[test]
    fn starter_and_private_agent_have_distinct_value_allowances() {
        let starter = private_agent_trading_plan_for_tier("starter").unwrap();
        let private_agent = private_agent_trading_plan_for_tier("private_agent").unwrap();
        assert_eq!(starter.included_notional_micro_usd, 100_000_000_000);
        assert_eq!(starter.overage_fee_bps, 3);
        assert_eq!(private_agent.included_notional_micro_usd, 1_000_000_000_000);
        assert_eq!(private_agent.overage_fee_bps, 2);
        assert!(
            private_agent.default_monthly_fee_cap_micro_usd
                > starter.default_monthly_fee_cap_micro_usd
        );
    }

    #[test]
    fn trial_pack_stops_at_included_notional_without_creating_overage() {
        let plan = private_agent_trading_plan_for_tier("trial_pack").unwrap();
        let start = chrono::Utc
            .with_ymd_and_hms(2026, 7, 1, 0, 0, 0)
            .single()
            .unwrap();
        let end = chrono::Utc
            .with_ymd_and_hms(2026, 8, 1, 0, 0, 0)
            .single()
            .unwrap();
        let status = private_agent_trading_status_from_values(
            plan,
            plan.included_notional_micro_usd,
            0,
            0,
            0,
            0,
            start,
            end,
        );
        assert!(!status.live_trading_allowed);
        assert!(!status.cap_reached);
        assert_eq!(status.accrued_fee_micro_usd, 0);
    }

    #[test]
    fn paid_plan_stops_when_user_fee_ceiling_is_reached() {
        let plan = private_agent_trading_plan_for_tier("starter").unwrap();
        let start = chrono::Utc
            .with_ymd_and_hms(2026, 7, 1, 0, 0, 0)
            .single()
            .unwrap();
        let end = chrono::Utc
            .with_ymd_and_hms(2026, 8, 1, 0, 0, 0)
            .single()
            .unwrap();
        let status = private_agent_trading_status_from_values(
            plan,
            plan.included_notional_micro_usd + 200_000_000_000,
            plan.default_monthly_fee_cap_micro_usd,
            5_000,
            5_000,
            plan.default_monthly_fee_cap_micro_usd,
            start,
            end,
        );
        assert!(status.cap_reached);
        assert!(!status.live_trading_allowed);
    }

    #[test]
    fn zero_fee_ceiling_means_no_overage_not_unlimited_overage() {
        let plan = private_agent_trading_plan_for_tier("starter").unwrap();
        let start = chrono::Utc
            .with_ymd_and_hms(2026, 7, 1, 0, 0, 0)
            .single()
            .unwrap();
        let end = chrono::Utc
            .with_ymd_and_hms(2026, 8, 1, 0, 0, 0)
            .single()
            .unwrap();
        let status = private_agent_trading_status_from_values(
            plan,
            plan.included_notional_micro_usd,
            0,
            0,
            0,
            0,
            start,
            end,
        );
        assert!(status.cap_reached);
        assert!(!status.live_trading_allowed);
    }
}
