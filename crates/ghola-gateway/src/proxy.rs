//! The hot path. One handler, one shape:
//!
//! 1. Resolve the slug via the in-memory route cache.
//! 2. Check circuit breaker. If open, fail-fast with 503.
//! 3. Parse and verify optional x402 payment header against Solana before
//!    treating the request as billable.
//! 4. Decrypt the merchant's upstream credential via the vault. Held in a
//!    local variable that drops at the end of this function.
//! 5. Build the outbound request: rewrite path, copy safe headers, inject
//!    auth, stream the body through.
//! 6. Send to origin with a hard timeout.
//! 7. On upstream success (2xx or 3xx) → write `metered_usage` + log as
//!    `payment_status='paid'` + close circuit breaker + stream response.
//! 8. On upstream failure (5xx, timeout, network error) → log as
//!    `payment_status='refunded'` + open circuit breaker on repeated
//!    failure + return 504 with an `X-Payment-Refund` header telling the
//!    caller's x402 client to void the inbound payment.
//!
//! Body streaming note: we use `reqwest::Body::wrap_stream` on the outbound
//! leg and `axum::body::Body::from_stream` on the return leg, so neither
//! direction has to buffer more than one chunk in memory. That's important
//! for SSE (agents streaming LLM responses from merchants) and for large
//! uploads. Headers we never forward upstream: `host`, `connection`,
//! `authorization` (we supply our own), `x-payment`, `x-forwarded-*`.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::Arc;
use std::time::Instant;

use axum::{
    body::{Body, Bytes},
    extract::{Path, Request, State},
    http::{HeaderName, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
};
use chrono::{Duration as ChronoDuration, Utc};
use futures::StreamExt;
use uuid::Uuid;

use crate::auth_inject;
use crate::meter;
use crate::route_cache::ResolvedRoute;
use crate::state::AppState;
use crate::x402_challenge;
use crate::x402_verify;

/// Headers we drop on both legs — they're connection-scoped or identity-
/// leaking and shouldn't be blindly forwarded through a reverse proxy.
const HOP_BY_HOP: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "host",
    "content-length", // reqwest computes its own
];

/// Headers that leak inbound payment state into the upstream request. Always
/// drop on the outbound leg.
const INBOUND_PAYMENT_HEADERS: &[&str] = &[
    "x-payment",
    "x402-payment",
    "x-payment-signature",
    "authorization",
];

/// Header prefixes and exact names we never proxy upstream because they are
/// gateway/client routing metadata and are easy to spoof.
const BLOCKED_HEADER_PREFIXES: &[&str] = &[
    "x-forwarded-",
    "x-real-",
    "forwarded",
    "cf-",
    "x-amzn-",
    "x-envoy-",
    "x-google-",
    "x-azure-",
    "x-ghola-",
];
const BLOCKED_HEADER_EXACT: &[&str] = &[
    "fly-client-ip",
    "x-vercel-ip-country",
    "x-vercel-id",
    "true-client-ip",
];

const MAX_UPSTREAM_PATH_LEN: usize = 4096;
const MAX_QUERY_LEN: usize = 8192;

/// Entry point for `/m/{slug}` and `/m/{slug}/` — forward to the merchant's
/// origin root. Delegates to [`proxy_handler`] after rewriting the path
/// extractor shape.
pub async fn proxy_root_handler(
    state: State<Arc<AppState>>,
    Path(slug): Path<String>,
    req: Request,
) -> Response {
    proxy_inner(state, slug, String::new(), req).await
}

pub async fn proxy_handler(
    state: State<Arc<AppState>>,
    Path((slug, upstream_path)): Path<(String, String)>,
    req: Request,
) -> Response {
    proxy_inner(state, slug, upstream_path, req).await
}

async fn proxy_inner(
    State(state): State<Arc<AppState>>,
    slug: String,
    upstream_path: String,
    req: Request,
) -> Response {
    let start = Instant::now();
    if !is_allowed_method(req.method()) {
        return (StatusCode::METHOD_NOT_ALLOWED, "method not allowed").into_response();
    }
    if upstream_path.len() > MAX_UPSTREAM_PATH_LEN {
        return (StatusCode::URI_TOO_LONG, "request path too long").into_response();
    }
    if req
        .uri()
        .query()
        .map(|q| q.len() > MAX_QUERY_LEN)
        .unwrap_or(false)
    {
        return (StatusCode::URI_TOO_LONG, "request query too long").into_response();
    }

    // ── 1. Route resolution ─────────────────────────────────────────────
    let route = match state.cache.resolve(&state.db, &slug).await {
        Ok(Some(r)) if r.proxy_enabled => r,
        Ok(Some(_)) => {
            return (StatusCode::NOT_FOUND, "merchant proxy disabled").into_response();
        }
        Ok(None) => {
            return (StatusCode::NOT_FOUND, "unknown merchant slug").into_response();
        }
        Err(e) => {
            tracing::error!("route cache error: {e}");
            return (StatusCode::SERVICE_UNAVAILABLE, "gateway error").into_response();
        }
    };

    // Defense in depth: block private/metadata targets even if a malicious row
    // lands in service_listings.
    if let Err(reason) = ensure_safe_upstream_origin(&route.origin_url).await {
        tracing::warn!(slug = %slug, origin = %route.origin_url, "blocked unsafe origin: {reason}");
        return error_response(
            &state,
            &route,
            &None,
            req.method().as_str(),
            &upstream_path,
            start,
            400,
            "blocked_unsafe_origin",
        )
        .await;
    }

    // ── 2. Circuit breaker ──────────────────────────────────────────────
    if route.circuit_breaker_open {
        let open_until = route.circuit_breaker_until;
        let still_open = open_until.map(|t| t > Utc::now()).unwrap_or(true);
        if still_open {
            let _ = meter::record_call_log(
                &state.db,
                route.service_id,
                None,
                None,
                req.method().as_str(),
                &upstream_path,
                None,
                503,
                start.elapsed().as_millis() as i32,
                0,
                0,
                0,
                "none",
                None,
                Some("circuit_breaker_open"),
            )
            .await;

            let mut resp = (
                StatusCode::SERVICE_UNAVAILABLE,
                "upstream origin is failing — try again later",
            )
                .into_response();
            resp.headers_mut().insert(
                HeaderName::from_static("x-ghola-circuit"),
                HeaderValue::from_static("open"),
            );
            return resp;
        }
    }

    // ── 3. Extract caller identity + payment header ─────────────────────
    //
    // Security-first default: x402 headers are verified on-chain before being
    // treated as paid. Legacy trust-without-verification mode is opt-in via
    // ALLOW_UNVERIFIED_XPAYMENT=true.
    let caller_agent_did = req
        .headers()
        .get("x-agent-did")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    let x_payment = req
        .headers()
        .get("x-payment")
        .or_else(|| req.headers().get("x402-payment"))
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let (requested_paid, x402_tx_signature, amount_charged, payment_precheck_error_reason) =
        if let Some(payload) = x_payment.as_deref() {
            if let Some(parsed_payment) = x402_verify::parse_payment_header(payload) {
                if state.config.allow_unverified_xpayment {
                    tracing::warn!(
                        slug = %slug,
                        "ALLOW_UNVERIFIED_XPAYMENT=true: trusting x402 header without on-chain verification"
                    );
                    (
                        true,
                        Some(parsed_payment.signature),
                        route.price_micro_usdc,
                        None,
                    )
                } else {
                    match x402_verify::verify_onchain_payment(
                        &state.http,
                        &state.config,
                        &parsed_payment,
                        route.price_micro_usdc,
                    )
                    .await
                    {
                        Ok(verified) => {
                            (true, Some(verified.signature), route.price_micro_usdc, None)
                        }
                        Err(code) => {
                            tracing::warn!(
                                slug = %slug,
                                code,
                                "x402 verification failed; call will be treated as unpaid"
                            );
                            (false, None, 0, Some(code))
                        }
                    }
                }
            } else {
                tracing::warn!(slug = %slug, "malformed x-payment payload ignored");
                (false, None, 0, Some("x402_payload_malformed"))
            }
        } else {
            (false, None, 0, None)
        };

    // ── 3.5. Enforce x402 challenge for paid routes ─────────────────────
    //
    // Per x402 spec: if a paid route is hit without a verified payment, we
    // MUST return HTTP 402 with a body listing payment requirements. This
    // is what makes Ghola merchants discoverable to any standard x402
    // client without prior knowledge.
    if route.price_micro_usdc > 0 && !requested_paid {
        let resource_url =
            x402_challenge::resource_url_from_request(&req, state.config.trust_proxy_headers);
        match x402_challenge::build_challenge(
            &state.config,
            &route,
            resource_url,
            payment_precheck_error_reason,
        ) {
            Some(body) => {
                let _ = meter::record_call_log(
                    &state.db,
                    route.service_id,
                    caller_agent_did.as_deref(),
                    None,
                    req.method().as_str(),
                    &upstream_path,
                    None,
                    402,
                    start.elapsed().as_millis() as i32,
                    0,
                    0,
                    0,
                    "payment_required",
                    None,
                    payment_precheck_error_reason,
                )
                .await;
                let mut resp =
                    (StatusCode::PAYMENT_REQUIRED, axum::Json(body)).into_response();
                resp.headers_mut().insert(
                    HeaderName::from_static("x-accept-payment"),
                    HeaderValue::from_static("x402"),
                );
                return resp;
            }
            None => {
                tracing::error!(
                    slug = %slug,
                    "x402 challenge skipped: ESCROW_WALLET_ADDRESS not configured"
                );
                return (
                    StatusCode::SERVICE_UNAVAILABLE,
                    "gateway escrow wallet not configured",
                )
                    .into_response();
            }
        }
    }

    // ── 4. Decrypt upstream credential ──────────────────────────────────
    //
    // Short-lived. Drops when this function returns.
    let credential_plaintext = if matches!(route.auth_mode, said_turnkey::AuthMode::None) {
        None
    } else {
        let backend = match static_backend(&route.credential_backend) {
            Some(backend) => backend,
            None => {
                tracing::error!(
                    slug = %slug,
                    backend = %route.credential_backend,
                    "unknown credential backend in route cache"
                );
                return error_response(
                    &state,
                    &route,
                    &caller_agent_did,
                    req.method().as_str(),
                    &upstream_path,
                    start,
                    500,
                    "unknown_credential_backend",
                )
                .await;
            }
        };
        let stored = said_turnkey::StoredCredential {
            backend,
            key_version: route.credential_key_version,
            key_ref: route.credential_key_ref.clone(),
            ciphertext: route.credential_ciphertext.clone(),
            auth_mode: route.auth_mode,
        };
        match state.vault.decrypt(&stored).await {
            Ok(pt) => Some(pt),
            Err(e) => {
                tracing::error!(slug = %slug, "vault decrypt failed: {e}");
                return error_response(
                    &state,
                    &route,
                    &caller_agent_did,
                    req.method().as_str(),
                    &upstream_path,
                    start,
                    500,
                    "credential_decrypt_failed",
                )
                .await;
            }
        }
    };

    // ── 5. Build outbound request ───────────────────────────────────────
    let upstream_url = build_upstream_url(&route.origin_url, &upstream_path, req.uri().query());

    let method_bytes = req.method().clone();
    let reqwest_method = match reqwest_method_from_axum(&method_bytes) {
        Some(m) => m,
        None => {
            return (StatusCode::METHOD_NOT_ALLOWED, "unsupported method").into_response();
        }
    };

    let mut outbound =
        state
            .http
            .request(reqwest_method, &upstream_url)
            .timeout(std::time::Duration::from_secs(
                state.config.upstream_timeout_secs,
            ));

    // Copy safe headers.
    for (name, value) in req.headers() {
        let n = name.as_str().to_ascii_lowercase();
        if should_drop_outbound_header(&n) {
            continue;
        }
        outbound = outbound.header(name.clone(), value.clone());
    }
    // Add caller identity as a stable header for the origin to log.
    if let Some(did) = caller_agent_did.as_deref() {
        if let Ok(hv) = HeaderValue::from_str(did) {
            outbound = outbound.header("x-ghola-caller-did", hv);
        }
    }
    outbound = outbound.header("x-forwarded-by", HeaderValue::from_static("ghola-gateway"));

    // Inject merchant auth.
    let (outbound, final_url) = if let Some(pt) = credential_plaintext.as_deref() {
        match auth_inject::inject(
            outbound,
            route.auth_mode,
            route.auth_header_name.as_deref(),
            pt,
            &upstream_url,
        ) {
            Ok(v) => v,
            Err(e) => {
                tracing::error!(slug = %slug, "auth injection failed: {e}");
                return error_response(
                    &state,
                    &route,
                    &caller_agent_did,
                    method_bytes.as_str(),
                    &upstream_path,
                    start,
                    500,
                    "auth_injection_failed",
                )
                .await;
            }
        }
    } else {
        (outbound, upstream_url.clone())
    };

    // Stream the inbound body through to the origin.
    let body = req.into_body();
    let body_stream = body
        .into_data_stream()
        .map(|r| r.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e)));
    let outbound = outbound.body(reqwest::Body::wrap_stream(body_stream));

    tracing::debug!(slug = %slug, url = %final_url, "forwarding to origin");

    // ── 6. Send upstream ────────────────────────────────────────────────
    let resp_result = outbound.send().await;
    let upstream_resp = match resp_result {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(slug = %slug, "upstream send failed: {e}");
            let reason = if e.is_timeout() {
                "upstream_timeout"
            } else if e.is_connect() {
                "upstream_connect_failed"
            } else {
                "upstream_error"
            };
            return upstream_failure(
                &state,
                &route,
                caller_agent_did.as_deref(),
                method_bytes.as_str(),
                &upstream_path,
                start,
                reason,
            )
            .await;
        }
    };

    let status = upstream_resp.status();
    let upstream_status_code = status.as_u16() as i32;
    let upstream_headers = upstream_resp.headers().clone();

    // ── 7 + 8. Branch on upstream status ────────────────────────────────
    if status.is_server_error() {
        // Stream body for logging purposes? No — keep latency low, drop it.
        drop(upstream_resp);
        return upstream_failure(
            &state,
            &route,
            caller_agent_did.as_deref(),
            method_bytes.as_str(),
            &upstream_path,
            start,
            "upstream_5xx",
        )
        .await;
    }

    // Success (2xx/3xx/4xx). Meter only on 2xx — a 4xx is the caller's fault
    // but still counts as the merchant doing useful work (returning a
    // structured error), so we charge but flag it.
    let meter_ok = status.is_success();

    // Stream response body back to the caller.
    let body_stream = upstream_resp.bytes_stream().map(|r| {
        r.map(Bytes::from)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))
    });

    let mut response = Response::builder().status(status.as_u16());

    // Copy safe response headers.
    for (name, value) in upstream_headers.iter() {
        let n = name.as_str().to_ascii_lowercase();
        if HOP_BY_HOP.iter().any(|h| *h == n) {
            continue;
        }
        response = response.header(name.clone(), value.clone());
    }
    // Always attach our own trace headers so agents can find calls by id.
    let trace_id = Uuid::new_v4().to_string();
    response = response.header("x-ghola-trace-id", trace_id.clone());
    response = response.header("x-ghola-merchant", route.slug.clone());

    let final_response = response
        .body(Body::from_stream(body_stream))
        .unwrap_or_else(|e| {
            tracing::error!("response build failed: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, "response build failed").into_response()
        });

    // Fire-and-forget post-response bookkeeping. We don't want to block the
    // stream return on a DB write.
    let db = state.db.clone();
    let route_clone: Arc<ResolvedRoute> = route.clone();
    let caller_did_owned = caller_agent_did.clone();
    let method_str = method_bytes.as_str().to_string();
    let path_str = upstream_path.clone();
    let signature_owned = x402_tx_signature.clone();
    let elapsed_ms = start.elapsed().as_millis() as i32;
    let requested_paid_call = requested_paid;
    let payment_precheck_reason = payment_precheck_error_reason;

    tokio::spawn(async move {
        let mut charged_amount = 0_i64;
        let mut log_payment_status = if meter_ok { "none" } else { "client_error" };
        let mut log_signature: Option<String> = None;
        let mut log_error_reason: Option<&str> = payment_precheck_reason;

        if meter_ok && requested_paid_call && amount_charged > 0 {
            if let Some(sig) = signature_owned.as_deref() {
                match meter::consume_payment_signature(&db, route_clone.service_id, sig).await {
                    Ok(true) => {
                        charged_amount = amount_charged;
                        log_signature = Some(sig.to_string());
                        log_payment_status = "paid";
                    }
                    Ok(false) => {
                        if log_error_reason.is_none() {
                            log_error_reason = Some("replayed_payment_signature");
                        }
                        tracing::warn!(
                            service_id = %route_clone.service_id,
                            signature = %sig,
                            "replayed x402 signature blocked"
                        );
                    }
                    Err(e) => {
                        if log_error_reason.is_none() {
                            log_error_reason = Some("payment_signature_consume_failed");
                        }
                        tracing::error!(
                            service_id = %route_clone.service_id,
                            "failed to consume payment signature: {e}"
                        );
                    }
                }
            } else {
                if log_error_reason.is_none() {
                    log_error_reason = Some("missing_payment_signature");
                }
            }
        }

        let _ = meter::record_call_log(
            &db,
            route_clone.service_id,
            caller_did_owned.as_deref(),
            None,
            &method_str,
            &path_str,
            Some(upstream_status_code),
            upstream_status_code,
            elapsed_ms,
            0,
            0,
            charged_amount,
            log_payment_status,
            log_signature.as_deref(),
            log_error_reason,
        )
        .await;

        if meter_ok && charged_amount > 0 {
            let did = caller_did_owned.as_deref().unwrap_or("anonymous");
            let _ = meter::record_metered_usage(
                &db,
                route_clone.service_id,
                did,
                &path_str,
                charged_amount,
            )
            .await;
        }

        // Close circuit breaker on success.
        if meter_ok {
            let _ = meter::close_circuit_breaker(&db, route_clone.service_id).await;
        }
    });

    final_response
}

async fn upstream_failure(
    state: &AppState,
    route: &ResolvedRoute,
    caller_did: Option<&str>,
    method: &str,
    path: &str,
    start: Instant,
    reason: &str,
) -> Response {
    let latency_ms = start.elapsed().as_millis() as i32;

    // Log the refund.
    let _ = meter::record_call_log(
        &state.db,
        route.service_id,
        caller_did,
        None,
        method,
        path,
        None,
        504,
        latency_ms,
        0,
        0,
        0,
        "refunded",
        None,
        Some(reason),
    )
    .await;

    // Increment failure counter; trip the breaker only once threshold is hit.
    let reopen_at = Utc::now() + ChronoDuration::seconds(state.config.circuit_open_secs);
    match meter::record_failure_and_maybe_open(
        &state.db,
        route.service_id,
        reopen_at,
        state.config.circuit_failure_threshold,
    )
    .await
    {
        Ok(opened) => {
            if opened {
                tracing::warn!(
                    service_id = %route.service_id,
                    threshold = state.config.circuit_failure_threshold,
                    "circuit breaker opened"
                );
            }
        }
        Err(e) => {
            tracing::error!(service_id = %route.service_id, "failed to record upstream failure: {e}")
        }
    }
    // Force next request to re-read latest breaker/failure state.
    state.cache.invalidate(&route.slug);

    let mut resp = (
        StatusCode::GATEWAY_TIMEOUT,
        format!("upstream origin failed: {reason}"),
    )
        .into_response();
    // The "meter on success" promise is kept via this header: any x402 client
    // seeing X-Payment-Refund should void the inbound payment before sending
    // it to chain. If the payment was already confirmed, said-cloud's
    // settlement loop will include an explicit refund transfer in the next batch.
    resp.headers_mut().insert(
        HeaderName::from_static("x-payment-refund"),
        HeaderValue::from_static("upstream_failure"),
    );
    resp.headers_mut().insert(
        HeaderName::from_static("x-ghola-refund-reason"),
        HeaderValue::from_str(reason).unwrap_or_else(|_| HeaderValue::from_static("unknown")),
    );
    resp
}

async fn error_response(
    state: &AppState,
    route: &ResolvedRoute,
    caller_did: &Option<String>,
    method: &str,
    path: &str,
    start: Instant,
    status: i32,
    reason: &str,
) -> Response {
    let latency_ms = start.elapsed().as_millis() as i32;
    let _ = meter::record_call_log(
        &state.db,
        route.service_id,
        caller_did.as_deref(),
        None,
        method,
        path,
        None,
        status,
        latency_ms,
        0,
        0,
        0,
        "failed",
        None,
        Some(reason),
    )
    .await;

    let status_code =
        StatusCode::from_u16(status as u16).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    (status_code, format!("gateway error: {reason}")).into_response()
}

/// Concatenate origin + remaining path + query string.
fn build_upstream_url(origin: &str, upstream_path: &str, query: Option<&str>) -> String {
    let base = origin.trim_end_matches('/');
    let path = upstream_path.trim_start_matches('/');
    let mut out = if path.is_empty() {
        base.to_string()
    } else {
        format!("{base}/{path}")
    };
    if let Some(q) = query {
        if !q.is_empty() {
            out.push('?');
            out.push_str(q);
        }
    }
    out
}

fn reqwest_method_from_axum(m: &Method) -> Option<reqwest::Method> {
    reqwest::Method::from_bytes(m.as_str().as_bytes()).ok()
}

/// Translate a DB-loaded backend string into the `&'static str` that
/// [`said_turnkey::StoredCredential::backend`] expects. Unknown values are
/// rejected by the caller.
fn static_backend(s: &str) -> Option<&'static str> {
    match s {
        "local" => Some("local"),
        "turnkey" => Some("turnkey"),
        _ => None,
    }
}

fn is_allowed_method(method: &Method) -> bool {
    matches!(
        method,
        &Method::GET
            | &Method::POST
            | &Method::PUT
            | &Method::DELETE
            | &Method::PATCH
            | &Method::HEAD
            | &Method::OPTIONS
    )
}

fn should_drop_outbound_header(lower_name: &str) -> bool {
    HOP_BY_HOP.iter().any(|h| *h == lower_name)
        || INBOUND_PAYMENT_HEADERS.iter().any(|h| *h == lower_name)
        || BLOCKED_HEADER_EXACT.iter().any(|h| *h == lower_name)
        || BLOCKED_HEADER_PREFIXES
            .iter()
            .any(|prefix| lower_name.starts_with(prefix))
}

async fn ensure_safe_upstream_origin(origin_url: &str) -> Result<(), String> {
    let parsed = url::Url::parse(origin_url).map_err(|e| format!("invalid origin URL: {e}"))?;
    let host = parsed
        .host_str()
        .ok_or_else(|| "origin URL missing host".to_string())?
        .to_ascii_lowercase();

    if is_blocked_hostname(&host) {
        return Err(format!("blocked hostname '{host}'"));
    }

    if let Ok(ip) = host.parse::<IpAddr>() {
        if is_blocked_ip(ip) {
            return Err(format!("blocked IP '{ip}'"));
        }
        return Ok(());
    }

    let port = parsed
        .port_or_known_default()
        .unwrap_or(if parsed.scheme() == "http" { 80 } else { 443 });
    if is_blocked_port(port) {
        return Err(format!("blocked port '{port}'"));
    }
    let resolved = tokio::net::lookup_host((host.as_str(), port))
        .await
        .map_err(|e| format!("DNS lookup failed: {e}"))?;

    let mut resolved_any = false;
    for addr in resolved {
        resolved_any = true;
        if is_blocked_ip(addr.ip()) {
            return Err(format!("hostname resolves to blocked IP '{}'", addr.ip()));
        }
    }
    if !resolved_any {
        return Err("hostname resolved to zero addresses".to_string());
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
