use std::sync::Arc;

use axum::extract::DefaultBodyLimit;
use axum::http::{HeaderName, Method};
use axum::middleware;
use axum::routing::{delete, get, post, put};
use axum::Router;
use sqlx::postgres::PgPoolOptions;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;

mod auth;
mod config;
mod error;
mod routes;
mod schema;
mod security;
mod services;
mod state;

use auth::NonceStore;
use config::Config;
use state::AppState;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();

    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| {
            EnvFilter::new("orni_models_api=debug,tower_http=debug")
        }))
        .init();

    let config = Config::from_env();

    // Fail fast if JWT secret is the dev default in production
    if config.jwt_secret == "dev-secret-change-me" {
        if config.bind_addr.contains("0.0.0.0") && std::env::var("ALLOW_DEV_SECRET").is_err() {
            panic!("JWT_SECRET is the default 'dev-secret-change-me' — set a real secret in production! (set ALLOW_DEV_SECRET=1 to override)");
        }
        tracing::warn!("JWT_SECRET is the dev default — set a strong secret in production!");
    }

    // Append search_path to DATABASE_URL so all connections use the orni schema
    let db_url = if config.database_url.contains('?') {
        format!(
            "{}&options=-csearch_path%3Dorni%2Cpublic",
            config.database_url
        )
    } else {
        format!(
            "{}?options=-csearch_path%3Dorni%2Cpublic",
            config.database_url
        )
    };

    let db = PgPoolOptions::new()
        .max_connections(10)
        .acquire_timeout(std::time::Duration::from_secs(5))
        .idle_timeout(std::time::Duration::from_secs(300))
        .max_lifetime(std::time::Duration::from_secs(1800))
        .connect(&db_url)
        .await?;

    tracing::info!("Connected to database (pool: max 4 connections)");

    crate::schema::ensure_schema(&db).await?;
    tracing::info!("Schema ready");

    // Build HTTP client with timeouts (prevents SSRF hangs)
    let http_client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .connect_timeout(std::time::Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .build()?;

    // Phase 3.1: verify each accepted stablecoin mint is real, owned by the
    // canonical SPL Token program (not Token-2022), and has the configured
    // decimals. A misconfigured mint env var becomes a startup panic instead
    // of a silent fake-mint deposit hole.
    if std::env::var("SKIP_MINT_VERIFY").is_err() {
        for token in &config.accepted_tokens {
            match said_solana::spl::verify_mint(
                &http_client,
                &config.solana_rpc_url,
                &token.mint_b58,
                token.decimals,
            )
            .await
            {
                Ok(v) => tracing::info!(
                    symbol = %token.symbol,
                    mint = %v.mint_b58,
                    decimals = v.decimals,
                    "Stablecoin mint verified"
                ),
                Err(e) => {
                    panic!(
                        "Mint verification failed for {} ({}): {}. Set SKIP_MINT_VERIFY=1 only in tests.",
                        token.symbol, token.mint_b58, e
                    );
                }
            }
        }
    } else {
        tracing::warn!("SKIP_MINT_VERIFY set — stablecoin mints are NOT being verified at startup");
    }

    // Load escrow keypair for on-chain stablecoin settlements
    let escrow_keypair: Option<[u8; 64]> = if let Some(ref path) = config.escrow_keypair_path {
        match std::fs::read(path) {
            Ok(bytes) => {
                // Solana JSON keypair format: [u8; 64] as JSON array
                let parsed: Vec<u8> = serde_json::from_slice(&bytes)
                    .unwrap_or_else(|_| bytes.clone());
                if parsed.len() == 64 {
                    let mut arr = [0u8; 64];
                    arr.copy_from_slice(&parsed);
                    tracing::info!("Escrow keypair loaded — on-chain settlement enabled");
                    Some(arr)
                } else {
                    tracing::warn!("Escrow keypair invalid length ({}), settlements disabled", parsed.len());
                    None
                }
            }
            Err(e) => {
                tracing::warn!("Could not load escrow keypair at {path}: {e} — settlements disabled");
                None
            }
        }
    } else {
        tracing::info!("No ESCROW_KEYPAIR_PATH set — on-chain settlement disabled (Stripe-only mode)");
        None
    };

    // Phase 3.3: sanctions / risk-screening backend. Default is no-op; swap in
    // a real backend (Chainalysis / TRM / Range / custom block-list) by
    // changing this construction site — every route that screens deposits
    // already routes through the trait.
    let screener: Arc<dyn services::screening::Screener> = Arc::new(services::screening::NoopScreener);

    let state = Arc::new(AppState {
        db,
        config: config.clone(),
        http_client,
        nonce_store: Arc::new(NonceStore::new()),
        guest_rate_limits: Arc::new(Default::default()),
        auth_rate_limiter: Arc::new(state::AuthRateLimiter::new()),
        escrow_keypair,
        screener,
    });

    // Spawn settlement loop (every 5 minutes)
    if state.escrow_keypair.is_some() {
        tokio::spawn(services::settlement::settlement_loop(state.clone()));
        tracing::info!("Settlement loop started (5-minute cycle)");

        // Phase 3.3: hot/cold treasury sweep. No-op if COLD_WALLET_ADDRESS
        // is unset, so this is safe to spawn unconditionally when escrow is
        // available.
        tokio::spawn(services::treasury::treasury_loop(state.clone()));
        tracing::info!("Treasury sweep loop started (hourly)");
    }

    // Phase 3.4: peg monitor (alerting only, never auto-pauses).
    tokio::spawn(services::peg_monitor::peg_monitor_loop(state.clone()));
    tracing::info!("Peg monitor started (5-minute cycle, alerting only)");

    // CORS — locked to allowed origins only
    let allowed_origins: Vec<_> = config
        .frontend_url
        .split(',')
        .chain(std::iter::once("https://ghola.xyz"))
        .filter_map(|s| s.trim().parse().ok())
        .collect();

    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list(allowed_origins))
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::DELETE, Method::OPTIONS])
        .allow_headers([
            HeaderName::from_static("content-type"),
            HeaderName::from_static("authorization"),
        ])
        .allow_credentials(true);

    // Public routes
    let public = Router::new()
        .route("/auth/nonce", post(routes::auth::get_nonce))
        .route("/auth/verify", post(routes::auth::verify))
        .route("/models", get(routes::marketplace::browse))
        .route("/models/featured", get(routes::marketplace::get_featured))
        .route("/models/{slug}", get(routes::models::get_model))
        .route("/models/{slug}/reviews", get(routes::models::get_reviews))
        .route(
            "/models/{slug}/interest",
            post(routes::models::register_interest),
        )
        .route("/ai", get(routes::ai::get_ai_key))
        .route(
            "/creator/{did}/profile",
            get(routes::identity::get_creator_profile),
        )
        .route(
            "/creators/{slug}",
            get(routes::creators::get_creator_by_slug),
        )
        .route("/auth/register", post(routes::auth::register_email))
        .route("/auth/login", post(routes::auth::login_email))
        .route("/payments/webhook", post(routes::payments::stripe_webhook));

    // Protected routes
    let protected = Router::new()
        // Chat
        .route("/chat/{slug}/message", post(routes::chat::send_message))
        .route("/chat/{slug}/usage", get(routes::chat::get_usage))
        .route("/chat/sessions", get(routes::chat::list_sessions))
        .route(
            "/chat/sessions/{id}/messages",
            get(routes::chat::get_session_messages),
        )
        // Creator
        .route("/creator/stats", get(routes::creator::get_stats))
        .route("/creator/models", get(routes::creator::get_models))
        .route(
            "/creator/models/{id}",
            get(routes::creator::get_model_detail),
        )
        .route(
            "/creator/models/{id}/fine-tune",
            post(routes::creator::start_fine_tune),
        )
        .route(
            "/creator/models/{id}/publish",
            post(routes::creator::publish_model),
        )
        .route(
            "/creator/models/{id}/status",
            put(routes::creator::toggle_status),
        )
        .route("/creator/earnings", get(routes::creator::get_earnings))
        // Models
        .route("/models/create", post(routes::models::create_model))
        .route(
            "/models/quick-list",
            post(routes::models::quick_list_model),
        )
        .route("/models/id/{id}", put(routes::models::update_model))
        .route(
            "/models/id/{id}/content",
            post(routes::models::add_content),
        )
        .route(
            "/models/{slug}/review",
            post(routes::models::create_review),
        )
        // Payments
        .route("/balance", get(routes::payments::get_balance))
        .route("/deposit-address", get(routes::payments::get_deposit_address))
        .route("/deposits", post(routes::payments::submit_deposit))
        .route("/withdraw", post(routes::payments::request_withdraw))
        .route("/checkout", post(routes::payments::create_checkout))
        // Spending limits (budget caps)
        .route("/limits", get(routes::limits::get_limits))
        .route("/limits", post(routes::limits::update_limits))
        // Identity
        .route("/identity/link", post(routes::identity::link_did))
        // API Keys
        .route("/keys", post(routes::api_keys::create_api_key))
        .route("/keys", get(routes::api_keys::list_api_keys))
        .route("/keys/{id}", delete(routes::api_keys::revoke_api_key))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth::auth_middleware,
        ));

    // Root-level routes (not under /api)
    let root_routes = Router::new()
        .route("/agents.txt", get(routes::discovery::agents_txt))
        .route(
            "/.well-known/said.json",
            get(routes::discovery::well_known_said),
        )
        .route(
            "/.well-known/x402",
            get(routes::discovery::well_known_x402),
        )
        .route("/openapi.json", get(routes::discovery::openapi_json))
        .route("/.well-known/security.txt", get(security::security_txt))
        .route(
            "/v1/chat/completions",
            post(routes::openai_compat::chat_completions)
                .get(routes::openai_compat::x402_discovery),
        );

    // Honeypot routes — trap attacker reconnaissance
    let honeypots = Router::new()
        .route("/wp-admin", get(security::honeypot))
        .route("/wp-login.php", get(security::honeypot))
        .route("/.env", get(security::honeypot))
        .route("/api/.env", get(security::honeypot))
        .route("/api/admin/users", post(security::honeypot))
        .route("/api/internal/debug", get(security::honeypot))
        .route("/phpMyAdmin", get(security::honeypot))
        .route("/actuator", get(security::honeypot));

    // Global rate limiter
    let global_limiter = Arc::new(security::GlobalRateLimiter::new());
    let anomaly_detector = Arc::new(security::AnomalyDetector::new());

    // Layer ordering note: the LAST .layer() call is the OUTERMOST and runs
    // FIRST on each request. Middleware that reads an Extension must be
    // wrapped INSIDE the .layer() call that inserts the Extension — i.e. the
    // Extension layers below must come AFTER (= more outer than) the
    // rate_limit_middleware layer that reads them.
    let app = Router::new()
        .merge(honeypots)
        .merge(root_routes)
        .nest("/api", public.merge(protected))
        .with_state(state)
        // 256KB max request body
        .layer(DefaultBodyLimit::max(256 * 1024))
        .layer(middleware::from_fn(security::rate_limit_middleware))
        .layer(axum::Extension(global_limiter))
        .layer(axum::Extension(anomaly_detector))
        .layer(middleware::from_fn(security::security_headers))
        .layer(cors)
        .layer(TraceLayer::new_for_http());

    let bind_addr = config.bind_addr.parse::<std::net::SocketAddr>()?;
    tracing::info!("Starting server on {bind_addr}");

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
