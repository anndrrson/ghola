use std::env;
use std::net::SocketAddr;
use std::sync::Arc;

use axum::{
    extract::DefaultBodyLimit,
    http::{HeaderName, Method, StatusCode},
    middleware,
    routing::{any, get},
    Router,
};
use sqlx::postgres::PgPoolOptions;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;

mod auth_inject;
mod config;
mod ip_rate_limit;
mod meter;
mod proxy;
mod route_cache;
mod state;
mod x402_challenge;
mod x402_verify;

use config::Config;
use route_cache::RouteCache;
use state::AppState;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("ghola_gateway=debug,tower_http=info")),
        )
        .init();

    let config = Config::from_env();

    let db = PgPoolOptions::new()
        .max_connections(20)
        .connect(&config.database_url)
        .await?;
    tracing::info!("Gateway connected to database");

    let http = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .pool_max_idle_per_host(32)
        .build()?;

    let vault =
        said_turnkey::vault_from_env().map_err(|e| anyhow::anyhow!("vault init failed: {e}"))?;
    tracing::info!(backend = vault.backend_name(), "Vault initialized");

    let cache = Arc::new(RouteCache::new(config.route_cache_ttl_secs));

    let state = Arc::new(AppState {
        db,
        config: config.clone(),
        http,
        vault,
        cache,
        ip_rate_limiter: Arc::new(ip_rate_limit::IpRateLimiter::new()),
    });

    let origins: Vec<_> = config
        .allowed_origins
        .split(',')
        .filter_map(|s| s.trim().parse().ok())
        .collect();

    // Production safety checks. In prod, refuse to start with insecure
    // settings. ALLOW_INSECURE_STARTUP=1 bypasses (with a loud warning).
    let issues = startup_issues(
        &config,
        origins.len(),
        is_production_env(),
        insecure_startup_override_enabled(),
    );
    if !issues.is_empty() {
        for issue in &issues {
            tracing::error!(%issue, "fail-closed startup guard");
        }
        return Err(anyhow::anyhow!(
            "refusing to start in production with insecure config: {} issue(s)",
            issues.len()
        ));
    }

    if origins.is_empty() {
        return Err(anyhow::anyhow!(
            "ALLOWED_ORIGINS produced zero valid origins; refusing wildcard CORS"
        ));
    }

    let cors = CorsLayer::new()
        .allow_origin(origins)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::DELETE,
            Method::PATCH,
            Method::OPTIONS,
            Method::HEAD,
        ])
        .allow_headers([
            HeaderName::from_static("content-type"),
            HeaderName::from_static("authorization"),
            HeaderName::from_static("x-payment"),
            HeaderName::from_static("x402-payment"),
            HeaderName::from_static("x-payment-signature"),
            HeaderName::from_static("x-agent-did"),
        ])
        .expose_headers([
            HeaderName::from_static("x-payment-refund"),
            HeaderName::from_static("x-ghola-refund-reason"),
            HeaderName::from_static("x-ghola-trace-id"),
            HeaderName::from_static("x-ghola-merchant"),
            HeaderName::from_static("x-ghola-circuit"),
        ]);

    let app = Router::new()
        .route("/health", get(health))
        // Nested paths on a merchant. Wildcard cannot match empty, so we need
        // both routes below for `curl gateway/m/alpha` and `gateway/m/alpha/`.
        .route("/m/{slug}/{*upstream_path}", any(proxy::proxy_handler))
        .route("/m/{slug}", any(proxy::proxy_root_handler))
        .route("/m/{slug}/", any(proxy::proxy_root_handler))
        .layer(DefaultBodyLimit::max(config.max_request_body_bytes))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            ip_rate_limit::ip_rate_limit,
        ))
        .with_state(state)
        .layer(cors)
        .layer(TraceLayer::new_for_http());

    let addr: SocketAddr = config.bind_addr.parse()?;
    tracing::info!(%addr, "ghola-gateway listening");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;
    Ok(())
}

async fn health() -> (StatusCode, &'static str) {
    (StatusCode::OK, "ok")
}

/// Production-only fail-closed startup guards. Returns a list of fatal
/// configuration problems; an empty list means "safe to start".
fn startup_issues(
    config: &Config,
    allowed_origin_count: usize,
    is_production: bool,
    allow_insecure_override: bool,
) -> Vec<String> {
    if !is_production {
        return Vec::new();
    }
    if allow_insecure_override {
        tracing::warn!(
            "ALLOW_INSECURE_STARTUP=true set in production; bypassing fail-closed startup guards"
        );
        return Vec::new();
    }

    let mut issues = Vec::new();
    if config.allow_unverified_xpayment {
        issues.push("ALLOW_UNVERIFIED_XPAYMENT must be false".to_string());
    }
    if config.escrow_wallet_address.is_none() {
        issues.push("ESCROW_WALLET_ADDRESS is required in production".to_string());
    }
    if allowed_origin_count == 0 {
        issues.push("ALLOWED_ORIGINS parsed to an empty set".to_string());
    }
    if config.accepted_mints.is_empty() {
        issues.push("ACCEPTED_STABLECOINS produced zero accepted mints".to_string());
    }
    issues
}

fn is_production_env() -> bool {
    let raw = env::var("APP_ENV")
        .or_else(|_| env::var("RUST_ENV"))
        .or_else(|_| env::var("ENVIRONMENT"))
        .unwrap_or_default();
    matches!(raw.trim().to_ascii_lowercase().as_str(), "prod" | "production")
}

fn insecure_startup_override_enabled() -> bool {
    env::var("ALLOW_INSECURE_STARTUP")
        .ok()
        .map(|v| matches!(v.as_str(), "1" | "true" | "TRUE" | "yes" | "YES"))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::startup_issues;
    use crate::config::{AcceptedMint, Config};

    fn base_config() -> Config {
        Config {
            database_url: "postgres://example".into(),
            bind_addr: "0.0.0.0:8090".into(),
            platform_fee_bps: 300,
            route_cache_ttl_secs: 30,
            upstream_timeout_secs: 30,
            circuit_failure_threshold: 3,
            circuit_open_secs: 60,
            allow_unverified_xpayment: false,
            solana_rpc_url: "https://api.mainnet-beta.solana.com".into(),
            escrow_wallet_address: Some("dummy-wallet".into()),
            x402_max_tx_age_secs: 600,
            x402_verify_timeout_secs: 8,
            rate_limit_per_minute: 120,
            rate_limit_max_keys: 50_000,
            max_request_body_bytes: 10 * 1024 * 1024,
            allowed_origins: "https://example.com".into(),
            trust_proxy_headers: false,
            accepted_mints: vec![AcceptedMint {
                symbol: "USDT".into(),
                mint_b58: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB".into(),
                decimals: 6,
                paused: false,
            }],
            primary_mint_symbol: "USDT".into(),
        }
    }

    #[test]
    fn dev_mode_never_blocks_startup() {
        let mut cfg = base_config();
        cfg.allow_unverified_xpayment = true;
        cfg.escrow_wallet_address = None;
        let issues = startup_issues(&cfg, 0, false, false);
        assert!(issues.is_empty());
    }

    #[test]
    fn production_has_no_issues_when_config_is_strong() {
        let cfg = base_config();
        let issues = startup_issues(&cfg, 1, true, false);
        assert!(issues.is_empty());
    }

    #[test]
    fn production_reports_critical_gateway_issues() {
        let mut cfg = base_config();
        cfg.allow_unverified_xpayment = true;
        cfg.escrow_wallet_address = None;
        let issues = startup_issues(&cfg, 0, true, false);
        // unverified-xpayment, missing escrow, zero origins
        assert_eq!(issues.len(), 3);
    }

    #[test]
    fn production_flags_empty_accepted_mints() {
        let mut cfg = base_config();
        cfg.accepted_mints.clear();
        let issues = startup_issues(&cfg, 1, true, false);
        assert_eq!(issues, vec!["ACCEPTED_STABLECOINS produced zero accepted mints".to_string()]);
    }

    #[test]
    fn override_bypasses_production_guards() {
        let mut cfg = base_config();
        cfg.allow_unverified_xpayment = true;
        cfg.escrow_wallet_address = None;
        let issues = startup_issues(&cfg, 0, true, true);
        assert!(issues.is_empty());
    }

    #[test]
    fn production_reports_only_active_issues() {
        // Strong config but no allowed origins: only the origin issue fires.
        let cfg = base_config();
        let issues = startup_issues(&cfg, 0, true, false);
        assert_eq!(issues, vec!["ALLOWED_ORIGINS parsed to an empty set".to_string()]);
    }
}
