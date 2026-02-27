pub mod auth;
pub mod config;
pub mod error;
pub mod handlers;
pub mod state;

use axum::routing::get;
use axum::Router;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

use crate::config::RelayConfig;
use crate::state::AppState;

/// Run the relay server. Call this from the CLI or standalone binary.
pub async fn run_relay() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let config = RelayConfig::from_env();
    let bind_addr = config.bind_addr;

    if config.dev_mode {
        tracing::warn!("DEV MODE enabled — signature verification is DISABLED");
    }
    tracing::info!(%bind_addr, dev_mode = config.dev_mode, "starting thumper relay server");

    let state = AppState::new(config);

    // Spawn heartbeat + nonce cleanup + dead connection pruning task
    {
        let state = state.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(30));
            loop {
                interval.tick().await;
                state.prune_nonces();
                state.ping_all_and_prune_dead();
                state.prune_stale_connections(90);
                tracing::debug!(
                    devices = state.device_count(),
                    mcp_clients = state.mcp_client_count(),
                    "heartbeat tick"
                );
            }
        });
    }

    let app = Router::new()
        .route("/health", get(handlers::health))
        .route("/ws", get(handlers::ws_upgrade))
        .layer(TraceLayer::new_for_http())
        .layer(CorsLayer::permissive())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(bind_addr).await?;
    tracing::info!("thumper relay listening on {}", bind_addr);

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    tracing::info!("thumper relay shut down");
    Ok(())
}

async fn shutdown_signal() {
    tokio::signal::ctrl_c()
        .await
        .expect("failed to install Ctrl+C handler");
    tracing::info!("shutdown signal received");
}
