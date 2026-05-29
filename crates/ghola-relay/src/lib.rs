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

use axum::extract::DefaultBodyLimit;
use axum::routing::{get, post};
use axum::Router;
use tower_http::cors::CorsLayer;
use tower_http::set_header::SetResponseHeaderLayer;
use tower_http::trace::TraceLayer;

use crate::config::RelayConfig;
use crate::state::AppState;

/// Build the CORS layer from the configured allowed-origins list.
///
/// In dev mode we degrade to permissive so a developer doesn't have to
/// enumerate every localhost port. In prod we require an exact origin
/// match against the configured list.
fn build_cors_layer(config: &RelayConfig) -> CorsLayer {
    use axum::http::{HeaderValue, Method};

    if config.dev_mode {
        // Dev mode: permissive CORS so localhost:* + 127.0.0.1:* + any
        // origin a developer points at the relay just works.
        return CorsLayer::permissive();
    }

    let origins: Vec<HeaderValue> = config
        .cors_allowed_origins
        .iter()
        .filter_map(|o| HeaderValue::from_str(o).ok())
        .collect();

    CorsLayer::new()
        .allow_origin(origins)
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::OPTIONS])
        .allow_headers([
            axum::http::header::CONTENT_TYPE,
            axum::http::header::AUTHORIZATION,
        ])
}

/// Public entrypoint used by tests so the test harness builds the same
/// router shape (with body limits, CORS, and Cross-Origin-Resource-Policy
/// headers) that production uses.
pub fn build_app(state: AppState) -> Router {
    let max_body = state.config().max_body_size_bytes;
    let max_sealed_body = state.config().max_sealed_body_size_bytes;
    let cors = build_cors_layer(state.config());
    let ohttp_enabled = state.config().ohttp_keypair().is_some();

    // Sealed-inference path uses a larger body limit (encrypted prompt
    // + history blobs run bigger than the general 1 MiB ceiling) and
    // also carries the auth middleware that's already attached.
    let sealed_router = Router::new()
        .route(
            "/inference/sealed",
            post(handlers::dispatch_inference_sealed),
        )
        .route_layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth::require_sealed_envelope_auth,
        ))
        .layer(DefaultBodyLimit::max(max_sealed_body));

    // Public verifier path — Cross-Origin-Resource-Policy must be
    // permissive so the cross-origin `/r/<hash>` verifier page can
    // fetch the receipt proof + cached attestation without a CORP
    // block. We split this into its own sub-router so the broader
    // `same-origin` policy applies to every other route.
    let public_verifier_router = Router::new()
        .route("/attestations/{hash_hex}", get(handlers::get_attestation))
        .layer(SetResponseHeaderLayer::overriding(
            axum::http::HeaderName::from_static("cross-origin-resource-policy"),
            axum::http::HeaderValue::from_static("cross-origin"),
        ));

    let mut app = Router::new()
        .route("/health", get(handlers::health))
        .route("/healthz", get(handlers::healthz))
        .route("/ready", get(handlers::ready))
        .route("/ready/private", get(handlers::ready_private))
        .route("/metrics", get(handlers::metrics_handler))
        .route("/ws", get(handlers::ws_upgrade))
        .route("/inference", post(handlers::dispatch_inference))
        .route(
            "/inference-stream",
            post(handlers::dispatch_inference_stream),
        )
        .route("/providers/attest", post(handlers::provider_attest_http))
        .route(
            "/providers/attested",
            get(handlers::list_attested_providers),
        )
        .merge(public_verifier_router)
        .merge(sealed_router);

    if ohttp_enabled {
        // OHTTP gateway accepts the same large sealed-envelope payloads
        // as the direct sealed route; treat it identically.
        let ohttp_router = Router::new()
            .route("/ohttp-gateway", post(handlers::ohttp_gateway))
            .layer(DefaultBodyLimit::max(max_sealed_body));
        app = app
            .route("/ohttp-keys", get(handlers::ohttp_keys))
            .merge(ohttp_router);
    }

    app
        // General body limit (1 MiB default). Sealed-inference + OHTTP
        // override this via their own DefaultBodyLimit layers above.
        .layer(DefaultBodyLimit::max(max_body))
        // Cross-Origin-Resource-Policy: same-origin by default. The
        // public verifier sub-router overrides this with cross-origin.
        .layer(SetResponseHeaderLayer::if_not_present(
            axum::http::HeaderName::from_static("cross-origin-resource-policy"),
            axum::http::HeaderValue::from_static("same-origin"),
        ))
        .layer(TraceLayer::new_for_http())
        .layer(cors)
        .with_state(state)
}

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

    if is_production_env() {
        // Production fails closed. dev_mode (signature verification off)
        // and any sealed-mode preflight gap are fatal here — a single
        // mis-set env var must not silently downgrade the relay's auth
        // posture. ALLOW_INSECURE_STARTUP is the one explicit override.
        let issues = startup_issues(
            config.dev_mode,
            &preflight_failures,
            insecure_startup_override_enabled(),
        );
        if !issues.is_empty() {
            for issue in &issues {
                tracing::error!(%issue, "fail-closed startup guard");
            }
            return Err(format!(
                "refusing to start in production with insecure config: {} issue(s): {}",
                issues.len(),
                issues.join(",")
            )
            .into());
        }
    } else if !preflight_failures.is_empty() {
        // Outside production we preserve the warn-by-default posture.
        // Phase 1 (Nitro attestation) does not require the Phase 2 OHTTP
        // key or Phase 3 DID-set envs, so a Phase-1-only dev deploy can
        // start without those. The strict-refuse behavior stays opt-in
        // via GHOLA_RELAY_STRICT_PREFLIGHT for local Phase 2/3 testing.
        let strict = ghola_assistant_types::env_compat("GHOLA_RELAY_STRICT_PREFLIGHT", "THUMPER_RELAY_STRICT_PREFLIGHT")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false);
        if strict {
            tracing::error!(
                reason_codes = ?preflight_failures,
                "private-mode preflight failed; refusing to start relay (GHOLA_RELAY_STRICT_PREFLIGHT=1)"
            );
            return Err(format!(
                "private-mode preflight failed: {}",
                preflight_failures.join(",")
            )
            .into());
        } else {
            tracing::warn!(
                reason_codes = ?preflight_failures,
                "private-mode preflight failures present (relay still starting; set GHOLA_RELAY_STRICT_PREFLIGHT=1 to refuse-start instead)"
            );
        }
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
    // Body limits, CORS, and Cross-Origin-Resource-Policy headers are
    // applied by `build_app` so the test harness exercises the same
    // router shape as production.
    let app = build_app(state);

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

/// Production-only fail-closed startup guards for the relay. Returns the
/// list of fatal configuration problems; an empty list means "safe to
/// start". Pure (no env reads) so it can be unit-tested directly.
///
/// Mirrors `ghola-gateway`'s `startup_issues`: when the override is set we
/// bypass with a loud warning, otherwise dev-mode (signature verification
/// disabled) and any sealed-mode preflight gap are fatal.
pub(crate) fn startup_issues(
    dev_mode: bool,
    preflight_failures: &[String],
    allow_insecure_override: bool,
) -> Vec<String> {
    if allow_insecure_override {
        tracing::warn!(
            "ALLOW_INSECURE_STARTUP=true set in production; bypassing fail-closed startup guards"
        );
        return Vec::new();
    }
    let mut issues = Vec::new();
    if dev_mode {
        issues
            .push("GHOLA_DEV_MODE disables signature verification; must be off in production".to_string());
    }
    issues.extend(preflight_failures.iter().cloned());
    issues
}

/// True when the deploy environment indicates production. Matches the
/// gateway's detection so operators have one consistent set of env vars.
fn is_production_env() -> bool {
    let raw = std::env::var("APP_ENV")
        .or_else(|_| std::env::var("RUST_ENV"))
        .or_else(|_| std::env::var("ENVIRONMENT"))
        .unwrap_or_default();
    matches!(raw.trim().to_ascii_lowercase().as_str(), "prod" | "production")
}

/// Explicit operator opt-out of the production fail-closed guards. Same
/// env var name as `ghola-gateway`.
fn insecure_startup_override_enabled() -> bool {
    std::env::var("ALLOW_INSECURE_STARTUP")
        .ok()
        .map(|v| matches!(v.as_str(), "1" | "true" | "TRUE" | "yes" | "YES"))
        .unwrap_or(false)
}
