use axum::extract::{Path, Query, State};
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::error::CloudError;
use crate::privacy::{
    redact_sensitive_json, safe_task_result, task_network_scope, NetworkScope, PrivacyApproval,
};
use crate::state::AppState;

#[derive(Deserialize)]
pub struct CreateTaskRequest {
    pub task_type: String,
    pub template_id: Option<String>,
    pub params: serde_json::Value,
    pub bounty_usdc: Option<i64>,
    pub bounty_fee_bps: Option<i32>,
    /// If true, task is posted to the marketplace for external executors
    pub is_open: Option<bool>,
    /// Human-readable title for marketplace listing
    pub title: Option<String>,
    /// Description of what the executor should do
    pub description: Option<String>,
    /// Hours until claim expires if executor doesn't submit (default: 24)
    pub claim_deadline_hours: Option<i32>,
    /// Minimum reputation score (0.0-1.0) required to claim this task
    pub min_reputation: Option<f64>,
    /// Phase M3: optional agent that owns this task. The agent's ID lives in
    /// said-cloud's `agents` table; we store it here as a bare UUID with no
    /// FK constraint. v1 still bills the user's wallet — agent_id is purely
    /// stamped on related rows so the agent's history is queryable.
    pub agent_id: Option<Uuid>,
    /// Denormalized DID string for the same agent, so the task engine doesn't
    /// have to cross-DB lookup said-cloud just to know who's executing.
    pub agent_did: Option<String>,
    #[serde(flatten)]
    pub approval: PrivacyApproval,
}

#[derive(Serialize)]
pub struct TaskResponse {
    pub id: Uuid,
    pub task_type: String,
    pub template_id: Option<String>,
    pub status: String,
    pub params: serde_json::Value,
    pub result: Option<serde_json::Value>,
    pub error_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub privacy_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub network_scope: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_approved_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval_summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub privacy_boundary: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub completed_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounty_usdc: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounty_status: Option<String>,
}

#[derive(Serialize)]
pub struct TaskStepResponse {
    pub id: Uuid,
    pub step_number: i32,
    pub action_type: String,
    pub status: String,
    pub input: serde_json::Value,
    pub output: Option<serde_json::Value>,
}

#[derive(Deserialize)]
pub struct TaskListQuery {
    pub status: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

/// Validate task parameters based on task type.
fn validate_task_params(task_type: &str, params: &serde_json::Value) -> Result<(), CloudError> {
    match task_type {
        "call"
        | "customer_service"
        | "cancel_service"
        | "request_refund"
        | "complaint"
        | "cancel_subscription" => {
            let phone = params["phone_number"]
                .as_str()
                .or(params["phone"].as_str())
                .ok_or(CloudError::BadRequest(
                    "call tasks require a phone_number".to_string(),
                ))?;
            let digits: String = phone.chars().filter(|c| c.is_ascii_digit()).collect();
            if digits.len() < 10 || digits.len() > 15 {
                return Err(CloudError::BadRequest(
                    "invalid phone number: must be 10-15 digits".to_string(),
                ));
            }

            let objective = params["objective"].as_str().or(params["intent"].as_str());
            if objective.map(str::trim).unwrap_or_default().is_empty() {
                return Err(CloudError::BadRequest(
                    "call tasks require an objective".to_string(),
                ));
            }
        }
        "email" | "follow_up" => {
            if let Some(email) = params["to_address"]
                .as_str()
                .or(params["email"].as_str())
                .or(params["to"].as_str())
            {
                if !email.contains('@') || !email.contains('.') || email.len() < 5 {
                    return Err(CloudError::BadRequest("invalid email address".to_string()));
                }
            }

            let intent = params["intent"].as_str().or(params["objective"].as_str());
            if intent.map(str::trim).unwrap_or_default().is_empty() {
                return Err(CloudError::BadRequest(
                    "email tasks require an intent".to_string(),
                ));
            }
        }
        "calendar" => {
            let action = params["action"].as_str().unwrap_or("create_event");
            if action == "create_event" || action == "create" {
                for key in ["title", "start", "end"] {
                    if params[key]
                        .as_str()
                        .map(str::trim)
                        .unwrap_or_default()
                        .is_empty()
                    {
                        return Err(CloudError::BadRequest(format!(
                            "calendar create_event tasks require {key}"
                        )));
                    }
                }
            }
        }
        "crypto_transfer" | "send_crypto" => {
            // Validate Solana address (base58, 32 bytes)
            if let Some(address) = params["to"].as_str().or(params["address"].as_str()) {
                match bs58::decode(address).into_vec() {
                    Ok(bytes) if bytes.len() == 32 => {}
                    _ => {
                        return Err(CloudError::BadRequest(
                            "invalid Solana address — must be base58-encoded 32 bytes".to_string(),
                        ));
                    }
                }
            }
        }
        _ => {}
    }
    Ok(())
}

/// POST /api/tasks
pub async fn create_task(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Json(req): Json<CreateTaskRequest>,
) -> Result<Json<TaskResponse>, CloudError> {
    // Validate task parameters
    validate_task_params(&req.task_type, &req.params)?;

    let is_open = req.is_open.unwrap_or(false);
    let privacy_scope = task_network_scope(&req.task_type, &req.params);
    let stored_approval = privacy_scope
        .map(|scope| req.approval.require_and_store_for(scope))
        .transpose()?;

    // Open marketplace tasks require a bounty
    if is_open && req.bounty_usdc.is_none() {
        return Err(CloudError::BadRequest(
            "open marketplace tasks require a bounty_usdc".to_string(),
        ));
    }

    let row = sqlx::query_as::<_, TaskRow>(
        &format!(
            "INSERT INTO tasks (user_id, task_type, template_id, params, is_open, title, description, min_reputation, agent_id, agent_did, privacy_mode, network_scope, user_approved_at, approval_nonce, approval_summary) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) \
             RETURNING {TASK_SELECT}"
        ),
    )
    .bind(claims.sub)
    .bind(&req.task_type)
    .bind(&req.template_id)
    .bind(&req.params)
    .bind(is_open)
    .bind(&req.title)
    .bind(&req.description)
    .bind(req.min_reputation)
    .bind(req.agent_id)
    .bind(&req.agent_did)
    .bind(stored_approval.as_ref().map(|a| a.privacy_mode.as_str()))
    .bind(privacy_scope.map(NetworkScope::as_str))
    .bind(stored_approval.as_ref().map(|a| a.user_approved_at))
    .bind(stored_approval.as_ref().map(|a| a.approval_nonce_hash.as_str()))
    .bind(stored_approval.as_ref().map(|a| a.approval_summary.as_str()))
    .fetch_one(&state.db)
    .await?;

    let task_id = row.0;

    // Create bounty if requested
    let mut bounty_status = None;
    if let Some(bounty_amount) = req.bounty_usdc {
        let fee_bps = req.bounty_fee_bps.unwrap_or(300);
        crate::services::bounty_service::create_bounty(
            &state.db,
            claims.sub,
            task_id,
            bounty_amount,
            fee_bps,
            req.agent_id,
        )
        .await?;
        bounty_status = Some("held".to_string());
    }

    // Only auto-execute if NOT an open marketplace task
    // Open tasks wait for an executor to claim them
    if !is_open {
        let state_clone = state.clone();
        let user_id = claims.sub;
        tokio::spawn(async move {
            if let Err(e) =
                crate::services::task_engine::execute_task(&state_clone, user_id, task_id).await
            {
                let _ = e;
                tracing::error!(%task_id, "task execution failed");
            }
        });
    }

    let mut response = task_from_row(row, true);
    response.bounty_usdc = req.bounty_usdc;
    response.bounty_status = bounty_status;
    Ok(Json(response))
}

type TaskRow = (
    Uuid,
    String,
    Option<String>,
    String,
    serde_json::Value,
    Option<serde_json::Value>,
    Option<String>,
    DateTime<Utc>,
    DateTime<Utc>,
    Option<DateTime<Utc>>,
    Option<i64>,
    Option<String>,
    Option<String>,
    Option<DateTime<Utc>>,
    Option<String>,
);

fn task_from_row(r: TaskRow, include_sensitive: bool) -> TaskResponse {
    let params = if include_sensitive {
        redact_sensitive_json(&r.4)
    } else {
        redact_task_params(&r.1)
    };
    let result = safe_task_result(&r.1, &r.3, r.5);
    let privacy_boundary =
        r.12.as_deref()
            .and_then(NetworkScope::from_str)
            .map(|scope| scope.boundary_label().to_string());

    TaskResponse {
        id: r.0,
        task_type: r.1,
        template_id: r.2,
        status: r.3,
        params,
        result,
        error_message: r.6,
        privacy_mode: r.11,
        network_scope: r.12,
        user_approved_at: r.13,
        approval_summary: r.14,
        privacy_boundary,
        created_at: r.7,
        updated_at: r.8,
        completed_at: r.9,
        bounty_usdc: r.10,
        bounty_status: None, // populated separately when needed
    }
}

fn redact_task_params(task_type: &str) -> serde_json::Value {
    serde_json::json!({
        "redacted": true,
        "task_type": task_type,
    })
}

const TASK_SELECT: &str = "id, task_type, template_id, status, params, result, error_message, created_at, updated_at, completed_at, bounty_usdc, privacy_mode, network_scope, user_approved_at, approval_summary";

/// GET /api/tasks
pub async fn list_tasks(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Query(query): Query<TaskListQuery>,
) -> Result<Json<Vec<TaskResponse>>, CloudError> {
    let limit = query.limit.unwrap_or(20).min(100);
    let offset = query.offset.unwrap_or(0);

    let rows = if let Some(ref status) = query.status {
        sqlx::query_as::<_, TaskRow>(
            &format!("SELECT {TASK_SELECT} FROM tasks WHERE (user_id = $1 OR executor_id = $1) AND status = $2 ORDER BY created_at DESC LIMIT $3 OFFSET $4"),
        )
        .bind(claims.sub)
        .bind(status)
        .bind(limit)
        .bind(offset)
        .fetch_all(&state.db)
        .await?
    } else {
        sqlx::query_as::<_, TaskRow>(
            &format!("SELECT {TASK_SELECT} FROM tasks WHERE (user_id = $1 OR executor_id = $1) ORDER BY created_at DESC LIMIT $2 OFFSET $3"),
        )
        .bind(claims.sub)
        .bind(limit)
        .bind(offset)
        .fetch_all(&state.db)
        .await?
    };

    let tasks: Vec<TaskResponse> = rows
        .into_iter()
        .map(|row| task_from_row(row, false))
        .collect();
    Ok(Json(tasks))
}

/// GET /api/tasks/:id — accessible by funder (user_id) or executor (executor_id)
pub async fn get_task(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Path(task_id): Path<Uuid>,
) -> Result<Json<TaskResponse>, CloudError> {
    let row = sqlx::query_as::<_, TaskRow>(&format!(
        "SELECT {TASK_SELECT} FROM tasks WHERE id = $1 AND (user_id = $2 OR executor_id = $2)"
    ))
    .bind(task_id)
    .bind(claims.sub)
    .fetch_optional(&state.db)
    .await?
    .ok_or(CloudError::NotFound("task not found".to_string()))?;

    let mut task = task_from_row(row, false);

    // Populate bounty status if this task has a bounty
    if task.bounty_usdc.is_some() {
        if let Ok(Some(bounty)) =
            crate::services::bounty_service::get_bounty(&state.db, task_id).await
        {
            task.bounty_status = Some(bounty.status);
        }
    }

    Ok(Json(task))
}

/// GET /api/tasks/:id/steps
pub async fn get_task_steps(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Path(task_id): Path<Uuid>,
) -> Result<Json<Vec<TaskStepResponse>>, CloudError> {
    // Verify task belongs to user
    let exists = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM tasks WHERE id = $1 AND user_id = $2)",
    )
    .bind(task_id)
    .bind(claims.sub)
    .fetch_one(&state.db)
    .await?;

    if !exists {
        return Err(CloudError::NotFound("task not found".to_string()));
    }

    let rows = sqlx::query_as::<
        _,
        (
            Uuid,
            i32,
            String,
            String,
            serde_json::Value,
            Option<serde_json::Value>,
        ),
    >(
        r#"
        SELECT id, step_number, action_type, status, input, output
        FROM task_steps WHERE task_id = $1
        ORDER BY step_number
        "#,
    )
    .bind(task_id)
    .fetch_all(&state.db)
    .await?;

    let steps: Vec<TaskStepResponse> = rows
        .into_iter()
        .map(|r| TaskStepResponse {
            id: r.0,
            step_number: r.1,
            action_type: r.2,
            status: r.3,
            input: r.4,
            output: r.5.map(|value| redact_sensitive_json(&value)),
        })
        .collect();

    Ok(Json(steps))
}

/// POST /api/tasks/:id/cancel
pub async fn cancel_task(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Path(task_id): Path<Uuid>,
) -> Result<Json<TaskResponse>, CloudError> {
    let row = sqlx::query_as::<_, TaskRow>(
        &format!(
            "UPDATE tasks SET status = 'cancelled', updated_at = now() \
             WHERE id = $1 AND user_id = $2 AND status IN ('pending', 'in_progress', 'awaiting_approval') \
             RETURNING {TASK_SELECT}"
        ),
    )
    .bind(task_id)
    .bind(claims.sub)
    .fetch_optional(&state.db)
    .await?
    .ok_or(CloudError::NotFound("task not found or already completed".to_string()))?;

    // Refund bounty if one exists
    let _ = crate::services::bounty_service::refund_bounty(&state.db, task_id).await;

    Ok(Json(task_from_row(row, false)))
}

/// GET /api/tasks/:id/bounty
pub async fn get_task_bounty(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Path(task_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, CloudError> {
    // Verify task belongs to user
    let exists = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM tasks WHERE id = $1 AND user_id = $2)",
    )
    .bind(task_id)
    .bind(claims.sub)
    .fetch_one(&state.db)
    .await?;

    if !exists {
        return Err(CloudError::NotFound("task not found".to_string()));
    }

    let bounty = crate::services::bounty_service::get_bounty(&state.db, task_id)
        .await?
        .ok_or(CloudError::NotFound("no bounty on this task".to_string()))?;

    Ok(Json(serde_json::to_value(bounty).unwrap_or_default()))
}

#[derive(Deserialize)]
pub struct BountyListQuery {
    pub status: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

/// GET /api/bounties
pub async fn list_bounties(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Query(query): Query<BountyListQuery>,
) -> Result<Json<Vec<crate::services::bounty_service::TaskBounty>>, CloudError> {
    let limit = query.limit.unwrap_or(20).min(100);
    let offset = query.offset.unwrap_or(0);

    let bounties = crate::services::bounty_service::list_bounties(
        &state.db,
        claims.sub,
        query.status.as_deref(),
        limit,
        offset,
    )
    .await?;

    Ok(Json(bounties))
}
