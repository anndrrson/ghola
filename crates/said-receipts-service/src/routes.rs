//! HTTP routes.
//!
//! Two endpoints carry the contract:
//! - `POST /v1/receipts` accepts a `ReceiptV1`, hashes the canonical
//!   body, and records it. Returns the hex-encoded hash so the client
//!   can immediately use it as a lookup key.
//! - `GET /v1/receipts/:hash` returns the persisted receipt JSON body
//!   and the current anchoring status.
//! - `GET /v1/receipts/:hash/proof` returns either a Merkle inclusion
//!   proof + the Solana signature (200) or 202 Accepted if the
//!   receipt is still pending.

use std::sync::{Arc, OnceLock};
use std::time::Instant;

use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Serialize;
use serde_json::{json, Value};
use tower_http::cors::CorsLayer;
use tower_http::set_header::SetResponseHeaderLayer;

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

fn service_started_at() -> &'static Instant {
    static STARTED_AT: OnceLock<Instant> = OnceLock::new();
    STARTED_AT.get_or_init(Instant::now)
}

fn uptime_secs() -> u64 {
    service_started_at().elapsed().as_secs()
}

/// HTTP-surface hardening knobs for the receipts service. Mirrors the
/// shape of `thumper_relay::config::RelayConfig` so operators can reason
/// about both services with the same mental model.
#[derive(Debug, Clone)]
pub struct ReceiptsServiceConfig {
    /// Max body size accepted by `POST /v1/receipts`. Defaults to 64 KiB —
    /// receipts are small JSON blobs with two SHA-256 hashes + a sig.
    pub max_body_size_bytes: usize,
    /// CORS allowlist. Production defaults to `["https://ghola.xyz"]`.
    pub cors_allowed_origins: Vec<String>,
    /// When true (matched against `RECEIPTS_DEV_MODE=1`), CORS degrades
    /// to permissive so any localhost origin works without ceremony.
    pub dev_mode: bool,
}

impl ReceiptsServiceConfig {
    /// Construct from environment. Matches the env-var conventions used
    /// elsewhere in the workspace (THUMPER_/SAID_/RECEIPTS_ prefixes).
    pub fn from_env() -> Self {
        let max_body = std::env::var("RECEIPTS_MAX_BODY_SIZE_BYTES")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(64 * 1024);
        let dev_mode = std::env::var("RECEIPTS_DEV_MODE")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false);
        let cors_allowed_origins = std::env::var("RECEIPTS_CORS_ALLOWED_ORIGINS")
            .ok()
            .map(|s| {
                s.split(',')
                    .map(|p| p.trim().to_string())
                    .filter(|p| !p.is_empty())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_else(|| vec!["https://ghola.xyz".to_string()]);
        Self {
            max_body_size_bytes: max_body,
            cors_allowed_origins,
            dev_mode,
        }
    }
}

impl Default for ReceiptsServiceConfig {
    fn default() -> Self {
        Self {
            max_body_size_bytes: 64 * 1024,
            cors_allowed_origins: vec!["https://ghola.xyz".to_string()],
            dev_mode: false,
        }
    }
}

fn build_cors_layer(config: &ReceiptsServiceConfig) -> CorsLayer {
    use axum::http::{HeaderValue, Method};

    if config.dev_mode {
        return CorsLayer::permissive();
    }

    let origins: Vec<HeaderValue> = config
        .cors_allowed_origins
        .iter()
        .filter_map(|o| HeaderValue::from_str(o).ok())
        .collect();

    CorsLayer::new()
        .allow_origin(origins)
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([
            axum::http::header::CONTENT_TYPE,
            axum::http::header::AUTHORIZATION,
        ])
}

/// Build the router with default hardening configuration (suitable for
/// tests and existing call sites that don't pass an explicit config).
pub fn router(state: AppState) -> Router {
    router_with_config(state, ReceiptsServiceConfig::default())
}

/// Build the router with an explicit `ReceiptsServiceConfig`. The
/// binary entrypoint uses this so prod can tune body limits + CORS via
/// env vars without rebuilding.
pub fn router_with_config(state: AppState, config: ReceiptsServiceConfig) -> Router {
    let cors = build_cors_layer(&config);
    let max_body = config.max_body_size_bytes;

    // Public verifier paths are fetched from the cross-origin `/r/<hash>`
    // verifier page, so they must carry
    // `Cross-Origin-Resource-Policy: cross-origin` to avoid a CORP
    // block. Every other route (incl. `POST /v1/receipts`) defaults to
    // same-origin via the broader layer below.
    let public_receipt_router = Router::new()
        .route("/v1/receipts/{hash}", get(get_receipt))
        .route("/v1/receipts/{hash}/proof", get(get_proof))
        .layer(SetResponseHeaderLayer::overriding(
            axum::http::HeaderName::from_static("cross-origin-resource-policy"),
            axum::http::HeaderValue::from_static("cross-origin"),
        ));

    Router::new()
        .route("/health", get(health))
        .route("/healthz", get(healthz))
        .route("/ready", get(ready))
        .route("/v1/receipts", post(post_receipt))
        .merge(public_receipt_router)
        .layer(DefaultBodyLimit::max(max_body))
        .layer(SetResponseHeaderLayer::if_not_present(
            axum::http::HeaderName::from_static("cross-origin-resource-policy"),
            axum::http::HeaderValue::from_static("same-origin"),
        ))
        .layer(cors)
        .with_state(state)
}

async fn health(State(state): State<AppState>) -> Json<Value> {
    Json(receipts_health_body(&state, true).await)
}

async fn healthz() -> Json<Value> {
    Json(json!({
        "status": "ok",
        "service": "said-receipts-service",
        "version": env!("CARGO_PKG_VERSION"),
        "uptime_secs": uptime_secs(),
        "timestamp": chrono::Utc::now().to_rfc3339(),
    }))
}

async fn ready(State(state): State<AppState>) -> impl IntoResponse {
    let body = receipts_health_body(&state, true).await;
    let ready = body["checks"]["storage"]["ok"].as_bool().unwrap_or(false);
    let status = if ready {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    (status, Json(body))
}

async fn receipts_health_body(state: &AppState, include_storage: bool) -> Value {
    let storage_check = if include_storage {
        match state.store.list_pending(1).await {
            Ok(_) => json!({ "ok": true, "required": true }),
            Err(err) => {
                tracing::warn!("receipts readiness storage probe failed: {err}");
                json!({
                    "ok": false,
                    "required": true,
                    "detail": "storage_unavailable",
                })
            }
        }
    } else {
        json!({ "ok": true, "required": false, "skipped": true })
    };
    let ready = storage_check["ok"].as_bool().unwrap_or(false);
    json!({
        "status": if ready { "ok" } else { "degraded" },
        "service": "said-receipts-service",
        "version": env!("CARGO_PKG_VERSION"),
        "uptime_secs": uptime_secs(),
        "checks": {
            "storage": storage_check,
            "batcher": {
                "ok": state.batcher_interval_secs > 0,
                "required": true,
                "interval_secs": state.batcher_interval_secs,
            },
        },
        "degraded": !ready,
        "timestamp": chrono::Utc::now().to_rfc3339(),
    })
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

#[derive(Serialize)]
struct ReceiptResponse {
    receipt_hash: String,
    status: &'static str,
    receipt: serde_json::Value,
}

async fn get_receipt(
    State(state): State<AppState>,
    Path(hash_hex): Path<String>,
) -> Result<Json<ReceiptResponse>, ApiError> {
    let hash = parse_receipt_hash(&hash_hex)?;
    let stored = state
        .store
        .get_receipt(hash)
        .await?
        .ok_or(ApiError::NotFound)?;

    let status = match stored.lookup.batch_id {
        Some(batch_id) => {
            let batch = state.store.batch_for_id(batch_id).await?;
            if batch.solana_signature.is_some() {
                "anchored"
            } else {
                "pending"
            }
        }
        None => "pending",
    };

    Ok(Json(ReceiptResponse {
        receipt_hash: hex::encode(stored.lookup.receipt_hash),
        status,
        receipt: stored.body,
    }))
}

async fn get_proof(
    State(state): State<AppState>,
    Path(hash_hex): Path<String>,
) -> Result<axum::response::Response, ApiError> {
    let hash = parse_receipt_hash(&hash_hex)?;

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

fn parse_receipt_hash(hash_hex: &str) -> Result<[u8; 32], ApiError> {
    let hash_bytes =
        hex::decode(hash_hex).map_err(|e| ApiError::BadRequest(format!("invalid hex: {e}")))?;
    if hash_bytes.len() != 32 {
        return Err(ApiError::BadRequest("hash must be 32 bytes".into()));
    }
    let mut hash = [0u8; 32];
    hash.copy_from_slice(&hash_bytes);
    Ok(hash)
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
            ApiError::Storage(e) => {
                tracing::error!("receipts storage error: {e}");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "storage error".to_string(),
                )
            }
        };
        (status, Json(serde_json::json!({"error": msg}))).into_response()
    }
}
