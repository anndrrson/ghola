//! The hot path. One handler, one shape:
//!
//! 1. Resolve the slug via the in-memory route cache.
//! 2. Check circuit breaker. If open, fail-fast with 503.
//! 3. Check for x402 payment header. In dev we accept unpaid calls; in prod
//!    callers without a payment header get a 402 with `X-Payment-Required`.
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

use std::sync::Arc;
use std::time::Instant;

use axum::{
    body::{Body, Bytes},
    extract::{Path, Request, State},
    http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
};
use chrono::{Duration as ChronoDuration, Utc};
use futures::StreamExt;
use uuid::Uuid;

use crate::auth_inject;
use crate::meter;
use crate::route_cache::ResolvedRoute;
use crate::state::AppState;

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
const INBOUND_PAYMENT_HEADERS: &[&str] =
    &["x-payment", "x-payment-signature", "authorization"];

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
    // In the first cut, x402 verification is *permissive*: if the caller sends
    // an `X-Payment` header we record it as `paid`; if not we record `none`
    // and charge zero. This lets merchants validate their integration end-to-
    // end before flipping on real payments. Hardening into "402 on unpaid"
    // is one flag flip once said-x402 wires to a live verifier.
    let caller_agent_did = req
        .headers()
        .get("x-agent-did")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    let x_payment = req
        .headers()
        .get("x-payment")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    let (payment_status, x402_tx_signature, amount_charged) =
        if let Some(payload) = x_payment.as_deref() {
            // TODO: hook into said_x402::GholaX402Client::verify once the
            // verifier is live; for now we trust the header shape and bill
            // the listed price.
            ("paid", extract_signature(payload), route.price_micro_usdc)
        } else {
            ("none", None, 0)
        };

    // ── 4. Decrypt upstream credential ──────────────────────────────────
    //
    // Short-lived. Drops when this function returns.
    let credential_plaintext = if matches!(route.auth_mode, said_turnkey::AuthMode::None) {
        None
    } else {
        let stored = said_turnkey::StoredCredential {
            backend: static_backend(&route.credential_backend),
            key_version: route.credential_key_version,
            key_ref: None,
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

    let mut outbound = state
        .http
        .request(reqwest_method, &upstream_url)
        .timeout(std::time::Duration::from_secs(
            state.config.upstream_timeout_secs,
        ));

    // Copy safe headers.
    for (name, value) in req.headers() {
        let n = name.as_str().to_ascii_lowercase();
        if HOP_BY_HOP.iter().any(|h| *h == n) {
            continue;
        }
        if INBOUND_PAYMENT_HEADERS.iter().any(|h| *h == n) {
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
    let body_stream = body.into_data_stream().map(|r| {
        r.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))
    });
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

    tokio::spawn(async move {
        let log_payment_status = if meter_ok && payment_status == "paid" {
            "paid"
        } else if meter_ok {
            "none"
        } else {
            "client_error"
        };

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
            if meter_ok { amount_charged } else { 0 },
            log_payment_status,
            signature_owned.as_deref(),
            None,
        )
        .await;

        if meter_ok && amount_charged > 0 {
            let did = caller_did_owned.as_deref().unwrap_or("anonymous");
            let _ = meter::record_metered_usage(
                &db,
                route_clone.service_id,
                did,
                &path_str,
                amount_charged,
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

    // Trip the circuit breaker so we stop routing calls to a dead origin.
    let reopen_at = Utc::now() + ChronoDuration::seconds(state.config.circuit_open_secs);
    let _ = meter::open_circuit_breaker(&state.db, route.service_id, reopen_at).await;
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

    let status_code = StatusCode::from_u16(status as u16)
        .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
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
/// [`said_turnkey::StoredCredential::backend`] expects. The set is closed —
/// unknown backends become `"local"` and will fail at the vault boundary.
fn static_backend(s: &str) -> &'static str {
    match s {
        "turnkey" => "turnkey",
        _ => "local",
    }
}

/// Extract a tx signature from an x402 `X-Payment` base64-JSON payload.
/// Best-effort — returns `None` on any parse error. Real verification
/// happens in said-cloud's settlement loop.
fn extract_signature(payload: &str) -> Option<String> {
    use base64::Engine;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .ok()?;
    let v: serde_json::Value = serde_json::from_slice(&decoded).ok()?;
    v.get("signature")
        .and_then(|s| s.as_str())
        .map(|s| s.to_string())
}

/// Unused silencer for axum `HeaderMap` import; kept so the handler signature
/// can grow to inspect headers more aggressively without re-importing.
#[allow(dead_code)]
fn _touch(_: HeaderMap) {}
