use std::sync::Arc;

use axum::extract::State;
use axum::http::HeaderMap;
use axum::Extension;
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::auth::Claims;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

// ---------------------------------------------------------------------------
// POST /v1/billing/webhook (public)
// ---------------------------------------------------------------------------

pub async fn webhook(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: String,
) -> AppResult<Json<serde_json::Value>> {
    tracing::info!("Billing webhook received: {} bytes", body.len());

    // Verify Stripe signature if webhook secret is configured
    if let Some(ref webhook_secret) = state.config.stripe_webhook_secret {
        if let Some(sig_header) = headers.get("Stripe-Signature").and_then(|v| v.to_str().ok()) {
            if !verify_stripe_signature(sig_header, &body, webhook_secret) {
                tracing::warn!("Invalid Stripe webhook signature");
                return Err(AppError::Unauthorized("Invalid webhook signature".into()));
            }
        }
    }

    // Parse event
    let event: serde_json::Value = serde_json::from_str(&body)
        .map_err(|_| AppError::BadRequest("Invalid JSON".into()))?;

    let event_type = event
        .get("type")
        .and_then(|t| t.as_str())
        .unwrap_or("unknown");

    match event_type {
        "checkout.session.completed" => {
            if let Some(session) = event.get("data").and_then(|d| d.get("object")) {
                let user_id = session
                    .get("metadata")
                    .and_then(|m| m.get("user_id"))
                    .and_then(|u| u.as_str());
                let product = session
                    .get("metadata")
                    .and_then(|m| m.get("product"))
                    .and_then(|p| p.as_str());

                if let (Some(user_id), Some(product)) = (user_id, product) {
                    tracing::info!("Checkout completed: user={user_id} product={product}");
                    handle_checkout_completed(&state, user_id, product).await;
                }
            }
        }
        "invoice.paid" => {
            tracing::info!("Invoice paid event received");
        }
        "invoice.payment_failed" => {
            tracing::warn!("Invoice payment failed event received");
        }
        _ => {
            tracing::debug!("Unhandled webhook event type: {event_type}");
        }
    }

    Ok(Json(serde_json::json!({ "received": true })))
}

async fn handle_checkout_completed(state: &AppState, user_id: &str, product: &str) {
    let uid = match user_id.parse::<uuid::Uuid>() {
        Ok(u) => u,
        Err(_) => return,
    };

    match product {
        "verified_badge" => {
            // Get user's business profile and create a badge
            let profile: Option<(uuid::Uuid,)> =
                sqlx::query_as("SELECT id FROM business_profiles WHERE user_id = $1")
                    .bind(uid)
                    .fetch_optional(&state.db)
                    .await
                    .ok()
                    .flatten();

            if let Some((profile_id,)) = profile {
                let _ = sqlx::query(
                    "INSERT INTO verified_badges (profile_id, verified_by) VALUES ($1, 'stripe_purchase')",
                )
                .bind(profile_id)
                .execute(&state.db)
                .await;
            }
        }
        "domain_verification" => {
            tracing::info!("Domain verification purchased for user {user_id}");
        }
        _ => {
            tracing::debug!("Unknown product: {product}");
        }
    }
}

fn verify_stripe_signature(sig_header: &str, payload: &str, secret: &str) -> bool {
    // Parse t= and v1= from signature header
    let mut timestamp = None;
    let mut signature = None;

    for part in sig_header.split(',') {
        let part = part.trim();
        if let Some(t) = part.strip_prefix("t=") {
            timestamp = Some(t);
        } else if let Some(v) = part.strip_prefix("v1=") {
            signature = Some(v);
        }
    }

    let (timestamp, expected_sig) = match (timestamp, signature) {
        (Some(t), Some(s)) => (t, s),
        _ => return false,
    };

    // Compute expected signature: HMAC-SHA256(secret, "timestamp.payload")
    use hmac::{Hmac, Mac};
    use sha2::Sha256;

    type HmacSha256 = Hmac<Sha256>;
    let signed_payload = format!("{timestamp}.{payload}");

    let mut mac = match HmacSha256::new_from_slice(secret.as_bytes()) {
        Ok(m) => m,
        Err(_) => return false,
    };
    mac.update(signed_payload.as_bytes());

    let computed = hex::encode(mac.finalize().into_bytes());
    computed == expected_sig
}

// ---------------------------------------------------------------------------
// POST /v1/billing/create-checkout (protected)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct CreateCheckoutBody {
    pub product: String,
}

#[derive(Debug, Serialize)]
pub struct CheckoutResponse {
    #[serde(rename = "checkout_url")]
    pub url: String,
}

pub async fn create_checkout(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Json(body): Json<CreateCheckoutBody>,
) -> AppResult<Json<CheckoutResponse>> {
    let stripe_key = state
        .config
        .stripe_secret_key
        .as_ref()
        .ok_or_else(|| AppError::Internal("Stripe not configured".into()))?;

    let user_id: uuid::Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Internal("Invalid user ID in token".into()))?;

    // Validate product
    let (product_name, amount_cents) = match body.product.as_str() {
        "verified_badge" => ("Ghola Verified Badge (1 year)", 9900u64),
        "domain_verification" => ("Ghola Domain Verification", 2900u64),
        _ => return Err(AppError::BadRequest("Invalid product. Use 'verified_badge' or 'domain_verification'".into())),
    };

    // Get or create Stripe customer
    let customer_id = get_or_create_stripe_customer(&state, stripe_key, user_id, &claims.email).await?;

    // Create checkout session
    let params = [
        ("mode", "payment"),
        ("customer", &customer_id),
        ("success_url", &format!("{}/identity/dashboard?billing=success", state.config.base_url)),
        ("cancel_url", &format!("{}/identity/dashboard?billing=cancel", state.config.base_url)),
        ("metadata[user_id]", &user_id.to_string()),
        ("metadata[product]", &body.product),
        ("line_items[0][price_data][currency]", "usd"),
        ("line_items[0][price_data][product_data][name]", product_name),
        ("line_items[0][price_data][unit_amount]", &amount_cents.to_string()),
        ("line_items[0][quantity]", "1"),
    ];

    let resp = state
        .http_client
        .post("https://api.stripe.com/v1/checkout/sessions")
        .header("Authorization", format!("Bearer {stripe_key}"))
        .form(&params)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("Stripe API error: {e}")))?;

    let resp_json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("Stripe response parse error: {e}")))?;

    let checkout_url = resp_json
        .get("url")
        .and_then(|u| u.as_str())
        .ok_or_else(|| {
            let err = resp_json.get("error").and_then(|e| e.get("message")).and_then(|m| m.as_str());
            AppError::Internal(format!("Stripe checkout failed: {}", err.unwrap_or("unknown error")))
        })?;

    Ok(Json(CheckoutResponse {
        url: checkout_url.to_string(),
    }))
}

async fn get_or_create_stripe_customer(
    state: &AppState,
    stripe_key: &str,
    user_id: uuid::Uuid,
    email: &str,
) -> AppResult<String> {
    // Check if user already has a Stripe customer ID
    let existing: Option<(Option<String>,)> = sqlx::query_as(
        "SELECT stripe_customer_id FROM users WHERE id = $1",
    )
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?;

    if let Some((Some(customer_id),)) = existing {
        if !customer_id.is_empty() {
            return Ok(customer_id);
        }
    }

    // Create new Stripe customer
    let resp = state
        .http_client
        .post("https://api.stripe.com/v1/customers")
        .header("Authorization", format!("Bearer {stripe_key}"))
        .form(&[("email", email)])
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("Stripe customer creation error: {e}")))?;

    let resp_json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("Stripe response parse error: {e}")))?;

    let customer_id = resp_json
        .get("id")
        .and_then(|id| id.as_str())
        .ok_or_else(|| AppError::Internal("Failed to create Stripe customer".into()))?
        .to_string();

    // Store customer ID
    sqlx::query("UPDATE users SET stripe_customer_id = $1 WHERE id = $2")
        .bind(&customer_id)
        .bind(user_id)
        .execute(&state.db)
        .await?;

    Ok(customer_id)
}

// ---------------------------------------------------------------------------
// GET /v1/billing/status (protected)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Clone, Copy)]
pub struct TierLimits {
    pub resolve_per_day: u64,
    pub profiles: u64,
    pub analytics: bool,
}

#[derive(Debug, Serialize)]
pub struct DailyUsage {
    pub api_calls_today: u64,
    pub limit: u64,
}

#[derive(Debug, Serialize)]
pub struct BillingStatus {
    pub tier: String,
    pub stripe_customer_id: Option<String>,
    pub expires_at: Option<String>,
    pub limits: TierLimits,
    pub usage: DailyUsage,
}

pub async fn status(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
) -> AppResult<Json<BillingStatus>> {
    let user_id: uuid::Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Internal("Invalid user ID in token".into()))?;

    let row: Option<(String, Option<String>, Option<chrono::DateTime<chrono::Utc>>)> = sqlx::query_as(
        "SELECT subscription_tier::text, stripe_customer_id, subscription_expires_at FROM users WHERE id = $1",
    )
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?;

    let (tier, stripe_customer_id, expires_at) = row.unwrap_or_else(|| {
        ("free".to_string(), None, None)
    });

    let limits = match tier.as_str() {
        "consumer_pro" => TierLimits { resolve_per_day: 10_000, profiles: 5, analytics: true },
        "business" => TierLimits { resolve_per_day: 50_000, profiles: 20, analytics: true },
        "enterprise" => TierLimits { resolve_per_day: u64::MAX, profiles: 100, analytics: true },
        _ => TierLimits { resolve_per_day: 1_000, profiles: 1, analytics: false },
    };

    // Get in-memory usage count
    let mem_usage = state.usage_meter.get_count(&user_id.to_string());

    // Get already-flushed usage from DB
    let db_usage: Option<(i64,)> = sqlx::query_as(
        "SELECT COALESCE(SUM(count), 0)::bigint FROM usage_records WHERE user_id = $1 AND period_start = CURRENT_DATE",
    )
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?;

    let total_usage = mem_usage + db_usage.map(|(c,)| c as u64).unwrap_or(0);

    Ok(Json(BillingStatus {
        tier,
        stripe_customer_id,
        expires_at: expires_at.map(|e| e.to_rfc3339()),
        limits,
        usage: DailyUsage {
            api_calls_today: total_usage,
            limit: limits.resolve_per_day,
        },
    }))
}

// ---------------------------------------------------------------------------
// GET /v1/billing/portal (protected)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct PortalResponse {
    #[serde(rename = "portal_url")]
    pub url: String,
}

pub async fn portal(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
) -> AppResult<Json<PortalResponse>> {
    let stripe_key = state
        .config
        .stripe_secret_key
        .as_ref()
        .ok_or_else(|| AppError::Internal("Stripe not configured".into()))?;

    let user_id: uuid::Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Internal("Invalid user ID in token".into()))?;

    // Get user's Stripe customer ID
    let row: Option<(Option<String>,)> = sqlx::query_as(
        "SELECT stripe_customer_id FROM users WHERE id = $1",
    )
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?;

    let customer_id = row
        .and_then(|(c,)| c)
        .ok_or_else(|| AppError::BadRequest("No billing account found. Please make a purchase first.".into()))?;

    let resp = state
        .http_client
        .post("https://api.stripe.com/v1/billing_portal/sessions")
        .header("Authorization", format!("Bearer {stripe_key}"))
        .form(&[
            ("customer", customer_id.as_str()),
            ("return_url", &format!("{}/identity/dashboard", state.config.base_url)),
        ])
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("Stripe API error: {e}")))?;

    let resp_json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("Stripe response parse error: {e}")))?;

    let portal_url = resp_json
        .get("url")
        .and_then(|u| u.as_str())
        .ok_or_else(|| AppError::Internal("Failed to create billing portal session".into()))?;

    Ok(Json(PortalResponse {
        url: portal_url.to_string(),
    }))
}
