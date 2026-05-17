use reqwest::Client;
use serde::Deserialize;

use crate::config::Config;
use crate::error::{AppError, AppResult};

pub struct CreditPack {
    pub label: &'static str,
    pub amount_usd_cents: i32,
    pub amount_micro_usdc: i64,
}

pub const CREDIT_PACKS: &[CreditPack] = &[
    CreditPack { label: "$5", amount_usd_cents: 500, amount_micro_usdc: 5_000_000 },
    CreditPack { label: "$10", amount_usd_cents: 1000, amount_micro_usdc: 10_000_000 },
    CreditPack { label: "$25", amount_usd_cents: 2500, amount_micro_usdc: 25_000_000 },
    CreditPack { label: "$50", amount_usd_cents: 5000, amount_micro_usdc: 50_000_000 },
];

pub fn get_pack(pack_id: &str) -> Option<&'static CreditPack> {
    CREDIT_PACKS.iter().find(|p| p.label.trim_start_matches('$') == pack_id)
}

#[derive(Debug, Deserialize)]
struct StripeSession {
    id: String,
    url: Option<String>,
}

pub async fn create_checkout_session(
    client: &Client,
    config: &Config,
    pack: &CreditPack,
    user_id: &str,
) -> AppResult<(String, String)> {
    let secret = config.stripe_secret_key.as_deref()
        .ok_or_else(|| AppError::Internal("Stripe not configured".into()))?;

    let params = [
        ("mode", "payment"),
        ("success_url", &format!("{}/account?checkout=success", config.frontend_url)),
        ("cancel_url", &format!("{}/account?checkout=cancel", config.frontend_url)),
        ("line_items[0][price_data][currency]", "usd"),
        ("line_items[0][price_data][unit_amount]", &pack.amount_usd_cents.to_string()),
        ("line_items[0][price_data][product_data][name]", &format!("Orni Credits — {}", pack.label)),
        ("line_items[0][quantity]", "1"),
        ("metadata[user_id]", user_id),
        ("metadata[amount_micro_usdc]", &pack.amount_micro_usdc.to_string()),
    ];

    let resp = client
        .post("https://api.stripe.com/v1/checkout/sessions")
        .basic_auth(secret, Option::<&str>::None)
        .form(&params)
        .send()
        .await?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::Internal(format!("Stripe error: {body}")));
    }

    let session: StripeSession = resp.json().await
        .map_err(|e| AppError::Internal(format!("Stripe parse error: {e}")))?;

    let url = session.url.ok_or_else(|| AppError::Internal("No checkout URL returned".into()))?;

    Ok((session.id, url))
}
