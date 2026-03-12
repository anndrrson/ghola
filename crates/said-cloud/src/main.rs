use std::sync::Arc;

use axum::http::{HeaderName, Method};
use axum::middleware;
use axum::routing::{delete, get, post, put};
use axum::Router;
use sqlx::postgres::PgPoolOptions;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;

mod auth;
mod config;
mod db;
mod error;
mod health_checker;
mod routes;
mod state;

use config::Config;
use state::AppState;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();

    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| {
            EnvFilter::new("said_cloud=debug,tower_http=debug")
        }))
        .init();

    let config = Config::from_env();

    let db = PgPoolOptions::new()
        .max_connections(20)
        .connect(&config.database_url)
        .await?;

    tracing::info!("Connected to database");

    sqlx::migrate!("../../migrations-cloud").run(&db).await?;
    tracing::info!("Migrations applied");

    let state = Arc::new(AppState {
        db,
        config: config.clone(),
        http_client: reqwest::Client::new(),
        rate_limiter: Arc::new(state::RateLimiter::new()),
        usage_meter: Arc::new(state::UsageMeter::new()),
    });

    // Spawn background health checker for inference nodes
    tokio::spawn(health_checker::run(state.clone()));

    // Spawn usage meter flush task
    let usage_state = state.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
        loop {
            interval.tick().await;
            if let Err(e) = usage_state.usage_meter.flush_to_db(&usage_state.db).await {
                tracing::warn!("Usage flush error: {e}");
            }
        }
    });

    // CORS configuration
    let origins: Vec<_> = config
        .allowed_origins
        .split(',')
        .filter_map(|s| s.trim().parse().ok())
        .collect();

    let cors = CorsLayer::new()
        .allow_origin(origins)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([
            HeaderName::from_static("content-type"),
            HeaderName::from_static("authorization"),
        ])
        .allow_credentials(true);

    // Public routes
    let public = Router::new()
        .route("/health", get(routes::health::health))
        .route("/v1/auth/register", post(routes::auth::register))
        .route("/v1/auth/login", post(routes::auth::login))
        .route("/v1/consumer/register", post(routes::consumer::register))
        .route("/v1/profile/{did}", get(routes::consumer::get_public_profile))
        .route("/v1/resolve/{did_or_handle}", get(routes::resolve::resolve))
        .route("/v1/discover", get(routes::resolve::discover))
        .route("/v1/billing/webhook", post(routes::billing::webhook))
        .route("/v1/badges/{did}", get(routes::badges::check_badge))
        .route("/v1/nodes", get(routes::nodes::list_nodes))
        .route("/v1/nodes/resolve", get(routes::nodes::resolve_nodes))
        .route("/v1/nodes/{id}", get(routes::nodes::get_node))
        .route(
            "/v1/nodes/{id}/heartbeat",
            post(routes::nodes::node_heartbeat),
        )
        .route(
            "/v1/nodes/{id}/reviews",
            get(routes::nodes::get_reviews),
        )
        .route(
            "/v1/nodes/{id}/payment",
            post(routes::nodes::record_payment),
        );

    // Protected routes (require Bearer JWT)
    let protected = Router::new()
        .route("/v1/business/profile", get(routes::business::get_profile))
        .route("/v1/business/profile", put(routes::business::update_profile))
        .route(
            "/v1/business/verify-domain",
            post(routes::business::verify_domain),
        )
        .route(
            "/v1/business/check-domain-verification",
            post(routes::business::check_domain_verification),
        )
        .route("/v1/business/agents-txt", get(routes::business::agents_txt))
        .route(
            "/v1/business/well-known",
            get(routes::business::well_known),
        )
        .route("/v1/consumer/profile", get(routes::consumer::get_profile))
        .route("/v1/consumer/profile", put(routes::consumer::update_profile))
        .route("/v1/consumer/wallet", get(routes::consumer::get_wallet))
        .route("/v1/consumer/wallet", post(routes::consumer::upload_wallet))
        .route(
            "/v1/analytics/summary",
            get(routes::analytics::summary),
        )
        .route(
            "/v1/billing/create-checkout",
            post(routes::billing::create_checkout),
        )
        .route("/v1/billing/status", get(routes::billing::status))
        .route("/v1/billing/portal", get(routes::billing::portal))
        .route(
            "/v1/analytics/timeline",
            get(routes::analytics::timeline),
        )
        .route(
            "/v1/analytics/agents",
            get(routes::analytics::agents),
        )
        .route(
            "/v1/analytics/funnel",
            get(routes::analytics::funnel),
        )
        .route(
            "/v1/badges/request",
            post(routes::badges::request_badge),
        )
        .route(
            "/v1/admin/badges/grant",
            post(routes::badges::grant_badge),
        )
        .route(
            "/v1/nodes/register",
            post(routes::nodes::register_node),
        )
        .route(
            "/v1/nodes/manage/{id}",
            put(routes::nodes::update_node).delete(routes::nodes::delete_node),
        )
        .route(
            "/v1/nodes/{id}/review",
            post(routes::nodes::submit_review),
        )
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth::auth_middleware,
        ));

    let app = Router::new()
        .merge(public)
        .merge(protected)
        .with_state(state)
        .layer(cors)
        .layer(TraceLayer::new_for_http());

    let bind_addr = config.bind_addr.parse::<std::net::SocketAddr>()?;
    tracing::info!("Starting SAID Cloud API on {bind_addr}");

    let listener = tokio::net::TcpListener::bind(bind_addr).await?;
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    Ok(())
}

async fn shutdown_signal() {
    tokio::signal::ctrl_c()
        .await
        .expect("Failed to listen for ctrl+c");
    tracing::info!("Shutdown signal received");
}
