pub mod auth;
pub mod config;
pub mod db;
pub mod error;
pub mod middleware;
pub mod privacy;
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

    tracing::info!(
        groq = config.groq_api_key.is_some(),
        cerebras = config.cerebras_api_key.is_some(),
        gemini = config.google_gemini_api_key.is_some(),
        openrouter = config.openrouter_api_key.is_some(),
        "free cascade config"
    );

    tracing::info!(
        relay_url = %config.relay_url,
        platform_wallet = config.platform_wallet_address.is_some(),
        "compute marketplace config"
    );

    if config.claude_api_key.is_none()
        && config.groq_api_key.is_none()
        && config.cerebras_api_key.is_none()
        && config.google_gemini_api_key.is_none()
        && config.openrouter_api_key.is_none()
    {
        tracing::warn!(
            "⚠ No CLAUDE_API_KEY or free cascade keys — default chat will fail. \
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
        let ip_limiter = state.ip_rate_limiter.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(300));
            loop {
                interval.tick().await;
                limiter.cleanup().await;
                ip_limiter.cleanup().await;
            }
        });
    }

    // Start Telegram bot polling loop (if token configured)
    if state.config.telegram_bot_token.is_some() {
        let tg_state = state.clone();
        tokio::spawn(services::telegram::start_telegram_bot(tg_state));
    }

    // GPU compute background tasks
    services::compute_service::start_escrow_expiry_task(state.clone());
    services::compute_service::start_reputation_decay_task(state.db.clone());

    // Marketplace: expire stale claims every 5 minutes
    tokio::spawn(routes::marketplace::claim_expiry_loop(state.db.clone()));
    // Refresh compute provider cache every 30s
    {
        let state = state.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(30));
            loop {
                interval.tick().await;
                if let Err(e) = services::compute_service::refresh_provider_cache(&state).await {
                    tracing::warn!("failed to refresh compute cache: {e}");
                }
            }
        });
    }

    let app = build_router(state)
        .into_make_service_with_connect_info::<std::net::SocketAddr>();

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
        .route("/api/auth/siws/challenge", get(routes::auth::siws_challenge))
        .route("/api/auth/siws", post(routes::auth::siws_sign_in))
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
        .route("/api/tasks/{id}/bounty", get(routes::tasks::get_task_bounty))
        // Bounties
        .route("/api/bounties", get(routes::tasks::list_bounties))
        // Marketplace
        .route("/api/marketplace", get(routes::marketplace::browse))
        .route("/api/marketplace/{id}", get(routes::marketplace::get_task))
        .route("/api/marketplace/{id}/claim", post(routes::marketplace::claim_task))
        .route("/api/marketplace/{id}/submit", post(routes::marketplace::submit_task))
        .route("/api/marketplace/{id}/release", post(routes::marketplace::release_task))
        .route("/api/marketplace/{id}/reject", post(routes::marketplace::reject_task))
        .route("/api/marketplace/{id}/unclaim", post(routes::marketplace::unclaim_task))
        // Calls
        .route("/api/calls", post(routes::calls::initiate_call))
        .route("/api/calls/initiate", post(routes::calls::initiate_call))
        .route("/api/calls/webhook", post(routes::calls::call_webhook))
        // Device-action planning
        .route("/api/agent/plan", post(routes::agent::plan))
        // Emails
        .route("/api/emails", get(routes::emails::list_emails))
        .route("/api/emails/draft", post(routes::emails::create_draft))
        .route("/api/emails/generate", post(routes::emails::generate_email))
        .route("/api/emails/send", post(routes::emails::send_email_direct))
        .route("/api/emails/{id}/send", post(routes::emails::send_email))
        // SMS
        .route("/api/sms/send", post(routes::sms::send_sms))
        .route("/api/sms/webhook", post(routes::sms::sms_webhook))
        // Calendar
        .route(
            "/api/calendar/events",
            post(routes::calendar::create_event).get(routes::calendar::list_events),
        )
        // User
        .route("/api/user/profile", get(routes::user::get_profile))
        .route("/api/user/profile", patch(routes::user::update_profile))
        .route("/api/user/usage", get(routes::user::get_usage))
        // Devices
        .route("/api/devices", post(routes::devices::register_device))
        .route("/api/devices", get(routes::devices::list_devices))
        .route("/api/devices/{id}", delete(routes::devices::remove_device))
        .route("/api/devices/{id}/push-token", post(routes::devices::update_push_token))
        // Pair Device handshake mailbox — unauthenticated (the receiving
        // device is fresh and has no auth yet); confidentiality comes
        // from the sealed envelope, not from any header check.
        .route(
            "/api/devices/handshake",
            post(routes::handshake::post_handshake),
        )
        .route(
            "/api/devices/handshake/{id}",
            get(routes::handshake::get_handshake),
        )
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
        // Provider key (one-click onboarding)
        .route("/api/auth/provider-key", post(routes::api_keys::create_provider_key))
        // Wallet (crypto)
        .route("/api/wallet/provision", post(routes::wallet::provision_wallet))
        .route("/api/wallet/address", get(routes::wallet::get_address))
        .route("/api/wallet/balances", get(routes::wallet::get_balances))
        .route("/api/wallet/transfer", post(routes::wallet::transfer))
        .route("/api/wallet/history", get(routes::wallet::get_history))
        .route("/api/wallet/earnings", get(routes::wallet::get_earnings))
        .route("/api/wallet/withdraw-earnings", post(routes::wallet::withdraw_earnings))
        // Compute (GPU marketplace)
        .route("/api/compute/providers/register", post(routes::compute::register_provider))
        .route("/api/compute/providers/me", get(routes::compute::get_my_provider).patch(routes::compute::update_my_provider))
        .route("/api/compute/providers", get(routes::compute::list_providers))
        .route("/api/compute/models", get(routes::compute::list_models))
        .route("/api/compute/stats", get(routes::compute::get_stats))
        .route("/api/compute/jobs", get(routes::compute::get_recent_jobs))
        .route("/api/compute/escrow", get(routes::compute::get_escrow))
        .route("/api/compute/providers/me/withdraw", post(routes::compute::withdraw_earnings))
        .route("/api/compute/providers/me/payouts", get(routes::compute::get_payouts))
        // Agent Rental
        .route("/api/agents", post(routes::agents::create_agent).get(routes::agents::list_agents))
        .route("/api/agents/mine", get(routes::agents::list_my_agents))
        .route("/api/agents/{slug_or_id}", get(routes::agents::get_agent)
            .patch(routes::agents::update_agent).delete(routes::agents::delete_agent))
        .route("/api/agents/{slug_or_id}/sessions", get(routes::agents::list_sessions))
        .route("/api/agents/{slug_or_id}/rate", post(routes::agents::rate_agent))
        // Swarm (elastic agent dispatch)
        .route("/api/swarm/estimate", post(routes::swarm::estimate_swarm))
        .route("/api/swarm", post(routes::swarm::create_swarm).get(routes::swarm::list_swarms))
        .route("/api/swarm/{id}", get(routes::swarm::get_swarm))
        .route("/api/swarm/{id}/units", get(routes::swarm::get_work_units))
        .route("/api/swarm/{id}/results", get(routes::swarm::get_results))
        .route("/api/swarm/{id}/stream", get(routes::swarm::stream_progress))
        .route("/api/swarm/{id}/cancel", post(routes::swarm::cancel_swarm))
        // x402 Discovery (unauthenticated)
        .route("/x402/agents", get(routes::x402::list_agents))
        .route("/x402/agents/{slug}", get(routes::x402::get_agent))
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
        .allow_headers([
            axum::http::header::CONTENT_TYPE,
            axum::http::header::AUTHORIZATION,
            axum::http::header::ACCEPT,
            axum::http::header::ORIGIN,
            axum::http::header::HeaderName::from_static("x-requested-with"),
        ])
        .allow_credentials(true)
}

async fn health(State(state): State<AppState>) -> String {
    let user_count = sqlx::query_scalar::<_, i64>("SELECT count(*) FROM users")
        .fetch_one(&state.db)
        .await;

    let providers = format!(
        "google={} apple={} stripe={} bland={} claude={} gmail={} telegram={} groq={} cerebras={} gemini={} openrouter={}",
        state.config.google_client_id.is_some(),
        state.config.apple_client_id.is_some(),
        state.config.stripe_secret_key.is_some(),
        state.config.bland_api_key.is_some(),
        state.config.claude_api_key.is_some(),
        state.config.gmail_client_id.is_some(),
        state.config.telegram_bot_token.is_some(),
        state.config.groq_api_key.is_some(),
        state.config.cerebras_api_key.is_some(),
        state.config.google_gemini_api_key.is_some(),
        state.config.openrouter_api_key.is_some(),
    );

    let cascade_stats = state.free_cascade.stats().await;
    let cascade_info: Vec<String> = cascade_stats
        .iter()
        .map(|(name, (used, limit))| format!("{name}={used}/{limit}"))
        .collect();

    let community_count = state.compute_cache.lock().await.len();

    format!(
        "ok users={:?} providers=[{providers}] cascade=[{}] community={community_count}",
        user_count,
        cascade_info.join(" "),
    )
}

async fn health_providers(State(state): State<AppState>) -> Json<serde_json::Value> {
    let cascade_stats = state.free_cascade.stats().await;
    let cascade_json: serde_json::Value = cascade_stats
        .into_iter()
        .map(|(name, (used, limit))| {
            (name, json!({ "used": used, "limit": limit }))
        })
        .collect::<serde_json::Map<String, serde_json::Value>>()
        .into();

    let community_providers = state.compute_cache.lock().await;
    let community_count = community_providers.len();
    drop(community_providers);

    Json(json!({
        "google": state.config.google_client_id.is_some(),
        "apple": state.config.apple_client_id.is_some(),
        "stripe": state.config.stripe_secret_key.is_some(),
        "bland_ai": state.config.bland_api_key.is_some(),
        "claude": state.config.claude_api_key.is_some(),
        "gmail": state.config.gmail_client_id.is_some(),
        "telegram": state.config.telegram_bot_token.is_some(),
        "groq": state.config.groq_api_key.is_some(),
        "cerebras": state.config.cerebras_api_key.is_some(),
        "gemini": state.config.google_gemini_api_key.is_some(),
        "openrouter": state.config.openrouter_api_key.is_some(),
        "free_cascade": cascade_json,
        "community_providers": community_count,
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
