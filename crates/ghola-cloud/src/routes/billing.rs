use axum::extract::State;
use axum::http::HeaderMap;
use axum::Json;
use chrono::Datelike;
use serde::{Deserialize, Serialize};

use crate::auth::AuthUser;
use crate::error::CloudError;
use crate::state::AppState;

#[derive(Deserialize)]
pub struct CreateCheckoutRequest {
    pub tier: String, // "pro", "private_agent", "founding_trader", or "unlimited"
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
    pub stripe_customer_id: Option<String>,
    pub portal_url: Option<String>,
    pub limits: BillingLimits,
    pub private_agent_compute: PrivateAgentComputeStatus,
    pub founding_trader_cohort: FoundingTraderCohortStatus,
}

#[derive(Serialize)]
pub struct FoundingTraderCohortStatus {
    pub capacity: i64,
    pub claimed_seats: i64,
    pub remaining_seats: i64,
    pub checkout_open: bool,
}

#[derive(Serialize)]
pub struct BillingLimits {
    pub calls_per_month: i32,
    pub emails_per_month: i32,
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

#[derive(Deserialize)]
pub struct ReservePrivateAgentComputeRequest {
    pub session_id: String,
    pub seconds: i64,
}

#[derive(Deserialize)]
pub struct ReleasePrivateAgentComputeRequest {
    pub session_id: String,
    pub status: String,
}

#[derive(Serialize)]
pub struct PrivateAgentComputeReservationResponse {
    pub ok: bool,
    pub reservation_id: String,
    pub reserved_seconds: i64,
    pub private_agent_compute: PrivateAgentComputeStatus,
}

// Stripe validates `expires_at` after receiving the request. Use one minute of
// clock/network headroom beyond its 30-minute minimum.
const FOUNDING_TRADER_RESERVATION_MINUTES: i64 = 31;

enum FoundingTraderSeatReservation {
    Created,
    ExistingCheckout(String),
}

fn founding_trader_cohort_has_capacity(claimed_seats: i64, max_seats: i64) -> bool {
    claimed_seats < max_seats
}

async fn reserve_founding_trader_seat(
    db: &sqlx::PgPool,
    max_seats: i64,
    user_id: uuid::Uuid,
) -> Result<FoundingTraderSeatReservation, CloudError> {
    let mut tx = db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended('founding-trader-seats', 0))")
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        r#"
        UPDATE founding_trader_seats
        SET status = 'released', released_at = now(), updated_at = now()
        WHERE status = 'reserved' AND expires_at <= now()
        "#,
    )
    .execute(&mut *tx)
    .await?;

    let existing = sqlx::query_as::<_, (String, Option<String>)>(
        r#"
        SELECT status, checkout_url
        FROM founding_trader_seats
        WHERE user_id = $1 AND (
            status = 'active' OR (status = 'reserved' AND expires_at > now())
        )
        "#,
    )
    .bind(user_id)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some((status, checkout_url)) = existing {
        tx.commit().await?;
        if status == "active" {
            return Err(CloudError::BadRequest(
                "Founding Trader is already active for this account".to_string(),
            ));
        }
        return checkout_url
            .map(FoundingTraderSeatReservation::ExistingCheckout)
            .ok_or_else(|| {
                CloudError::ServiceUnavailable(
                    "Founding Trader checkout is already being prepared; retry shortly".to_string(),
                )
            });
    }

    let claimed: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)::BIGINT
        FROM founding_trader_seats
        WHERE status = 'active' OR (status = 'reserved' AND expires_at > now())
        "#,
    )
    .fetch_one(&mut *tx)
    .await?;
    if !founding_trader_cohort_has_capacity(claimed, max_seats) {
        tx.commit().await?;
        return Err(CloudError::BadRequest(format!(
            "The {}-seat Founding Trader cohort is full",
            max_seats
        )));
    }

    sqlx::query(
        r#"
        INSERT INTO founding_trader_seats
            (user_id, status, reserved_at, expires_at, stripe_session_id,
             checkout_url, activated_at, released_at, updated_at)
        VALUES ($1, 'reserved', now(), now() + ($2 || ' minutes')::interval,
                NULL, NULL, NULL, NULL, now())
        ON CONFLICT (user_id) DO UPDATE SET
            status = 'reserved',
            reserved_at = now(),
            expires_at = now() + ($2 || ' minutes')::interval,
            stripe_session_id = NULL,
            checkout_url = NULL,
            activated_at = NULL,
            released_at = NULL,
            updated_at = now()
        "#,
    )
    .bind(user_id)
    .bind(FOUNDING_TRADER_RESERVATION_MINUTES.to_string())
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(FoundingTraderSeatReservation::Created)
}

async fn release_founding_trader_reservation(
    db: &sqlx::PgPool,
    user_id: uuid::Uuid,
) -> Result<(), CloudError> {
    sqlx::query(
        r#"
        UPDATE founding_trader_seats
        SET status = 'released', released_at = now(), updated_at = now()
        WHERE user_id = $1 AND status = 'reserved'
        "#,
    )
    .bind(user_id)
    .execute(db)
    .await?;
    Ok(())
}

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

    let email: Option<String> = sqlx::query_scalar("SELECT email FROM users WHERE id = $1")
        .bind(claims.sub)
        .fetch_optional(&state.db)
        .await?
        .flatten();

    let founding_trader_checkout = req.tier == "founding_trader";
    let price_id =
        match req.tier.as_str() {
            "pro" => {
                state
                    .config
                    .stripe_price_pro
                    .as_deref()
                    .ok_or(CloudError::ServiceUnavailable(
                        "pro price not configured".to_string(),
                    ))?
            }
            "private_agent" => state.config.stripe_price_private_agent.as_deref().ok_or(
                CloudError::ServiceUnavailable("private agent price not configured".to_string()),
            )?,
            "founding_trader" => state.config.stripe_price_founding_trader.as_deref().ok_or(
                CloudError::ServiceUnavailable("founding trader price not configured".to_string()),
            )?,
            "unlimited" => state.config.stripe_price_unlimited.as_deref().ok_or(
                CloudError::ServiceUnavailable("unlimited price not configured".to_string()),
            )?,
            _ => {
                return Err(CloudError::BadRequest(
                    "tier must be 'pro', 'private_agent', 'founding_trader', or 'unlimited'"
                        .to_string(),
                ));
            }
        };

    if founding_trader_checkout {
        match reserve_founding_trader_seat(
            &state.db,
            state.config.founding_trader_max_seats,
            claims.sub,
        )
        .await?
        {
            FoundingTraderSeatReservation::ExistingCheckout(checkout_url) => {
                return Ok(Json(CheckoutResponse { checkout_url }));
            }
            FoundingTraderSeatReservation::Created => {}
        }
    }

    let client = reqwest::Client::new();

    // Create checkout session
    let mut form = vec![
        ("mode", "subscription".to_string()),
        ("line_items[0][price]", price_id.to_string()),
        ("line_items[0][quantity]", "1".to_string()),
        (
            "success_url",
            format!(
                "{}/settings?tab=plan&checkout=success",
                state.config.base_url
            ),
        ),
        (
            "cancel_url",
            format!(
                "{}/settings?tab=plan&checkout=cancelled",
                state.config.base_url
            ),
        ),
        ("client_reference_id", claims.sub.to_string()),
        ("metadata[ghola_kind]", "subscription".to_string()),
        ("metadata[ghola_tier]", req.tier.clone()),
        ("metadata[price_id]", price_id.to_string()),
        ("subscription_data[metadata][ghola_tier]", req.tier.clone()),
        (
            "subscription_data[metadata][user_id]",
            claims.sub.to_string(),
        ),
        (
            "subscription_data[metadata][price_id]",
            price_id.to_string(),
        ),
    ];

    if founding_trader_checkout {
        form.push((
            "expires_at",
            (chrono::Utc::now().timestamp() + FOUNDING_TRADER_RESERVATION_MINUTES * 60).to_string(),
        ));
    }

    if let Some(ref email) = email {
        form.push(("customer_email", email.clone()));
    }

    let resp = client
        .post("https://api.stripe.com/v1/checkout/sessions")
        .header("Authorization", format!("Bearer {stripe_key}"))
        .form(&form)
        .send()
        .await
        .map_err(|e| CloudError::Internal(format!("stripe request failed: {e}")));

    let resp = match resp {
        Ok(resp) => resp,
        Err(error) => {
            if founding_trader_checkout {
                release_founding_trader_reservation(&state.db, claims.sub).await?;
            }
            return Err(error);
        }
    };

    let status = resp.status();
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| CloudError::Internal(format!("stripe response parse failed: {e}")))?;

    if !status.is_success() {
        tracing::warn!(?body, "Stripe subscription checkout could not be created");
        if founding_trader_checkout {
            release_founding_trader_reservation(&state.db, claims.sub).await?;
        }
        return Err(CloudError::ServiceUnavailable(
            "Stripe checkout could not be created".to_string(),
        ));
    }

    let checkout_url = match body["url"].as_str() {
        Some(url) => url.to_string(),
        None => {
            if founding_trader_checkout {
                release_founding_trader_reservation(&state.db, claims.sub).await?;
            }
            return Err(CloudError::Internal(
                "no checkout URL in Stripe response".to_string(),
            ));
        }
    };

    if founding_trader_checkout {
        let stripe_session_id = match body["id"].as_str() {
            Some(session_id) => session_id,
            None => {
                release_founding_trader_reservation(&state.db, claims.sub).await?;
                return Err(CloudError::Internal(
                    "no Checkout session ID in Stripe response".to_string(),
                ));
            }
        };
        sqlx::query(
            r#"
            UPDATE founding_trader_seats
            SET stripe_session_id = $2, checkout_url = $3, updated_at = now()
            WHERE user_id = $1 AND status = 'reserved'
            "#,
        )
        .bind(claims.sub)
        .bind(stripe_session_id)
        .bind(&checkout_url)
        .execute(&state.db)
        .await?;
    }

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
    tier_from_configured_price(
        event,
        state.config.stripe_price_pro.as_deref(),
        state.config.stripe_price_private_agent.as_deref(),
        state.config.stripe_price_founding_trader.as_deref(),
        state.config.stripe_price_unlimited.as_deref(),
    )
}

fn tier_from_configured_price(
    event: &serde_json::Value,
    pro_price: Option<&str>,
    private_agent_price: Option<&str>,
    founding_trader_price: Option<&str>,
    unlimited_price: Option<&str>,
) -> &'static str {
    match event["data"]["object"]["metadata"]["ghola_tier"].as_str() {
        Some("founding_trader") => return "founding_trader",
        Some("private_agent") => return "private_agent",
        Some("unlimited") => return "unlimited",
        Some("pro") => return "pro",
        _ => {}
    }

    // Try to extract price ID from line_items or metadata
    let price_id = event["data"]["object"]["line_items"]["data"][0]["price"]["id"]
        .as_str()
        .or_else(|| event["data"]["object"]["items"]["data"][0]["price"]["id"].as_str())
        .or_else(|| event["data"]["object"]["metadata"]["price_id"].as_str())
        .unwrap_or("");

    if let Some(unlimited_price) = unlimited_price {
        if price_id == unlimited_price {
            return "unlimited";
        }
    }
    if let Some(private_agent_price) = private_agent_price {
        if price_id == private_agent_price {
            return "private_agent";
        }
    }
    if let Some(founding_trader_price) = founding_trader_price {
        if price_id == founding_trader_price {
            return "founding_trader";
        }
    }
    if let Some(pro_price) = pro_price {
        if price_id == pro_price {
            return "pro";
        }
    }

    // Fallback: check amount if price ID not available
    let amount = event["data"]["object"]["amount_total"]
        .as_i64()
        .unwrap_or(0);
    if amount >= 2999 {
        "unlimited"
    } else if amount >= 2900 {
        "founding_trader"
    } else if amount >= 1999 {
        "private_agent"
    } else {
        "pro"
    }
}

fn private_agent_limits(tier: &str) -> (i64, i64) {
    match tier {
        "private_agent" => (30 * 60 * 60, 1),
        "founding_trader" => (100 * 60 * 60, 3),
        "unlimited" => (100 * 60 * 60, 3),
        "enterprise" => (500 * 60 * 60, 10),
        _ => (0, 0),
    }
}

fn billing_limits(tier: &str) -> BillingLimits {
    let (calls_per_month, emails_per_month) = match tier {
        "pro" | "private_agent" => (30, 50),
        "founding_trader" | "unlimited" | "enterprise" => (999, 999),
        _ => (5, 10),
    };
    let (private_compute_seconds, active_private_agents) = private_agent_limits(tier);
    BillingLimits {
        calls_per_month,
        emails_per_month,
        private_compute_seconds,
        active_private_agents,
    }
}

fn month_bounds() -> (String, String) {
    let now = chrono::Utc::now().date_naive();
    let period_start = now.format("%Y-%m-01").to_string();
    let next_month = if now.month() == 12 {
        chrono::NaiveDate::from_ymd_opt(now.year() + 1, 1, 1)
    } else {
        chrono::NaiveDate::from_ymd_opt(now.year(), now.month() + 1, 1)
    }
    .expect("valid next month");
    (period_start, next_month.to_string())
}

async fn private_agent_compute_status_for(
    state: &AppState,
    user_id: uuid::Uuid,
    tier: &str,
) -> Result<PrivateAgentComputeStatus, CloudError> {
    let (period_start, period_end) = month_bounds();
    let (included_seconds, active_agent_limit) = private_agent_limits(tier);
    let row = sqlx::query_as::<_, (i64, i64, i64)>(
        r#"
        SELECT
            COALESCE(SUM(seconds_reserved), 0)::BIGINT,
            COALESCE(SUM(seconds_used), 0)::BIGINT,
            COUNT(*) FILTER (WHERE status = 'active')::BIGINT
        FROM private_agent_compute_usage
        WHERE user_id = $1 AND period_start = $2::date
        "#,
    )
    .bind(user_id)
    .bind(&period_start)
    .fetch_one(&state.db)
    .await?;

    let reserved_seconds = row.0;
    let used_seconds = row.1;
    let active_agent_count = row.2;
    Ok(PrivateAgentComputeStatus {
        included_seconds,
        reserved_seconds,
        used_seconds,
        remaining_seconds: (included_seconds - reserved_seconds).max(0),
        active_agent_limit,
        active_agent_count,
        period_start,
        period_end,
        metering_unit: "agent_second",
    })
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

fn subscription_event_user_id(event: &serde_json::Value) -> Option<uuid::Uuid> {
    event["data"]["object"]["client_reference_id"]
        .as_str()
        .or_else(|| event["data"]["object"]["metadata"]["user_id"].as_str())
        .and_then(|value| value.parse::<uuid::Uuid>().ok())
}

async fn activate_founding_trader_seat(
    db: &sqlx::PgPool,
    user_id: uuid::Uuid,
    stripe_session_id: Option<&str>,
) -> Result<(), CloudError> {
    sqlx::query(
        r#"
        INSERT INTO founding_trader_seats
            (user_id, status, stripe_session_id, activated_at, expires_at, updated_at)
        VALUES ($1, 'active', $2, now(), NULL, now())
        ON CONFLICT (user_id) DO UPDATE SET
            status = 'active',
            stripe_session_id = COALESCE(EXCLUDED.stripe_session_id,
                                         founding_trader_seats.stripe_session_id),
            activated_at = COALESCE(founding_trader_seats.activated_at, now()),
            expires_at = NULL,
            released_at = NULL,
            updated_at = now()
        "#,
    )
    .bind(user_id)
    .bind(stripe_session_id)
    .execute(db)
    .await?;
    Ok(())
}

async fn release_founding_trader_seat_for_customer(
    db: &sqlx::PgPool,
    customer_id: &str,
) -> Result<(), CloudError> {
    sqlx::query(
        r#"
        UPDATE founding_trader_seats
        SET status = 'released', released_at = now(), expires_at = NULL, updated_at = now()
        WHERE user_id IN (SELECT id FROM users WHERE stripe_customer_id = $1)
          AND status <> 'released'
        "#,
    )
    .bind(customer_id)
    .execute(db)
    .await?;
    Ok(())
}

async fn founding_trader_cohort_status_for(
    state: &AppState,
) -> Result<FoundingTraderCohortStatus, CloudError> {
    let claimed_seats: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)::BIGINT
        FROM founding_trader_seats
        WHERE status = 'active' OR (status = 'reserved' AND expires_at > now())
        "#,
    )
    .fetch_one(&state.db)
    .await?;
    let capacity = state.config.founding_trader_max_seats;
    let remaining_seats = (capacity - claimed_seats).max(0);
    Ok(FoundingTraderCohortStatus {
        capacity,
        claimed_seats,
        remaining_seats,
        checkout_open: founding_trader_cohort_has_capacity(claimed_seats, capacity)
            && state.config.stripe_price_founding_trader.is_some()
            && state.config.stripe_secret_key.is_some(),
    })
}

/// GET /api/billing/founding-cohort — Public, non-user-specific seat count.
pub async fn founding_trader_cohort_status(
    State(state): State<AppState>,
) -> Result<Json<FoundingTraderCohortStatus>, CloudError> {
    Ok(Json(founding_trader_cohort_status_for(&state).await?))
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

            let payment_status = event["data"]["object"]["payment_status"]
                .as_str()
                .unwrap_or("");
            let customer_id = event["data"]["object"]["customer"].as_str().unwrap_or("");

            if matches!(payment_status, "paid" | "no_payment_required") {
                if let Some(user_id) = subscription_event_user_id(&event) {
                    // Determine tier from the checkout session's price ID.
                    let tier = tier_from_price_id(&event, &state);

                    sqlx::query(
                        "UPDATE users SET tier = $1, stripe_customer_id = $2, updated_at = now() WHERE id = $3",
                    )
                    .bind(tier)
                    .bind(customer_id)
                    .bind(user_id)
                    .execute(&state.db)
                    .await?;

                    if tier == "founding_trader" {
                        activate_founding_trader_seat(
                            &state.db,
                            user_id,
                            event["data"]["object"]["id"].as_str(),
                        )
                        .await?;
                    }

                    tracing::info!(%user_id, tier, "subscription activated");
                }
            } else {
                tracing::info!(payment_status, "subscription checkout is awaiting payment");
            }
        }
        "checkout.session.expired" => {
            let stripe_session_id = event["data"]["object"]["id"].as_str().unwrap_or("");
            sqlx::query(
                r#"
                UPDATE founding_trader_seats
                SET status = 'released', released_at = now(), expires_at = NULL, updated_at = now()
                WHERE stripe_session_id = $1 AND status = 'reserved'
                "#,
            )
            .bind(stripe_session_id)
            .execute(&state.db)
            .await?;
            tracing::info!(stripe_session_id, "expired founding checkout seat released");
        }
        "customer.subscription.deleted" => {
            let customer_id = event["data"]["object"]["customer"].as_str().unwrap_or("");

            sqlx::query(
                "UPDATE users SET tier = 'free', updated_at = now() WHERE stripe_customer_id = $1",
            )
            .bind(customer_id)
            .execute(&state.db)
            .await?;
            release_founding_trader_seat_for_customer(&state.db, customer_id).await?;

            tracing::info!(customer_id, "subscription cancelled, reverted to free");
        }
        "customer.subscription.created" | "customer.subscription.updated" => {
            let subscription = &event["data"]["object"];
            let customer_id = subscription["customer"].as_str().unwrap_or("");
            let status = subscription["status"].as_str().unwrap_or("");
            let tier = if matches!(status, "active" | "trialing") {
                tier_from_price_id(&event, &state)
            } else {
                "free"
            };
            let event_user_id = subscription_event_user_id(&event);
            if let Some(user_id) = event_user_id {
                sqlx::query(
                    "UPDATE users SET tier = $1, stripe_customer_id = $2, updated_at = now() WHERE id = $3",
                )
                .bind(tier)
                .bind(customer_id)
                .bind(user_id)
                .execute(&state.db)
                .await?;
            } else {
                sqlx::query(
                    "UPDATE users SET tier = $1, updated_at = now() WHERE stripe_customer_id = $2",
                )
                .bind(tier)
                .bind(customer_id)
                .execute(&state.db)
                .await?;
            }
            if tier == "founding_trader" {
                let user_id = match event_user_id {
                    Some(user_id) => Some(user_id),
                    None => {
                        sqlx::query_scalar("SELECT id FROM users WHERE stripe_customer_id = $1")
                            .bind(customer_id)
                            .fetch_optional(&state.db)
                            .await?
                    }
                };
                if let Some(user_id) = user_id {
                    activate_founding_trader_seat(&state.db, user_id, None).await?;
                }
            } else {
                release_founding_trader_seat_for_customer(&state.db, customer_id).await?;
            }
            tracing::info!(customer_id, status, tier, "subscription state synchronized");
        }
        "invoice.payment_failed" => {
            let customer_id = event["data"]["object"]["customer"].as_str().unwrap_or("");
            sqlx::query(
                "UPDATE users SET tier = 'free', updated_at = now() WHERE stripe_customer_id = $1",
            )
            .bind(customer_id)
            .execute(&state.db)
            .await?;
            release_founding_trader_seat_for_customer(&state.db, customer_id).await?;
            tracing::warn!(
                customer_id,
                "subscription payment failed, opening trades disabled"
            );
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

/// GET /api/billing/status
pub async fn billing_status(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
) -> Result<Json<BillingStatusResponse>, CloudError> {
    let row = sqlx::query_as::<_, (String, Option<String>)>(
        "SELECT tier, stripe_customer_id FROM users WHERE id = $1",
    )
    .bind(claims.sub)
    .fetch_optional(&state.db)
    .await?
    .ok_or(CloudError::NotFound("user not found".to_string()))?;

    let portal_url = if let (Some(ref customer_id), Some(stripe_key)) =
        (&row.1, state.config.stripe_secret_key.as_deref())
    {
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

    let private_agent_compute =
        private_agent_compute_status_for(&state, claims.sub, &row.0).await?;
    let founding_trader_cohort = founding_trader_cohort_status_for(&state).await?;

    Ok(Json(BillingStatusResponse {
        limits: billing_limits(&row.0),
        private_agent_compute,
        founding_trader_cohort,
        tier: row.0,
        stripe_customer_id: row.1,
        portal_url,
    }))
}

/// POST /api/billing/private-agent/compute/reserve
pub async fn reserve_private_agent_compute(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Json(req): Json<ReservePrivateAgentComputeRequest>,
) -> Result<Json<PrivateAgentComputeReservationResponse>, CloudError> {
    if req.session_id.trim().is_empty() {
        return Err(CloudError::BadRequest("session_id is required".to_string()));
    }
    if !(60..=24 * 60 * 60).contains(&req.seconds) {
        return Err(CloudError::BadRequest(
            "seconds must be between 60 and 86400".to_string(),
        ));
    }

    let tier: String = sqlx::query_scalar("SELECT tier FROM users WHERE id = $1")
        .bind(claims.sub)
        .fetch_optional(&state.db)
        .await?
        .ok_or(CloudError::NotFound("user not found".to_string()))?;
    let mut status = private_agent_compute_status_for(&state, claims.sub, &tier).await?;
    if status.included_seconds <= 0 {
        return Err(CloudError::PaymentRequired(
            "private-agent plan required".to_string(),
        ));
    }
    if status.active_agent_count >= status.active_agent_limit {
        return Err(CloudError::PaymentRequired(
            "active private-agent limit reached".to_string(),
        ));
    }
    if status.remaining_seconds < req.seconds {
        return Err(CloudError::PaymentRequired(
            "private-agent compute allowance exhausted".to_string(),
        ));
    }

    let (period_start, _) = month_bounds();
    sqlx::query(
        r#"
        INSERT INTO private_agent_compute_usage
            (user_id, session_id, seconds_reserved, period_start, metadata)
        VALUES ($1, $2, $3, $4::date, $5)
        ON CONFLICT (user_id, session_id) DO NOTHING
        "#,
    )
    .bind(claims.sub)
    .bind(&req.session_id)
    .bind(req.seconds as i32)
    .bind(&period_start)
    .bind(serde_json::json!({
        "source": "ghola_private_agent_session",
        "metering": "reserved_upfront"
    }))
    .execute(&state.db)
    .await?;

    status = private_agent_compute_status_for(&state, claims.sub, &tier).await?;
    Ok(Json(PrivateAgentComputeReservationResponse {
        ok: true,
        reservation_id: req.session_id,
        reserved_seconds: req.seconds,
        private_agent_compute: status,
    }))
}

/// POST /api/billing/private-agent/compute/release
pub async fn release_private_agent_compute(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Json(req): Json<ReleasePrivateAgentComputeRequest>,
) -> Result<Json<serde_json::Value>, CloudError> {
    let status = match req.status.as_str() {
        "paused" | "completed" | "failed" => req.status.as_str(),
        _ => {
            return Err(CloudError::BadRequest(
                "status must be paused, completed, or failed".to_string(),
            ));
        }
    };
    sqlx::query(
        r#"
        UPDATE private_agent_compute_usage
        SET status = $3, updated_at = now()
        WHERE user_id = $1 AND session_id = $2
        "#,
    )
    .bind(claims.sub)
    .bind(req.session_id)
    .bind(status)
    .execute(&state.db)
    .await?;

    Ok(Json(serde_json::json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn founding_trader_checkout_metadata_maps_to_the_trading_tier() {
        let event = serde_json::json!({
            "data": { "object": { "metadata": { "ghola_tier": "founding_trader" } } }
        });
        assert_eq!(
            tier_from_configured_price(&event, None, None, None, None),
            "founding_trader"
        );
    }

    #[test]
    fn founding_trader_subscription_price_survives_webhook_updates() {
        let event = serde_json::json!({
            "data": { "object": { "items": { "data": [{ "price": { "id": "price_founding" } }] } } }
        });
        assert_eq!(
            tier_from_configured_price(
                &event,
                Some("price_pro"),
                Some("price_agents"),
                Some("price_founding"),
                Some("price_unlimited"),
            ),
            "founding_trader"
        );
    }

    #[test]
    fn founding_trader_cohort_closes_at_its_atomic_cap() {
        assert!(founding_trader_cohort_has_capacity(0, 100));
        assert!(founding_trader_cohort_has_capacity(99, 100));
        assert!(!founding_trader_cohort_has_capacity(100, 100));
        assert!(!founding_trader_cohort_has_capacity(101, 100));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn founding_trader_reservations_do_not_oversubscribe_under_concurrency() {
        let Ok(database_url) = ghola_assistant_types::env_compat(
            "GHOLA_BILLING_E2E_DATABASE_URL",
            "THUMPER_BILLING_E2E_DATABASE_URL",
        ) else {
            eprintln!(
                "skipping billing concurrency e2e: GHOLA_BILLING_E2E_DATABASE_URL is not set"
            );
            return;
        };
        let pool = crate::db::create_pool(&database_url)
            .await
            .expect("billing e2e database should connect");
        crate::db::run_migrations(&pool)
            .await
            .expect("billing e2e migrations should apply");

        let run_id = uuid::Uuid::new_v4();
        let mut user_ids = Vec::with_capacity(101);
        for index in 0..101 {
            let user_id: uuid::Uuid =
                sqlx::query_scalar("INSERT INTO users (email) VALUES ($1) RETURNING id")
                    .bind(format!("billing-cap-{run_id}-{index}@example.invalid"))
                    .fetch_one(&pool)
                    .await
                    .expect("billing test user should be created");
            user_ids.push(user_id);
        }

        let baseline: i64 = sqlx::query_scalar(
            r#"
            SELECT COUNT(*)::BIGINT FROM founding_trader_seats
            WHERE status = 'active' OR (status = 'reserved' AND expires_at > now())
            "#,
        )
        .fetch_one(&pool)
        .await
        .expect("baseline seat count should load");
        let max_seats = baseline + 100;

        let mut handles = Vec::with_capacity(user_ids.len());
        for user_id in user_ids.iter().copied() {
            let pool = pool.clone();
            handles.push(tokio::spawn(async move {
                reserve_founding_trader_seat(&pool, max_seats, user_id).await
            }));
        }
        let mut created = 0;
        let mut rejected = 0;
        for handle in handles {
            match handle.await.expect("reservation task should finish") {
                Ok(FoundingTraderSeatReservation::Created) => created += 1,
                Ok(FoundingTraderSeatReservation::ExistingCheckout(_)) => {
                    panic!("fresh users must not reuse a checkout")
                }
                Err(CloudError::BadRequest(message)) if message.contains("cohort is full") => {
                    rejected += 1
                }
                Err(error) => panic!("unexpected reservation error: {error}"),
            }
        }

        let lifecycle_user = user_ids[0];
        let customer_id = format!("cus_billing_cap_{run_id}");
        sqlx::query("UPDATE users SET stripe_customer_id = $1 WHERE id = $2")
            .bind(&customer_id)
            .bind(lifecycle_user)
            .execute(&pool)
            .await
            .expect("billing test customer should be assigned");
        activate_founding_trader_seat(&pool, lifecycle_user, Some("cs_test_founding"))
            .await
            .expect("completed checkout should activate its seat");
        release_founding_trader_reservation(&pool, lifecycle_user)
            .await
            .expect("reservation cleanup should be idempotent");
        let status: String =
            sqlx::query_scalar("SELECT status FROM founding_trader_seats WHERE user_id = $1")
                .bind(lifecycle_user)
                .fetch_one(&pool)
                .await
                .expect("active seat should survive a reload query");
        assert_eq!(status, "active");
        release_founding_trader_seat_for_customer(&pool, &customer_id)
            .await
            .expect("subscription cancellation should release its seat");
        let status: String =
            sqlx::query_scalar("SELECT status FROM founding_trader_seats WHERE user_id = $1")
                .bind(lifecycle_user)
                .fetch_one(&pool)
                .await
                .expect("released seat should remain durable");
        assert_eq!(status, "released");

        sqlx::query("DELETE FROM users WHERE id = ANY($1)")
            .bind(&user_ids)
            .execute(&pool)
            .await
            .expect("billing test users should be cleaned up");
        assert_eq!(created, 100);
        assert_eq!(rejected, 1);
    }

    #[test]
    fn founding_trader_includes_bounded_private_compute() {
        assert_eq!(private_agent_limits("founding_trader"), (100 * 60 * 60, 3));
        let limits = billing_limits("founding_trader");
        assert_eq!(limits.private_compute_seconds, 100 * 60 * 60);
        assert_eq!(limits.active_private_agents, 3);
        assert_eq!(limits.calls_per_month, 999);
    }
}
