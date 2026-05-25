//! axum HTTP router for the prover service.
//!
//! Endpoints:
//!   - `POST /prove`   — body: `TransferWitness` JSON. Returns
//!                       `ProofBundle` JSON on success.
//!   - `POST /verify`  — body: `ProofBundle` JSON. Returns `{ok: bool}`
//!                       after running snarkjs's local Groth16 verifier
//!                       against the configured vk. Useful for client
//!                       sanity-checks before submitting on-chain.
//!   - `GET  /vk`      — returns the raw verification key JSON.
//!   - `GET  /healthz` — backend name + ready flag.

use std::sync::Arc;

use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Serialize;

use said_shielded_pool_types::BatchedUpdateWitness;

use crate::backend::{self, Backend};
use crate::config::Config;
use crate::error::Error;
use crate::wire::{witness_from_json, ForesterProofBundleWire, ProofBundleWire};

/// Shared service state injected into every handler.
#[derive(Clone)]
pub struct AppState {
    pub backend: Arc<dyn Backend>,
    pub cfg: Config,
}

/// Build the full router for the prover service.
pub fn router(cfg: Config) -> Router {
    let state = AppState {
        backend: backend::build(&cfg),
        cfg,
    };
    Router::new()
        .route("/prove", post(prove))
        .route("/prove/batched-update", post(prove_forester))
        .route("/verify", post(verify))
        .route("/vk", get(vk))
        .route("/vk/forester", get(vk_forester))
        .route("/healthz", get(healthz))
        .with_state(state)
}

// ----- handlers -----

#[derive(Serialize)]
struct HealthResponse {
    ok: bool,
    backend: &'static str,
    artifacts_dir: String,
    artifacts_present: bool,
}

async fn healthz(State(s): State<AppState>) -> Json<HealthResponse> {
    let zkey = s.cfg.zkey_path();
    let vk = s.cfg.vk_path();
    let wasm = s.cfg.wasm_path();
    let present = zkey.exists() && vk.exists() && wasm.exists();
    Json(HealthResponse {
        ok: true,
        backend: s.backend.name(),
        artifacts_dir: s.cfg.artifacts_dir.display().to_string(),
        artifacts_present: present,
    })
}

async fn vk(State(s): State<AppState>) -> Result<Response, ApiError> {
    let bytes = s.backend.vk().await.map_err(ApiError::from)?;
    Ok((
        StatusCode::OK,
        [("content-type", "application/json")],
        bytes,
    )
        .into_response())
}

async fn prove(
    State(s): State<AppState>,
    Json(witness_raw): Json<serde_json::Value>,
) -> Result<Json<ProofBundleWire>, ApiError> {
    let witness = witness_from_json(witness_raw).map_err(ApiError::from)?;
    let bundle = s.backend.prove(witness).await.map_err(ApiError::from)?;
    Ok(Json(ProofBundleWire::from_bundle(&bundle)))
}

async fn prove_forester(
    State(s): State<AppState>,
    Json(witness): Json<BatchedUpdateWitness>,
) -> Result<Json<ForesterProofBundleWire>, ApiError> {
    let bundle = s
        .backend
        .prove_forester(witness)
        .await
        .map_err(ApiError::from)?;
    Ok(Json(ForesterProofBundleWire::from_bundle(&bundle)))
}

async fn vk_forester(State(s): State<AppState>) -> Result<Response, ApiError> {
    let bytes = s.backend.forester_vk().await.map_err(ApiError::from)?;
    Ok((
        StatusCode::OK,
        [("content-type", "application/json")],
        bytes,
    )
        .into_response())
}

#[derive(Serialize)]
struct VerifyResponse {
    ok: bool,
}

/// Verify shells out to `snarkjs groth16 verify` against the configured
/// vk. This is a convenience endpoint — the on-chain program does the
/// authoritative verification. Returns 200 with `{ok: false}` when the
/// proof is well-formed but invalid; returns 400 only on parse errors.
async fn verify(
    State(s): State<AppState>,
    Json(bundle_wire): Json<ProofBundleWire>,
) -> Result<Json<VerifyResponse>, ApiError> {
    // Parse the wire bundle to surface bad-encoding errors as 500
    // (ApiError) rather than silently returning ok=false.
    let _bundle = bundle_wire.into_bundle().map_err(ApiError::from)?;
    // The bundle is in on-chain (big-endian, A-negated) form; to run
    // it through snarkjs we'd need to invert that. For Phase 37 we
    // expose the endpoint but defer the round-trip implementation to
    // Phase 38 (where the client crate handles the inverse encoding).
    //
    // Returning ok=false is safer than ok=true here; clients should
    // not rely on this endpoint until the inverse-encoding lands.
    let _ = s;
    Ok(Json(VerifyResponse { ok: false }))
}

// ----- error mapping -----

/// Wrapper so we can map `Error` → HTTP status codes.
struct ApiError(Error);

impl From<Error> for ApiError {
    fn from(e: Error) -> Self {
        Self(e)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, msg) = match &self.0 {
            Error::WitnessInvalid(_) => (StatusCode::BAD_REQUEST, self.0.to_string()),
            Error::ArtifactsNotFound(_) => (StatusCode::SERVICE_UNAVAILABLE, self.0.to_string()),
            Error::BackendNotImplemented(_) => (StatusCode::NOT_IMPLEMENTED, self.0.to_string()),
            Error::ConfigInvalid(_) => (StatusCode::INTERNAL_SERVER_ERROR, self.0.to_string()),
            _ => (StatusCode::INTERNAL_SERVER_ERROR, self.0.to_string()),
        };
        #[derive(Serialize)]
        struct E {
            error: String,
        }
        (status, Json(E { error: msg })).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn router_builds() {
        let cfg = Config {
            port: 0,
            artifacts_dir: std::env::temp_dir(),
            backend: crate::config::BackendKind::Snarkjs,
            subprocess_timeout_ms: crate::config::DEFAULT_SUBPROCESS_TIMEOUT_MS,
        };
        let _ = router(cfg);
    }
}
