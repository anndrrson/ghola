mod auth;
mod config;
mod db;
mod error;
mod llm;
mod ollama;
mod routes;
mod state;

use axum::routing::{get, post};
use axum::Router;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

use config::HomeConfig;
use state::HomeState;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "ghola_home=info,tower_http=info".into()),
        )
        .init();

    let config = HomeConfig::from_env();
    let pool = db::init_pool(&config.db_path)
        .await
        .expect("failed to init database");

    tracing::info!("database: {}", config.db_path.display());
    tracing::info!("PIN: {}", config.pin);

    let state = HomeState::new(config.clone(), pool);

    let app = Router::new()
        // Public endpoints (no auth)
        .route("/health", get(routes::health::health))
        .route("/health/ollama", get(routes::health::health_ollama))
        .route("/api/local/pair", post(routes::pair::pair))
        // Authenticated endpoints (require paired device token)
        .route("/api/chat", post(routes::chat::chat))
        .route("/api/models", get(routes::models::list_models))
        .route("/api/models/pull", post(routes::models::pull_model))
        .route(
            "/api/settings",
            get(routes::settings::get_settings).patch(routes::settings::update_settings),
        )
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&config.bind_addr)
        .await
        .expect("failed to bind");

    tracing::info!("listening on {}", config.bind_addr);

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("server error");
}

async fn shutdown_signal() {
    tokio::signal::ctrl_c()
        .await
        .expect("failed to listen for ctrl+c");
    tracing::info!("shutting down");
}
