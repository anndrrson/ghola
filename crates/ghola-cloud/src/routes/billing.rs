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
    pub subscription_status: Option<String>,
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
const FOUNDING_TRADER_LOCK_RETRY_ATTEMPTS: usize = 600;
const FOUNDING_TRADER_LOCK_RETRY_MILLIS: u64 = 50;

enum FoundingTraderSeatReservation {
    Created,
    ExistingCheckout(String),
}

fn subscription_checkout_form(
    state: &AppState,
    user_id: uuid::Uuid,
    tier: &str,
    price_id: &str,
    email: Option<&str>,
    stripe_customer_id: Option<&str>,
    founding_trader_checkout: bool,
) -> Vec<(&'static str, String)> {
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
        ("client_reference_id", user_id.to_string()),
        ("metadata[ghola_kind]", "subscription".to_string()),
        ("metadata[ghola_tier]", tier.to_string()),
        ("metadata[user_id]", user_id.to_string()),
        ("metadata[price_id]", price_id.to_string()),
        ("subscription_data[metadata][ghola_tier]", tier.to_string()),
        ("subscription_data[metadata][user_id]", user_id.to_string()),
        (
            "subscription_data[metadata][price_id]",
            price_id.to_string(),
        ),
        (
            "adaptive_pricing[enabled]",
            state.config.stripe_adaptive_pricing_enabled.to_string(),
        ),
    ];

    if state.config.stripe_automatic_tax_enabled {
        form.push(("automatic_tax[enabled]", "true".to_string()));
        form.push(("billing_address_collection", "required".to_string()));
    }
    if state.config.stripe_tax_id_collection_enabled {
        form.push(("tax_id_collection[enabled]", "true".to_string()));
    }
    if let Some(configuration) = state.config.stripe_payment_method_configuration.as_deref() {
        form.push(("payment_method_configuration", configuration.to_string()));
    }

    if founding_trader_checkout {
        form.push((
            "expires_at",
            (chrono::Utc::now().timestamp() + FOUNDING_TRADER_RESERVATION_MINUTES * 60).to_string(),
        ));
    }

    if let Some(customer_id) = stripe_customer_id.filter(|value| !value.is_empty()) {
        form.push(("customer", customer_id.to_string()));
        form.push(("customer_update[address]", "auto".to_string()));
        form.push(("customer_update[name]", "auto".to_string()));
    } else if let Some(email) = email.filter(|value| !value.is_empty()) {
        form.push(("customer_email", email.to_string()));
    }

    form
}

fn founding_trader_cohort_has_capacity(claimed_seats: i64, max_seats: i64) -> bool {
    claimed_seats < max_seats
}

async fn reserve_founding_trader_seat(
    db: &sqlx::PgPool,
    max_seats: i64,
    user_id: uuid::Uuid,
) -> Result<FoundingTraderSeatReservation, CloudError> {
    // The lock decision, cleanup, cap count, and reservation all execute in one
    // PostgreSQL statement. The transaction-scoped advisory lock is therefore
    // released before the pooled connection returns. Busy callers retry without
    // occupying a connection, while the single statement keeps the cap atomic.
    for attempt in 1..=FOUNDING_TRADER_LOCK_RETRY_ATTEMPTS {
        let (acquired, existing_status, checkout_url, claimed, created): (
            bool,
            Option<String>,
            Option<String>,
            i64,
            bool,
        ) = sqlx::query_as(
            r#"
            WITH cohort_lock AS MATERIALIZED (
                SELECT pg_try_advisory_xact_lock(
                    hashtextextended('founding-trader-seats', 0)
                ) AS acquired
            ),
            released AS (
                UPDATE founding_trader_seats
                SET status = 'released', released_at = now(), updated_at = now()
                WHERE (SELECT acquired FROM cohort_lock)
                  AND status = 'reserved' AND expires_at <= now()
                RETURNING user_id
            ),
            existing AS MATERIALIZED (
                SELECT status, checkout_url
                FROM founding_trader_seats
                WHERE (SELECT acquired FROM cohort_lock)
                  AND user_id = $1 AND (
                    status = 'active'
                    OR (status IN ('reserved', 'pending_payment') AND expires_at > now())
                  )
            ),
            claimed AS MATERIALIZED (
                SELECT COUNT(*)::BIGINT AS count
                FROM founding_trader_seats
                WHERE (SELECT acquired FROM cohort_lock)
                  AND (
                    status = 'active'
                    OR (status IN ('reserved', 'pending_payment') AND expires_at > now())
                  )
            ),
            reservation AS (
                INSERT INTO founding_trader_seats
                    (user_id, status, reserved_at, expires_at, stripe_session_id,
                     checkout_url, activated_at, released_at, updated_at)
                SELECT $1, 'reserved', now(), now() + ($2 || ' minutes')::interval,
                       NULL, NULL, NULL, NULL, now()
                WHERE (SELECT acquired FROM cohort_lock)
                  AND NOT EXISTS (SELECT 1 FROM existing)
                  AND (SELECT count FROM claimed) < $3
                ON CONFLICT (user_id) DO UPDATE SET
                    status = 'reserved',
                    reserved_at = now(),
                    expires_at = now() + ($2 || ' minutes')::interval,
                    stripe_session_id = NULL,
                    checkout_url = NULL,
                    activated_at = NULL,
                    released_at = NULL,
                    updated_at = now()
                RETURNING user_id
            )
            SELECT
                (SELECT acquired FROM cohort_lock),
                (SELECT status FROM existing),
                (SELECT checkout_url FROM existing),
                (SELECT count FROM claimed),
                EXISTS(SELECT 1 FROM reservation)
            "#,
        )
        .bind(user_id)
        .bind(FOUNDING_TRADER_RESERVATION_MINUTES.to_string())
        .bind(max_seats)
        .fetch_one(db)
        .await?;

        if !acquired {
            tokio::time::sleep(std::time::Duration::from_millis(
                FOUNDING_TRADER_LOCK_RETRY_MILLIS,
            ))
            .await;
            continue;
        }
        if let Some(status) = existing_status {
            if status == "active" {
                return Err(CloudError::BadRequest(
                    "Founding Trader is already active for this account".to_string(),
                ));
            }
            if status == "pending_payment" {
                return Err(CloudError::BadRequest(
                    "Founding Trader payment is still being confirmed".to_string(),
                ));
            }
            return checkout_url
                .map(FoundingTraderSeatReservation::ExistingCheckout)
                .ok_or_else(|| {
                    CloudError::ServiceUnavailable(
                        "Founding Trader checkout is already being prepared; retry shortly"
                            .to_string(),
                    )
                });
        }
        if created {
            return Ok(FoundingTraderSeatReservation::Created);
        }
        if !founding_trader_cohort_has_capacity(claimed, max_seats) {
            return Err(CloudError::BadRequest(format!(
                "The {}-seat Founding Trader cohort is full",
                max_seats
            )));
        }
        tracing::warn!(attempt, "founding cohort reservation returned no decision");
    }

    Err(CloudError::ServiceUnavailable(
        "Founding Trader checkout is busy; retry shortly".to_string(),
    ))
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

    let user: (Option<String>, Option<String>, String) =
        sqlx::query_as("SELECT email, stripe_customer_id, tier FROM users WHERE id = $1")
            .bind(claims.sub)
            .fetch_optional(&state.db)
            .await?
            .ok_or(CloudError::NotFound("user not found".to_string()))?;

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

    let existing_subscription: Option<(String, String)> = sqlx::query_as(
        r#"
        SELECT tier, status
        FROM stripe_subscriptions
        WHERE user_id = $1
          AND status NOT IN ('canceled', 'incomplete_expired')
        ORDER BY updated_at DESC
        LIMIT 1
        "#,
    )
    .bind(claims.sub)
    .fetch_optional(&state.db)
    .await?;
    if let Some((tier, status)) = existing_subscription {
        return Err(CloudError::BadRequest(format!(
            "An existing {tier} subscription is {status}; manage it in the Stripe billing portal"
        )));
    }
    if user.2 != "free" {
        return Err(CloudError::BadRequest(
            "A paid plan is already active; manage it in the Stripe billing portal".to_string(),
        ));
    }

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

    // Leave payment methods Dashboard-managed so Stripe can present eligible
    // cards, wallets, local methods, and approved stablecoin rails dynamically.
    let form = subscription_checkout_form(
        &state,
        claims.sub,
        &req.tier,
        price_id,
        user.0.as_deref(),
        user.1.as_deref(),
        founding_trader_checkout,
    );

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
        // Stripe error payloads can echo customer or payment context. Keep
        // operational logs useful without retaining that response body.
        tracing::warn!(%status, "Stripe subscription checkout could not be created");
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

/// Determine a tier only from a server-configured Stripe price. Event metadata
/// is useful for locating the price, but never grants an entitlement by itself.
fn tier_from_price_id(event: &serde_json::Value, state: &AppState) -> Option<&'static str> {
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
) -> Option<&'static str> {
    let price_id = price_id_from_event(event).unwrap_or("");

    if let Some(unlimited_price) = unlimited_price {
        if price_id == unlimited_price {
            return Some("unlimited");
        }
    }
    if let Some(private_agent_price) = private_agent_price {
        if price_id == private_agent_price {
            return Some("private_agent");
        }
    }
    if let Some(founding_trader_price) = founding_trader_price {
        if price_id == founding_trader_price {
            return Some("founding_trader");
        }
    }
    if let Some(pro_price) = pro_price {
        if price_id == pro_price {
            return Some("pro");
        }
    }
    None
}

fn price_id_from_event(event: &serde_json::Value) -> Option<&str> {
    event["data"]["object"]["line_items"]["data"][0]["price"]["id"]
        .as_str()
        .or_else(|| event["data"]["object"]["items"]["data"][0]["price"]["id"].as_str())
        .or_else(|| event["data"]["object"]["lines"]["data"][0]["price"]["id"].as_str())
        .or_else(|| {
            event["data"]["object"]["lines"]["data"][0]["pricing"]["price_details"]["price"]
                .as_str()
        })
        .or_else(|| event["data"]["object"]["metadata"]["price_id"].as_str())
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
    db: &mut sqlx::PgConnection,
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
    .execute(&mut *db)
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
        .execute(&mut *db)
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

fn subscription_id_from_event(event: &serde_json::Value) -> Option<&str> {
    let object = &event["data"]["object"];
    if event["type"]
        .as_str()
        .is_some_and(|event_type| event_type.starts_with("customer.subscription."))
    {
        return object["id"].as_str();
    }
    object["subscription"]
        .as_str()
        .or_else(|| object["parent"]["subscription_details"]["subscription"].as_str())
}

fn event_created(event: &serde_json::Value) -> i64 {
    event["created"].as_i64().unwrap_or(0)
}

pub(crate) fn stripe_key_livemode(stripe_key: &str) -> Option<bool> {
    if stripe_key.starts_with("sk_live_") || stripe_key.starts_with("rk_live_") {
        Some(true)
    } else if stripe_key.starts_with("sk_test_") || stripe_key.starts_with("rk_test_") {
        Some(false)
    } else {
        None
    }
}

fn unix_timestamp(value: &serde_json::Value) -> Option<chrono::DateTime<chrono::Utc>> {
    value
        .as_i64()
        .and_then(|timestamp| chrono::DateTime::from_timestamp(timestamp, 0))
}

#[cfg(test)]
fn subscription_event_is_newer(
    existing_created: i64,
    existing_id: &str,
    incoming_created: i64,
    incoming_id: &str,
) -> bool {
    incoming_created > existing_created
        || (incoming_created == existing_created && incoming_id > existing_id)
}

async fn activate_founding_trader_seat_on(
    db: &mut sqlx::PgConnection,
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
    .execute(&mut *db)
    .await?;
    Ok(())
}

#[cfg(test)]
async fn activate_founding_trader_seat(
    db: &sqlx::PgPool,
    user_id: uuid::Uuid,
    stripe_session_id: Option<&str>,
) -> Result<(), CloudError> {
    let mut connection = db.acquire().await?;
    activate_founding_trader_seat_on(&mut connection, user_id, stripe_session_id).await
}

async fn release_founding_trader_seat_on(
    db: &mut sqlx::PgConnection,
    user_id: uuid::Uuid,
) -> Result<(), CloudError> {
    sqlx::query(
        r#"
        UPDATE founding_trader_seats
        SET status = 'released', released_at = now(), expires_at = NULL, updated_at = now()
        WHERE user_id = $1 AND status <> 'released'
        "#,
    )
    .bind(user_id)
    .execute(&mut *db)
    .await?;
    Ok(())
}

#[cfg(test)]
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

async fn mark_founding_trader_payment_pending(
    db: &mut sqlx::PgConnection,
    user_id: uuid::Uuid,
    stripe_session_id: &str,
) -> Result<(), CloudError> {
    sqlx::query(
        r#"
        UPDATE founding_trader_seats
        SET status = 'pending_payment',
            stripe_session_id = $2,
            expires_at = now() + interval '7 days',
            updated_at = now()
        WHERE user_id = $1 AND status IN ('reserved', 'pending_payment')
        "#,
    )
    .bind(user_id)
    .bind(stripe_session_id)
    .execute(&mut *db)
    .await?;
    Ok(())
}

async fn resolve_subscription_user_id(
    db: &mut sqlx::PgConnection,
    event: &serde_json::Value,
    subscription_id: &str,
    customer_id: &str,
) -> Result<Option<uuid::Uuid>, CloudError> {
    if let Some(user_id) = subscription_event_user_id(event) {
        let existing_customer: Option<Option<String>> =
            sqlx::query_scalar("SELECT stripe_customer_id FROM users WHERE id = $1")
                .bind(user_id)
                .fetch_optional(&mut *db)
                .await?;
        let Some(existing_customer) = existing_customer else {
            return Err(CloudError::BadRequest(
                "Stripe subscription references an unknown Ghola user".to_string(),
            ));
        };
        if let Some(existing_customer) = existing_customer {
            if !customer_id.is_empty() && existing_customer != customer_id {
                return Err(CloudError::BadRequest(
                    "Stripe customer does not match the Ghola billing identity".to_string(),
                ));
            }
        }
        if !customer_id.is_empty() {
            let customer_owner: Option<uuid::Uuid> = sqlx::query_scalar(
                "SELECT id FROM users WHERE stripe_customer_id = $1 AND id <> $2 LIMIT 1",
            )
            .bind(customer_id)
            .bind(user_id)
            .fetch_optional(&mut *db)
            .await?;
            if customer_owner.is_some() {
                return Err(CloudError::BadRequest(
                    "Stripe customer is already linked to another Ghola account".to_string(),
                ));
            }
        }
        return Ok(Some(user_id));
    }

    if !subscription_id.is_empty() {
        if let Some(user_id) = sqlx::query_scalar(
            "SELECT user_id FROM stripe_subscriptions WHERE stripe_subscription_id = $1",
        )
        .bind(subscription_id)
        .fetch_optional(&mut *db)
        .await?
        {
            return Ok(Some(user_id));
        }
    }

    if customer_id.is_empty() {
        return Ok(None);
    }
    Ok(
        sqlx::query_scalar("SELECT id FROM users WHERE stripe_customer_id = $1")
            .bind(customer_id)
            .fetch_optional(&mut *db)
            .await?,
    )
}

async fn reconcile_user_subscription_entitlement(
    db: &mut sqlx::PgConnection,
    user_id: uuid::Uuid,
) -> Result<(), CloudError> {
    let active = sqlx::query_as::<_, (String, String, String)>(
        r#"
        SELECT tier, stripe_subscription_id, status
        FROM stripe_subscriptions
        WHERE user_id = $1 AND status IN ('active', 'trialing')
        ORDER BY CASE tier
            WHEN 'unlimited' THEN 4
            WHEN 'founding_trader' THEN 3
            WHEN 'private_agent' THEN 2
            WHEN 'pro' THEN 1
            ELSE 0
        END DESC, updated_at DESC
        LIMIT 1
        "#,
    )
    .bind(user_id)
    .fetch_optional(&mut *db)
    .await?;

    let (tier, subscription_id, subscription_status) = match active {
        Some((tier, subscription_id, status)) => (tier, Some(subscription_id), Some(status)),
        None => {
            // A failed payment must revoke the paid entitlement, but it must not
            // erase the recovery state the Settings UI needs to direct the user
            // back to Stripe. Terminal states such as canceled intentionally do
            // not linger as an attention banner.
            let attention_required = sqlx::query_as::<_, (String, String)>(
                r#"
                SELECT stripe_subscription_id, status
                FROM stripe_subscriptions
                WHERE user_id = $1 AND status IN ('past_due', 'unpaid', 'incomplete')
                ORDER BY updated_at DESC
                LIMIT 1
                "#,
            )
            .bind(user_id)
            .fetch_optional(&mut *db)
            .await?;
            match attention_required {
                Some((subscription_id, status)) => {
                    ("free".to_string(), Some(subscription_id), Some(status))
                }
                None => ("free".to_string(), None, None),
            }
        }
    };
    sqlx::query(
        r#"
        UPDATE users
        SET tier = $2,
            stripe_subscription_id = $3,
            stripe_subscription_status = $4,
            updated_at = now()
        WHERE id = $1
        "#,
    )
    .bind(user_id)
    .bind(&tier)
    .bind(subscription_id)
    .bind(subscription_status)
    .execute(&mut *db)
    .await?;

    let founding_active: bool = sqlx::query_scalar(
        r#"
        SELECT EXISTS(
            SELECT 1 FROM stripe_subscriptions
            WHERE user_id = $1
              AND tier = 'founding_trader'
              AND status IN ('active', 'trialing')
        )
        "#,
    )
    .bind(user_id)
    .fetch_one(&mut *db)
    .await?;
    if founding_active {
        activate_founding_trader_seat_on(db, user_id, None).await?;
    } else {
        release_founding_trader_seat_on(db, user_id).await?;
    }
    Ok(())
}

async fn sync_subscription_from_event(
    db: &mut sqlx::PgConnection,
    event: &serde_json::Value,
    state: &AppState,
    forced_status: Option<&str>,
) -> Result<Option<uuid::Uuid>, CloudError> {
    let Some(subscription_id) = subscription_id_from_event(event) else {
        tracing::warn!(
            event_type = event["type"].as_str().unwrap_or(""),
            "Stripe event is missing a subscription ID"
        );
        return Ok(None);
    };
    let object = &event["data"]["object"];
    let existing = sqlx::query_as::<_, (uuid::Uuid, String, String, String)>(
        r#"
        SELECT user_id, stripe_customer_id, stripe_price_id, tier
        FROM stripe_subscriptions WHERE stripe_subscription_id = $1
        "#,
    )
    .bind(subscription_id)
    .fetch_optional(&mut *db)
    .await?;
    let customer_id = object["customer"]
        .as_str()
        .filter(|value| !value.is_empty())
        .or_else(|| existing.as_ref().map(|row| row.1.as_str()))
        .unwrap_or("");
    let user_id =
        match resolve_subscription_user_id(db, event, subscription_id, customer_id).await? {
            Some(user_id) => user_id,
            None => {
                tracing::warn!(
                    subscription_id,
                    "Stripe subscription is not mapped to a Ghola user"
                );
                return Ok(None);
            }
        };

    let tier = tier_from_price_id(event, state)
        .map(str::to_string)
        .or_else(|| existing.as_ref().map(|row| row.3.clone()));
    let price_id = price_id_from_event(event)
        .map(str::to_string)
        .or_else(|| existing.as_ref().map(|row| row.2.clone()));
    let (Some(tier), Some(price_id)) = (tier, price_id) else {
        tracing::info!(
            subscription_id,
            "ignoring Stripe subscription for an unconfigured price"
        );
        return Ok(None);
    };
    let status = forced_status
        .or_else(|| object["status"].as_str())
        .unwrap_or("incomplete");
    let event_id = event["id"].as_str().unwrap_or("");
    let created = event_created(event);
    let current_period_end = unix_timestamp(&object["current_period_end"]);
    let cancel_at_period_end = object["cancel_at_period_end"].as_bool().unwrap_or(false);

    let updated = sqlx::query(
        r#"
        INSERT INTO stripe_subscriptions
            (stripe_subscription_id, user_id, stripe_customer_id, stripe_price_id,
             tier, status, current_period_end, cancel_at_period_end,
             last_event_created, last_event_id, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
        ON CONFLICT (stripe_subscription_id) DO UPDATE SET
            user_id = EXCLUDED.user_id,
            stripe_customer_id = EXCLUDED.stripe_customer_id,
            stripe_price_id = EXCLUDED.stripe_price_id,
            tier = EXCLUDED.tier,
            status = EXCLUDED.status,
            current_period_end = COALESCE(EXCLUDED.current_period_end,
                                          stripe_subscriptions.current_period_end),
            cancel_at_period_end = EXCLUDED.cancel_at_period_end,
            last_event_created = EXCLUDED.last_event_created,
            last_event_id = EXCLUDED.last_event_id,
            updated_at = now()
        WHERE EXCLUDED.last_event_created > stripe_subscriptions.last_event_created
           OR (EXCLUDED.last_event_created = stripe_subscriptions.last_event_created
               AND EXCLUDED.last_event_id > stripe_subscriptions.last_event_id)
        "#,
    )
    .bind(subscription_id)
    .bind(user_id)
    .bind(customer_id)
    .bind(price_id)
    .bind(&tier)
    .bind(status)
    .bind(current_period_end)
    .bind(cancel_at_period_end)
    .bind(created)
    .bind(event_id)
    .execute(&mut *db)
    .await?;

    if updated.rows_affected() == 0 {
        tracing::info!(
            subscription_id,
            event_id,
            "stale Stripe subscription event ignored"
        );
        return Ok(Some(user_id));
    }
    sqlx::query(
        r#"
        UPDATE users
        SET stripe_customer_id = COALESCE(stripe_customer_id, NULLIF($2, '')),
            updated_at = now()
        WHERE id = $1
        "#,
    )
    .bind(user_id)
    .bind(customer_id)
    .execute(&mut *db)
    .await?;
    reconcile_user_subscription_entitlement(db, user_id).await?;
    Ok(Some(user_id))
}

async fn update_subscription_payment_status(
    db: &mut sqlx::PgConnection,
    event: &serde_json::Value,
    status: &str,
) -> Result<Option<uuid::Uuid>, CloudError> {
    let Some(subscription_id) = subscription_id_from_event(event) else {
        return Ok(None);
    };
    let event_id = event["id"].as_str().unwrap_or("");
    let created = event_created(event);
    let updated_user: Option<uuid::Uuid> = sqlx::query_scalar(
        r#"
        UPDATE stripe_subscriptions
        SET status = $2,
            last_event_created = $3,
            last_event_id = $4,
            updated_at = now()
        WHERE stripe_subscription_id = $1
          AND (last_event_created < $3 OR (last_event_created = $3 AND last_event_id < $4))
        RETURNING user_id
        "#,
    )
    .bind(subscription_id)
    .bind(status)
    .bind(created)
    .bind(event_id)
    .fetch_optional(&mut *db)
    .await?;
    if let Some(user_id) = updated_user {
        reconcile_user_subscription_entitlement(db, user_id).await?;
        return Ok(Some(user_id));
    }
    Ok(None)
}

async fn founding_trader_cohort_status_for(
    state: &AppState,
) -> Result<FoundingTraderCohortStatus, CloudError> {
    let claimed_seats: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)::BIGINT
        FROM founding_trader_seats
        WHERE status = 'active'
           OR (status IN ('reserved', 'pending_payment') AND expires_at > now())
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

    let event_id = event["id"]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or(CloudError::BadRequest(
            "Stripe webhook event is missing an ID".to_string(),
        ))?;
    let event_type = event["type"]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or(CloudError::BadRequest(
            "Stripe webhook event is missing a type".to_string(),
        ))?;
    let created = event["created"].as_i64().ok_or(CloudError::BadRequest(
        "Stripe webhook event is missing its creation time".to_string(),
    ))?;
    let livemode = event["livemode"].as_bool().unwrap_or(false);
    if let Some(expected_livemode) = state
        .config
        .stripe_secret_key
        .as_deref()
        .and_then(stripe_key_livemode)
    {
        if livemode != expected_livemode {
            return Err(CloudError::BadRequest(
                "Stripe webhook mode does not match the configured Stripe account".to_string(),
            ));
        }
    }
    let object_id = event["data"]["object"]["id"].as_str();

    let mut tx = state.db.begin().await?;
    let inserted = sqlx::query(
        r#"
        INSERT INTO stripe_webhook_events
            (stripe_event_id, event_type, event_created, livemode, object_id)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (stripe_event_id) DO NOTHING
        "#,
    )
    .bind(event_id)
    .bind(event_type)
    .bind(created)
    .bind(livemode)
    .bind(object_id)
    .execute(&mut *tx)
    .await?;
    if inserted.rows_affected() == 0 {
        tx.commit().await?;
        tracing::debug!(event_id, event_type, "duplicate Stripe event acknowledged");
        return Ok(Json(serde_json::json!({ "ok": true, "duplicate": true })));
    }

    {
        let db = &mut *tx;
        match event_type {
            "checkout.session.completed" | "checkout.session.async_payment_succeeded" => {
                let payment_status = event["data"]["object"]["payment_status"]
                    .as_str()
                    .unwrap_or("");
                let paid = event_type == "checkout.session.async_payment_succeeded"
                    || matches!(payment_status, "paid" | "no_payment_required");
                if event["data"]["object"]["metadata"]["ghola_kind"].as_str()
                    == Some("private_balance_top_up")
                {
                    if paid {
                        mark_private_balance_top_up_paid(&event, db).await?;
                    } else {
                        tracing::info!(
                            event_id,
                            payment_status,
                            "private-balance Checkout is awaiting payment"
                        );
                    }
                } else if paid {
                    if let Some(user_id) =
                        sync_subscription_from_event(db, &event, &state, Some("active")).await?
                    {
                        if tier_from_price_id(&event, &state) == Some("founding_trader") {
                            activate_founding_trader_seat_on(
                                db,
                                user_id,
                                event["data"]["object"]["id"].as_str(),
                            )
                            .await?;
                        }
                        tracing::info!(%user_id, event_id, "subscription Checkout activated");
                    }
                } else if let (Some(user_id), Some(session_id)) = (
                    subscription_event_user_id(&event),
                    event["data"]["object"]["id"].as_str(),
                ) {
                    if tier_from_price_id(&event, &state) == Some("founding_trader") {
                        mark_founding_trader_payment_pending(db, user_id, session_id).await?;
                    }
                    tracing::info!(%user_id, payment_status, "subscription Checkout is awaiting payment");
                }
            }
            "checkout.session.async_payment_failed" | "checkout.session.expired" => {
                let stripe_session_id = event["data"]["object"]["id"].as_str().unwrap_or("");
                sqlx::query(
                    r#"
                    UPDATE founding_trader_seats
                    SET status = 'released', released_at = now(), expires_at = NULL, updated_at = now()
                    WHERE stripe_session_id = $1 AND status IN ('reserved', 'pending_payment')
                    "#,
                )
                .bind(stripe_session_id)
                .execute(&mut *db)
                .await?;
                tracing::info!(
                    stripe_session_id,
                    event_type,
                    "founding Checkout seat released"
                );
            }
            "customer.subscription.created"
            | "customer.subscription.updated"
            | "customer.subscription.resumed"
            | "customer.subscription.paused"
            | "customer.subscription.deleted" => {
                let forced_status = if event_type == "customer.subscription.deleted" {
                    Some("canceled")
                } else if event_type == "customer.subscription.paused" {
                    Some("paused")
                } else {
                    None
                };
                sync_subscription_from_event(db, &event, &state, forced_status).await?;
            }
            "invoice.paid" | "invoice.payment_succeeded" => {
                if let Some(user_id) =
                    update_subscription_payment_status(db, &event, "active").await?
                {
                    tracing::info!(%user_id, event_id, "subscription payment restored entitlement");
                }
            }
            "invoice.payment_failed"
            | "invoice.payment_action_required"
            | "invoice.finalization_failed" => {
                if let Some(user_id) =
                    update_subscription_payment_status(db, &event, "past_due").await?
                {
                    tracing::warn!(%user_id, event_id, event_type, "subscription payment needs attention; opening trades disabled");
                }
            }
            _ => tracing::debug!(event_type, "unhandled Stripe event"),
        }
    }

    sqlx::query("UPDATE stripe_webhook_events SET processed_at = now() WHERE stripe_event_id = $1")
        .bind(event_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    Ok(Json(serde_json::json!({ "ok": true, "duplicate": false })))
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
    let row = sqlx::query_as::<_, (String, Option<String>, Option<String>)>(
        "SELECT tier, stripe_customer_id, stripe_subscription_status FROM users WHERE id = $1",
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
        subscription_status: row.2,
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

    fn test_config(database_url: String) -> crate::config::CloudConfig {
        crate::config::CloudConfig {
            bind_addr: "127.0.0.1:0".parse().expect("test address"),
            database_url,
            jwt_secret: "billing-test-jwt".to_string(),
            bland_api_key: None,
            bland_webhook_url: None,
            claude_api_key: None,
            google_client_id: None,
            google_client_secret: None,
            apple_client_id: None,
            gmail_client_id: None,
            gmail_client_secret: None,
            stripe_secret_key: Some("sk_test_redacted".to_string()),
            stripe_webhook_secret: Some("whsec_billing_regression".to_string()),
            stripe_price_pro: Some("price_pro".to_string()),
            stripe_price_private_agent: Some("price_private".to_string()),
            stripe_price_founding_trader: Some("price_founding".to_string()),
            founding_trader_max_seats: 100,
            stripe_price_unlimited: Some("price_unlimited".to_string()),
            stripe_automatic_tax_enabled: false,
            stripe_tax_id_collection_enabled: true,
            stripe_adaptive_pricing_enabled: true,
            stripe_payment_method_configuration: Some("pmc_international".to_string()),
            base_url: "https://ghola.test".to_string(),
            encryption_key: [0u8; 32],
            telegram_bot_token: None,
            solana_rpc_url: "https://api.devnet.solana.com".to_string(),
            groq_api_key: None,
            cerebras_api_key: None,
            google_gemini_api_key: None,
            openrouter_api_key: None,
            relay_url: "http://localhost:8080".to_string(),
            platform_wallet_address: None,
            treasury_mnemonic: None,
            min_provider_reputation: 0.3,
            max_escrow_age_secs: 300,
            provider_payout_interval_secs: 3600,
        }
    }

    fn signed_headers(body: &str, secret: &str) -> HeaderMap {
        let timestamp = chrono::Utc::now().timestamp();
        let signed_payload = format!("{timestamp}.{body}");
        let signature = hmac_sha256(secret.as_bytes(), signed_payload.as_bytes());
        let signature_hex: String = signature.iter().map(|byte| format!("{byte:02x}")).collect();
        let mut headers = HeaderMap::new();
        headers.insert(
            "stripe-signature",
            format!("t={timestamp},v1={signature_hex}")
                .parse()
                .expect("valid signature header"),
        );
        headers
    }

    async fn deliver_test_event(state: &AppState, event: serde_json::Value) -> serde_json::Value {
        let body = event.to_string();
        let secret = state
            .config
            .stripe_webhook_secret
            .as_deref()
            .expect("test webhook secret");
        billing_webhook(State(state.clone()), signed_headers(&body, secret), body)
            .await
            .expect("signed billing event should process")
            .0
    }

    #[test]
    fn metadata_without_a_configured_price_cannot_grant_a_tier() {
        let event = serde_json::json!({
            "data": { "object": { "metadata": { "ghola_tier": "founding_trader" } } }
        });
        assert_eq!(
            tier_from_configured_price(&event, None, None, None, None),
            None
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
            Some("founding_trader")
        );
    }

    #[tokio::test]
    async fn checkout_reuses_customer_and_enables_dashboard_managed_international_options() {
        let config = test_config("postgres://unused".to_string());
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://unused")
            .expect("lazy test pool");
        let state = AppState::new(config, pool);
        let user_id = uuid::Uuid::new_v4();
        let user_id_string = user_id.to_string();
        let form = subscription_checkout_form(
            &state,
            user_id,
            "founding_trader",
            "price_founding",
            Some("founder@example.test"),
            Some("cus_existing"),
            true,
        );
        let value = |key: &str| {
            form.iter()
                .find_map(|(candidate, value)| (*candidate == key).then_some(value.as_str()))
        };
        assert_eq!(value("customer"), Some("cus_existing"));
        assert_eq!(value("customer_email"), None);
        assert_eq!(value("adaptive_pricing[enabled]"), Some("true"));
        assert_eq!(value("tax_id_collection[enabled]"), Some("true"));
        assert_eq!(value("automatic_tax[enabled]"), None);
        assert_eq!(
            value("payment_method_configuration"),
            Some("pmc_international")
        );
        assert_eq!(value("payment_method_types[]"), None);
        assert_eq!(value("client_reference_id"), Some(user_id_string.as_str()));
    }

    #[test]
    fn later_subscription_events_win_and_stale_events_are_rejected() {
        assert!(subscription_event_is_newer(10, "evt_a", 11, "evt_b"));
        assert!(subscription_event_is_newer(10, "evt_a", 10, "evt_b"));
        assert!(!subscription_event_is_newer(11, "evt_b", 10, "evt_z"));
        assert!(!subscription_event_is_newer(10, "evt_b", 10, "evt_a"));
    }

    #[test]
    fn stripe_key_mode_is_bound_to_webhook_mode() {
        assert_eq!(stripe_key_livemode("sk_test_example"), Some(false));
        assert_eq!(stripe_key_livemode("rk_test_example"), Some(false));
        assert_eq!(stripe_key_livemode("sk_live_example"), Some(true));
        assert_eq!(stripe_key_livemode("rk_live_example"), Some(true));
        assert_eq!(stripe_key_livemode("not-a-stripe-key"), None);
    }

    #[test]
    fn stripe_signatures_reject_tampering_and_replays() {
        let payload = r#"{"id":"evt_signature_regression"}"#;
        let secret = "whsec_signature_regression";
        let valid_headers = signed_headers(payload, secret);
        let valid_signature = valid_headers
            .get("stripe-signature")
            .and_then(|value| value.to_str().ok())
            .expect("signed header should be valid UTF-8");
        assert!(verify_stripe_signature(payload, valid_signature, secret).is_ok());
        assert!(verify_stripe_signature("{}", valid_signature, secret).is_err());

        let stale_timestamp = chrono::Utc::now().timestamp() - 301;
        let stale_payload = format!("{stale_timestamp}.{payload}");
        let stale_signature = hmac_sha256(secret.as_bytes(), stale_payload.as_bytes());
        let stale_signature_hex: String = stale_signature
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        assert!(verify_stripe_signature(
            payload,
            &format!("t={stale_timestamp},v1={stale_signature_hex}"),
            secret,
        )
        .is_err());
    }

    #[test]
    fn founding_trader_cohort_closes_at_its_atomic_cap() {
        assert!(founding_trader_cohort_has_capacity(0, 10));
        assert!(founding_trader_cohort_has_capacity(9, 10));
        assert!(!founding_trader_cohort_has_capacity(10, 10));
        assert!(!founding_trader_cohort_has_capacity(11, 10));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn founding_trader_reservations_do_not_oversubscribe_ten_seat_cohort() {
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
        let mut user_ids = Vec::with_capacity(11);
        for index in 0..11 {
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
            WHERE status = 'active'
               OR (status IN ('reserved', 'pending_payment') AND expires_at > now())
            "#,
        )
        .fetch_one(&pool)
        .await
        .expect("baseline seat count should load");
        let max_seats = baseline + 10;

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
        assert_eq!(created, 10);
        assert_eq!(rejected, 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn new_email_user_keeps_one_identity_through_founding_trader_activation() {
        let Ok(database_url) = ghola_assistant_types::env_compat(
            "GHOLA_BILLING_E2E_DATABASE_URL",
            "THUMPER_BILLING_E2E_DATABASE_URL",
        ) else {
            eprintln!("skipping new-user billing e2e: GHOLA_BILLING_E2E_DATABASE_URL is not set");
            return;
        };
        let pool = crate::db::create_pool(&database_url)
            .await
            .expect("new-user billing e2e database should connect");
        crate::db::run_migrations(&pool)
            .await
            .expect("new-user billing e2e migrations should apply");
        let mut config = test_config(database_url);
        config.founding_trader_max_seats = 10;
        let state = AppState::new(config, pool.clone());

        let run_id = uuid::Uuid::new_v4();
        let email = format!("new-founding-user-{run_id}@example.invalid");
        let password = "test-only-password-2026";
        let signup = crate::routes::auth::email_sign_up(
            State(state.clone()),
            Json(crate::routes::auth::EmailSignUpRequest {
                email: email.clone(),
                password: password.to_string(),
                display_name: Some("New Founding Trader".to_string()),
            }),
        )
        .await
        .expect("new email signup should succeed")
        .0;
        assert!(signup.is_new_user);
        let signup_claims = crate::auth::verify_jwt(&signup.token, &state.config.jwt_secret)
            .expect("signup token should verify");
        assert_eq!(signup_claims.sub, signup.user_id);
        assert_eq!(signup_claims.email.as_deref(), Some(email.as_str()));
        assert_eq!(signup_claims.tier, "free");

        let before = billing_status(
            State(state.clone()),
            crate::auth::AuthUser(signup_claims.clone()),
        )
        .await
        .expect("free billing status should load")
        .0;
        assert_eq!(before.tier, "free");
        assert_eq!(before.founding_trader_cohort.capacity, 10);
        assert_eq!(before.founding_trader_cohort.claimed_seats, 0);
        assert_eq!(before.founding_trader_cohort.remaining_seats, 10);

        let customer_id = format!("cus_new_founding_{run_id}");
        let subscription_id = format!("sub_new_founding_{run_id}");
        let checkout_event = serde_json::json!({
            "id": format!("evt_new_founding_{run_id}"),
            "type": "checkout.session.completed",
            "created": chrono::Utc::now().timestamp(),
            "livemode": false,
            "data": { "object": {
                "id": format!("cs_new_founding_{run_id}"),
                "customer": customer_id,
                "subscription": subscription_id,
                "client_reference_id": signup.user_id,
                "payment_status": "paid",
                "metadata": {
                    "ghola_kind": "subscription",
                    "ghola_tier": "founding_trader",
                    "user_id": signup.user_id,
                    "price_id": "price_founding"
                }
            }}
        });
        let delivered = deliver_test_event(&state, checkout_event).await;
        assert_eq!(delivered["duplicate"], false);

        let entitled = billing_status(State(state.clone()), crate::auth::AuthUser(signup_claims))
            .await
            .expect("paid billing status should load for the signup identity")
            .0;
        assert_eq!(entitled.tier, "founding_trader");
        assert_eq!(entitled.subscription_status.as_deref(), Some("active"));
        assert_eq!(entitled.founding_trader_cohort.claimed_seats, 1);
        assert_eq!(entitled.founding_trader_cohort.remaining_seats, 9);
        assert!(entitled.founding_trader_cohort.checkout_open);

        let signin = crate::routes::auth::email_sign_in(
            State(state.clone()),
            Json(crate::routes::auth::EmailSignInRequest {
                email,
                password: password.to_string(),
            }),
        )
        .await
        .expect("the paid user should sign in again")
        .0;
        assert!(!signin.is_new_user);
        assert_eq!(signin.user_id, signup.user_id);
        let signin_claims = crate::auth::verify_jwt(&signin.token, &state.config.jwt_secret)
            .expect("signin token should verify");
        assert_eq!(signin_claims.sub, signup.user_id);
        assert_eq!(signin_claims.tier, "founding_trader");

        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(signup.user_id)
            .execute(&pool)
            .await
            .expect("new-user billing test should clean up");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn signed_webhooks_are_idempotent_ordered_and_restore_paid_entitlements() {
        let Ok(database_url) = ghola_assistant_types::env_compat(
            "GHOLA_BILLING_E2E_DATABASE_URL",
            "THUMPER_BILLING_E2E_DATABASE_URL",
        ) else {
            eprintln!("skipping billing webhook e2e: GHOLA_BILLING_E2E_DATABASE_URL is not set");
            return;
        };
        let pool = crate::db::create_pool(&database_url)
            .await
            .expect("billing e2e database should connect");
        crate::db::run_migrations(&pool)
            .await
            .expect("billing e2e migrations should apply");
        let state = AppState::new(test_config(database_url), pool.clone());

        let run_id = uuid::Uuid::new_v4();
        let user_id: uuid::Uuid =
            sqlx::query_scalar("INSERT INTO users (email) VALUES ($1) RETURNING id")
                .bind(format!("billing-webhook-{run_id}@example.invalid"))
                .fetch_one(&pool)
                .await
                .expect("billing webhook test user should be created");
        let customer_id = format!("cus_{run_id}");
        let founding_subscription_id = format!("sub_founding_{run_id}");
        let pro_subscription_id = format!("sub_pro_{run_id}");
        let event_prefix = format!("evt_{run_id}");
        let created = chrono::Utc::now().timestamp();

        let checkout_event = serde_json::json!({
            "id": format!("{event_prefix}_checkout"),
            "type": "checkout.session.completed",
            "created": created,
            "livemode": false,
            "data": { "object": {
                "id": format!("cs_{run_id}"),
                "customer": customer_id,
                "subscription": founding_subscription_id,
                "client_reference_id": user_id,
                "payment_status": "paid",
                "metadata": {
                    "ghola_kind": "subscription",
                    "ghola_tier": "founding_trader",
                    "user_id": user_id,
                    "price_id": "price_founding"
                }
            }}
        });
        let first = deliver_test_event(&state, checkout_event.clone()).await;
        assert_eq!(first["duplicate"], false);
        let duplicate = deliver_test_event(&state, checkout_event).await;
        assert_eq!(duplicate["duplicate"], true);
        let (tier, subscription_status): (String, Option<String>) =
            sqlx::query_as("SELECT tier, stripe_subscription_status FROM users WHERE id = $1")
                .bind(user_id)
                .fetch_one(&pool)
                .await
                .expect("activated billing identity should load");
        assert_eq!(tier, "founding_trader");
        assert_eq!(subscription_status.as_deref(), Some("active"));

        let failed = serde_json::json!({
            "id": format!("{event_prefix}_failed"),
            "type": "invoice.payment_failed",
            "created": created + 2,
            "livemode": false,
            "data": { "object": {
                "id": format!("in_failed_{run_id}"),
                "customer": customer_id,
                "subscription": founding_subscription_id
            }}
        });
        deliver_test_event(&state, failed).await;
        let (tier, subscription_status): (String, Option<String>) =
            sqlx::query_as("SELECT tier, stripe_subscription_status FROM users WHERE id = $1")
                .bind(user_id)
                .fetch_one(&pool)
                .await
                .expect("failed-payment state should load");
        assert_eq!(tier, "free");
        assert_eq!(subscription_status.as_deref(), Some("past_due"));
        let seat_status: String =
            sqlx::query_scalar("SELECT status FROM founding_trader_seats WHERE user_id = $1")
                .bind(user_id)
                .fetch_one(&pool)
                .await
                .expect("failed-payment seat state should load");
        assert_eq!(seat_status, "released");

        let paid = serde_json::json!({
            "id": format!("{event_prefix}_paid"),
            "type": "invoice.paid",
            "created": created + 3,
            "livemode": false,
            "data": { "object": {
                "id": format!("in_paid_{run_id}"),
                "customer": customer_id,
                "subscription": founding_subscription_id,
                "paid": true
            }}
        });
        deliver_test_event(&state, paid).await;
        let (tier, subscription_status): (String, Option<String>) =
            sqlx::query_as("SELECT tier, stripe_subscription_status FROM users WHERE id = $1")
                .bind(user_id)
                .fetch_one(&pool)
                .await
                .expect("renewed subscription state should load");
        assert_eq!(tier, "founding_trader");
        assert_eq!(subscription_status.as_deref(), Some("active"));
        let seat_status: String =
            sqlx::query_scalar("SELECT status FROM founding_trader_seats WHERE user_id = $1")
                .bind(user_id)
                .fetch_one(&pool)
                .await
                .expect("renewed seat state should load");
        assert_eq!(seat_status, "active");

        let stale_cancel = serde_json::json!({
            "id": format!("{event_prefix}_stale_cancel"),
            "type": "customer.subscription.deleted",
            "created": created + 1,
            "livemode": false,
            "data": { "object": {
                "id": founding_subscription_id,
                "customer": customer_id,
                "status": "canceled",
                "metadata": { "user_id": user_id, "price_id": "price_founding" },
                "items": { "data": [{ "price": { "id": "price_founding" } }] }
            }}
        });
        deliver_test_event(&state, stale_cancel).await;
        let tier: String = sqlx::query_scalar("SELECT tier FROM users WHERE id = $1")
            .bind(user_id)
            .fetch_one(&pool)
            .await
            .expect("stale-event tier should load");
        assert_eq!(tier, "founding_trader");

        let pro_created = serde_json::json!({
            "id": format!("{event_prefix}_pro_created"),
            "type": "customer.subscription.created",
            "created": created + 4,
            "livemode": false,
            "data": { "object": {
                "id": pro_subscription_id,
                "customer": customer_id,
                "status": "active",
                "metadata": { "user_id": user_id, "price_id": "price_pro" },
                "items": { "data": [{ "price": { "id": "price_pro" } }] }
            }}
        });
        deliver_test_event(&state, pro_created).await;

        let founding_cancel = serde_json::json!({
            "id": format!("{event_prefix}_founding_cancel"),
            "type": "customer.subscription.deleted",
            "created": created + 5,
            "livemode": false,
            "data": { "object": {
                "id": founding_subscription_id,
                "customer": customer_id,
                "status": "canceled",
                "metadata": { "user_id": user_id, "price_id": "price_founding" },
                "items": { "data": [{ "price": { "id": "price_founding" } }] }
            }}
        });
        deliver_test_event(&state, founding_cancel).await;
        let tier: String = sqlx::query_scalar("SELECT tier FROM users WHERE id = $1")
            .bind(user_id)
            .fetch_one(&pool)
            .await
            .expect("remaining-subscription tier should load");
        assert_eq!(tier, "pro");

        let pro_cancel = serde_json::json!({
            "id": format!("{event_prefix}_pro_cancel"),
            "type": "customer.subscription.deleted",
            "created": created + 6,
            "livemode": false,
            "data": { "object": {
                "id": pro_subscription_id,
                "customer": customer_id,
                "status": "canceled",
                "metadata": { "user_id": user_id, "price_id": "price_pro" },
                "items": { "data": [{ "price": { "id": "price_pro" } }] }
            }}
        });
        deliver_test_event(&state, pro_cancel).await;
        let tier: String = sqlx::query_scalar("SELECT tier FROM users WHERE id = $1")
            .bind(user_id)
            .fetch_one(&pool)
            .await
            .expect("cancelled tier should load");
        assert_eq!(tier, "free");

        let mismatched_customer_event_id = format!("{event_prefix}_mismatched_customer");
        let mismatched_customer = serde_json::json!({
            "id": mismatched_customer_event_id,
            "type": "customer.subscription.created",
            "created": created + 7,
            "livemode": false,
            "data": { "object": {
                "id": format!("sub_mismatched_{run_id}"),
                "customer": format!("cus_other_{run_id}"),
                "status": "active",
                "metadata": { "user_id": user_id, "price_id": "price_founding" },
                "items": { "data": [{ "price": { "id": "price_founding" } }] }
            }}
        });
        let mismatched_body = mismatched_customer.to_string();
        let secret = state
            .config
            .stripe_webhook_secret
            .as_deref()
            .expect("test webhook secret");
        let mismatch_result = billing_webhook(
            State(state.clone()),
            signed_headers(&mismatched_body, secret),
            mismatched_body,
        )
        .await;
        assert!(matches!(mismatch_result, Err(CloudError::BadRequest(_))));
        let mismatch_persisted: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM stripe_webhook_events WHERE stripe_event_id = $1)",
        )
        .bind(&mismatched_customer_event_id)
        .fetch_one(&pool)
        .await
        .expect("mismatched event ledger state should load");
        assert!(!mismatch_persisted);

        let processed_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*)::BIGINT FROM stripe_webhook_events WHERE stripe_event_id LIKE $1",
        )
        .bind(format!("{event_prefix}%"))
        .fetch_one(&pool)
        .await
        .expect("processed-event count should load");
        assert_eq!(processed_count, 7);

        sqlx::query("DELETE FROM stripe_webhook_events WHERE stripe_event_id LIKE $1")
            .bind(format!("{event_prefix}%"))
            .execute(&pool)
            .await
            .expect("test webhook events should be cleaned up");
        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user_id)
            .execute(&pool)
            .await
            .expect("billing webhook test user should be cleaned up");
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
