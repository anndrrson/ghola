//! Axum HTTP routes — the public witness API.
//!
//! | Method | Path             | Purpose |
//! |--------|------------------|---------|
//! | GET    | `/healthz`       | liveness + indexer height |
//! | GET    | `/tree-state`    | current root, next_index, depth |
//! | GET    | `/witness`       | Merkle path for a commitment |
//! | GET    | `/root-history`  | last `ROOT_HISTORY_SIZE` roots |
//!
//! All responses are JSON. `commitment`, `root`, and `siblings` are
//! returned as lowercase hex strings without `0x` prefix.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::{
    extract::{FromRequestParts, Query, State},
    http::{request::Parts, HeaderMap, StatusCode},
    response::{IntoResponse, Json},
    routing::get,
    Router,
};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::timeout::TimeoutLayer;

use said_shielded_pool_types::{Commitment, FIELD_BYTES, ROOT_HISTORY_SIZE, TREE_DEPTH};

use crate::error::Error;
use crate::state::AppState;

/// Per-IP fixed-window rate limiter. Mirrors the relayer's
/// `said_shielded_pool_relayer::routes::IpRateLimiter`: a coarse
/// `IpAddr -> (window_minute, count)` map, nothing persisted or logged.
#[derive(Clone, Default)]
pub struct IpRateLimiter {
    windows: Arc<Mutex<HashMap<IpAddr, (i64, u32)>>>,
}

impl IpRateLimiter {
    /// `true` if allowed, `false` if the per-minute limit is exceeded.
    /// `max_per_min == 0` disables limiting.
    pub async fn check(&self, ip: IpAddr, max_per_min: u32) -> bool {
        if max_per_min == 0 {
            return true;
        }
        let now_minute = now_unix_secs() / 60;
        let mut windows = self.windows.lock().await;
        let entry = windows.entry(ip).or_insert((now_minute, 0));
        if entry.0 != now_minute {
            *entry = (now_minute, 1);
            return true;
        }
        entry.1 += 1;
        entry.1 <= max_per_min
    }
}

fn now_unix_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Resolve the rate-limit client identity.
///
/// `X-Forwarded-For` is honored ONLY when the connecting peer is in
/// `trusted_proxies` (taking the rightmost valid entry the proxy appended).
/// For any untrusted peer we ignore XFF and key on the socket peer — otherwise
/// a direct client could forge XFF to rotate its identity every request. An
/// IPv4-mapped IPv6 peer (`::ffff:a.b.c.d`) is normalized to its v4 form before
/// the trusted-proxy membership check. Returns `None` when there is no peer
/// (e.g. tests using a bare `axum::serve`), in which case limiting is skipped.
pub fn client_ip(
    headers: &HeaderMap,
    conn: Option<IpAddr>,
    trusted_proxies: &std::collections::HashSet<IpAddr>,
) -> Option<IpAddr> {
    let peer = normalize_peer(conn?);
    if trusted_proxies.contains(&peer) {
        if let Some(xff_ip) = headers
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.split(',').rev().find_map(|part| part.trim().parse().ok()))
        {
            return Some(xff_ip);
        }
    }
    Some(peer)
}

/// Collapse an IPv4-mapped IPv6 address to its canonical v4 form.
fn normalize_peer(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => IpAddr::V4(v4),
            None => IpAddr::V6(v6),
        },
        v4 => v4,
    }
}

/// The single opaque body the indexer returns for ANY client-side error
/// (malformed query/path, extractor rejection, unknown route/method). The
/// real reason is logged at `tracing::debug!` and never put on the wire, so
/// the HTTP surface can't be used to probe parser internals or distinguish
/// failure modes.
fn opaque_bad_request() -> axum::response::Response {
    (
        StatusCode::BAD_REQUEST,
        Json(serde_json::json!({ "error": "bad request" })),
    )
        .into_response()
}

/// `Query<T>` wrapper that collapses EVERY extractor rejection (missing param,
/// parse failure, malformed query string) into the indexer's fixed opaque
/// `{"error":"bad request"}` body. The default `Query` rejection echoes serde
/// detail like "missing query parameter `commitment`" / parse messages, which
/// is a response-surface leak; we log that detail at `debug!` instead.
pub struct OpaqueQuery<T>(pub T);

impl<T, S> FromRequestParts<S> for OpaqueQuery<T>
where
    Query<T>: FromRequestParts<S, Rejection = axum::extract::rejection::QueryRejection>,
    S: Send + Sync,
{
    type Rejection = axum::response::Response;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        match Query::<T>::from_request_parts(parts, state).await {
            Ok(Query(value)) => Ok(Self(value)),
            Err(rejection) => {
                tracing::debug!(reason = %rejection, "rejected query extraction");
                Err(opaque_bad_request())
            }
        }
    }
}

/// Router fallback for unknown routes / unsupported methods. Returns the same
/// fixed opaque body as every other client error so a probe can't enumerate
/// which paths exist via differing 404/405 bodies.
async fn opaque_fallback() -> axum::response::Response {
    opaque_bad_request()
}

pub fn router(state: AppState) -> Router {
    // Bound the witness path's blast radius:
    //   - `GlobalConcurrencyLimitLayer` caps simultaneous in-flight requests so
    //     a burst can't pin every core on the (Poseidon-touching) witness path.
    //   - `TimeoutLayer` enforces a hard per-request deadline.
    //   - `RequestBodyLimitLayer` cheaply rejects oversized bodies.
    // Per-IP rate limiting is applied inside the `witness` handler itself (it
    // needs ConnectInfo + the trusted-proxy config from AppState).
    let max_conc = state.cfg.witness_max_concurrency;
    let timeout = Duration::from_secs(state.cfg.witness_timeout_secs.max(1));

    let router = Router::new()
        .route("/healthz", get(healthz))
        .route("/tree-state", get(tree_state))
        .route("/witness", get(witness))
        .route("/root-history", get(root_history))
        // 404/405 return the same opaque body as every other client error so a
        // probe can't enumerate routes/methods via differing error bodies.
        .fallback(opaque_fallback)
        .layer(TimeoutLayer::with_status_code(
            StatusCode::SERVICE_UNAVAILABLE,
            timeout,
        ))
        .layer(RequestBodyLimitLayer::new(8 * 1024));

    let router = if max_conc > 0 {
        router.layer(tower::limit::GlobalConcurrencyLimitLayer::new(max_conc))
    } else {
        router
    };

    router.with_state(state)
}

#[derive(Serialize)]
struct HealthResp {
    ok: bool,
    next_index: u64,
    depth: usize,
}

async fn healthz(State(st): State<AppState>) -> impl IntoResponse {
    // NOTE (zero-leakage review): `next_index`/`depth` are intentionally
    // public — they are on-chain-derivable tree state (the queue position is
    // emitted by the program and the depth is a protocol constant). This is
    // NOT a leak; do not redact it.
    let tree = st.tree.read().await;
    Json(HealthResp {
        ok: true,
        next_index: tree.next_index(),
        depth: tree.depth(),
    })
}

#[derive(Serialize)]
struct TreeStateResp {
    root: String,
    next_index: u64,
    depth: usize,
    root_history_size: usize,
    tree_capacity: u64,
}

async fn tree_state(State(st): State<AppState>) -> axum::response::Response {
    // NOTE (zero-leakage review): `root`, `next_index`, `depth`, and the
    // staleness `age_secs` are intentionally public — all are on-chain-derivable
    // shielded-pool state (the root is published on-chain, the index is the
    // queue position, depth/history-size are protocol constants). This is NOT a
    // leak; do not redact it.
    if let Some(resp) = stale_response(&st) {
        return resp;
    }
    let tree = st.tree.read().await;
    Json(TreeStateResp {
        root: hex::encode(tree.root().0),
        next_index: tree.next_index(),
        depth: tree.depth(),
        root_history_size: ROOT_HISTORY_SIZE,
        tree_capacity: crate::tree::tree_capacity(),
    })
    .into_response()
}

/// Returns `Some(503)` if the listener hasn't observed a fresh on-chain
/// payload in the configured staleness window. Used by `/witness` and
/// `/tree-state` so clients don't build proofs against a root the chain
/// has already rotated past.
fn stale_response(st: &AppState) -> Option<axum::response::Response> {
    let age = st.root_age_secs();
    let threshold = st.cfg.staleness_threshold_secs;
    if age > threshold {
        // Cap `age_secs` for the response so a freshly-started node
        // doesn't emit `u64::MAX` (which round-trips as a non-JSON-safe
        // number in some clients).
        let reported_age = age.min(u64::from(u32::MAX));
        return Some(
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(serde_json::json!({
                    "error": "stale_state",
                    "age_secs": reported_age,
                    "threshold": threshold,
                })),
            )
                .into_response(),
        );
    }
    None
}

#[derive(Deserialize)]
struct WitnessQuery {
    commitment: String,
}

#[derive(Serialize)]
struct WitnessResp {
    commitment: String,
    leaf_index: u64,
    siblings: Vec<String>,
    path_bits: Vec<bool>,
    root: String,
    depth: usize,
}

/// Retry-After (seconds) returned with HTTP 429 when the per-IP witness rate
/// limit is hit. Aligned with the per-minute window.
const WITNESS_RATE_LIMIT_RETRY_AFTER_SECS: u64 = 60;

async fn witness(
    State(st): State<AppState>,
    headers: HeaderMap,
    OpaqueQuery(q): OpaqueQuery<WitnessQuery>,
    req: axum::extract::Request,
) -> Result<axum::response::Response, ApiError> {
    // ----- per-IP rate limit (DoS bound) -----
    // Runs before any tree work or hex parsing so a flood is cheap to reject.
    // Keyed on the resolved client identity (trusted-proxy XFF, else peer). The
    // peer comes from `ConnectInfo` in the request extensions (present in prod
    // via `into_make_service_with_connect_info`; absent in bare-serve tests, in
    // which case there's no peer to key on and limiting is skipped).
    let conn_ip = req
        .extensions()
        .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
        .map(|ci| ci.0.ip());
    if let Some(ip) = client_ip(&headers, conn_ip, &st.cfg.trusted_proxies) {
        if !st
            .witness_rate_limiter
            .check(ip, st.cfg.witness_rate_limit_per_min)
            .await
        {
            return Ok((
                StatusCode::TOO_MANY_REQUESTS,
                [(
                    "Retry-After",
                    WITNESS_RATE_LIMIT_RETRY_AFTER_SECS.to_string(),
                )],
                Json(serde_json::json!({ "error": "rate_limited" })),
            )
                .into_response());
        }
    }

    if let Some(resp) = stale_response(&st) {
        return Ok(resp);
    }
    let commitment_bytes = hex::decode(q.commitment.trim_start_matches("0x"))
        .map_err(|e| ApiError::BadRequest(format!("commitment hex: {e}")))?;
    if commitment_bytes.len() != FIELD_BYTES {
        return Err(ApiError::BadRequest(format!(
            "commitment must be {FIELD_BYTES} bytes, got {}",
            commitment_bytes.len()
        )));
    }
    let mut c = [0u8; FIELD_BYTES];
    c.copy_from_slice(&commitment_bytes);
    let commitment = Commitment(c);

    let tree = st.tree.read().await;
    let leaf_index = tree.leaf_index_of(&commitment)?.ok_or(ApiError::NotFound)?;
    let path = tree.path(leaf_index)?;
    let siblings = path.siblings.iter().map(hex::encode).collect();

    Ok(Json(WitnessResp {
        commitment: q.commitment,
        leaf_index,
        siblings,
        path_bits: path.path_bits,
        root: hex::encode(tree.root().0),
        depth: TREE_DEPTH,
    })
    .into_response())
}

#[derive(Serialize)]
struct RootHistoryResp {
    roots: Vec<String>,
    head: String,
}

async fn root_history(State(st): State<AppState>) -> Result<Json<RootHistoryResp>, ApiError> {
    let tree = st.tree.read().await;
    let history = tree.root_history()?;
    Ok(Json(RootHistoryResp {
        roots: history.iter().map(hex::encode).collect(),
        head: hex::encode(tree.root().0),
    }))
}

/// API-layer error mapper.
pub enum ApiError {
    BadRequest(String),
    NotFound,
    Internal(String),
}

impl From<Error> for ApiError {
    fn from(e: Error) -> Self {
        match e {
            Error::CommitmentNotFound => Self::NotFound,
            Error::LeafIndexOutOfRange(_, _) => Self::BadRequest(e.to_string()),
            other => Self::Internal(other.to_string()),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        // Zero-leakage policy: clients NEVER receive parser/validation/internal
        // detail. BadRequest's inner message (e.g. "commitment hex: <serde
        // detail>", "commitment must be 32 bytes, got X") is logged at `debug!`
        // and replaced with a fixed opaque body so the HTTP surface can't be
        // used to probe input-parsing internals. Internal detail is logged at
        // `error!` and likewise collapsed to a generic 500. NotFound keeps a
        // fixed string ("commitment not found") because absence is an intended,
        // detail-free protocol signal.
        let (status, msg): (StatusCode, &str) = match self {
            Self::BadRequest(m) => {
                tracing::debug!(reason = %m, "rejected request (bad request)");
                (StatusCode::BAD_REQUEST, "bad request")
            }
            Self::NotFound => (StatusCode::NOT_FOUND, "commitment not found"),
            Self::Internal(detail) => {
                tracing::error!(error = %detail, "indexer internal error");
                (StatusCode::INTERNAL_SERVER_ERROR, "internal error")
            }
        };
        (status, Json(serde_json::json!({ "error": msg }))).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use axum::extract::FromRequestParts;
    use axum::http::Request;

    /// Collect a response body into a `String` for assertions.
    async fn body_string(resp: axum::response::Response) -> String {
        let bytes = to_bytes(resp.into_body(), 64 * 1024)
            .await
            .expect("read body");
        String::from_utf8(bytes.to_vec()).expect("utf8 body")
    }

    /// The `BadRequest` mapping must surface the FIXED opaque body and NEVER
    /// the inner (potentially parser-derived) detail.
    #[tokio::test]
    async fn bad_request_maps_to_opaque_body() {
        let detail = "commitment must be 32 bytes, got 7";
        let resp = ApiError::BadRequest(detail.to_string()).into_response();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

        let body = body_string(resp).await;
        assert_eq!(body, r#"{"error":"bad request"}"#);
        // No inner detail leaks onto the wire.
        assert!(!body.contains("32 bytes"), "leaked length detail: {body}");
        assert!(!body.contains("got 7"), "leaked length detail: {body}");
    }

    /// `NotFound` stays a fixed, detail-free protocol signal.
    #[tokio::test]
    async fn not_found_maps_to_fixed_string() {
        let resp = ApiError::NotFound.into_response();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            body_string(resp).await,
            r#"{"error":"commitment not found"}"#
        );
    }

    /// `Internal` is opaque (detail logged at ERROR, not surfaced).
    #[tokio::test]
    async fn internal_maps_to_opaque_body() {
        let resp = ApiError::Internal("sled: backing store on fire".to_string()).into_response();
        assert_eq!(resp.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let body = body_string(resp).await;
        assert_eq!(body, r#"{"error":"internal error"}"#);
        assert!(!body.contains("sled"), "leaked internal detail: {body}");
    }

    /// Drive the `OpaqueQuery<WitnessQuery>` extractor with a URI and return
    /// the body of whatever rejection (or success) it produces.
    async fn extract_witness_query(uri: &str) -> (StatusCode, String) {
        let req = Request::builder().uri(uri).body(()).expect("build request");
        let (mut parts, _) = req.into_parts();
        match OpaqueQuery::<WitnessQuery>::from_request_parts(&mut parts, &()).await {
            Ok(_) => (StatusCode::OK, String::new()),
            Err(resp) => {
                let status = resp.status();
                (status, body_string(resp).await)
            }
        }
    }

    /// A missing `commitment` param must yield the opaque body with NO serde
    /// "missing query parameter" detail.
    #[tokio::test]
    async fn opaque_query_missing_param_is_opaque() {
        let (status, body) = extract_witness_query("/witness").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body, r#"{"error":"bad request"}"#);
        assert!(
            !body.to_lowercase().contains("commitment") && !body.contains("missing"),
            "leaked extractor detail: {body}"
        );
    }

    /// A garbage query string that fails to deserialize into `WitnessQuery`
    /// must also collapse to the opaque body (no serde detail).
    #[tokio::test]
    async fn opaque_query_garbage_is_opaque() {
        // `commitment` expects a string; a repeated/array-shaped param trips
        // the serde_urlencoded deserializer used by `Query`.
        let (status, body) = extract_witness_query("/witness?not_commitment=foo").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body, r#"{"error":"bad request"}"#);
        assert!(!body.contains("commitment"), "leaked field name: {body}");
    }

    /// The witness handler maps a wrong-length / bad-hex commitment to
    /// `BadRequest` *inside* the handler; assert that path is opaque too
    /// (mirrors `witness()`'s hex-decode + length-check error mapping).
    #[tokio::test]
    async fn handler_length_check_is_opaque() {
        // 14 hex chars => 7 bytes, not FIELD_BYTES.
        let short = "aabbccddeeff00";
        let bytes = hex::decode(short).unwrap();
        let resp = ApiError::BadRequest(format!(
            "commitment must be {FIELD_BYTES} bytes, got {}",
            bytes.len()
        ))
        .into_response();
        let body = body_string(resp).await;
        assert_eq!(body, r#"{"error":"bad request"}"#);
        assert!(!body.contains("got 7"), "leaked length: {body}");
    }
}
