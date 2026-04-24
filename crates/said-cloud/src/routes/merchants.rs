//! `/v1/m/*` — headless merchant onboarding and dashboard endpoints.
//!
//! This is the control plane. The data plane is `ghola-gateway`, a separate
//! stateless binary. These two services share Postgres and the [`Vault`] but
//! nothing else — the gateway can be deployed and scaled independently.
//!
//! ## The 60-second merchant flow
//!
//! 1. `POST /v1/m/new` — merchant submits 3 fields (URL, auth, price).
//!    - We mint a vault sub-org + Solana wallet.
//!    - We encrypt their upstream credential.
//!    - We insert a `service_listings` row with `proxy_enabled=true`.
//!    - We probe their origin live and store the result.
//!    - We return `{ slug, wallet_address, gateway_url, public_url }`.
//! 2. Web client redirects to `/m/{slug}/dash`.
//! 3. Web client optionally calls `POST /v1/m/{slug}/test-call` to fire
//!    a treasury-funded call through the gateway, completing the ritual
//!    ("your first sale").
//! 4. Merchant sees a live log tail via `GET /v1/m/{slug}/logs`.
//!
//! No JWT is required for `POST /v1/m/new`. The merchant doesn't have an
//! account yet — we create an ephemeral `users` row keyed on the slug for
//! ownership bookkeeping, with a flag that lets them claim it later via
//! the standard auth flow.

use std::collections::HashSet;
use std::net::SocketAddr;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::Arc;

use axum::extract::{ConnectInfo, Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use uuid::Uuid;

use said_turnkey::AuthMode;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

// ─── Request / response shapes ─────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct NewMerchantRequest {
    /// e.g. `https://api.example.com/v1`
    pub origin_url: String,
    /// `bearer` | `api_key_header` | `api_key_query` | `basic` | `none`
    pub auth_mode: String,
    /// Header name for `api_key_header` mode; ignored otherwise.
    pub auth_header_name: Option<String>,
    /// Raw upstream credential. Encrypted via the vault before it touches
    /// Postgres. Never logged, never returned in any response.
    pub auth_credential: Option<String>,
    /// Price per call in micro-USDC. `1_000` = $0.001.
    pub price_micro_usdc: i64,
    /// Optional display name. Defaults to a pretty slug.
    pub name: Option<String>,
    /// Optional explicit slug. If absent we derive one from the URL host.
    pub slug: Option<String>,
    /// Optional one-line description for the public listing.
    pub description: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct NewMerchantResponse {
    pub slug: String,
    pub service_id: Uuid,
    pub wallet_address: String,
    /// Bearer-like capability token for owner actions before claim/sign-in.
    pub manage_token: String,
    pub gateway_url: String,
    pub public_url: String,
    pub dashboard_url: String,
    pub origin_probe: ProbeResult,
}

#[derive(Debug, Serialize, Deserialize)]
struct MerchantManageClaims {
    sub: String,
    slug: String,
    service_id: String,
    purpose: String,
    iss: String,
    aud: String,
    jti: String,
    exp: u64,
    iat: u64,
}

#[derive(Debug, Serialize, Deserialize)]
struct LegacyMerchantManageClaims {
    sub: String,
    slug: String,
    service_id: String,
    purpose: String,
    exp: u64,
    iat: u64,
}

#[derive(Debug, Serialize)]
pub struct ProbeResult {
    pub ok: bool,
    pub status: Option<i32>,
    pub latency_ms: Option<i32>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct PublicListing {
    pub slug: String,
    pub name: String,
    pub description: String,
    pub price_micro_usdc: i64,
    pub wallet_address: Option<String>,
    pub status: String,
    pub gateway_url: String,
    pub total_requests: i64,
    pub total_revenue_micro_usdc: i64,
}

#[derive(Debug, Serialize)]
pub struct CallLogRow {
    pub id: Uuid,
    pub caller_agent_did: Option<String>,
    pub method: String,
    pub path: String,
    pub upstream_status: Option<i32>,
    pub gateway_status: i32,
    pub latency_ms: i32,
    pub amount_charged_micro_usdc: i64,
    pub payment_status: String,
    pub error_reason: Option<String>,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Deserialize)]
pub struct LogsQuery {
    pub limit: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct EarningsSummary {
    pub total_micro_usdc: i64,
    pub last_24h_micro_usdc: i64,
    pub total_calls: i64,
    pub by_day: Vec<DailyEarnings>,
}

#[derive(Debug, Serialize)]
pub struct DailyEarnings {
    pub day: chrono::DateTime<chrono::Utc>,
    pub micro_usdc: i64,
    pub calls: i64,
}

#[derive(Debug, Serialize)]
pub struct TestCallResponse {
    pub status: i32,
    pub latency_ms: i32,
    pub trace_id: Option<String>,
    pub error: Option<String>,
}

// ─── POST /v1/m/new ────────────────────────────────────────────────────────

pub async fn create_merchant(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<NewMerchantRequest>,
) -> AppResult<(StatusCode, Json<NewMerchantResponse>)> {
    let ip = request_ip(&headers, Some(addr), state.config.trust_proxy_headers);
    let onboarding_key = format!("merchant_onboarding:{ip}");
    if let Err(retry_after) = state.rate_limiter.check(&onboarding_key, 5) {
        return Err(AppError::TooManyRequests(retry_after));
    }

    // 1. Validate inputs.
    let origin = req.origin_url.trim().trim_end_matches('/');
    if origin.is_empty() {
        return Err(AppError::BadRequest("origin_url is required".into()));
    }
    let parsed_origin = url::Url::parse(origin)
        .map_err(|e| AppError::BadRequest(format!("origin_url is not a valid URL: {e}")))?;
    if !matches!(parsed_origin.scheme(), "http" | "https") {
        return Err(AppError::BadRequest(
            "origin_url must be http:// or https://".into(),
        ));
    }
    if parsed_origin.scheme() == "http" && !state.config.allow_insecure_merchant_origin_http {
        return Err(AppError::BadRequest(
            "origin_url must use https:// (set ALLOW_INSECURE_MERCHANT_ORIGIN_HTTP=true only for local dev)".into(),
        ));
    }
    ensure_safe_origin(&parsed_origin).await?;

    let auth_mode = AuthMode::parse(req.auth_mode.trim().to_ascii_lowercase().as_str())
        .map_err(|_| {
            AppError::BadRequest(format!(
                "auth_mode must be one of: bearer, api_key_header, api_key_query, basic, none (got '{}')",
                req.auth_mode
            ))
        })?;

    if !matches!(auth_mode, AuthMode::None)
        && req.auth_credential.as_deref().unwrap_or("").is_empty()
    {
        return Err(AppError::BadRequest(
            "auth_credential is required when auth_mode != 'none'".into(),
        ));
    }
    if matches!(auth_mode, AuthMode::ApiKeyHeader)
        && req.auth_header_name.as_deref().unwrap_or("").is_empty()
    {
        return Err(AppError::BadRequest(
            "auth_header_name is required for api_key_header mode".into(),
        ));
    }
    if req.price_micro_usdc < 0 || req.price_micro_usdc > 1_000_000_000 {
        return Err(AppError::BadRequest(
            "price_micro_usdc must be 0..1_000_000_000 (= $1000)".into(),
        ));
    }

    // 2. Derive a slug. Explicit > request field > auto-derive from host.
    let raw_slug = req.slug.as_deref().map(str::to_string).unwrap_or_else(|| {
        parsed_origin
            .host_str()
            .unwrap_or("merchant")
            .replace('.', "-")
    });
    let slug = slugify(&raw_slug);
    if slug.is_empty() {
        return Err(AppError::BadRequest("derived slug is empty".into()));
    }

    // Ensure slug is unique — append a 4-char suffix if needed.
    let slug = make_unique_slug(&state.db, &slug).await?;

    // 3. Resolve or mint an ephemeral owner_id. For the zero-account flow we
    // reuse an "anonymous merchant" system user. A follow-up claim flow can
    // reassign ownership when the merchant actually signs up.
    let owner_id = ensure_anonymous_merchant_user(&state.db).await?;
    let owner_did = format!("did:anon:{}", owner_id);

    // 4. Mint vault sub-org + wallet.
    let suborg = state
        .vault
        .mint_suborg(&slug)
        .await
        .map_err(|e| AppError::Internal(format!("vault mint_suborg failed: {e}")))?;

    // 5. Pre-encrypt the credential (outside the transaction — vault ops can
    // be slow and we don't want to hold a DB row lock while we wait on HSMs).
    let stored_cred = if matches!(auth_mode, AuthMode::None) {
        None
    } else {
        let plaintext = req
            .auth_credential
            .as_deref()
            .expect("validated above: auth_credential required when auth_mode != none");
        Some(
            state
                .vault
                .encrypt(auth_mode, plaintext)
                .await
                .map_err(|e| AppError::Internal(format!("vault encrypt failed: {e}")))?,
        )
    };

    // 6. All three DB writes in a transaction:
    //      (a) INSERT service_listings with merchant_credential_id = NULL
    //      (b) INSERT merchant_credentials pointing at the real listing id
    //      (c) UPDATE service_listings.merchant_credential_id = the credential's id
    //    This is the only safe ordering given the cross-FK.
    let name = req
        .name
        .as_deref()
        .map(str::to_string)
        .unwrap_or_else(|| titlecase_slug(&slug));
    let description = req.description.unwrap_or_default();

    let mut tx = state.db.begin().await?;

    let service_id: Uuid = sqlx::query(
        r#"
        INSERT INTO service_listings (
            owner_id, owner_did, name, slug, description,
            base_url, auth_type, auth_details,
            pricing_model, price_micro_usdc,
            status, receive_address,
            proxy_enabled, proxy_origin_url, proxy_auth_mode,
            proxy_auth_header_name,
            vault_suborg_id, vault_wallet_address
        )
        VALUES (
            $1, $2, $3, $4, $5,
            $6, 'none', '{}'::jsonb,
            'per_request', $7,
            'active', $8,
            true, $6, $9,
            $10,
            $11, $8
        )
        RETURNING id
        "#,
    )
    .bind(owner_id)
    .bind(&owner_did)
    .bind(&name)
    .bind(&slug)
    .bind(&description)
    .bind(origin)
    .bind(req.price_micro_usdc)
    .bind(&suborg.solana_address)
    .bind(auth_mode.as_str())
    .bind(req.auth_header_name.as_deref())
    .bind(&suborg.suborg_id)
    .fetch_one(&mut *tx)
    .await?
    .get("id");

    let credential_id: Option<Uuid> = if let Some(stored) = stored_cred {
        let id: Uuid = sqlx::query(
            r#"
            INSERT INTO merchant_credentials (
                service_listing_id, auth_mode, header_name, ciphertext,
                key_version, vault_backend, vault_key_ref
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING id
            "#,
        )
        .bind(service_id)
        .bind(auth_mode.as_str())
        .bind(req.auth_header_name.as_deref())
        .bind(&stored.ciphertext)
        .bind(stored.key_version)
        .bind(stored.backend)
        .bind(stored.key_ref.as_deref())
        .fetch_one(&mut *tx)
        .await?
        .get("id");

        sqlx::query("UPDATE service_listings SET merchant_credential_id = $1 WHERE id = $2")
            .bind(id)
            .bind(service_id)
            .execute(&mut *tx)
            .await?;

        Some(id)
    } else {
        None
    };

    tx.commit().await?;
    let _ = credential_id; // silence unused if branch returned None

    let manage_token = issue_manage_token(service_id, &slug, &state.config)?;

    // 8. Live probe — best-effort, non-blocking for the response but we wait
    // for the result because showing a green check is the entire point.
    let probe = probe_origin(&state.http_client, origin).await;

    let gateway_base =
        std::env::var("GATEWAY_BASE_URL").unwrap_or_else(|_| "https://gateway.ghola.xyz".into());
    let frontend = &state.config.frontend_url;

    Ok((
        StatusCode::CREATED,
        Json(NewMerchantResponse {
            slug: slug.clone(),
            service_id,
            wallet_address: suborg.solana_address,
            manage_token,
            gateway_url: format!("{gateway_base}/m/{slug}"),
            public_url: format!("{frontend}/m/{slug}"),
            dashboard_url: format!("{frontend}/m/{slug}/dash"),
            origin_probe: probe,
        }),
    ))
}

// ─── GET /v1/m/:slug ───────────────────────────────────────────────────────

pub async fn get_public_listing(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
) -> AppResult<Json<PublicListing>> {
    let row = sqlx::query(
        r#"
        SELECT name, description, price_micro_usdc, vault_wallet_address,
               status::text AS status, total_requests, total_revenue_micro_usdc
        FROM service_listings
        WHERE slug = $1 AND proxy_enabled = true
        "#,
    )
    .bind(&slug)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("no merchant with slug '{slug}'")))?;

    let gateway_base =
        std::env::var("GATEWAY_BASE_URL").unwrap_or_else(|_| "https://gateway.ghola.xyz".into());

    Ok(Json(PublicListing {
        slug: slug.clone(),
        name: row.get("name"),
        description: row
            .get::<Option<String>, _>("description")
            .unwrap_or_default(),
        price_micro_usdc: row.get("price_micro_usdc"),
        wallet_address: row.get("vault_wallet_address"),
        status: row.get("status"),
        gateway_url: format!("{gateway_base}/m/{slug}"),
        total_requests: row.get("total_requests"),
        total_revenue_micro_usdc: row.get("total_revenue_micro_usdc"),
    }))
}

// ─── GET /v1/m/:slug/logs ──────────────────────────────────────────────────

pub async fn get_logs(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
    Query(q): Query<LogsQuery>,
    headers: HeaderMap,
) -> AppResult<Json<Vec<CallLogRow>>> {
    let service_id = authorize_merchant_access(&state, &slug, &headers).await?;
    let limit = q.limit.unwrap_or(100).clamp(1, 500);

    let rows = sqlx::query(
        r#"
        SELECT gcl.id, gcl.caller_agent_did, gcl.method, gcl.path,
               gcl.upstream_status, gcl.gateway_status, gcl.latency_ms,
               gcl.amount_charged_micro_usdc, gcl.payment_status,
               gcl.error_reason, gcl.created_at
        FROM gateway_call_logs gcl
        WHERE gcl.service_listing_id = $1
        ORDER BY gcl.created_at DESC
        LIMIT $2
        "#,
    )
    .bind(service_id)
    .bind(limit)
    .fetch_all(&state.db)
    .await?;

    let out = rows
        .into_iter()
        .map(|r| CallLogRow {
            id: r.get("id"),
            caller_agent_did: r.get("caller_agent_did"),
            method: r.get("method"),
            path: r.get("path"),
            upstream_status: r.get("upstream_status"),
            gateway_status: r.get("gateway_status"),
            latency_ms: r.get("latency_ms"),
            amount_charged_micro_usdc: r.get("amount_charged_micro_usdc"),
            payment_status: r.get("payment_status"),
            error_reason: r.get("error_reason"),
            created_at: r.get("created_at"),
        })
        .collect();

    Ok(Json(out))
}

// ─── GET /v1/m/:slug/earnings ──────────────────────────────────────────────

pub async fn get_earnings(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
    headers: HeaderMap,
) -> AppResult<Json<EarningsSummary>> {
    let service_id = authorize_merchant_access(&state, &slug, &headers).await?;
    let totals = sqlx::query(
        r#"
        SELECT
            COALESCE(SUM(CASE WHEN gcl.payment_status='paid' THEN gcl.amount_charged_micro_usdc ELSE 0 END), 0)::bigint AS total_micro_usdc,
            COALESCE(SUM(CASE WHEN gcl.payment_status='paid' AND gcl.created_at > NOW() - INTERVAL '24 hours' THEN gcl.amount_charged_micro_usdc ELSE 0 END), 0)::bigint AS last_24h_micro_usdc,
            COUNT(*)::bigint AS total_calls
        FROM gateway_call_logs gcl
        WHERE gcl.service_listing_id = $1
        "#,
    )
    .bind(service_id)
    .fetch_one(&state.db)
    .await?;

    let daily_rows = sqlx::query(
        r#"
        SELECT date_trunc('day', gcl.created_at) AS day,
               COALESCE(SUM(CASE WHEN gcl.payment_status='paid' THEN gcl.amount_charged_micro_usdc ELSE 0 END), 0)::bigint AS micro_usdc,
               COUNT(*)::bigint AS calls
        FROM gateway_call_logs gcl
        WHERE gcl.service_listing_id = $1 AND gcl.created_at > NOW() - INTERVAL '30 days'
        GROUP BY 1
        ORDER BY 1 DESC
        "#,
    )
    .bind(service_id)
    .fetch_all(&state.db)
    .await?;

    let by_day = daily_rows
        .into_iter()
        .map(|r| DailyEarnings {
            day: r.get("day"),
            micro_usdc: r.get("micro_usdc"),
            calls: r.get("calls"),
        })
        .collect();

    Ok(Json(EarningsSummary {
        total_micro_usdc: totals.get("total_micro_usdc"),
        last_24h_micro_usdc: totals.get("last_24h_micro_usdc"),
        total_calls: totals.get("total_calls"),
        by_day,
    }))
}

// ─── POST /v1/m/:slug/test-call ────────────────────────────────────────────

pub async fn run_test_call(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
    headers: HeaderMap,
) -> AppResult<Json<TestCallResponse>> {
    let _ = authorize_merchant_access(&state, &slug, &headers).await?;
    // Fire a synthetic GET through the gateway. We use the gateway base URL
    // rather than invoking proxy logic directly — that way the ritual exercises
    // the whole loop: route cache, vault decrypt, auth injection, metering.
    let gateway_base =
        std::env::var("GATEWAY_BASE_URL").unwrap_or_else(|_| "http://localhost:8090".into());
    let url = format!("{gateway_base}/m/{slug}/");

    let start = std::time::Instant::now();
    let response = state
        .http_client
        .get(&url)
        .header("x-agent-did", "did:ghola:treasury-test-agent")
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await;

    let latency_ms = start.elapsed().as_millis() as i32;

    match response {
        Ok(r) => {
            let status = r.status().as_u16() as i32;
            let trace_id = r
                .headers()
                .get("x-ghola-trace-id")
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string());
            Ok(Json(TestCallResponse {
                status,
                latency_ms,
                trace_id,
                error: None,
            }))
        }
        Err(e) => Ok(Json(TestCallResponse {
            status: 0,
            latency_ms,
            trace_id: None,
            error: Some(e.to_string()),
        })),
    }
}

// ─── DELETE /v1/m/:slug ────────────────────────────────────────────────────

pub async fn kill_switch(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
    headers: HeaderMap,
) -> AppResult<StatusCode> {
    let service_id = authorize_merchant_access(&state, &slug, &headers).await?;
    let affected = sqlx::query(
        "UPDATE service_listings SET proxy_enabled = false, status = 'suspended' WHERE id = $1",
    )
    .bind(service_id)
    .execute(&state.db)
    .await?
    .rows_affected();

    if affected == 0 {
        return Err(AppError::NotFound(
            "merchant not found or not owned by you".into(),
        ));
    }
    Ok(StatusCode::NO_CONTENT)
}

// ─── helpers ───────────────────────────────────────────────────────────────

fn issue_manage_token(
    service_id: Uuid,
    slug: &str,
    config: &crate::config::Config,
) -> AppResult<String> {
    let now = chrono::Utc::now().timestamp() as u64;
    let claims = MerchantManageClaims {
        sub: format!("merchant:{service_id}"),
        slug: slug.to_string(),
        service_id: service_id.to_string(),
        purpose: "merchant_manage".to_string(),
        iss: config.base_url.clone(),
        aud: "ghola-merchant-manage".to_string(),
        jti: Uuid::new_v4().to_string(),
        exp: now + config.merchant_manage_token_ttl_secs.max(60),
        iat: now,
    };

    jsonwebtoken::encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(config.jwt_secret.as_bytes()),
    )
    .map_err(|e| AppError::Internal(format!("failed to issue manage token: {e}")))
}

fn verify_manage_token(
    token: &str,
    config: &crate::config::Config,
) -> AppResult<MerchantManageClaims> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.validate_exp = true;
    validation.required_spec_claims = HashSet::from([
        "exp".to_string(),
        "iat".to_string(),
        "sub".to_string(),
        "aud".to_string(),
        "iss".to_string(),
    ]);
    validation.set_audience(&["ghola-merchant-manage"]);
    validation.set_issuer(&[config.base_url.as_str()]);

    let claims = jsonwebtoken::decode::<MerchantManageClaims>(
        token,
        &DecodingKey::from_secret(config.jwt_secret.as_bytes()),
        &validation,
    );
    if let Ok(claims) = claims {
        if claims.claims.purpose != "merchant_manage" {
            return Err(AppError::Unauthorized(
                "invalid manage token purpose".into(),
            ));
        }
        if claims.claims.jti.is_empty() {
            return Err(AppError::Unauthorized("invalid manage token id".into()));
        }
        return Ok(claims.claims);
    }

    // Backward compatibility for manage tokens issued before aud/iss/jti was
    // added. These tokens still expire and are only accepted if purpose matches.
    let legacy = jsonwebtoken::decode::<LegacyMerchantManageClaims>(
        token,
        &DecodingKey::from_secret(config.jwt_secret.as_bytes()),
        &Validation::new(Algorithm::HS256),
    )
    .map_err(|_| AppError::Unauthorized("invalid or expired manage token".into()))?
    .claims;
    if legacy.purpose != "merchant_manage" {
        return Err(AppError::Unauthorized(
            "invalid manage token purpose".into(),
        ));
    }
    Ok(MerchantManageClaims {
        sub: legacy.sub,
        slug: legacy.slug,
        service_id: legacy.service_id.clone(),
        purpose: legacy.purpose,
        iss: config.base_url.clone(),
        aud: "ghola-merchant-manage".to_string(),
        jti: format!("legacy:{}", legacy.service_id),
        exp: legacy.exp,
        iat: legacy.iat,
    })
}

fn bearer_user_id(headers: &HeaderMap, jwt_secret: &str) -> AppResult<Uuid> {
    let auth_header = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| {
            AppError::Unauthorized("missing authorization header or x-merchant-manage-token".into())
        })?;

    let token = auth_header
        .strip_prefix("Bearer ")
        .ok_or_else(|| AppError::Unauthorized("invalid authorization format".into()))?;
    let claims = crate::auth::validate_jwt(token, jwt_secret)?;
    claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("invalid user id in token".into()))
}

async fn authorize_merchant_access(
    state: &AppState,
    slug: &str,
    headers: &HeaderMap,
) -> AppResult<Uuid> {
    if let Some(token) = headers
        .get("x-merchant-manage-token")
        .and_then(|v| v.to_str().ok())
        .filter(|v| !v.is_empty())
    {
        let claims = verify_manage_token(token, &state.config)?;
        if claims.slug != slug {
            return Err(AppError::Unauthorized(
                "manage token does not match slug".into(),
            ));
        }
        let service_id: Uuid = claims
            .service_id
            .parse()
            .map_err(|_| AppError::Unauthorized("invalid manage token service id".into()))?;
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM service_listings WHERE id = $1 AND slug = $2)",
        )
        .bind(service_id)
        .bind(slug)
        .fetch_one(&state.db)
        .await?;
        if !exists {
            return Err(AppError::NotFound(format!(
                "no merchant with slug '{slug}'"
            )));
        }
        return Ok(service_id);
    }

    let user_id = bearer_user_id(headers, &state.config.jwt_secret)?;
    let service_id: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM service_listings WHERE slug = $1 AND owner_id = $2")
            .bind(slug)
            .bind(user_id)
            .fetch_optional(&state.db)
            .await?;

    service_id.ok_or_else(|| AppError::NotFound("merchant not found or not owned by you".into()))
}

fn request_ip(
    headers: &HeaderMap,
    socket_addr: Option<SocketAddr>,
    trust_proxy_headers: bool,
) -> String {
    if trust_proxy_headers {
        if let Some(ip) = headers
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.split(',').next())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
        {
            return ip;
        }
    }

    socket_addr
        .map(|a| a.ip().to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

async fn ensure_safe_origin(origin: &url::Url) -> AppResult<()> {
    let host = origin
        .host_str()
        .ok_or_else(|| AppError::BadRequest("origin_url must include a host".into()))?
        .to_ascii_lowercase();

    if is_blocked_hostname(&host) {
        return Err(AppError::BadRequest(format!(
            "origin_url host '{}' is not allowed",
            host
        )));
    }

    if let Ok(ip) = host.parse::<IpAddr>() {
        if is_blocked_ip(ip) {
            return Err(AppError::BadRequest(format!(
                "origin_url IP '{}' is not allowed",
                ip
            )));
        }
        return Ok(());
    }

    let port = origin
        .port_or_known_default()
        .unwrap_or(if origin.scheme() == "http" { 80 } else { 443 });
    if is_blocked_port(port) {
        return Err(AppError::BadRequest(format!(
            "origin_url port '{}' is not allowed",
            port
        )));
    }
    let resolved = tokio::net::lookup_host((host.as_str(), port))
        .await
        .map_err(|e| AppError::BadRequest(format!("origin_url host lookup failed: {e}")))?;

    let mut resolved_any = false;
    for addr in resolved {
        resolved_any = true;
        if is_blocked_ip(addr.ip()) {
            return Err(AppError::BadRequest(format!(
                "origin_url host resolves to private address '{}'",
                addr.ip()
            )));
        }
    }
    if !resolved_any {
        return Err(AppError::BadRequest(
            "origin_url host resolved to zero addresses".into(),
        ));
    }

    Ok(())
}

fn is_blocked_hostname(host: &str) -> bool {
    host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
        || host == "metadata"
        || host == "metadata.google.internal"
        || host == "metadata.azure.internal"
        || host == "instance-data"
        || host == "instance-data.ec2.internal"
        || host == "169.254.169.254"
        || host == "169.254.170.2"
        || host == "100.100.100.200"
}

fn is_blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_blocked_ipv4(v4),
        IpAddr::V6(v6) => is_blocked_ipv6(v6),
    }
}

fn is_blocked_ipv4(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_documentation()
        || ip.is_unspecified()
        || o[0] == 0
        || (o[0] == 100 && (64..=127).contains(&o[1])) // CGNAT
        || (o[0] == 198 && (o[1] == 18 || o[1] == 19)) // benchmarking
        || (o[0] == 192 && o[1] == 0 && o[2] == 0) // IETF protocol assignments
}

fn is_blocked_ipv6(ip: Ipv6Addr) -> bool {
    ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_unique_local()
        || ip.is_unicast_link_local()
        || ip.is_multicast()
}

fn is_blocked_port(port: u16) -> bool {
    matches!(
        port,
        0 | 22
            | 23
            | 25
            | 53
            | 111
            | 135
            | 137
            | 138
            | 139
            | 161
            | 389
            | 445
            | 1433
            | 1521
            | 2049
            | 2375
            | 2376
            | 3306
            | 3389
            | 5432
            | 5672
            | 5985
            | 5986
            | 6379
            | 7001
            | 7199
            | 7474
            | 7687
            | 9200
            | 9300
            | 11211
            | 27017
    )
}

/// Snake-case, lowercase, strip non-[a-z0-9-], collapse dashes.
fn slugify(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut last_dash = false;
    for ch in input.chars() {
        let c = ch.to_ascii_lowercase();
        if c.is_ascii_alphanumeric() {
            out.push(c);
            last_dash = false;
        } else if c == '-' || c == '_' || c == ' ' || c == '.' {
            if !last_dash {
                out.push('-');
                last_dash = true;
            }
        }
    }
    out.trim_matches('-').chars().take(48).collect()
}

fn titlecase_slug(slug: &str) -> String {
    slug.split('-')
        .map(|w| {
            let mut chars = w.chars();
            match chars.next() {
                Some(c) => c.to_ascii_uppercase().to_string() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

async fn make_unique_slug(db: &sqlx::PgPool, base: &str) -> AppResult<String> {
    // Try base, then base-1, base-2, ... then append a short random suffix.
    for i in 0..10 {
        let candidate = if i == 0 {
            base.to_string()
        } else {
            format!("{base}-{i}")
        };
        let exists: Option<Uuid> =
            sqlx::query_scalar("SELECT id FROM service_listings WHERE slug = $1")
                .bind(&candidate)
                .fetch_optional(db)
                .await?;
        if exists.is_none() {
            return Ok(candidate);
        }
    }
    // Fallback — 4-char suffix from a fresh uuid.
    let suffix = &Uuid::new_v4().to_string()[..4];
    Ok(format!("{base}-{suffix}"))
}

/// The "zero-account" flow creates merchants before they have a user record.
/// Instead of making the schema nullable, we ensure a single system user
/// `anonymous-merchants@ghola.xyz` exists and own every orphan listing.
/// When the merchant later claims their listing via a proper sign-up, said-cloud
/// can transfer ownership with a simple UPDATE.
async fn ensure_anonymous_merchant_user(db: &sqlx::PgPool) -> AppResult<Uuid> {
    let email = "anonymous-merchants@ghola.xyz";
    if let Some(id) = sqlx::query_scalar::<_, Uuid>("SELECT id FROM users WHERE email = $1")
        .bind(email)
        .fetch_optional(db)
        .await?
    {
        return Ok(id);
    }
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO users (email, password_hash) VALUES ($1, NULL) RETURNING id",
    )
    .bind(email)
    .fetch_one(db)
    .await?;
    Ok(id)
}

/// Best-effort GET against the merchant's origin. Used for the "green check"
/// moment in the onboarding flow. Never returns an error up the stack — a
/// failed probe is still a successful merchant creation.
async fn probe_origin(http: &reqwest::Client, origin: &str) -> ProbeResult {
    let start = std::time::Instant::now();
    match http
        .get(origin)
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
    {
        Ok(r) => ProbeResult {
            ok: r.status().is_success() || r.status().is_redirection(),
            status: Some(r.status().as_u16() as i32),
            latency_ms: Some(start.elapsed().as_millis() as i32),
            error: None,
        },
        Err(e) => ProbeResult {
            ok: false,
            status: None,
            latency_ms: Some(start.elapsed().as_millis() as i32),
            error: Some(e.to_string()),
        },
    }
}
