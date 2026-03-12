//! HTTP transport for the SAID MCP server with UCAN bearer token authentication.

use std::sync::{Arc, Mutex};

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

use said_core::Wallet;
use said_types::{Capability, KeyType, Provider};

use crate::SaidServer;

/// Shared state for the auth middleware.
#[derive(Clone)]
struct AuthState {
    wallet: Arc<Mutex<Wallet>>,
    /// The verified capabilities are stored here by the middleware
    /// and consumed by the service factory when creating a new session.
    current_capabilities: Arc<Mutex<Option<Vec<Capability>>>>,
    /// The provider label from the authenticated session.
    current_provider_label: Arc<Mutex<Option<String>>>,
}

/// Auth middleware: extracts and verifies the UCAN bearer token from the Authorization header.
async fn auth_middleware(
    state: AuthState,
    req: Request,
    next: Next,
) -> Result<Response, Response> {
    // Extract bearer token from Authorization header
    let auth_header = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|s| s.to_string());

    let token = auth_header.ok_or_else(|| {
        (
            StatusCode::UNAUTHORIZED,
            "Missing Authorization: Bearer <token> header",
        )
            .into_response()
    })?;

    // Verify the token using the wallet (scope the lock so it's dropped before await)
    let (capabilities, provider_label) = {
        let wallet = state.wallet.lock().unwrap();

        // Get master public key for verification
        let master_xprv = wallet.derive_provider_key(Provider::Master, KeyType::Signing, 0);
        let master_pub = said_core::ucan::xprv_to_verifying_key(&master_xprv);

        // Verify the UCAN token (signature + expiry)
        let payload = said_core::verify_ucan(&token, &master_pub).map_err(|e| {
            (
                StatusCode::UNAUTHORIZED,
                format!("Token verification failed: {}", e),
            )
                .into_response()
        })?;

        // Check that the session is not revoked
        let sessions: Vec<said_types::ProviderSession> =
            wallet.storage().load("sessions").unwrap_or_default();
        let session = sessions.iter().find(|s| s.token == token).ok_or_else(|| {
            (StatusCode::UNAUTHORIZED, "Unknown session token").into_response()
        })?;
        if session.revoked {
            return Err((StatusCode::UNAUTHORIZED, "Session has been revoked").into_response());
        }

        // Extract capabilities and provider label from the session
        let caps = said_core::ucan::capabilities_from_payload(&payload);
        let label = session.label.clone();
        (caps, label)
    };

    // Store capabilities and provider label for the service factory
    *state.current_capabilities.lock().unwrap() = Some(capabilities);
    *state.current_provider_label.lock().unwrap() = Some(provider_label);

    Ok(next.run(req).await)
}

/// Start the HTTP MCP server with UCAN authentication.
pub async fn run_http_server(
    wallet: Wallet,
    port: u16,
) -> Result<(), Box<dyn std::error::Error>> {
    let wallet = Arc::new(Mutex::new(wallet));

    let auth_state = AuthState {
        wallet: wallet.clone(),
        current_capabilities: Arc::new(Mutex::new(None)),
        current_provider_label: Arc::new(Mutex::new(None)),
    };

    let config = StreamableHttpServerConfig::default();
    let ct = config.cancellation_token.clone();

    // Factory creates a SaidServer with the capabilities from the last verified request
    let caps_for_factory = auth_state.current_capabilities.clone();
    let label_for_factory = auth_state.current_provider_label.clone();
    let wallet_for_factory = wallet.clone();
    let mcp_service = StreamableHttpService::new(
        move || {
            let caps = caps_for_factory
                .lock()
                .unwrap()
                .take()
                .unwrap_or_default();
            let label = label_for_factory.lock().unwrap().take();
            Ok(SaidServer::new_with_auth(
                wallet_for_factory.clone(),
                caps,
                label,
            ))
        },
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
