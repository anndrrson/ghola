use axum::extract::State;
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::auth::AuthUser;
use crate::error::CloudError;
use crate::services::llm_router;
use crate::state::AppState;

#[derive(Deserialize)]
pub struct AgentPlanRequest {
    pub message: String,
    /// Optional sealed-envelope-v1 payload from client. The route currently
    /// echoes this field back so Android can keep a symmetric request/response
    /// shape while server-side planning is phased in.
    #[serde(default)]
    pub envelope_blob_b64: Option<String>,
}

#[derive(Serialize)]
pub struct AgentPlanResponse {
    pub plan: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub envelope_blob_b64: Option<String>,
}

/// POST /api/agent/plan — server-side planning for device actions.
pub async fn plan(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Json(req): Json<AgentPlanRequest>,
) -> Result<Json<AgentPlanResponse>, CloudError> {
    if req.message.trim().is_empty() {
        return Err(CloudError::BadRequest("message cannot be empty".to_string()));
    }

    let prompt = format!(
        "You are a mobile device-control planner. Produce a concise execution plan \
for Android accessibility automation.\n\nUser request:\n{}\n\nReturn plain text only.",
        req.message
    );
    let plan = llm_router::generate(&state, claims.sub, &prompt, None).await?;

    Ok(Json(AgentPlanResponse {
        plan,
        envelope_blob_b64: req.envelope_blob_b64,
    }))
}
