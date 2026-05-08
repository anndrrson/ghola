use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde::Serialize;
use sqlx::Row;
use std::sync::Arc;

use crate::state::AppState;
use crate::x402_challenge::{PaymentRequiredBody, PaymentRequirement};

const USDC_MINT_MAINNET_B58: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDC_MINT_DEVNET_B58: &str = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const DEFAULT_MAX_TIMEOUT_SECS: u32 = 60;

#[derive(Debug, Serialize)]
pub struct X402Agent {
    pub slug: String,
    pub display_name: String,
    pub description: String,
    pub price_micro_usdc: i64,
    pub payment_network: String,
    pub payment_asset: String,
    pub payment_destination: String,
}

#[derive(Debug, Serialize)]
pub struct X402AgentDetail {
    pub agent: X402Agent,
    pub payment_requirements: PaymentRequiredBody,
}

pub async fn list_agents(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<X402Agent>>, (StatusCode, Json<serde_json::Value>)> {
    let rows = sqlx::query(
        r#"
        SELECT slug, name, COALESCE(description, '') AS description, price_micro_usdc
        FROM service_listings
        WHERE proxy_enabled = true
          AND status::text IN ('active', 'pending')
        ORDER BY total_requests DESC, created_at DESC
        LIMIT 200
        "#,
    )
    .fetch_all(&state.db)
    .await
    .map_err(internal)?;

    let destination = payment_destination(&state)?;
    let network = network_for_rpc(&state.config.solana_rpc_url);
    let primary_asset = state
        .config
        .find_symbol(&state.config.primary_mint_symbol)
        .map(|m| m.mint_b58.clone())
        .unwrap_or_default();

    let out = rows
        .into_iter()
        .map(|row| X402Agent {
            slug: row.get("slug"),
            display_name: row.get::<String, _>("name"),
            description: row.get::<String, _>("description"),
            price_micro_usdc: row.get("price_micro_usdc"),
            payment_network: network.clone(),
            payment_asset: primary_asset.clone(),
            payment_destination: destination.clone(),
        })
        .collect();

    Ok(Json(out))
}

pub async fn get_agent(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
) -> Result<Json<X402AgentDetail>, (StatusCode, Json<serde_json::Value>)> {
    let row = sqlx::query(
        r#"
        SELECT slug, name, COALESCE(description, '') AS description, price_micro_usdc
        FROM service_listings
        WHERE slug = $1
          AND proxy_enabled = true
          AND status::text IN ('active', 'pending')
        LIMIT 1
        "#,
    )
    .bind(&slug)
    .fetch_optional(&state.db)
    .await
    .map_err(internal)?;

    let row = match row {
        Some(v) => v,
        None => {
            return Err((
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": "agent_not_found"})),
            ));
        }
    };

    let destination = payment_destination(&state)?;
    let network = network_for_rpc(&state.config.solana_rpc_url);
    // Discovery summary still surfaces a single (primary) mint for clients
    // that only render one asset; the per-agent detail returns the full
    // accepts-array below.
    let primary_asset = state
        .config
        .find_symbol(&state.config.primary_mint_symbol)
        .map(|m| m.mint_b58.clone())
        .unwrap_or_default();
    let price: i64 = row.get("price_micro_usdc");

    let gateway_base = std::env::var("GATEWAY_PUBLIC_BASE_URL")
        .unwrap_or_else(|_| "https://ghola-merchant-gateway.onrender.com".to_string());
    let resource = format!("{}/m/{}/", gateway_base.trim_end_matches('/'), slug);

    let agent = X402Agent {
        slug: row.get("slug"),
        display_name: row.get::<String, _>("name"),
        description: row.get::<String, _>("description"),
        price_micro_usdc: price,
        payment_network: network.clone(),
        payment_asset: primary_asset,
        payment_destination: destination.clone(),
    };

    // One accepts entry per non-paused stablecoin, primary first. Mirrors
    // `x402_challenge::build_challenge` so on-chain agents can pay the
    // discovery-level URL with whichever stablecoin they hold.
    let mut sorted: Vec<&crate::config::AcceptedMint> = state
        .config
        .accepted_mints
        .iter()
        .filter(|m| !m.paused)
        .collect();
    sorted.sort_by_key(|m| {
        if m.symbol.eq_ignore_ascii_case(&state.config.primary_mint_symbol) {
            0
        } else {
            1
        }
    });
    let accepts = sorted
        .into_iter()
        .map(|m| PaymentRequirement {
            scheme: "exact",
            network: network.clone(),
            max_amount_required: price.to_string(),
            resource: resource.clone(),
            description: format!("Ghola merchant: {}", agent.slug),
            mime_type: "application/json",
            pay_to: destination.clone(),
            max_timeout_seconds: DEFAULT_MAX_TIMEOUT_SECS,
            asset: m.mint_b58.clone(),
            currency_symbol: m.symbol.clone(),
            decimals: m.decimals,
            extra: serde_json::json!({
                "merchant_slug": agent.slug,
            }),
        })
        .collect();

    let payment_requirements = PaymentRequiredBody {
        version: 1,
        accepts,
        error: None,
    };

    Ok(Json(X402AgentDetail {
        agent,
        payment_requirements,
    }))
}

fn payment_destination(
    state: &AppState,
) -> Result<String, (StatusCode, Json<serde_json::Value>)> {
    state
        .config
        .escrow_wallet_address
        .clone()
        .ok_or_else(|| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(serde_json::json!({"error": "x402_escrow_wallet_missing"})),
            )
        })
}

fn network_for_rpc(rpc_url: &str) -> String {
    if rpc_url.contains("devnet") {
        "solana:devnet".to_string()
    } else {
        "solana:mainnet".to_string()
    }
}

fn usdc_mint_b58_for_rpc(rpc_url: &str) -> &'static str {
    if rpc_url.contains("devnet") {
        USDC_MINT_DEVNET_B58
    } else {
        USDC_MINT_MAINNET_B58
    }
}

fn internal(e: sqlx::Error) -> (StatusCode, Json<serde_json::Value>) {
    tracing::error!("x402 discovery db error: {e}");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(serde_json::json!({"error": "internal"})),
    )
}
