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
use axum::http::{HeaderValue, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{delete, get, patch, post};
use axum::Json;
use axum::Router;
use serde_json::{json, Map, Value};
use std::time::Duration;
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

    // Recover queued task executions after process restarts and fail stale provider waits.
    {
        let state = state.clone();
        tokio::spawn(services::task_engine::start_task_recovery_loop(state));
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

    let app = build_router(state).into_make_service_with_connect_info::<std::net::SocketAddr>();

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
        .route("/healthz", get(healthz))
        .route("/ready", get(ready))
        .route("/health/providers", get(health_providers))
        .route("/health/payments", get(health_payments))
        .route("/health/privacy", get(health_privacy))
        .route("/health/institutional", get(health_institutional))
        // Auth
        .route(
            "/api/auth/siws/challenge",
            get(routes::auth::siws_challenge),
        )
        .route("/api/auth/siws", post(routes::auth::siws_sign_in))
        .route("/api/auth/google", post(routes::auth::google_sign_in))
        .route("/api/auth/apple", post(routes::auth::apple_sign_in))
        .route("/api/auth/twitter", post(routes::auth::twitter_sign_in))
        .route("/api/auth/refresh", post(routes::auth::refresh_token))
        .route("/api/auth/email/signup", post(routes::auth::email_sign_up))
        .route("/api/auth/email/signin", post(routes::auth::email_sign_in))
        // Seeker
        .route("/api/seeker/verify", post(routes::seeker::verify))
        // Tasks
        .route("/api/tasks", post(routes::tasks::create_task))
        .route("/api/tasks", get(routes::tasks::list_tasks))
        .route("/api/tasks/{id}", get(routes::tasks::get_task))
        .route("/api/tasks/{id}/steps", get(routes::tasks::get_task_steps))
        .route("/api/tasks/{id}/cancel", post(routes::tasks::cancel_task))
        .route(
            "/api/tasks/{id}/bounty",
            get(routes::tasks::get_task_bounty),
        )
        // Bounties
        .route("/api/bounties", get(routes::tasks::list_bounties))
        // Marketplace
        .route("/api/marketplace", get(routes::marketplace::browse))
        .route("/api/marketplace/{id}", get(routes::marketplace::get_task))
        .route(
            "/api/marketplace/{id}/claim",
            post(routes::marketplace::claim_task),
        )
        .route(
            "/api/marketplace/{id}/submit",
            post(routes::marketplace::submit_task),
        )
        .route(
            "/api/marketplace/{id}/release",
            post(routes::marketplace::release_task),
        )
        .route(
            "/api/marketplace/{id}/reject",
            post(routes::marketplace::reject_task),
        )
        .route(
            "/api/marketplace/{id}/unclaim",
            post(routes::marketplace::unclaim_task),
        )
        // Commerce intents (additive front flow over existing rails)
        .route(
            "/api/commerce/intents",
            post(routes::commerce::create_intent),
        )
        .route(
            "/api/commerce/intents/{id}",
            get(routes::commerce::get_intent),
        )
        .route(
            "/api/commerce/intents/{id}/offers",
            get(routes::commerce::list_offers),
        )
        .route(
            "/api/commerce/intents/{id}/quote",
            post(routes::commerce::create_quote),
        )
        .route(
            "/api/commerce/intents/{id}/execute",
            post(routes::commerce::execute_quote),
        )
        .route(
            "/api/commerce/executions/{id}",
            get(routes::commerce::get_execution),
        )
        .route(
            "/api/commerce/receipts/{id}",
            get(routes::commerce::get_receipt),
        )
        .route(
            "/api/commerce/receipts/{id}/export",
            post(routes::commerce::export_receipt),
        )
        // Calls
        .route("/api/calls", post(routes::calls::initiate_call))
        .route("/api/calls/initiate", post(routes::calls::initiate_call))
        .route("/api/calls/webhook", post(routes::calls::call_webhook))
        // Device-action planning
        .route("/api/agent/plan", post(routes::agent::plan))
        // Emails
        .route("/api/emails", get(routes::emails::list_emails))
        .route("/api/emails/{id}", get(routes::emails::get_email_detail))
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
        .route(
            "/api/devices/{id}/push-token",
            post(routes::devices::update_push_token),
        )
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
        // Ghola-native E2EE messaging relay. The relay stores and returns
        // ciphertext envelopes only; plaintext content is rejected at route
        // boundaries.
        .route(
            "/api/messages/devices",
            post(routes::messages::register_device),
        )
        .route(
            "/api/messages/prekeys/{did}",
            get(routes::messages::get_prekeys),
        )
        .route(
            "/api/messages/envelopes",
            post(routes::messages::post_envelope),
        )
        .route("/api/messages/sync", get(routes::messages::sync))
        .route("/api/messages/block", post(routes::messages::block_sender))
        .route("/api/messages/report", post(routes::messages::report_abuse))
        .route("/api/messages/{id}/ack", post(routes::messages::ack))
        // Billing
        .route(
            "/api/billing/checkout",
            post(routes::billing::create_checkout),
        )
        .route(
            "/api/billing/private-balance/checkout",
            post(routes::billing::create_private_balance_top_up),
        )
        .route(
            "/api/billing/private-balance",
            get(routes::billing::private_balance_status),
        )
        .route(
            "/api/billing/private-agent/compute/reserve",
            post(routes::billing::reserve_private_agent_compute),
        )
        .route(
            "/api/billing/private-agent/compute/release",
            post(routes::billing::release_private_agent_compute),
        )
        .route(
            "/api/billing/webhook",
            post(routes::billing::billing_webhook),
        )
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
        .route(
            "/api/accounts/authorize/gmail",
            get(routes::accounts::authorize_gmail),
        )
        .route(
            "/api/accounts/callback/gmail",
            get(routes::accounts::callback_gmail),
        )
        .route(
            "/api/accounts/status",
            get(routes::accounts::accounts_status),
        )
        // Telegram
        .route(
            "/api/telegram/link-code",
            post(routes::telegram::create_link_code),
        )
        .route("/api/telegram/status", get(routes::telegram::get_status))
        .route("/api/telegram/unlink", delete(routes::telegram::unlink))
        // API Keys (Developer Platform)
        .route("/api/keys", post(routes::api_keys::create_key))
        .route("/api/keys", get(routes::api_keys::list_keys))
        .route("/api/keys/{id}", delete(routes::api_keys::revoke_key))
        // Provider key (one-click onboarding)
        .route(
            "/api/auth/provider-key",
            post(routes::api_keys::create_provider_key),
        )
        // Wallet (crypto)
        .route(
            "/api/wallet/provision",
            post(routes::wallet::provision_wallet),
        )
        .route("/api/wallet/address", get(routes::wallet::get_address))
        .route("/api/wallet/balances", get(routes::wallet::get_balances))
        .route("/api/wallet/transfer", post(routes::wallet::transfer))
        .route("/api/wallet/history", get(routes::wallet::get_history))
        .route(
            "/api/wallet/private/intent",
            post(routes::wallet::create_private_transfer_intent),
        )
        .route(
            "/api/wallet/private/submit-proof",
            post(routes::wallet::submit_private_transfer_proof),
        )
        .route(
            "/api/wallet/private/submit-signed-transfer",
            post(routes::wallet::submit_signed_private_transfer),
        )
        .route(
            "/api/wallet/private/recipient",
            get(routes::wallet::get_private_rail_recipient),
        )
        .route(
            "/api/wallet/private/history",
            get(routes::wallet::get_private_transfer_history),
        )
        .route(
            "/api/wallet/private/receipts/{id}",
            get(routes::wallet::get_private_transfer_receipt),
        )
        .route(
            "/api/wallet/private/receipts/{id}/export",
            post(routes::wallet::export_private_transfer_receipt),
        )
        .route("/api/wallet/earnings", get(routes::wallet::get_earnings))
        .route(
            "/api/wallet/withdraw-earnings",
            post(routes::wallet::withdraw_earnings),
        )
        // Compute (GPU marketplace)
        .route(
            "/api/compute/providers/register",
            post(routes::compute::register_provider),
        )
        .route(
            "/api/compute/providers/me",
            get(routes::compute::get_my_provider).patch(routes::compute::update_my_provider),
        )
        .route(
            "/api/compute/providers",
            get(routes::compute::list_providers),
        )
        .route("/api/compute/models", get(routes::compute::list_models))
        .route("/api/compute/stats", get(routes::compute::get_stats))
        .route("/api/compute/jobs", get(routes::compute::get_recent_jobs))
        .route("/api/compute/escrow", get(routes::compute::get_escrow))
        .route(
            "/api/compute/providers/me/withdraw",
            post(routes::compute::withdraw_earnings),
        )
        .route(
            "/api/compute/providers/me/payouts",
            get(routes::compute::get_payouts),
        )
        // Agent Rental
        .route(
            "/api/agents",
            post(routes::agents::create_agent).get(routes::agents::list_agents),
        )
        .route("/api/agents/mine", get(routes::agents::list_my_agents))
        .route(
            "/api/agents/{slug_or_id}",
            get(routes::agents::get_agent)
                .patch(routes::agents::update_agent)
                .delete(routes::agents::delete_agent),
        )
        .route(
            "/api/agents/{slug_or_id}/sessions",
            get(routes::agents::list_sessions),
        )
        .route(
            "/api/agents/{slug_or_id}/rate",
            post(routes::agents::rate_agent),
        )
        // Swarm (elastic agent dispatch)
        .route("/api/swarm/estimate", post(routes::swarm::estimate_swarm))
        .route(
            "/api/swarm",
            post(routes::swarm::create_swarm).get(routes::swarm::list_swarms),
        )
        .route("/api/swarm/{id}", get(routes::swarm::get_swarm))
        .route("/api/swarm/{id}/units", get(routes::swarm::get_work_units))
        .route("/api/swarm/{id}/results", get(routes::swarm::get_results))
        .route(
            "/api/swarm/{id}/stream",
            get(routes::swarm::stream_progress),
        )
        .route("/api/swarm/{id}/cancel", post(routes::swarm::cancel_swarm))
        // x402 Discovery (unauthenticated)
        .route(
            "/.well-known/x402.json",
            get(routes::x402::well_known_manifest),
        )
        .route("/x402/agents", get(routes::x402::list_agents))
        .route("/x402/agents/{slug}", get(routes::x402::get_agent))
        .route("/x402/resources", get(routes::x402::list_resources))
        // DID set snapshot (relay polls this with a static API key).
        // Phase 3 privacy: lets the relay verify "this sealed request is
        // from *some* registered Ghola DID" without learning which user.
        .route("/v1/did-set", get(routes::did_snapshot::get_did_set))
        // OpenAI-compatible endpoints
        .route(
            "/v1/chat/completions",
            post(routes::openai_compat::chat_completions),
        )
        .route("/v1/models", get(routes::openai_compat::list_models))
        // Middleware
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            |State(state): State<AppState>,
             request: axum::extract::Request,
             next: axum::middleware::Next| {
                middleware::track_api_usage(state, request, next)
            },
        ))
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

async fn health(State(state): State<AppState>) -> Json<Value> {
    let snapshot = readiness_snapshot(&state).await;
    Json(standard_health_body(&state, snapshot))
}

async fn healthz() -> &'static str {
    "ok"
}

async fn ready(State(state): State<AppState>) -> impl IntoResponse {
    let snapshot = readiness_snapshot(&state).await;
    let status = if snapshot.ready {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    (status, Json(standard_health_body(&state, snapshot)))
}

struct ReadinessSnapshot {
    ready: bool,
    degraded: bool,
    checks: Map<String, Value>,
    reason_codes: Vec<String>,
}

fn standard_health_body(state: &AppState, snapshot: ReadinessSnapshot) -> Value {
    json!({
        "status": if snapshot.ready { "ok" } else { "degraded" },
        "service": "thumper-cloud",
        "version": env!("CARGO_PKG_VERSION"),
        "uptime_secs": state.uptime_secs(),
        "checks": snapshot.checks,
        "degraded": snapshot.degraded,
        "reason_codes": snapshot.reason_codes,
        "timestamp": chrono::Utc::now().to_rfc3339(),
    })
}

async fn readiness_snapshot(state: &AppState) -> ReadinessSnapshot {
    let mut checks = Map::new();
    let mut reason_codes = Vec::new();
    let mut degraded = false;

    add_check(
        &mut checks,
        &mut reason_codes,
        &mut degraded,
        "db",
        check_db(&state.db).await,
        true,
        "db_readiness_failed",
    );

    let llm_configured = llm_provider_configured(&state.config);
    add_check(
        &mut checks,
        &mut reason_codes,
        &mut degraded,
        "llm_provider_configured",
        json!({
            "ok": llm_configured,
            "configured": llm_provider_names(&state.config),
        }),
        true,
        "no_llm_provider_configured",
    );

    add_check(
        &mut checks,
        &mut reason_codes,
        &mut degraded,
        "relay_private",
        probe_json_endpoint(format!(
            "{}/ready/private",
            state.config.relay_url.trim_end_matches('/')
        ))
        .await,
        true,
        "relay_readiness_failed",
    );

    add_check(
        &mut checks,
        &mut reason_codes,
        &mut degraded,
        "receipts",
        probe_receipts_health(receipts_base_url())
        .await,
        true,
        "receipts_readiness_failed",
    );

    let shielded = services::x402_service::shielded_stablecoin_runtime_status();
    let shielded_ready = shielded.ready;
    add_check(
        &mut checks,
        &mut reason_codes,
        &mut degraded,
        "payment_private_rail",
        json!({
            "ok": shielded_ready,
            "required": false,
            "shielded_stablecoin": shielded,
        }),
        false,
        "private_rail_not_ready",
    );

    add_check(
        &mut checks,
        &mut reason_codes,
        &mut degraded,
        "migrations",
        json!({
            "ok": true,
            "detail": "startup migrations completed before server bind",
        }),
        true,
        "migrations_not_applied",
    );

    let community_count = state.compute_cache.lock().await.len();
    checks.insert(
        "community_provider_cache".to_string(),
        json!({
            "ok": true,
            "required": false,
            "provider_count": community_count,
        }),
    );

    let ready = reason_codes.is_empty();
    ReadinessSnapshot {
        ready,
        degraded,
        checks,
        reason_codes,
    }
}

fn add_check(
    checks: &mut Map<String, Value>,
    reason_codes: &mut Vec<String>,
    degraded: &mut bool,
    name: &'static str,
    mut check: Value,
    required: bool,
    failure_code: &'static str,
) {
    let ok = check.get("ok").and_then(Value::as_bool).unwrap_or(false);
    if let Some(obj) = check.as_object_mut() {
        obj.entry("required".to_string()).or_insert(json!(required));
    }
    if !ok {
        *degraded = true;
        if required {
            reason_codes.push(failure_code.to_string());
        }
    }
    checks.insert(name.to_string(), check);
}

async fn check_db(pool: &sqlx::PgPool) -> Value {
    match sqlx::query_scalar::<_, i64>("SELECT 1::BIGINT")
        .fetch_one(pool)
        .await
    {
        Ok(1) => json!({ "ok": true }),
        Ok(other) => {
            json!({ "ok": false, "detail": format!("unexpected SELECT 1 result: {other}") })
        }
        Err(err) => {
            tracing::warn!("cloud readiness DB probe failed: {err}");
            json!({ "ok": false, "detail": "database_unreachable" })
        }
    }
}

async fn probe_receipts_health(base_url: String) -> Value {
    let base_url = base_url.trim_end_matches('/');
    let primary = probe_json_endpoint(format!("{base_url}/health")).await;
    if primary.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        return primary;
    }

    let fallback = probe_json_endpoint(format!("{base_url}/healthz")).await;
    if fallback.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        tracing::warn!(
            url = %fallback
                .get("url")
                .and_then(|value| value.as_str())
                .unwrap_or("unknown"),
            "receipts service still serves legacy /healthz; accepting fallback until /health alias deploys"
        );
        let mut fallback = fallback;
        if let Some(obj) = fallback.as_object_mut() {
            obj.insert("fallback".to_string(), json!("healthz"));
            obj.insert("primary".to_string(), primary);
        }
        return fallback;
    }

    primary
}

async fn probe_json_endpoint(url: String) -> Value {
    let public_url = public_probe_url(&url);
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
    {
        Ok(client) => client,
        Err(err) => {
            tracing::warn!(url = %public_url, "readiness HTTP client build failed: {err}");
            return json!({ "ok": false, "url": public_url, "detail": "http_client_unavailable" });
        }
    };

    match client.get(&url).send().await {
        Ok(response) => {
            let status = response.status();
            let summary = response
                .json::<Value>()
                .await
                .ok()
                .map(dependency_body_summary);
            json!({
                "ok": status.is_success(),
                "url": public_url,
                "status_code": status.as_u16(),
                "summary": summary,
            })
        }
        Err(err) => {
            tracing::warn!(url = %public_url, "readiness dependency probe failed: {err}");
            json!({
                "ok": false,
                "url": public_url,
                "detail": "dependency_probe_failed",
            })
        }
    }
}

fn public_probe_url(raw: &str) -> String {
    match reqwest::Url::parse(raw) {
        Ok(mut parsed) => {
            parsed.set_query(None);
            parsed.set_fragment(None);
            parsed.to_string()
        }
        Err(_) => "invalid_url".to_string(),
    }
}

fn dependency_body_summary(body: Value) -> Value {
    json!({
        "service": body.get("service").and_then(Value::as_str),
        "status": body.get("status").and_then(Value::as_str),
        "private_ready": body.get("private_ready").and_then(Value::as_bool),
        "private_capacity_ready": body.get("private_capacity_ready").and_then(Value::as_bool),
        "attested_provider_count": body.get("attested_provider_count").and_then(Value::as_u64),
        "capacity_reason_codes": body.get("capacity_reason_codes").cloned().unwrap_or(Value::Null),
    })
}

fn receipts_base_url() -> String {
    std::env::var("RECEIPTS_BASE_URL")
        .or_else(|_| std::env::var("SAID_RECEIPTS_BASE_URL"))
        .unwrap_or_else(|_| "https://ghola-receipts.onrender.com".to_string())
}

fn llm_provider_configured(config: &CloudConfig) -> bool {
    config.claude_api_key.is_some()
        || config.groq_api_key.is_some()
        || config.cerebras_api_key.is_some()
        || config.google_gemini_api_key.is_some()
        || config.openrouter_api_key.is_some()
}

fn llm_provider_names(config: &CloudConfig) -> Vec<&'static str> {
    let mut providers = Vec::new();
    if config.claude_api_key.is_some() {
        providers.push("claude");
    }
    if config.groq_api_key.is_some() {
        providers.push("groq");
    }
    if config.cerebras_api_key.is_some() {
        providers.push("cerebras");
    }
    if config.google_gemini_api_key.is_some() {
        providers.push("gemini");
    }
    if config.openrouter_api_key.is_some() {
        providers.push("openrouter");
    }
    providers
}

async fn health_providers(State(state): State<AppState>) -> Json<serde_json::Value> {
    let gmail_configured =
        state.config.gmail_client_id.is_some() && state.config.gmail_client_secret.is_some();
    let cascade_stats = state.free_cascade.stats().await;
    let cascade_json: serde_json::Value = cascade_stats
        .into_iter()
        .map(|(name, (used, limit))| (name, json!({ "used": used, "limit": limit })))
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
        "gmail": gmail_configured,
        "telegram": state.config.telegram_bot_token.is_some(),
        "groq": state.config.groq_api_key.is_some(),
        "cerebras": state.config.cerebras_api_key.is_some(),
        "gemini": state.config.google_gemini_api_key.is_some(),
        "openrouter": state.config.openrouter_api_key.is_some(),
        "free_cascade": cascade_json,
        "community_providers": community_count,
        "shielded_stablecoin": services::x402_service::shielded_stablecoin_runtime_status(),
    }))
}

async fn health_payments() -> Json<serde_json::Value> {
    let shielded = services::x402_service::shielded_stablecoin_runtime_status();
    Json(json!({
        "default_rail": services::x402_service::SOLANA_PUBLIC_USDC_RAIL,
        "rails": {
            "solana_public_usdc": {
                "configured": true,
                "ready": true,
                "provider": "solana",
                "network": "solana",
                "asset": "USDC",
                "rail": "solana_public_stablecoin",
                "canonical_rail": services::x402_service::SOLANA_PUBLIC_USDC_RAIL,
                "fallback_allowed": true,
                "privacy_disclosure": services::x402_service::PUBLIC_STABLECOIN_DISCLOSURE
            },
            "solana_public_stablecoin": {
                "configured": true,
                "ready": true,
                "provider": "solana",
                "network": "solana",
                "asset": "USDC",
                "canonical_rail": services::x402_service::SOLANA_PUBLIC_USDC_RAIL,
                "fallback_allowed": true,
                "privacy_disclosure": services::x402_service::PUBLIC_STABLECOIN_DISCLOSURE
            },
            "aleo_usdcx_shielded": shielded.clone(),
            "shielded_stablecoin": shielded
        }
    }))
}

async fn health_privacy() -> Json<serde_json::Value> {
    let shielded = services::x402_service::shielded_stablecoin_runtime_status();
    let mut blocking_reasons = Vec::new();
    if !shielded.ready {
        blocking_reasons.push("shielded_stablecoin_not_ready");
    }

    Json(json!({
        "strict_local_default": true,
        "approval_enforcement_enabled": true,
        "raw_approval_nonce_hashing_enabled": true,
        "sms_approval_enabled": true,
        "task_result_redaction_enabled": true,
        "task_step_redaction_enabled": true,
        "call_recipient_hashing_enabled": true,
        "sms_recipient_hashing_enabled": true,
        "remote_compute_approval_enabled": true,
        "agent_plan_approval_enabled": true,
        "swarm_execution_approval_enabled": true,
        "messaging_block_report_enabled": true,
        "email_list_redaction_enabled": true,
        "public_wallet_recipient_hashing_enabled": true,
        "call_transcript_retention_default": "redacted",
        "private_rail_fail_closed": !shielded.fallback_allowed,
        "blocking_reasons": blocking_reasons,
    }))
}

async fn health_institutional() -> Json<serde_json::Value> {
    Json(json!(
        services::private_settlement_service::institutional_readiness()
    ))
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

#[cfg(test)]
mod privacy_log_safety_tests {
    use super::*;

    fn test_config() -> CloudConfig {
        CloudConfig {
            bind_addr: "127.0.0.1:0".parse().unwrap(),
            database_url: "postgres://user:pass@localhost/test".to_string(),
            jwt_secret: "test-secret".to_string(),
            bland_api_key: None,
            bland_webhook_url: None,
            claude_api_key: Some("claude-test".to_string()),
            google_client_id: None,
            google_client_secret: None,
            apple_client_id: None,
            gmail_client_id: None,
            gmail_client_secret: None,
            stripe_secret_key: None,
            stripe_webhook_secret: None,
            stripe_price_pro: None,
            stripe_price_unlimited: None,
            base_url: "http://localhost:3000".to_string(),
            encryption_key: [7u8; 32],
            telegram_bot_token: None,
            solana_rpc_url: "https://api.devnet.solana.com".to_string(),
            groq_api_key: None,
            cerebras_api_key: None,
            google_gemini_api_key: None,
            openrouter_api_key: None,
            relay_url: "http://localhost:8080".to_string(),
            platform_wallet_address: None,
            treasury_mnemonic: None,
            min_provider_reputation: 0.3,
            max_escrow_age_secs: 300,
            provider_payout_interval_secs: 3600,
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn cloud_health_body_uses_standard_json_contract() {
        let config = test_config();
        let pool = sqlx::PgPool::connect_lazy(&config.database_url).expect("lazy pool");
        let state = AppState::new(config, pool);
        let body = standard_health_body(
            &state,
            ReadinessSnapshot {
                ready: true,
                degraded: false,
                checks: Map::new(),
                reason_codes: Vec::new(),
            },
        );

        assert_eq!(body["status"], "ok");
        assert_eq!(body["service"], "thumper-cloud");
        assert!(body.get("version").is_some());
        assert!(body.get("uptime_secs").is_some());
        assert!(body.get("checks").is_some());
        assert_eq!(body["degraded"], false);
        assert!(body.get("timestamp").is_some());
    }

    #[test]
    fn llm_provider_config_check_tracks_configured_provider() {
        let mut config = test_config();
        assert!(llm_provider_configured(&config));
        assert_eq!(llm_provider_names(&config), vec!["claude"]);

        config.claude_api_key = None;
        assert!(!llm_provider_configured(&config));
        assert!(llm_provider_names(&config).is_empty());
    }

    #[test]
    fn dependency_probe_summary_redacts_query_and_raw_body() {
        assert_eq!(
            public_probe_url("https://example.test/ready?api-key=secret#frag"),
            "https://example.test/ready"
        );

        let summary = dependency_body_summary(json!({
            "service": "relay",
            "status": "ok",
            "private_ready": true,
            "secret": "must-not-leak",
        }));
        assert_eq!(summary["service"], "relay");
        assert_eq!(summary["private_ready"], true);
        assert!(summary.get("secret").is_none());
    }

    #[test]
    fn telegram_notifications_do_not_embed_provider_content() {
        let emails = include_str!("routes/emails.rs");
        let calls = include_str!("routes/calls.rs");
        let sms = include_str!("routes/sms.rs");

        assert!(!emails.contains("Email sent!\\n\\nTo:"));
        assert!(!emails.contains("Subject: {}"));
        assert!(!calls.contains("Transcript:\\n{}"));
        assert!(!sms.contains("chars().take(40)"));
    }

    #[test]
    fn public_list_serializers_do_not_expose_raw_approval_nonce() {
        let wallet = include_str!("services/wallet_service.rs");
        let messages = include_str!("routes/messages.rs");

        assert!(wallet.contains("value.get(\"approval_nonce\").is_none()"));
        assert!(messages.contains("approval_nonce is not stored by native messaging relay"));
    }
}
