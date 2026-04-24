//! x402 HTTP 402 challenge response builder.
//!
//! When a paid route is hit without a verified payment, the gateway responds
//! with HTTP 402 and a body that tells the agent exactly what it needs to pay
//! and where. This is the spec-compliant entry point for any x402 client to
//! discover Ghola merchant pricing without prior knowledge.
//!
//! Body shape (per https://x402.org spec, version 1):
//! ```json
//! {
//!   "x402Version": 1,
//!   "accepts": [
//!     {
//!       "scheme": "exact",
//!       "network": "solana:mainnet",
//!       "maxAmountRequired": "1000",
//!       "resource": "https://gateway.ghola.xyz/m/<slug>/<path>",
//!       "description": "Ghola merchant: <slug>",
//!       "mimeType": "application/json",
//!       "payTo": "<escrow_wallet>",
//!       "maxTimeoutSeconds": 60,
//!       "asset": "<USDC mint b58>",
//!       "extra": {
//!         "merchant_slug": "...",
//!         "platform_fee_bps": 300
//!       }
//!     }
//!   ],
//!   "error": null
//! }
//! ```

use axum::http::Request;
use serde::Serialize;

use crate::config::Config;
use crate::route_cache::ResolvedRoute;

const USDC_MINT_MAINNET_B58: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDC_MINT_DEVNET_B58: &str = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
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
    pub asset: String,
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

/// Build the spec-compliant 402 challenge body for a paid route.
///
/// Returns `None` if escrow_wallet_address is unset (gateway misconfiguration);
/// caller should fall back to a plain 503 in that case.
pub fn build_challenge(
    config: &Config,
    route: &ResolvedRoute,
    resource_url: String,
    error_reason: Option<&str>,
) -> Option<PaymentRequiredBody> {
    let pay_to = config.escrow_wallet_address.clone()?;
    let network = network_for_rpc(&config.solana_rpc_url);
    let asset = usdc_mint_b58_for_rpc(&config.solana_rpc_url).to_string();

    Some(PaymentRequiredBody {
        version: 1,
        accepts: vec![PaymentRequirement {
            scheme: "exact",
            network,
            max_amount_required: route.price_micro_usdc.to_string(),
            resource: resource_url,
            description: format!("Ghola merchant: {}", route.slug),
            mime_type: "application/json",
            pay_to,
            max_timeout_seconds: DEFAULT_MAX_TIMEOUT_SECS,
            asset,
            extra: serde_json::json!({
                "merchant_slug": route.slug,
                "platform_fee_bps": route.platform_fee_bps,
            }),
        }],
        error: error_reason.map(|s| s.to_string()),
    })
}

/// Reconstruct the public URL the agent called, for the `resource` field.
/// Uses Host + X-Forwarded-Proto when proxy headers are trusted; falls back
/// to https + request authority otherwise.
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
        .map(|s| s.to_string())
        .or_else(|| req.uri().host().map(|h| h.to_string()))
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

fn usdc_mint_b58_for_rpc(rpc_url: &str) -> &'static str {
    if rpc_url.contains("devnet") {
        USDC_MINT_DEVNET_B58
    } else {
        USDC_MINT_MAINNET_B58
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::route_cache::ResolvedRoute;
    use said_turnkey::AuthMode;
    use uuid::Uuid;

    fn test_config(rpc: &str, escrow: Option<&str>) -> Config {
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
            escrow_wallet_address: escrow.map(|s| s.to_string()),
            x402_max_tx_age_secs: 600,
            x402_verify_timeout_secs: 8,
            rate_limit_per_minute: 120,
            max_request_body_bytes: 10 * 1024 * 1024,
            allowed_origins: "*".into(),
            trust_proxy_headers: false,
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
            credential_key_ref: None,
            credential_ciphertext: vec![],
        }
    }

    #[test]
    fn challenge_omits_when_escrow_unset() {
        let config = test_config("https://api.mainnet-beta.solana.com", None);
        let route = test_route();
        let result = build_challenge(&config, &route, "https://gateway/x".into(), None);
        assert!(result.is_none());
    }

    #[test]
    fn challenge_uses_mainnet_for_mainnet_rpc() {
        let config = test_config(
            "https://api.mainnet-beta.solana.com",
            Some("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"),
        );
        let route = test_route();
        let body = build_challenge(&config, &route, "https://gateway/x".into(), None).unwrap();
        assert_eq!(body.version, 1);
        assert_eq!(body.accepts.len(), 1);
        let req = &body.accepts[0];
        assert_eq!(req.scheme, "exact");
        assert_eq!(req.network, "solana:mainnet");
        assert_eq!(req.max_amount_required, "1000");
        assert_eq!(req.asset, USDC_MINT_MAINNET_B58);
        assert_eq!(req.pay_to, "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
        assert_eq!(req.max_timeout_seconds, 60);
        assert_eq!(
            req.extra.get("merchant_slug").and_then(|v| v.as_str()),
            Some("test-merchant")
        );
        assert_eq!(
            req.extra.get("platform_fee_bps").and_then(|v| v.as_i64()),
            Some(300)
        );
    }

    #[test]
    fn challenge_uses_devnet_for_devnet_rpc() {
        let config = test_config(
            "https://api.devnet.solana.com",
            Some("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"),
        );
        let route = test_route();
        let body = build_challenge(&config, &route, "https://gateway/x".into(), None).unwrap();
        assert_eq!(body.accepts[0].network, "solana:devnet");
        assert_eq!(body.accepts[0].asset, USDC_MINT_DEVNET_B58);
    }

    #[test]
    fn challenge_carries_error_reason() {
        let config = test_config(
            "https://api.devnet.solana.com",
            Some("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"),
        );
        let route = test_route();
        let body = build_challenge(
            &config,
            &route,
            "https://gateway/x".into(),
            Some("x402_amount_too_low"),
        )
        .unwrap();
        assert_eq!(body.error.as_deref(), Some("x402_amount_too_low"));
    }

    #[test]
    fn resource_url_uses_host_header() {
        let req = axum::http::Request::builder()
            .uri("/m/test-merchant/foo?x=1")
            .header("host", "gateway.example.com")
            .body(())
            .unwrap();
        let url = resource_url_from_request(&req, false);
        assert_eq!(url, "https://gateway.example.com/m/test-merchant/foo?x=1");
    }

    #[test]
    fn resource_url_respects_forwarded_proto_when_trusted() {
        let req = axum::http::Request::builder()
            .uri("/m/test")
            .header("host", "gateway.example.com")
            .header("x-forwarded-proto", "http")
            .body(())
            .unwrap();
        let trusted = resource_url_from_request(&req, true);
        let untrusted = resource_url_from_request(&req, false);
        assert_eq!(trusted, "http://gateway.example.com/m/test");
        assert_eq!(untrusted, "https://gateway.example.com/m/test");
    }

    #[test]
    fn body_serializes_to_spec_shape() {
        let config = test_config(
            "https://api.mainnet-beta.solana.com",
            Some("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"),
        );
        let route = test_route();
        let body = build_challenge(&config, &route, "https://gw/x".into(), None).unwrap();
        let json = serde_json::to_value(&body).unwrap();
        assert_eq!(json["x402Version"], 1);
        assert!(json["accepts"].is_array());
        let accepts = &json["accepts"][0];
        assert_eq!(accepts["scheme"], "exact");
        assert_eq!(accepts["maxAmountRequired"], "1000");
        assert_eq!(accepts["mimeType"], "application/json");
        assert_eq!(accepts["payTo"], "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
        assert_eq!(accepts["maxTimeoutSeconds"], 60);
        assert!(json.get("error").is_none());
    }
}
