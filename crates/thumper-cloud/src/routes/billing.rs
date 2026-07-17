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

fn effective_tier(tier: String, expires_at: Option<chrono::DateTime<chrono::Utc>>) -> String {
    if tier == "trial_pack" {
        if expires_at
            .map(|expiry| expiry <= chrono::Utc::now())
            .unwrap_or(true)
        {
            return "free".to_string();
        }
    }
    tier
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

fn current_private_agent_period() -> Result<
    (
        chrono::NaiveDate,
        chrono::DateTime<chrono::Utc>,
        chrono::DateTime<chrono::Utc>,
    ),
    CloudError,
> {
    let now = chrono::Utc::now();
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
    tier: &str,
) -> Result<Option<PrivateAgentComputeStatus>, CloudError> {
    let Some((included_seconds, active_agent_limit)) = private_agent_allowance_for_tier(tier)
    else {
        return Ok(None);
    };
    let (period_start, period_start_dt, period_end_dt) = current_private_agent_period()?;
    let (reserved_seconds, used_seconds, active_agent_count) =
        sqlx::query_as::<_, (i64, i64, i64)>(
            r#"
        SELECT
            COALESCE(SUM(seconds) FILTER (WHERE status = 'reserved'), 0)::BIGINT,
            COALESCE(SUM(seconds) FILTER (WHERE status = 'completed'), 0)::BIGINT,
            COALESCE(COUNT(*) FILTER (
                WHERE status = 'reserved' AND reason = 'private_agent_session'
            ), 0)::BIGINT
        FROM private_agent_compute_reservations
        WHERE user_id = $1 AND period_start = $2
        "#,
        )
        .bind(user_id)
        .bind(period_start)
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
    tier: &str,
) -> Result<Option<PrivateAgentTradingStatus>, CloudError> {
    let Some(plan) = private_agent_trading_plan_for_tier(tier) else {
        return Ok(None);
    };
    let (period_start, period_start_dt, period_end_dt) = current_private_agent_period()?;
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
    .bind(tier)
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

/// POST /api/billing/private-agent/compute/reserve
pub async fn reserve_private_agent_compute(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Json(req): Json<ReservePrivateAgentComputeRequest>,
) -> Result<Json<ReservePrivateAgentComputeResponse>, CloudError> {
    validate_private_agent_session_id(&req.session_id)?;
    if !(1..=24 * 60 * 60).contains(&req.seconds) {
        return Err(CloudError::BadRequest(
            "seconds must be between 1 and 86400".to_string(),
        ));
    }
    let reason = normalize_private_agent_reservation_reason(req.reason);
    let (period_start, _, _) = current_private_agent_period()?;

    let mut tx = state.db.begin().await?;
    let row = sqlx::query_as::<_, (String, Option<chrono::DateTime<chrono::Utc>>)>(
        "SELECT tier, tier_expires_at FROM users WHERE id = $1 FOR UPDATE",
    )
    .bind(claims.sub)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(CloudError::NotFound("user not found".to_string()))?;
    let tier = effective_tier(row.0, row.1);

    let Some((included_seconds, active_agent_limit)) = private_agent_allowance_for_tier(&tier)
    else {
        return Err(CloudError::PaymentRequired(
            "private-agent compute allowance required".to_string(),
        ));
    };

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

    let (reserved_seconds, used_seconds, active_agent_count) =
        sqlx::query_as::<_, (i64, i64, i64)>(
            r#"
            SELECT
                COALESCE(SUM(seconds) FILTER (WHERE status = 'reserved'), 0)::BIGINT,
                COALESCE(SUM(seconds) FILTER (WHERE status = 'completed'), 0)::BIGINT,
                COALESCE(COUNT(*) FILTER (
                    WHERE status = 'reserved' AND reason = 'private_agent_session'
                ), 0)::BIGINT
            FROM private_agent_compute_reservations
            WHERE user_id = $1 AND period_start = $2
            "#,
        )
        .bind(claims.sub)
        .bind(period_start)
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
            (user_id, session_id, seconds, reason, status, period_start)
        VALUES ($1, $2, $3, $4, 'reserved', $5)
        RETURNING id
        "#,
    )
    .bind(claims.sub)
    .bind(&req.session_id)
    .bind(req.seconds)
    .bind(&reason)
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

/// POST /api/billing/private-agent/trading/meter
pub async fn meter_private_agent_trading(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
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
    let (period_start, period_start_dt, period_end_dt) = current_private_agent_period()?;
    let mut tx = state.db.begin().await?;
    let user = sqlx::query_as::<_, (String, Option<chrono::DateTime<chrono::Utc>>)>(
        "SELECT tier, tier_expires_at FROM users WHERE id = $1 FOR UPDATE",
    )
    .bind(claims.sub)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(CloudError::NotFound("user not found".to_string()))?;
    let tier = effective_tier(user.0, user.1);
    let Some(plan) = private_agent_trading_plan_for_tier(&tier) else {
        return Err(CloudError::PaymentRequired(
            "live trading plan required".to_string(),
        ));
    };
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
    let duplicate: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM private_agent_trading_usage_events WHERE user_id = $1 AND event_id = $2)",
    )
    .bind(claims.sub)
    .bind(&req.event_id)
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
        let capped_new_fee = theoretical_new_fee.min(row.6);
        let incremental_fee = (capped_new_fee - theoretical_old_fee.min(row.3)).max(0);
        let target_fee_cents = capped_new_fee / 10_000;
        let queue_delta_cents = (target_fee_cents - row.4).max(0);
        sqlx::query(
            r#"
            INSERT INTO private_agent_trading_usage_events
                (event_id, user_id, period_start, work_order_commitment,
                 connector_result_commitment, platform_class, fill_count,
                 filled_notional_micro_usd, incremental_fee_micro_usd)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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
            row.6,
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
    let tier_row = sqlx::query_as::<_, (String, Option<chrono::DateTime<chrono::Utc>>)>(
        "SELECT tier, tier_expires_at FROM users WHERE id = $1",
    )
    .bind(claims.sub)
    .fetch_optional(&state.db)
    .await?
    .ok_or(CloudError::NotFound("user not found".to_string()))?;
    let tier = effective_tier(tier_row.0, tier_row.1);
    let Some(plan) = private_agent_trading_plan_for_tier(&tier) else {
        return Err(CloudError::PaymentRequired(
            "live trading plan required".to_string(),
        ));
    };
    if plan.overage_fee_bps == 0 && req.monthly_fee_cap_micro_usd != 0 {
        return Err(CloudError::BadRequest(
            "this plan has no overage billing".to_string(),
        ));
    }
    let (period_start, _, _) = current_private_agent_period()?;
    private_agent_trading_status_for_user(&state, claims.sub, &tier).await?;
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
    private_agent_trading_status_for_user(&state, claims.sub, &tier)
        .await?
        .ok_or_else(|| CloudError::Internal("trading status unavailable".to_string()))
        .map(Json)
}

/// GET /api/billing/status
pub async fn billing_status(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
) -> Result<Json<BillingStatusResponse>, CloudError> {
    let row = sqlx::query_as::<
        _,
        (
            String,
            Option<chrono::DateTime<chrono::Utc>>,
            Option<String>,
        ),
    >("SELECT tier, tier_expires_at, stripe_customer_id FROM users WHERE id = $1")
    .bind(claims.sub)
    .fetch_optional(&state.db)
    .await?
    .ok_or(CloudError::NotFound("user not found".to_string()))?;

    let (raw_tier, tier_expires_at, stripe_customer_id) = row;
    let tier = effective_tier(raw_tier, tier_expires_at);
    process_private_agent_trading_invoice_outbox(&state, claims.sub).await?;
    let expires_at = if tier == "trial_pack" {
        tier_expires_at.map(|expiry| expiry.to_rfc3339())
    } else {
        None
    };

    let portal_url = if let (Some(ref customer_id), Some(stripe_key)) = (
        &stripe_customer_id,
        state.config.stripe_secret_key.as_deref(),
    ) {
        // Create billing portal session
        let client = reqwest::Client::new();
        let resp = client
            .post("https://api.stripe.com/v1/billing_portal/sessions")
            .header("Authorization", format!("Bearer {stripe_key}"))
            .form(&[
                ("customer", customer_id.as_str()),
                ("return_url", &format!("{}/settings", state.config.base_url)),
            ])
            .send()
            .await
            .ok();

        if let Some(resp) = resp {
            let body: serde_json::Value = resp.json().await.unwrap_or_default();
            body["url"].as_str().map(|s| s.to_string())
        } else {
            None
        }
    } else {
        None
    };

    Ok(Json(BillingStatusResponse {
        limits: billing_limits_for_tier(&tier),
        private_agent_compute: private_agent_compute_status_for_user(&state, claims.sub, &tier)
            .await?,
        private_agent_trading: private_agent_trading_status_for_user(&state, claims.sub, &tier)
            .await?,
        tier,
        expires_at,
        stripe_customer_id,
        portal_url,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

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
