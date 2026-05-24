use axum::extract::State;
use axum::http::HeaderMap;
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::auth::AuthUser;
use crate::error::CloudError;
use crate::state::AppState;

#[derive(Deserialize)]
pub struct CreateCheckoutRequest {
    pub tier: String, // "pro", "private_agent", or "unlimited"
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
                CloudError::ServiceUnavailable(
                    "private agent price not configured".to_string(),
                ),
            )?,
            "unlimited" => state.config.stripe_price_unlimited.as_deref().ok_or(
                CloudError::ServiceUnavailable("unlimited price not configured".to_string()),
            )?,
            _ => {
                return Err(CloudError::BadRequest(
                    "tier must be 'pro', 'private_agent', or 'unlimited'".to_string(),
                ));
            }
        };

    // Get or create Stripe customer
    let email: Option<String> = sqlx::query_scalar("SELECT email FROM users WHERE id = $1")
        .bind(claims.sub)
        .fetch_optional(&state.db)
        .await?
        .flatten();

    let client = reqwest::Client::new();

    // Create checkout session
    let mut form = vec![
        ("mode", "subscription".to_string()),
        ("line_items[0][price]", price_id.to_string()),
        ("line_items[0][quantity]", "1".to_string()),
        (
            "success_url",
            format!("{}/settings?tab=plan&checkout=success", state.config.base_url),
        ),
        (
            "cancel_url",
            format!("{}/settings?tab=plan&checkout=cancelled", state.config.base_url),
        ),
        ("client_reference_id", claims.sub.to_string()),
        ("metadata[ghola_kind]", "subscription".to_string()),
        ("metadata[ghola_tier]", req.tier.clone()),
        ("metadata[price_id]", price_id.to_string()),
        (
            "subscription_data[metadata][ghola_tier]",
            req.tier.clone(),
        ),
        (
            "subscription_data[metadata][price_id]",
            price_id.to_string(),
        ),
    ];

    if let Some(ref email) = email {
        form.push(("customer_email", email.clone()));
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
        tracing::warn!(?body, "Stripe subscription checkout could not be created");
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

    // Reject if timestamp is older than 5 minutes (replay protection)
    if let Ok(ts) = timestamp.parse::<i64>() {
        let now = chrono::Utc::now().timestamp();
        if (now - ts).abs() > 300 {
            return Err(CloudError::BadRequest(
                "Stripe webhook timestamp too old".to_string(),
            ));
        }
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
    match event["data"]["object"]["metadata"]["ghola_tier"].as_str() {
        Some("private_agent") => return "private_agent",
        Some("unlimited") => return "unlimited",
        Some("pro") => return "pro",
        _ => {}
    }

    // Try to extract price ID from line_items or metadata
    let price_id = event["data"]["object"]["line_items"]["data"][0]["price"]["id"]
        .as_str()
        .or_else(|| event["data"]["object"]["metadata"]["price_id"].as_str())
        .unwrap_or("");

    if let Some(ref unlimited_price) = state.config.stripe_price_unlimited {
        if price_id == unlimited_price {
            return "unlimited";
        }
    }
    if let Some(ref private_agent_price) = state.config.stripe_price_private_agent {
        if price_id == private_agent_price {
            return "private_agent";
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
    if amount >= 2999 {
        "unlimited"
    } else if amount >= 1999 {
        "private_agent"
    } else {
        "pro"
    }
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

            if let Ok(user_id) = user_id_str.parse::<uuid::Uuid>() {
                // Determine tier from the checkout session's price ID
                let tier = tier_from_price_id(&event, &state);

                sqlx::query(
                    "UPDATE users SET tier = $1, stripe_customer_id = $2, updated_at = now() WHERE id = $3",
                )
                .bind(tier)
                .bind(customer_id)
                .bind(user_id)
                .execute(&state.db)
                .await?;

                tracing::info!(%user_id, tier, "subscription activated");
            }
        }
        "customer.subscription.deleted" => {
            let customer_id = event["data"]["object"]["customer"].as_str().unwrap_or("");

            sqlx::query(
                "UPDATE users SET tier = 'free', updated_at = now() WHERE stripe_customer_id = $1",
            )
            .bind(customer_id)
            .execute(&state.db)
            .await?;

            tracing::info!(customer_id, "subscription cancelled, reverted to free");
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

    Ok(Json(BillingStatusResponse {
        tier: row.0,
        stripe_customer_id: row.1,
        portal_url,
    }))
}
