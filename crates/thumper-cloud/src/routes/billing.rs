use axum::extract::State;
use axum::http::HeaderMap;
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::auth::AuthUser;
use crate::error::CloudError;
use crate::state::AppState;

#[derive(Deserialize)]
pub struct CreateCheckoutRequest {
    pub tier: String, // "pro" or "unlimited"
}

#[derive(Serialize)]
pub struct CheckoutResponse {
    pub checkout_url: String,
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
    let stripe_key = state.config.stripe_secret_key.as_deref()
        .ok_or(CloudError::ServiceUnavailable("billing not configured".to_string()))?;

    let price_id = match req.tier.as_str() {
        "pro" => state.config.stripe_price_pro.as_deref()
            .ok_or(CloudError::ServiceUnavailable("pro price not configured".to_string()))?,
        "unlimited" => state.config.stripe_price_unlimited.as_deref()
            .ok_or(CloudError::ServiceUnavailable("unlimited price not configured".to_string()))?,
        _ => return Err(CloudError::BadRequest("tier must be 'pro' or 'unlimited'".to_string())),
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
        ("success_url", format!("{}/billing/success", state.config.base_url)),
        ("cancel_url", format!("{}/billing/cancel", state.config.base_url)),
        ("client_reference_id", claims.sub.to_string()),
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

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| CloudError::Internal(format!("stripe response parse failed: {e}")))?;

    let checkout_url = body["url"]
        .as_str()
        .ok_or(CloudError::Internal("no checkout URL in Stripe response".to_string()))?
        .to_string();

    Ok(Json(CheckoutResponse { checkout_url }))
}

/// Verify Stripe webhook signature (HMAC-SHA256).
fn verify_stripe_signature(payload: &str, sig_header: &str, secret: &str) -> Result<(), CloudError> {
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

    let timestamp = timestamp
        .ok_or(CloudError::BadRequest("missing timestamp in Stripe signature".to_string()))?;

    if signatures.is_empty() {
        return Err(CloudError::BadRequest("missing v1 signature in Stripe header".to_string()));
    }

    // Reject if timestamp is older than 5 minutes (replay protection)
    if let Ok(ts) = timestamp.parse::<i64>() {
        let now = chrono::Utc::now().timestamp();
        if (now - ts).abs() > 300 {
            return Err(CloudError::BadRequest("Stripe webhook timestamp too old".to_string()));
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
        return Err(CloudError::BadRequest("invalid Stripe webhook signature".to_string()));
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
    if let Some(ref pro_price) = state.config.stripe_price_pro {
        if price_id == pro_price {
            return "pro";
        }
    }

    // Fallback: check amount if price ID not available
    let amount = event["data"]["object"]["amount_total"].as_i64().unwrap_or(0);
    if amount >= 2999 {
        "unlimited"
    } else {
        "pro"
    }
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
        .ok_or(CloudError::BadRequest("missing Stripe-Signature header".to_string()))?;
    verify_stripe_signature(&body, sig_header, webhook_secret)?;

    let event: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| CloudError::BadRequest(format!("invalid JSON: {e}")))?;

    let event_type = event["type"].as_str().unwrap_or("");

    match event_type {
        "checkout.session.completed" => {
            let user_id_str = event["data"]["object"]["client_reference_id"]
                .as_str()
                .unwrap_or("");
            let customer_id = event["data"]["object"]["customer"]
                .as_str()
                .unwrap_or("");

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
            let customer_id = event["data"]["object"]["customer"]
                .as_str()
                .unwrap_or("");

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
