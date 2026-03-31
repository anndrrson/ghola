use std::net::SocketAddr;
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
mod ip_rate_limit;
mod metered;
mod routes;
mod self_register;
mod signing;
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

    let signing_key = Arc::new(AppState::build_signing_key(&config));
    tracing::info!(
        pubkey = %hex::encode(ed25519_dalek::VerifyingKey::from(signing_key.as_ref()).to_bytes()),
        "Response signing key loaded"
    );

    let state = Arc::new(AppState {
        db,
        config: config.clone(),
        http_client: reqwest::Client::new(),
        rate_limiter: Arc::new(state::RateLimiter::new()),
        usage_meter: Arc::new(state::UsageMeter::new()),
        signing_key,
    });

    // Spawn background health checker for inference nodes
    tokio::spawn(health_checker::run(state.clone()));

    // Self-register SAID's own APIs as headless merchant services
    self_register::register_self(&state.db, &config.base_url).await;

    // Spawn reputation recomputer (every 5 minutes)
    tokio::spawn(routes::reputation::recompute_loop(state.clone()));

    // Spawn settlement processor (every hour)
    tokio::spawn(routes::billing_service::settlement_loop(state.clone()));

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
            HeaderName::from_static("x-service-key"),
        ])
        .allow_credentials(true);

    // Public routes
    let public = Router::new()
        .route("/health", get(routes::health::health))
        // Expose server's ed25519 public key so clients can verify X-Ghola-Signature
        .route("/v1/signing-key", get(signing_key_handler))
        // Pricing catalog (headless merchant schema)
        .route("/v1/pricing", get(routes::pricing::get_pricing))
        .route(
            "/v1/pricing/{*path}",
            get(routes::pricing::get_endpoint_pricing),
        )
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
        )
        .route(
            "/v1/pay/merchant/{did}",
            get(routes::payments::get_merchant),
        )
        // Service registry (public routes)
        .route("/v1/services", get(routes::services::list_services))
        .route(
            "/v1/services/resolve",
            get(routes::services::resolve_services),
        )
        .route(
            "/v1/services/{id_or_slug}",
            get(routes::services::get_service),
        )
        .route(
            "/v1/services/{id}/heartbeat",
            post(routes::services::service_heartbeat),
        )
        .route(
            "/v1/services/{id}/reviews",
            get(routes::services::get_reviews),
        )
        .route(
            "/v1/services/{id}/payment",
            post(routes::services::record_payment),
        )
        .route(
            "/v1/services/{id}/openapi",
            get(routes::services::get_openapi_spec),
        )
        // Auth brokering (public + service-key-authed)
        .route("/v1/verify/did/{did}", get(routes::verify::lookup_did))
        .route(
            "/v1/verify/x402/{address}",
            get(routes::verify::verify_x402_merchant),
        )
        .route("/v1/verify/agent", post(routes::verify::verify_agent))
        .route(
            "/v1/verify/capability",
            post(routes::verify::verify_capability),
        )
        // Reputation (public + service-key-authed)
        .route(
            "/v1/reputation/{did}",
            get(routes::reputation::get_reputation),
        )
        .route(
            "/v1/reputation/{did}/history",
            get(routes::reputation::get_reputation_history),
        )
        .route(
            "/v1/reputation/event",
            post(routes::reputation::record_reputation_event),
        )
        // Delegation (public + service-key-authed)
        .route(
            "/v1/delegation/grants/{did}",
            get(routes::delegation::list_grants_for_did),
        )
        .route(
            "/v1/delegation/check",
            get(routes::delegation::check_revocation),
        )
        .route(
            "/v1/delegation/verify-chain",
            post(routes::delegation::verify_chain),
        )
        // Billing-as-a-service (metering + settlements, service-key-authed)
        .route("/v1/meter", post(routes::billing_service::record_usage))
        .route(
            "/v1/meter/summary/{service_id}",
            get(routes::billing_service::usage_summary),
        )
        .route(
            "/v1/settlements/{service_id}",
            get(routes::billing_service::list_settlements),
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
        .route(
            "/v1/pay/agents",
            get(routes::payments::list_agents).post(routes::payments::create_agent),
        )
        .route(
            "/v1/pay/agents/{id}",
            put(routes::payments::update_agent).delete(routes::payments::deactivate_agent),
        )
        .route("/v1/pay/history", get(routes::payments::history))
        .route("/v1/pay/sync", post(routes::payments::sync_transactions))
        .route(
            "/v1/pay/spending/{id}",
            get(routes::payments::spending_summary),
        )
        .route(
            "/v1/pay/merchant",
            post(routes::payments::upsert_merchant),
        )
        // Service registry (protected routes)
        .route(
            "/v1/services/mine",
            get(routes::services::my_services),
        )
        .route(
            "/v1/services/register",
            post(routes::services::register_service),
        )
        .route(
            "/v1/services/manage/{id}",
            put(routes::services::update_service).delete(routes::services::delete_service),
        )
        .route(
            "/v1/services/{id}/analytics",
            get(routes::services::service_analytics),
        )
        .route(
            "/v1/services/{id}/review",
            post(routes::services::submit_review),
        )
        // Delegation management
        .route(
            "/v1/delegation/grant",
            post(routes::delegation::create_grant),
        )
        .route(
            "/v1/delegation/revoke",
            post(routes::delegation::revoke_grant),
        )
        .route(
            "/v1/delegation/grants",
            get(routes::delegation::list_my_grants),
        )
        // Encrypted credential sharing
        .route(
            "/v1/credentials/share",
            post(routes::credentials::share_credential),
        )
        .route(
            "/v1/credentials/inbox",
            get(routes::credentials::inbox),
        )
        .route(
            "/v1/credentials/accept/{id}",
            post(routes::credentials::accept_credential),
        )
        .route(
            "/v1/credentials/revoke/{id}",
            post(routes::credentials::revoke_credential),
        )
        // Service API key management
        .route(
            "/v1/service-keys",
            get(routes::verify::list_service_keys).post(routes::verify::create_service_key),
        )
        .route(
            "/v1/service-keys/{id}",
            delete(routes::verify::revoke_service_key),
        )
        // Service subscriptions (billing-as-a-service, agent-facing)
        .route(
            "/v1/services/{id}/subscribe",
            post(routes::billing_service::subscribe_to_service),
        )
        .route(
            "/v1/services/subscriptions",
            get(routes::billing_service::list_subscriptions),
        )
        .route(
            "/v1/services/{id}/unsubscribe",
            delete(routes::billing_service::unsubscribe),
        )
        // Chat routes
        .route(
            "/v1/chat/agents",
            get(routes::chat::list_agents).post(routes::chat::create_agent),
        )
        .route(
            "/v1/chat/agents/{id}",
            put(routes::chat::update_agent).delete(routes::chat::delete_agent),
        )
        .route(
            "/v1/chat/history/{agent_id}",
            get(routes::chat::get_history).post(routes::chat::save_history),
        )
        .route("/v1/chat/relay", post(routes::chat::relay))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth::auth_middleware,
        ));

    let app = Router::new()
        .merge(public)
        .merge(protected)
        // IP rate limiting: 30/min unauthenticated, 300/min authenticated
        .layer(middleware::from_fn_with_state(
            state.clone(),
            ip_rate_limit::ip_rate_limit,
        ))
        // Cryptographic response signing (X-Ghola-Signature + X-Ghola-Timestamp)
        .layer(middleware::from_fn_with_state(
            state.clone(),
            signing::sign_responses,
        ))
        // Pricing headers (X-Price-Micro-USDC etc.)
        .layer(middleware::from_fn_with_state(
            state.clone(),
            metered::pricing_headers,
        ))
        .with_state(state)
        .layer(cors)
        .layer(TraceLayer::new_for_http());

    let bind_addr = config.bind_addr.parse::<SocketAddr>()?;
    tracing::info!("Starting SAID Cloud API on {bind_addr}");

    let listener = tokio::net::TcpListener::bind(bind_addr).await?;
    // Use connect_info so ip_rate_limit can extract the real socket address
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
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

/// GET /v1/signing-key — returns the server's ed25519 public key (hex).
/// Clients can use this to verify X-Ghola-Signature on any response.
async fn signing_key_handler(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
) -> axum::Json<serde_json::Value> {
    use ed25519_dalek::VerifyingKey;
    let pubkey = VerifyingKey::from(state.signing_key.as_ref());
    axum::Json(serde_json::json!({
        "algorithm": "ed25519",
        "public_key_hex": hex::encode(pubkey.to_bytes()),
        "signed_message_format": "{unix_timestamp}:{HTTP_METHOD}:{path}",
        "headers": {
            "signature": "X-Ghola-Signature",
            "timestamp": "X-Ghola-Timestamp"
        }
    }))
}
