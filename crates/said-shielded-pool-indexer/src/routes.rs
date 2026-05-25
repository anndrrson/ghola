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

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Json},
    routing::get,
    Router,
};
use serde::{Deserialize, Serialize};

use said_shielded_pool_types::{Commitment, FIELD_BYTES, ROOT_HISTORY_SIZE, TREE_DEPTH};

use crate::error::Error;
use crate::state::AppState;

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/tree-state", get(tree_state))
        .route("/witness", get(witness))
        .route("/root-history", get(root_history))
        .with_state(state)
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

async fn witness(
    State(st): State<AppState>,
    Query(q): Query<WitnessQuery>,
) -> Result<axum::response::Response, ApiError> {
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
