//! Phase 3.4: stablecoin peg monitor.
//!
//! Polls a price feed for each accepted stablecoin and emits structured
//! warnings when the price deviates from $1 by more than `DEPEG_PAUSE_BPS`
//! basis points sustained over `DEPEG_SUSTAIN_SECONDS`. **This monitor never
//! auto-pauses** — pausing is an ops-judgement call, and a noisy oracle blip
//! shouldn't take down the platform's deposit flow. Instead it logs at WARN
//! level so the alerting pipeline can page on-call, who then flips the
//! `STABLECOIN_<X>_PAUSED` env flag and restarts.
//!
//! The price feed is Coingecko's free public API by default (USDT/USDC have
//! ~1s update cadence on the simple/price endpoint). Operators with paying
//! Pyth or Chainlink integrations can override `PEG_PRICE_URL_<SYMBOL>` per
//! token to use a different source.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::state::AppState;

const COINGECKO_USDT: &str = "https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=usd";
const COINGECKO_USDC: &str = "https://api.coingecko.com/api/v3/simple/price?ids=usd-coin&vs_currencies=usd";

pub async fn peg_monitor_loop(state: Arc<AppState>) {
    let depeg_bps: u32 = std::env::var("DEPEG_PAUSE_BPS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(150);
    let sustain_secs: u64 = std::env::var("DEPEG_SUSTAIN_SECONDS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(1_800);

    let mut interval = tokio::time::interval(Duration::from_secs(300)); // 5 min
    // Per-symbol record of the first time we saw the peg breached + the most
    // recent breach. If both have been continuously breached for >= sustain,
    // we emit the WARN.
    let mut breach_state: HashMap<String, BreachWindow> = HashMap::new();

    loop {
        interval.tick().await;
        for token in &state.config.accepted_tokens {
            let url = price_url_for(&token.symbol);
            let url = match url {
                Some(u) => u,
                None => continue,
            };
            let price = match fetch_price(&state.http_client, &url, &token.symbol).await {
                Ok(p) => p,
                Err(e) => {
                    tracing::debug!(
                        symbol = %token.symbol,
                        error = %e,
                        "peg_monitor: price fetch failed (will retry)"
                    );
                    continue;
                }
            };

            let deviation_bps = ((price - 1.0).abs() * 10_000.0) as u32;
            let now = Instant::now();
            let entry = breach_state.entry(token.symbol.clone()).or_default();

            if deviation_bps >= depeg_bps {
                if entry.first_seen.is_none() {
                    entry.first_seen = Some(now);
                }
                entry.last_seen = Some(now);
                let sustained = entry
                    .first_seen
                    .map(|t| now.duration_since(t))
                    .unwrap_or_default();
                if sustained >= Duration::from_secs(sustain_secs) {
                    tracing::warn!(
                        symbol = %token.symbol,
                        price,
                        deviation_bps,
                        sustained_secs = sustained.as_secs(),
                        threshold_bps = depeg_bps,
                        "DEPEG ALERT: stablecoin peg breached. Pause via STABLECOIN_{}_PAUSED=1 if confirmed.",
                        token.symbol
                    );
                }
            } else {
                // Reset — back within tolerance.
                if entry.first_seen.is_some() {
                    tracing::info!(
                        symbol = %token.symbol,
                        price,
                        "peg_monitor: stablecoin recovered to within tolerance"
                    );
                }
                entry.first_seen = None;
                entry.last_seen = None;
            }
        }
    }
}

#[derive(Default)]
struct BreachWindow {
    first_seen: Option<Instant>,
    last_seen: Option<Instant>,
}

fn price_url_for(symbol: &str) -> Option<String> {
    let env_var = format!("PEG_PRICE_URL_{}", symbol.to_uppercase());
    if let Ok(url) = std::env::var(&env_var) {
        return Some(url);
    }
    match symbol.to_uppercase().as_str() {
        "USDT" => Some(COINGECKO_USDT.to_string()),
        "USDC" => Some(COINGECKO_USDC.to_string()),
        _ => None,
    }
}

async fn fetch_price(http: &reqwest::Client, url: &str, symbol: &str) -> anyhow::Result<f64> {
    let resp: serde_json::Value = http.get(url).send().await?.json().await?;
    // Coingecko shape: { "tether": { "usd": 1.0001 } }
    let upper = symbol.to_uppercase();
    let key: String = match upper.as_str() {
        "USDT" => "tether".into(),
        "USDC" => "usd-coin".into(),
        _ => upper.to_lowercase(),
    };
    resp.pointer(&format!("/{}/usd", key))
        .and_then(|v| v.as_f64())
        .ok_or_else(|| anyhow::anyhow!("price field missing in response"))
}
