//! Swarm (elastic agent dispatch) routes.

use std::convert::Infallible;
use std::pin::Pin;

use axum::extract::{Path, Query, State};
use axum::response::sse::{Event, Sse};
use axum::Json;
use futures::Stream;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::error::CloudError;
use crate::privacy::{record_privacy_audit_event, NetworkScope};
use crate::services::swarm_service::{
    self, CreateSwarmRequest, SwarmEstimate, SwarmJobInfo, WorkUnitInfo, WorkUnitResult,
};
use crate::state::AppState;

type SseStream = Pin<Box<dyn Stream<Item = Result<Event, Infallible>> + Send>>;

#[derive(Serialize)]
pub struct MessageResponse {
    message: String,
}

// ---------------------------------------------------------------------------
// POST /api/swarm/estimate
// ---------------------------------------------------------------------------

/// Preview: cost estimate, available agents, feasibility.
pub async fn estimate_swarm(
    State(state): State<AppState>,
    AuthUser(_claims): AuthUser,
    Json(req): Json<CreateSwarmRequest>,
) -> Result<Json<SwarmEstimate>, CloudError> {
    let estimate = swarm_service::estimate_swarm(&state.db, &req).await?;
    Ok(Json(estimate))
}

// ---------------------------------------------------------------------------
// POST /api/swarm
// ---------------------------------------------------------------------------

/// Create and start a swarm job.
pub async fn create_swarm(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Json(req): Json<CreateSwarmRequest>,
) -> Result<Json<SwarmJobInfo>, CloudError> {
    let approval = req
        .approval
        .require_and_store_for(NetworkScope::SwarmExecution)?;
    record_privacy_audit_event(
        &state.db,
        claims.sub,
        NetworkScope::SwarmExecution,
        &approval,
        "swarm_execution",
    )
    .await;
    let info = swarm_service::create_swarm(&state.db, claims.sub, req).await?;

    // Start the dispatch loop in the background
    swarm_service::start_swarm(state, info.id);

    Ok(Json(info))
}

// ---------------------------------------------------------------------------
// GET /api/swarm
// ---------------------------------------------------------------------------

/// List user's swarm history.
pub async fn list_swarms(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
) -> Result<Json<Vec<SwarmJobInfo>>, CloudError> {
    let swarms = swarm_service::list_swarms(&state.db, claims.sub).await?;
    Ok(Json(swarms))
}

// ---------------------------------------------------------------------------
// GET /api/swarm/{id}
// ---------------------------------------------------------------------------

/// Get swarm status and counts.
pub async fn get_swarm(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Path(id): Path<Uuid>,
) -> Result<Json<SwarmJobInfo>, CloudError> {
    let info = swarm_service::get_swarm(&state.db, id, claims.sub).await?;
    Ok(Json(info))
}

// ---------------------------------------------------------------------------
// GET /api/swarm/{id}/units
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct UnitsQuery {
    pub status: Option<String>,
}

/// List work units for a swarm. Optional filter: ?status=completed
pub async fn get_work_units(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Path(id): Path<Uuid>,
    Query(query): Query<UnitsQuery>,
) -> Result<Json<Vec<WorkUnitInfo>>, CloudError> {
    let units =
        swarm_service::get_work_units(&state.db, id, claims.sub, query.status.as_deref()).await?;
    Ok(Json(units))
}

// ---------------------------------------------------------------------------
// GET /api/swarm/{id}/results
// ---------------------------------------------------------------------------

/// Full results for completed units.
pub async fn get_results(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Path(id): Path<Uuid>,
) -> Result<Json<Vec<WorkUnitResult>>, CloudError> {
    let results = swarm_service::get_swarm_results(&state.db, id, claims.sub).await?;
    Ok(Json(results))
}

// ---------------------------------------------------------------------------
// GET /api/swarm/{id}/stream
// ---------------------------------------------------------------------------

/// SSE: real-time progress events for a swarm job.
pub async fn stream_progress(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Path(id): Path<Uuid>,
) -> Result<Sse<SseStream>, CloudError> {
    // Verify ownership
    let info = swarm_service::get_swarm(&state.db, id, claims.sub).await?;

    // If swarm is already terminal, send one status event and close
    if matches!(
        info.status.as_str(),
        "completed" | "partial" | "failed" | "cancelled"
    ) {
        let status = info.status.clone();
        let stream: SseStream = Box::pin(async_stream::stream! {
            yield Ok(Event::default()
                .event("swarm_completed")
                .data(serde_json::json!({
                    "status": status,
                    "completed": info.completed_units,
                    "failed": info.failed_units,
                    "total_cost": info.spent_usdc,
                }).to_string()));
        });
        return Ok(Sse::new(stream));
    }

    // Subscribe to the broadcast channel
    let rx = state
        .swarm_channels
        .get(&id)
        .map(|entry| entry.value().subscribe());

    match rx {
        Some(mut rx) => {
            let stream: SseStream = Box::pin(async_stream::stream! {
                loop {
                    match rx.recv().await {
                        Ok(msg) => {
                            yield Ok(Event::default().event("progress").data(msg));
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                            tracing::warn!(lagged = n, "swarm SSE client lagged");
                            continue;
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                            yield Ok(Event::default()
                                .event("done")
                                .data("stream closed".to_string()));
                            break;
                        }
                    }
                }
            });
            Ok(Sse::new(stream))
        }
        None => {
            // Channel not yet created (swarm is pending/matching) — wait briefly
            let stream: SseStream = Box::pin(async_stream::stream! {
                yield Ok(Event::default()
                    .event("waiting")
                    .data(serde_json::json!({"message": "swarm is starting"}).to_string()));
            });
            Ok(Sse::new(stream))
        }
    }
}

// ---------------------------------------------------------------------------
// POST /api/swarm/{id}/cancel
// ---------------------------------------------------------------------------

/// Cancel pending units. Running units finish normally.
pub async fn cancel_swarm(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Path(id): Path<Uuid>,
) -> Result<Json<MessageResponse>, CloudError> {
    swarm_service::cancel_swarm(&state.db, id, claims.sub).await?;
    Ok(Json(MessageResponse {
        message: "swarm cancelled — pending units stopped, running units will finish".into(),
    }))
}
