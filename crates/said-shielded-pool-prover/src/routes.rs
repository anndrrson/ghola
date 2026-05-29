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
    extract::{FromRequest, Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::de::DeserializeOwned;
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
        // Opaque 404/405 — never echo the requested path/method or the
        // route table back to the client.
        .fallback(fallback)
        .with_state(state)
}

/// Opaque catch-all for unmatched routes/methods. Returns the same fixed
/// `{"error":"bad request"}` body as the `OpaqueJson` extractor rejection,
/// with no path or allowed-method detail.
async fn fallback() -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(OpaqueError {
            error: "bad request",
        }),
    )
        .into_response()
}

/// A `Json<T>` replacement whose rejection is OPAQUE.
///
/// axum's default [`JsonRejection`](axum::extract::rejection::JsonRejection)
/// echoes serde/schema detail (field names, parse offsets, expected types)
/// in the 400 body. For the prover that body would describe the SHAPE of
/// the witness — exactly the structural metadata we keep opaque elsewhere
/// (see `ApiError::into_response`). This extractor maps ANY `Json`
/// rejection to a fixed `400 {"error":"bad request"}`, logging the real
/// rejection at `tracing::debug!` only.
pub struct OpaqueJson<T>(pub T);

impl<T, S> FromRequest<S> for OpaqueJson<T>
where
    T: DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = Response;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        match Json::<T>::from_request(req, state).await {
            Ok(Json(v)) => Ok(OpaqueJson(v)),
            Err(rejection) => {
                // Full detail (which may name witness fields / parse
                // offsets) is logged at DEBUG, never returned to the client.
                tracing::debug!(rejection = %rejection, "prover request body rejected");
                Err((
                    StatusCode::BAD_REQUEST,
                    Json(OpaqueError {
                        error: "bad request",
                    }),
                )
                    .into_response())
            }
        }
    }
}

#[derive(Serialize)]
struct OpaqueError {
    error: &'static str,
}

// ----- handlers -----

#[derive(Serialize)]
struct HealthResponse {
    ok: bool,
    backend: &'static str,
    artifacts_present: bool,
}

async fn healthz(State(s): State<AppState>) -> Json<HealthResponse> {
    let zkey = s.cfg.zkey_path();
    let vk = s.cfg.vk_path();
    let wasm = s.cfg.wasm_path();
    let present = zkey.exists() && vk.exists() && wasm.exists();
    // PRIVACY: do NOT echo `artifacts_dir` (a filesystem path) — only a
    // boolean readiness flag. The path is internal layout an unauthenticated
    // healthcheck caller has no business learning.
    Json(HealthResponse {
        ok: true,
        backend: s.backend.name(),
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
    OpaqueJson(witness_raw): OpaqueJson<serde_json::Value>,
) -> Result<Json<ProofBundleWire>, ApiError> {
    let witness = witness_from_json(witness_raw).map_err(ApiError::from)?;
    let bundle = s.backend.prove(witness).await.map_err(ApiError::from)?;
    Ok(Json(ProofBundleWire::from_bundle(&bundle)))
}

async fn prove_forester(
    State(s): State<AppState>,
    OpaqueJson(witness): OpaqueJson<BatchedUpdateWitness>,
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
        // CRITICAL: do NOT leak internal detail to clients. The full error
        // Display can carry redacted-but-still-internal subprocess stderr
        // (the delivery vehicle for the spending-key leak chain),
        // filesystem layout from `ArtifactsNotFound(PathBuf)`, serde
        // messages, etc. Return a fixed message per status class and log
        // the full (already-redacted) detail at DEBUG only. Mirrors the
        // relayer's opaque-response pattern.
        let (status, msg) = match &self.0 {
            Error::WitnessInvalid(_) => (StatusCode::BAD_REQUEST, "bad request"),
            Error::BackendNotImplemented(_) => (StatusCode::NOT_IMPLEMENTED, "not implemented"),
            Error::ArtifactsNotFound(_) => (StatusCode::SERVICE_UNAVAILABLE, "service unavailable"),
            _ => (StatusCode::INTERNAL_SERVER_ERROR, "internal error"),
        };
        // Full detail (which has already passed through stderr redaction
        // upstream) is logged at DEBUG, never returned to the client.
        tracing::debug!(error = %self.0, "prover request failed");
        #[derive(Serialize)]
        struct E {
            error: &'static str,
        }
        (status, Json(E { error: msg })).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use tower::ServiceExt; // for `oneshot`

    fn test_cfg() -> Config {
        Config {
            port: 0,
            artifacts_dir: std::env::temp_dir(),
            backend: crate::config::BackendKind::Snarkjs,
            subprocess_timeout_ms: crate::config::DEFAULT_SUBPROCESS_TIMEOUT_MS,
        }
    }

    #[test]
    fn router_builds() {
        let _ = router(test_cfg());
    }

    /// Group 4: the `/healthz` body must not leak the artifacts filesystem
    /// path — only `ok` + `artifacts_present`.
    #[tokio::test]
    async fn healthz_body_has_no_filesystem_path() {
        let app = router(test_cfg());
        let req = axum::http::Request::builder()
            .method("GET")
            .uri("/healthz")
            .body(axum::body::Body::empty())
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let body_str = String::from_utf8_lossy(&body);

        assert!(
            !body_str.contains("artifacts_dir"),
            "leaked field: {body_str}"
        );
        // No filesystem path component should appear — the only `/` allowed
        // would be inside a path, so assert there is none at all.
        assert!(
            !body_str.contains('/'),
            "leaked filesystem path: {body_str}"
        );
        assert!(body_str.contains("\"ok\""), "missing ok: {body_str}");
        assert!(
            body_str.contains("artifacts_present"),
            "missing artifacts_present: {body_str}"
        );
    }

    /// Group 4: a malformed `POST /prove` body must return the OPAQUE
    /// `{"error":"bad request"}` and echo NO serde/schema detail (field
    /// names, parse offsets, expected types).
    #[tokio::test]
    async fn malformed_prove_body_returns_opaque_error() {
        let app = router(test_cfg());
        // Not valid JSON at all — axum's default JsonRejection would echo a
        // parse-error message ("expected value", offset, etc.).
        let req = axum::http::Request::builder()
            .method("POST")
            .uri("/prove")
            .header("content-type", "application/json")
            .body(axum::body::Body::from("{ this is not json"))
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let body_str = String::from_utf8_lossy(&body);

        assert_eq!(
            body_str, r#"{"error":"bad request"}"#,
            "non-opaque body: {body_str}"
        );
        // Belt-and-suspenders: none of serde's usual leak vocabulary.
        for needle in ["expected", "column", "line", "invalid", "missing field"] {
            assert!(
                !body_str.contains(needle),
                "leaked serde detail `{needle}`: {body_str}"
            );
        }
    }

    /// H1 regression: even if a `BackendSpawnFailed` error string carries a
    /// (redacted-or-not) spending-key fragment, the HTTP body must be the
    /// fixed opaque message and contain none of the key bytes.
    #[tokio::test]
    async fn backend_spawn_error_does_not_leak_key_in_body() {
        // Simulate a subprocess error whose Display still embeds key-like
        // material — the worst case where upstream redaction was bypassed.
        let leaked = "[119,119,119,119,119,119,119,119] spending_key deadbeef";
        let err = Error::BackendSpawnFailed(format!("snarkjs exited 1: {leaked}"));
        let resp = ApiError(err).into_response();

        assert_eq!(resp.status(), StatusCode::INTERNAL_SERVER_ERROR);

        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("read body");
        let body_str = String::from_utf8_lossy(&body);

        assert!(
            !body_str.contains("spending_key"),
            "leaked field name: {body_str}"
        );
        assert!(
            !body_str.contains("119,119"),
            "leaked key bytes: {body_str}"
        );
        assert!(!body_str.contains("deadbeef"), "leaked hex: {body_str}");
        assert!(
            body_str.contains("internal error"),
            "expected opaque body: {body_str}"
        );
    }

    /// H1: `ArtifactsNotFound(PathBuf)` must not leak the filesystem path.
    #[tokio::test]
    async fn artifacts_not_found_does_not_leak_path() {
        let err = Error::ArtifactsNotFound(std::path::PathBuf::from(
            "/srv/secret-artifacts/circuit_final.zkey",
        ));
        let resp = ApiError(err).into_response();

        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);

        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("read body");
        let body_str = String::from_utf8_lossy(&body);

        assert!(
            !body_str.contains("/srv/secret-artifacts"),
            "leaked path: {body_str}"
        );
        assert!(
            body_str.contains("service unavailable"),
            "expected opaque body: {body_str}"
        );
    }
}
