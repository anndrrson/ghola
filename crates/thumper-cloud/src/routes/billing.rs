use axum::extract::State;
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

/// POST /api/billing/webhook — Stripe webhook
pub async fn billing_webhook(
    State(state): State<AppState>,
    body: String,
) -> Result<Json<serde_json::Value>, CloudError> {
    // In production, verify Stripe webhook signature
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
                // Determine tier from the subscription
                let tier = "pro"; // Default; inspect line items for actual tier

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
