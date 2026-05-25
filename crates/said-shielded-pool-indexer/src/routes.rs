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
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
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
    Query(q): Query<WitnessQuery>,
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
                [("Retry-After", WITNESS_RATE_LIMIT_RETRY_AFTER_SECS.to_string())],
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
    let leaf_index = tree
        .leaf_index_of(&commitment)?
        .ok_or(ApiError::NotFound)?;
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
        // Internal/database detail is logged server-side only; clients always
        // get a generic 500 body. BadRequest carries client-actionable
        // validation text (e.g. "commitment must be 32 bytes"), which is safe
        // to surface.
        let (status, msg): (StatusCode, String) = match self {
            Self::BadRequest(m) => (StatusCode::BAD_REQUEST, m),
            Self::NotFound => (StatusCode::NOT_FOUND, "commitment not found".into()),
            Self::Internal(detail) => {
                tracing::error!(error = %detail, "indexer internal error");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal error".to_string(),
                )
            }
        };
        (status, Json(serde_json::json!({ "error": msg }))).into_response()
    }
}
