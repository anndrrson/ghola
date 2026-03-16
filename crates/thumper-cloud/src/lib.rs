pub mod auth;
pub mod config;
pub mod db;
pub mod error;
pub mod middleware;
pub mod routes;
pub mod services;
pub mod state;

use axum::extract::State;
use axum::http::HeaderValue;
use axum::routing::{delete, get, patch, post};
use axum::Json;
use axum::Router;
use serde_json::json;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::trace::TraceLayer;

use crate::config::CloudConfig;
use crate::state::AppState;

/// Run the thumper-cloud server.
pub async fn run_cloud() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let config = CloudConfig::from_env();
    let bind_addr = config.bind_addr;

    tracing::info!(%bind_addr, "starting thumper-cloud server");

    tracing::info!(
        google = config.google_client_id.is_some(),
        apple = config.apple_client_id.is_some(),
        stripe = config.stripe_secret_key.is_some(),
        bland_ai = config.bland_api_key.is_some(),
        claude = config.claude_api_key.is_some(),
        gmail = config.gmail_client_id.is_some(),
        telegram = config.telegram_bot_token.is_some(),
        "provider config"
    );

    if config.claude_api_key.is_none() {
        tracing::warn!(
            "⚠ No CLAUDE_API_KEY — default chat will fail. \
             Only BYOM users (with their own key in Settings) can chat."
        );
    }

    let pool = db::create_pool(&config.database_url).await?;
    db::run_migrations(&pool).await?;

    // Seed default templates
    routes::templates::seed_templates(&pool).await?;

    let state = AppState::new(config, pool);

    // Start proactive monitor loop
    {
        let state = state.clone();
        tokio::spawn(services::proactive::start_monitor_loop(state));
    }

    // Rate limiter cleanup (every 5 minutes)
    {
        let limiter = state.rate_limiter.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(300));
            loop {
                interval.tick().await;
                limiter.cleanup().await;
            }
        });
    }

    // Start Telegram bot polling loop (if token configured)
    if state.config.telegram_bot_token.is_some() {
        let tg_state = state.clone();
        tokio::spawn(services::telegram::start_telegram_bot(tg_state));
    }

    let app = build_router(state);

    let listener = tokio::net::TcpListener::bind(bind_addr).await?;
    tracing::info!("thumper-cloud listening on {}", bind_addr);
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    tracing::info!("thumper-cloud shut down");
    Ok(())
}

pub fn build_router(state: AppState) -> Router {
    Router::new()
        // Health
        .route("/health", get(health))
        .route("/health/providers", get(health_providers))
        // Auth
        .route("/api/auth/google", post(routes::auth::google_sign_in))
        .route("/api/auth/apple", post(routes::auth::apple_sign_in))
        .route("/api/auth/twitter", post(routes::auth::twitter_sign_in))
        .route("/api/auth/refresh", post(routes::auth::refresh_token))
        .route("/api/auth/email/signup", post(routes::auth::email_sign_up))
        .route("/api/auth/email/signin", post(routes::auth::email_sign_in))
        // Tasks
        .route("/api/tasks", post(routes::tasks::create_task))
        .route("/api/tasks", get(routes::tasks::list_tasks))
        .route("/api/tasks/{id}", get(routes::tasks::get_task))
        .route("/api/tasks/{id}/steps", get(routes::tasks::get_task_steps))
        .route("/api/tasks/{id}/cancel", post(routes::tasks::cancel_task))
        // Calls
        .route("/api/calls", post(routes::calls::initiate_call))
        .route("/api/calls/webhook", post(routes::calls::call_webhook))
        // Emails
        .route("/api/emails", get(routes::emails::list_emails))
        .route("/api/emails/draft", post(routes::emails::create_draft))
        .route("/api/emails/generate", post(routes::emails::generate_email))
        .route("/api/emails/send", post(routes::emails::send_email_direct))
        .route("/api/emails/{id}/send", post(routes::emails::send_email))
        // User
        .route("/api/user/profile", get(routes::user::get_profile))
        .route("/api/user/profile", patch(routes::user::update_profile))
        .route("/api/user/usage", get(routes::user::get_usage))
        // Devices
        .route("/api/devices", post(routes::devices::register_device))
        .route("/api/devices", get(routes::devices::list_devices))
        .route("/api/devices/{id}", delete(routes::devices::remove_device))
        .route("/api/devices/{id}/push-token", post(routes::devices::update_push_token))
        // Billing
        .route("/api/billing/checkout", post(routes::billing::create_checkout))
        .route("/api/billing/webhook", post(routes::billing::billing_webhook))
        .route("/api/billing/status", get(routes::billing::billing_status))
        // Templates
        .route("/api/templates", get(routes::templates::list_templates))
        .route("/api/templates/{id}", get(routes::templates::get_template))
        // LLM config (BYOM)
        .route("/api/llm/config", get(routes::llm::get_config))
        .route("/api/llm/config", patch(routes::llm::update_config))
        .route("/api/llm/providers", get(routes::llm::list_providers))
        // Chat (SSE streaming)
        .route("/api/chat", post(routes::chat::chat))
        // Accounts (Gmail OAuth)
        .route("/api/accounts/authorize/gmail", get(routes::accounts::authorize_gmail))
        .route("/api/accounts/callback/gmail", get(routes::accounts::callback_gmail))
        .route("/api/accounts/status", get(routes::accounts::accounts_status))
        // Telegram
        .route("/api/telegram/link-code", post(routes::telegram::create_link_code))
        .route("/api/telegram/status", get(routes::telegram::get_status))
        .route("/api/telegram/unlink", delete(routes::telegram::unlink))
        // API Keys (Developer Platform)
        .route("/api/keys", post(routes::api_keys::create_key))
        .route("/api/keys", get(routes::api_keys::list_keys))
        .route("/api/keys/{id}", delete(routes::api_keys::revoke_key))
        // Wallet (crypto)
        .route("/api/wallet/provision", post(routes::wallet::provision_wallet))
        .route("/api/wallet/address", get(routes::wallet::get_address))
        .route("/api/wallet/balances", get(routes::wallet::get_balances))
        .route("/api/wallet/transfer", post(routes::wallet::transfer))
        .route("/api/wallet/history", get(routes::wallet::get_history))
        // OpenAI-compatible endpoints
        .route("/v1/chat/completions", post(routes::openai_compat::chat_completions))
        .route("/v1/models", get(routes::openai_compat::list_models))
        // Middleware
        .layer(axum::middleware::from_fn_with_state(state.clone(), |
            State(state): State<AppState>,
            request: axum::extract::Request,
            next: axum::middleware::Next,
        | middleware::track_api_usage(state, request, next)))
        .layer(TraceLayer::new_for_http())
        .layer(build_cors_layer(&state.config.base_url))
        .with_state(state)
}

fn build_cors_layer(base_url: &str) -> CorsLayer {
    use axum::http::Method;

    let mut origins: Vec<HeaderValue> = vec![
        "https://ghola.xyz".parse().unwrap(),
        "https://www.ghola.xyz".parse().unwrap(),
        "http://localhost:3000".parse().unwrap(),
        "http://localhost:3001".parse().unwrap(),
        "http://127.0.0.1:3000".parse().unwrap(),
    ];

    // Add base_url if it's not already in the list
    if let Ok(val) = base_url.parse::<HeaderValue>() {
        if !origins.contains(&val) {
            origins.push(val);
        }
    }

    CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins))
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers(tower_http::cors::Any)
        .allow_credentials(true)
}

async fn health(State(state): State<AppState>) -> String {
    let user_count = sqlx::query_scalar::<_, i64>("SELECT count(*) FROM users")
        .fetch_one(&state.db)
        .await;

    let providers = format!(
        "google={} apple={} stripe={} bland={} claude={} gmail={} telegram={}",
        state.config.google_client_id.is_some(),
        state.config.apple_client_id.is_some(),
        state.config.stripe_secret_key.is_some(),
        state.config.bland_api_key.is_some(),
        state.config.claude_api_key.is_some(),
        state.config.gmail_client_id.is_some(),
        state.config.telegram_bot_token.is_some(),
    );

    format!(
        "ok users={:?} providers=[{providers}]",
        user_count
    )
}

async fn health_providers(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(json!({
        "google": state.config.google_client_id.is_some(),
        "apple": state.config.apple_client_id.is_some(),
        "stripe": state.config.stripe_secret_key.is_some(),
        "bland_ai": state.config.bland_api_key.is_some(),
        "claude": state.config.claude_api_key.is_some(),
        "gmail": state.config.gmail_client_id.is_some(),
        "telegram": state.config.telegram_bot_token.is_some(),
    }))
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }

    tracing::info!("shutdown signal received");
}
