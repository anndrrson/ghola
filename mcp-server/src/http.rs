//! HTTP transport for the SAID MCP server with UCAN bearer-token authentication.
//!
//! ## Per-request session isolation
//!
//! An earlier version of this file stashed verified capabilities in a shared
//! `Arc<Mutex<Option<Vec<Capability>>>>` written by the auth middleware and
//! `take()`-d by the rmcp service factory. That was unsound under
//! concurrency: request A's caps could be consumed by the factory call
//! triggered by request B, allowing a low-privilege session to satisfy
//! tools that required higher capabilities. The current implementation
//! stores the verified session in a Tokio task-local
//! ([`crate::REQUEST_SESSION`]) scoped around the next-handler invocation,
//! so capabilities are bound to the request's task and cannot leak across
//! parallel requests.
//!
//! ## UCAN replay protection
//!
//! Every UCAN carries a per-issuance `nnc` claim. The middleware verifies
//! the token through [`said_core::verify_ucan_with_replay`], which records
//! the nonce in a long-lived [`said_core::NonceCache`] (default TTL: 1
//! hour). A second presentation of the same token within the TTL window
//! is rejected as a replay — even if the token is otherwise still inside
//! its `exp`.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::{
    body::Body,
    extract::Request,
    http::{header, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    Router,
};
use rmcp::transport::streamable_http_server::{
    session::local::LocalSessionManager,
    tower::{StreamableHttpService, StreamableHttpServerConfig},
};
use tower_http::cors::CorsLayer;

use said_core::{NonceCache, Wallet};
use said_types::{KeyType, Provider};

use crate::{RequestSession, SaidServer, REQUEST_SESSION};

/// How long a UCAN nonce stays in the replay cache. Long enough to cover
/// the maximum sane token lifetime so an attacker who captures a token
/// can't replay it later in the validity window.
const REPLAY_TTL_SECS: u64 = 60 * 60;

/// Shared state for the auth middleware. Note: nothing about a single
/// request lives in here — request-scoped data flows through the task-local
/// established by `auth_middleware`.
#[derive(Clone)]
struct AuthState {
    wallet: Arc<Mutex<Wallet>>,
    nonce_cache: NonceCache,
}

/// Auth middleware: extracts and verifies the UCAN bearer token, then runs
/// the next handler inside a [`REQUEST_SESSION`] scope so tool dispatch in
/// `SaidServer` can read the verified capabilities for *this* request.
async fn auth_middleware(
    state: AuthState,
    req: Request,
    next: Next,
) -> Result<Response, Response> {
    let token = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|s| s.to_string())
        .ok_or_else(|| {
            (
                StatusCode::UNAUTHORIZED,
                "Missing Authorization: Bearer <token> header",
            )
                .into_response()
        })?;

    // Verify the token + nonce + load session metadata. Hold the wallet
    // lock only for the duration of the synchronous crypto work — never
    // across `await`.
    let session = {
        let wallet = state.wallet.lock().unwrap();

        let master_xprv = wallet.derive_provider_key(Provider::Master, KeyType::Signing, 0);
        let master_pub = said_core::ucan::xprv_to_verifying_key(&master_xprv);

        let payload = said_core::verify_ucan_with_replay(&token, &master_pub, &state.nonce_cache)
            .map_err(|e| {
                (
                    StatusCode::UNAUTHORIZED,
                    format!("Token verification failed: {}", e),
                )
                    .into_response()
            })?;

        let sessions: Vec<said_types::ProviderSession> =
            wallet.storage().load("sessions").unwrap_or_default();
        let stored = sessions
            .iter()
            .find(|s| s.token == token)
            .ok_or_else(|| (StatusCode::UNAUTHORIZED, "Unknown session token").into_response())?;
        if stored.revoked {
            return Err((StatusCode::UNAUTHORIZED, "Session has been revoked").into_response());
        }

        RequestSession {
            capabilities: said_core::ucan::capabilities_from_payload(&payload),
            provider_label: Some(stored.label.clone()),
            issuer_did: Some(payload.iss),
        }
    };

    Ok(REQUEST_SESSION.scope(session, next.run(req)).await)
}

/// Start the HTTP MCP server with UCAN authentication and a long-lived
/// nonce cache for replay protection.
pub async fn run_http_server(
    wallet: Wallet,
    port: u16,
) -> Result<(), Box<dyn std::error::Error>> {
    let wallet = Arc::new(Mutex::new(wallet));
    let nonce_cache = NonceCache::new(REPLAY_TTL_SECS);

    // Periodic prune so the cache doesn't grow unboundedly. Runs on a
    // background task; if it ever panics the only consequence is a slow
    // memory drift, never a security regression.
    {
        let cache = nonce_cache.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(60));
            loop {
                tick.tick().await;
                cache.prune();
            }
        });
    }

    let auth_state = AuthState {
        wallet: wallet.clone(),
        nonce_cache,
    };

    let config = StreamableHttpServerConfig::default();
    let ct = config.cancellation_token.clone();

    // The factory builds a SaidServer once per session. It carries no
    // request-scoped data — all per-request state lives in the
    // REQUEST_SESSION task-local that auth_middleware scopes around the
    // request.
    let wallet_for_factory = wallet.clone();
    let mcp_service = StreamableHttpService::new(
        move || Ok(SaidServer::new_http(wallet_for_factory.clone())),
        Arc::new(LocalSessionManager::default()),
        config,
    );

    let app = Router::new()
        .nest_service("/mcp", mcp_service)
        .layer(middleware::from_fn({
            let state = auth_state;
            move |req: Request<Body>, next: Next| {
                let state = state.clone();
                async move { auth_middleware(state, req, next).await }
            }
        }))
        .layer(CorsLayer::permissive());

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
    eprintln!("SAID MCP server listening on http://127.0.0.1:{}/mcp", port);
    eprintln!("Requires Authorization: Bearer <ucan_token> header");

    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            ct.cancelled().await;
        })
        .await?;

    Ok(())
}
