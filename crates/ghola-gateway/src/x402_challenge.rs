//! x402 HTTP 402 challenge response builder.
//!
//! When a paid route is hit without a verified payment, the gateway responds
//! with HTTP 402 and a body that tells the agent exactly what it needs to pay
//! and where.

use axum::http::Request;
use serde::Serialize;

use crate::config::Config;
use crate::route_cache::ResolvedRoute;

const DEFAULT_MAX_TIMEOUT_SECS: u32 = 60;

#[derive(Debug, Serialize)]
pub struct PaymentRequirement {
    pub scheme: &'static str,
    pub network: String,
    #[serde(rename = "maxAmountRequired")]
    pub max_amount_required: String,
    pub resource: String,
    pub description: String,
    #[serde(rename = "mimeType")]
    pub mime_type: &'static str,
    #[serde(rename = "payTo")]
    pub pay_to: String,
    #[serde(rename = "maxTimeoutSeconds")]
    pub max_timeout_seconds: u32,
    /// Base58 SPL mint address.
    pub asset: String,
    /// Stablecoin symbol (e.g. "USDT"). Convenience field for clients that
    /// don't want to dictionary-lookup mint→symbol.
    #[serde(rename = "currencySymbol")]
    pub currency_symbol: String,
    /// On-chain decimals for `asset`. Both USDT and USDC are 6 today, but
    /// emitting it explicitly future-proofs against new tokens.
    pub decimals: u8,
    pub extra: serde_json::Value,
}

#[derive(Debug, Serialize)]
pub struct PaymentRequiredBody {
    #[serde(rename = "x402Version")]
    pub version: u32,
    pub accepts: Vec<PaymentRequirement>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Build a 402 challenge body for paid routes.
///
/// Emits one `PaymentRequirement` per non-paused accepted stablecoin, with
/// the platform's primary mint listed first. Agents SHOULD pay with the
/// first entry they can satisfy. Returns `None` when ESCROW_WALLET_ADDRESS
/// is missing or no mints are accepted.
pub fn build_challenge(
    config: &Config,
    route: &ResolvedRoute,
    resource_url: String,
    error_reason: Option<&str>,
) -> Option<PaymentRequiredBody> {
    let pay_to = config.escrow_wallet_address.clone()?;
    let network = network_for_rpc(&config.solana_rpc_url);

    // Order: primary first, then everything else. Skip paused mints entirely
    // so an ops-driven pause cleanly removes a token from the challenge.
    let mut sorted: Vec<&crate::config::AcceptedMint> = config
        .accepted_mints
        .iter()
        .filter(|m| !m.paused)
        .collect();
    sorted.sort_by_key(|m| {
        if m.symbol.eq_ignore_ascii_case(&config.primary_mint_symbol) {
            0
        } else {
            1
        }
    });
    if sorted.is_empty() {
        return None;
    }

    let accepts = sorted
        .into_iter()
        .map(|m| PaymentRequirement {
            scheme: "exact",
            network: network.clone(),
            max_amount_required: route.price_micro_usdc.to_string(),
            resource: resource_url.clone(),
            description: format!("Ghola merchant: {}", route.slug),
            mime_type: "application/json",
            pay_to: pay_to.clone(),
            max_timeout_seconds: DEFAULT_MAX_TIMEOUT_SECS,
            asset: m.mint_b58.clone(),
            currency_symbol: m.symbol.clone(),
            decimals: m.decimals,
            extra: serde_json::json!({
                "merchant_slug": route.slug,
                "platform_fee_bps": route.platform_fee_bps,
            }),
        })
        .collect();

    Some(PaymentRequiredBody {
        version: 1,
        accepts,
        error: error_reason.map(str::to_string),
    })
}

/// Reconstruct the public URL for the x402 `resource` field.
pub fn resource_url_from_request<B>(req: &Request<B>, trust_proxy_headers: bool) -> String {
    let scheme = if trust_proxy_headers {
        req.headers()
            .get("x-forwarded-proto")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.split(',').next().unwrap_or(s).trim())
            .filter(|s| !s.is_empty())
            .unwrap_or("https")
            .to_string()
    } else {
        "https".to_string()
    };

    let host = req
        .headers()
        .get("host")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
        .or_else(|| req.uri().host().map(str::to_string))
        .unwrap_or_else(|| "gateway.ghola.xyz".to_string());

    let path_and_query = req
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_else(|| req.uri().path().to_string());

    format!("{scheme}://{host}{path_and_query}")
}

fn network_for_rpc(rpc_url: &str) -> String {
    if rpc_url.contains("devnet") {
        "solana:devnet".to_string()
    } else {
        "solana:mainnet".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AcceptedMint;
    use crate::route_cache::ResolvedRoute;
    use said_turnkey::AuthMode;
    use uuid::Uuid;

    const USDC_MINT_MAINNET_B58: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const USDC_MINT_DEVNET_B58: &str = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
    const USDT_MINT_MAINNET_B58: &str = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

    fn test_mints(devnet: bool) -> Vec<AcceptedMint> {
        vec![
            AcceptedMint {
                symbol: "USDT".into(),
                mint_b58: if devnet { "" } else { USDT_MINT_MAINNET_B58 }.into(),
                decimals: 6,
                paused: devnet, // devnet has no canonical USDT mint, treat as paused for tests
            },
            AcceptedMint {
                symbol: "USDC".into(),
                mint_b58: if devnet {
                    USDC_MINT_DEVNET_B58
                } else {
                    USDC_MINT_MAINNET_B58
                }
                .into(),
                decimals: 6,
                paused: false,
            },
        ]
    }

    fn test_config(rpc: &str, escrow: Option<&str>) -> Config {
        let devnet = rpc.contains("devnet");
        Config {
            database_url: "postgres://test".into(),
            bind_addr: "0.0.0.0:0".into(),
            platform_fee_bps: 300,
            route_cache_ttl_secs: 30,
            upstream_timeout_secs: 30,
            circuit_failure_threshold: 3,
            circuit_open_secs: 60,
            allow_unverified_xpayment: false,
            solana_rpc_url: rpc.to_string(),
            escrow_wallet_address: escrow.map(str::to_string),
            x402_max_tx_age_secs: 600,
            x402_verify_timeout_secs: 8,
            rate_limit_per_minute: 120,
            rate_limit_max_keys: 50_000,
            max_request_body_bytes: 10 * 1024 * 1024,
            allowed_origins: "*".into(),
            trust_proxy_headers: false,
            accepted_mints: test_mints(devnet),
            primary_mint_symbol: "USDT".into(),
        }
    }

    fn test_route() -> ResolvedRoute {
        ResolvedRoute {
            service_id: Uuid::new_v4(),
            owner_id: None,
            slug: "test-merchant".into(),
            origin_url: "https://api.example.com".into(),
            auth_mode: AuthMode::None,
            auth_header_name: None,
            price_micro_usdc: 1000,
            platform_fee_bps: 300,
            proxy_enabled: true,
            circuit_breaker_open: false,
            circuit_breaker_until: None,
            vault_wallet_address: None,
            credential_backend: "none".into(),
            credential_key_version: 0,
            credential_ciphertext: vec![],
        }
    }

    #[test]
    fn challenge_omits_when_escrow_unset() {
        let config = test_config("https://api.mainnet-beta.solana.com", None);
        let route = test_route();
        assert!(build_challenge(&config, &route, "https://gateway/x".into(), None).is_none());
    }

    #[test]
    fn mainnet_challenge_lists_usdt_first_then_usdc() {
        let config = test_config(
            "https://api.mainnet-beta.solana.com",
            Some("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"),
        );
        let route = test_route();
        let body = build_challenge(&config, &route, "https://gateway/x".into(), None).unwrap();
        assert_eq!(body.version, 1);
        assert_eq!(body.accepts.len(), 2);
        assert_eq!(body.accepts[0].network, "solana:mainnet");
        assert_eq!(body.accepts[0].currency_symbol, "USDT");
        assert_eq!(body.accepts[0].asset, USDT_MINT_MAINNET_B58);
        assert_eq!(body.accepts[0].decimals, 6);
        assert_eq!(body.accepts[1].currency_symbol, "USDC");
        assert_eq!(body.accepts[1].asset, USDC_MINT_MAINNET_B58);
    }

    #[test]
    fn devnet_challenge_falls_back_to_usdc_when_usdt_unavailable() {
        // Devnet test config marks USDT paused (no canonical devnet mint).
        let config = test_config(
            "https://api.devnet.solana.com",
            Some("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"),
        );
        let route = test_route();
        let body = build_challenge(&config, &route, "https://gateway/x".into(), None).unwrap();
        assert_eq!(body.accepts.len(), 1);
        assert_eq!(body.accepts[0].network, "solana:devnet");
        assert_eq!(body.accepts[0].currency_symbol, "USDC");
        assert_eq!(body.accepts[0].asset, USDC_MINT_DEVNET_B58);
    }

    #[test]
    fn resource_url_respects_forwarded_proto_when_trusted() {
        let req = axum::http::Request::builder()
            .uri("/m/test")
            .header("host", "gateway.example.com")
            .header("x-forwarded-proto", "http")
            .body(())
            .unwrap();
        assert_eq!(
            resource_url_from_request(&req, true),
            "http://gateway.example.com/m/test"
        );
        assert_eq!(
            resource_url_from_request(&req, false),
            "https://gateway.example.com/m/test"
        );
    }
}
