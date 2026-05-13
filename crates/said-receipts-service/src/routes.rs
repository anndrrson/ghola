//! HTTP routes.
//!
//! Two endpoints carry the contract:
//! - `POST /v1/receipts` accepts a `ReceiptV1`, hashes the canonical
//!   body, and records it. Returns the hex-encoded hash so the client
//!   can immediately use it as a lookup key.
//! - `GET /v1/receipts/:hash/proof` returns either a Merkle inclusion
//!   proof + the Solana signature (200) or 202 Accepted if the
//!   receipt is still pending.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Serialize;

use crate::merkle::{build_tree, proof_for_leaf};
use crate::receipt::ReceiptV1;
use crate::storage::{ReceiptsStore, StorageError};

#[derive(Clone)]
pub struct AppState {
    pub store: Arc<dyn ReceiptsStore>,
    /// Used as the "estimated_anchor_at" projection in the pending
    /// response. Just `now + interval_secs`.
    pub batcher_interval_secs: u64,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/v1/receipts", post(post_receipt))
        .route("/v1/receipts/{hash}/proof", get(get_proof))
        .with_state(state)
}

async fn healthz() -> &'static str {
    "ok"
}

#[derive(Serialize)]
struct PostResponse {
    receipt_hash: String,
}

async fn post_receipt(
    State(state): State<AppState>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<PostResponse>, ApiError> {
    // Parse into a typed ReceiptV1 to validate shape, but persist the
    // original JSON so future schema versions still survive.
    let receipt: ReceiptV1 = serde_json::from_value(body.clone())
        .map_err(|e| ApiError::BadRequest(format!("invalid receipt: {e}")))?;
    let hash = receipt.hash();
    state.store.insert_receipt(hash, &body).await?;
    Ok(Json(PostResponse {
        receipt_hash: hex::encode(hash),
    }))
}

#[derive(Serialize)]
struct ProofResponse {
    receipt_hash: String,
    batch_root: String,
    merkle_proof: Vec<String>,
    leaf_index: i32,
    period_start_unix: i64,
    period_end_unix: i64,
    solana_signature: String,
}

#[derive(Serialize)]
struct PendingResponse {
    status: &'static str,
    estimated_anchor_at: i64,
}

async fn get_proof(
    State(state): State<AppState>,
    Path(hash_hex): Path<String>,
) -> Result<axum::response::Response, ApiError> {
    let hash_bytes = hex::decode(&hash_hex)
        .map_err(|e| ApiError::BadRequest(format!("invalid hex: {e}")))?;
    if hash_bytes.len() != 32 {
        return Err(ApiError::BadRequest("hash must be 32 bytes".into()));
    }
    let mut hash = [0u8; 32];
    hash.copy_from_slice(&hash_bytes);

    let lookup = state
        .store
        .lookup_receipt(hash)
        .await?
        .ok_or(ApiError::NotFound)?;

    let (Some(batch_id), Some(leaf_index)) = (lookup.batch_id, lookup.leaf_index) else {
        // Pending: project an ETA for the next anchor based on the
        // batcher cadence. Not authoritative — clients should poll.
        let eta = chrono::Utc::now().timestamp() + state.batcher_interval_secs as i64;
        return Ok((
            StatusCode::ACCEPTED,
            Json(PendingResponse {
                status: "pending",
                estimated_anchor_at: eta,
            }),
        )
            .into_response());
    };

    let batch = state.store.batch_for_id(batch_id).await?;
    let Some(sig) = batch.solana_signature.clone() else {
        // Batch row exists but hasn't been anchored on-chain yet.
        // Treated the same as pending from the client's perspective.
        let eta = chrono::Utc::now().timestamp() + state.batcher_interval_secs as i64;
        return Ok((
            StatusCode::ACCEPTED,
            Json(PendingResponse {
                status: "pending",
                estimated_anchor_at: eta,
            }),
        )
            .into_response());
    };

    // Rebuild the proof from the persisted leaves so we don't have to
    // keep a tree in memory between batcher restarts.
    let leaves = state.store.leaves_for_batch(batch_id).await?;
    let tree = build_tree(&leaves);
    let proof = proof_for_leaf(&tree, leaf_index as usize);

    let resp = ProofResponse {
        receipt_hash: hash_hex,
        batch_root: hex::encode(batch.root),
        merkle_proof: proof.iter().map(hex::encode).collect(),
        leaf_index,
        period_start_unix: batch.period_start_unix,
        period_end_unix: batch.period_end_unix,
        solana_signature: sig,
    };
    Ok((StatusCode::OK, Json(resp)).into_response())
}

// -----------------------------------------------------------------
// Error type.
// -----------------------------------------------------------------

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("bad request: {0}")]
    BadRequest(String),
    #[error("not found")]
    NotFound,
    #[error("storage: {0}")]
    Storage(#[from] StorageError),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        let (status, msg) = match &self {
            ApiError::BadRequest(m) => (StatusCode::BAD_REQUEST, m.clone()),
            ApiError::NotFound => (StatusCode::NOT_FOUND, "not found".to_string()),
            ApiError::Storage(StorageError::NotFound) => {
                (StatusCode::NOT_FOUND, "not found".to_string())
            }
            ApiError::Storage(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        };
        (status, Json(serde_json::json!({"error": msg}))).into_response()
    }
}

