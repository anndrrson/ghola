pub mod auth;
pub mod config;
pub mod did_set;
pub mod error;
pub mod handlers;
pub mod metrics;
pub mod ohttp;
pub mod state;

#[cfg(test)]
mod tests;

use axum::routing::{get, post};
use axum::Router;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

use crate::config::RelayConfig;
use crate::state::AppState;

/// Run the relay server. Call this from the CLI or standalone binary.
pub async fn run_relay() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let config = RelayConfig::from_env();
    let bind_addr = config.bind_addr;
    let tls_cert_path = config.tls_cert_path.clone();
    let tls_key_path = config.tls_key_path.clone();
    let preflight_failures = config.private_preflight_failures();

    if config.dev_mode {
        tracing::warn!("DEV MODE enabled — signature verification is DISABLED");
    }
    if !preflight_failures.is_empty() {
        tracing::error!(
            reason_codes = ?preflight_failures,
            "private-mode preflight failed; refusing to start relay in production mode"
        );
        return Err(format!(
            "private-mode preflight failed: {}",
            preflight_failures.join(",")
        )
        .into());
    }
    tracing::info!(%bind_addr, dev_mode = config.dev_mode, "starting thumper relay server");

    let state = AppState::new(config);

    // Phase 3 (v3.5): periodically poll thumper-cloud for the registered
    // Ghola DID set. The sealed-inference auth middleware uses this to
    // verify "request is from *some* registered DID" without learning
    // which user account it maps to. The holder is in-memory only.
    did_set::spawn_refresh_task(
        state.did_set().clone(),
        state.config().did_set_url.clone(),
        state.config().did_set_api_key.clone(),
    );

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
                // Keep per-DID rate-limiter map bounded — drop buckets
                // we haven't touched in 15 minutes.
                state.prune_sealed_did_rate_limiters(15 * 60);
                let now = chrono::Utc::now().timestamp();
                let removed = state.prune_expired_enclaves(now);
                if removed > 0 {
                    tracing::info!(removed, "pruned expired attested enclaves");
                }
                tracing::debug!(
                    devices = state.device_count(),
                    mcp_clients = state.mcp_client_count(),
                    gpu_providers = state.gpu_provider_count(),
                    "heartbeat tick"
                );
            }
        });
    }

    let ohttp_enabled = state.config().ohttp_keypair().is_some();
    if ohttp_enabled {
        tracing::info!("OHTTP gateway routes mounted (/ohttp-keys, /ohttp-gateway)");
    } else {
        tracing::info!(
            "OHTTP gateway disabled — set GHOLA_OHTTP_KEY_SECRET_HEX to enable RFC 9458 routes"
        );
    }

    // The sealed-inference route uses a DID-envelope-based auth
    // middleware (Phase 3 privacy): the Bearer token is gone, auth
    // derives from the said-envelope's sender signature + did_set
    // membership. All other routes keep their existing auth posture.
    let sealed_router = Router::new()
        .route("/inference/sealed", post(handlers::dispatch_inference_sealed))
        .route_layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth::require_sealed_envelope_auth,
        ));

    let mut app = Router::new()
        .route("/health", get(handlers::health))
        .route("/ready/private", get(handlers::ready_private))
        .route("/metrics", get(handlers::metrics_handler))
        .route("/ws", get(handlers::ws_upgrade))
        .route("/inference", post(handlers::dispatch_inference))
        .route("/inference-stream", post(handlers::dispatch_inference_stream))
        .route("/providers/attest", post(handlers::provider_attest_http))
        .route("/providers/attested", get(handlers::list_attested_providers))
        .route("/attestations/{hash_hex}", get(handlers::get_attestation))
        .merge(sealed_router);

    if ohttp_enabled {
        app = app
            .route("/ohttp-keys", get(handlers::ohttp_keys))
            .route("/ohttp-gateway", post(handlers::ohttp_gateway));
    }

    let app = app
        .layer(TraceLayer::new_for_http())
        .layer(CorsLayer::permissive())
        .with_state(state);

    // Use TLS if cert and key paths are provided
    if let (Some(cert_path), Some(key_path)) = (&tls_cert_path, &tls_key_path) {
        let tls_config = axum_server::tls_rustls::RustlsConfig::from_pem_file(cert_path, key_path)
            .await
            .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> {
                format!("failed to load TLS config: {}", e).into()
            })?;
        tracing::info!("thumper relay listening on {} (TLS)", bind_addr);
        axum_server::bind_rustls(bind_addr, tls_config)
            .serve(app.into_make_service())
            .await?;
    } else {
        let listener = tokio::net::TcpListener::bind(bind_addr).await?;
        tracing::info!("thumper relay listening on {}", bind_addr);
        axum::serve(listener, app)
            .with_graceful_shutdown(shutdown_signal())
            .await?;
    }

    tracing::info!("thumper relay shut down");
    Ok(())
}

async fn shutdown_signal() {
    tokio::signal::ctrl_c()
        .await
        .expect("failed to install Ctrl+C handler");
    tracing::info!("shutdown signal received");
}
