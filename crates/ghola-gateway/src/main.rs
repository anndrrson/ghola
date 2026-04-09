use std::net::SocketAddr;
use std::sync::Arc;

use axum::{
    http::{HeaderName, Method, StatusCode},
    routing::{any, get},
    Router,
};
use sqlx::postgres::PgPoolOptions;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;

mod auth_inject;
mod config;
mod meter;
mod proxy;
mod route_cache;
mod state;

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

    let vault = said_turnkey::vault_from_env()
        .map_err(|e| anyhow::anyhow!("vault init failed: {e}"))?;
    tracing::info!(backend = vault.backend_name(), "Vault initialized");

    let cache = Arc::new(RouteCache::new(config.route_cache_ttl_secs));

    let state = Arc::new(AppState {
        db,
        config: config.clone(),
        http,
        vault,
        cache,
    });

    let cors = CorsLayer::new()
        .allow_origin(Any)
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
        .route(
            "/m/{slug}/{*upstream_path}",
            any(proxy::proxy_handler),
        )
        .route("/m/{slug}", any(proxy::proxy_root_handler))
        .route("/m/{slug}/", any(proxy::proxy_root_handler))
        .with_state(state)
        .layer(cors)
        .layer(TraceLayer::new_for_http());

    let addr: SocketAddr = config.bind_addr.parse()?;
    tracing::info!(%addr, "ghola-gateway listening");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

async fn health() -> (StatusCode, &'static str) {
    (StatusCode::OK, "ok")
}
