use axum::extract::{Path, Query, State};
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::error::CloudError;
use crate::state::AppState;

#[derive(Deserialize)]
pub struct CreateTaskRequest {
    pub task_type: String,
    pub template_id: Option<String>,
    pub params: serde_json::Value,
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
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub completed_at: Option<DateTime<Utc>>,
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

/// POST /api/tasks
pub async fn create_task(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Json(req): Json<CreateTaskRequest>,
) -> Result<Json<TaskResponse>, CloudError> {
    let row = sqlx::query_as::<_, (Uuid, String, Option<String>, String, serde_json::Value, Option<serde_json::Value>, Option<String>, DateTime<Utc>, DateTime<Utc>, Option<DateTime<Utc>>)>(
        r#"
        INSERT INTO tasks (user_id, task_type, template_id, params)
        VALUES ($1, $2, $3, $4)
        RETURNING id, task_type, template_id, status, params, result, error_message, created_at, updated_at, completed_at
        "#,
    )
    .bind(claims.sub)
    .bind(&req.task_type)
    .bind(&req.template_id)
    .bind(&req.params)
    .fetch_one(&state.db)
    .await?;

    // Kick off task execution asynchronously
    let task_id = row.0;
    let state_clone = state.clone();
    let user_id = claims.sub;
    tokio::spawn(async move {
        if let Err(e) = crate::services::task_engine::execute_task(&state_clone, user_id, task_id).await {
            tracing::error!(%task_id, "task execution failed: {e}");
        }
    });

    Ok(Json(TaskResponse {
        id: row.0,
        task_type: row.1,
        template_id: row.2,
        status: row.3,
        params: row.4,
        result: row.5,
        error_message: row.6,
        created_at: row.7,
        updated_at: row.8,
        completed_at: row.9,
    }))
}

/// GET /api/tasks
pub async fn list_tasks(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Query(query): Query<TaskListQuery>,
) -> Result<Json<Vec<TaskResponse>>, CloudError> {
    let limit = query.limit.unwrap_or(20).min(100);
    let offset = query.offset.unwrap_or(0);

    let rows = if let Some(ref status) = query.status {
        sqlx::query_as::<_, (Uuid, String, Option<String>, String, serde_json::Value, Option<serde_json::Value>, Option<String>, DateTime<Utc>, DateTime<Utc>, Option<DateTime<Utc>>)>(
            r#"
            SELECT id, task_type, template_id, status, params, result, error_message, created_at, updated_at, completed_at
            FROM tasks WHERE user_id = $1 AND status = $2
            ORDER BY created_at DESC LIMIT $3 OFFSET $4
            "#,
        )
        .bind(claims.sub)
        .bind(status)
        .bind(limit)
        .bind(offset)
        .fetch_all(&state.db)
        .await?
    } else {
        sqlx::query_as::<_, (Uuid, String, Option<String>, String, serde_json::Value, Option<serde_json::Value>, Option<String>, DateTime<Utc>, DateTime<Utc>, Option<DateTime<Utc>>)>(
            r#"
            SELECT id, task_type, template_id, status, params, result, error_message, created_at, updated_at, completed_at
            FROM tasks WHERE user_id = $1
            ORDER BY created_at DESC LIMIT $2 OFFSET $3
            "#,
        )
        .bind(claims.sub)
        .bind(limit)
        .bind(offset)
        .fetch_all(&state.db)
        .await?
    };

    let tasks: Vec<TaskResponse> = rows
        .into_iter()
        .map(|r| TaskResponse {
            id: r.0,
            task_type: r.1,
            template_id: r.2,
            status: r.3,
            params: r.4,
            result: r.5,
            error_message: r.6,
            created_at: r.7,
            updated_at: r.8,
            completed_at: r.9,
        })
        .collect();

    Ok(Json(tasks))
}

/// GET /api/tasks/:id
pub async fn get_task(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Path(task_id): Path<Uuid>,
) -> Result<Json<TaskResponse>, CloudError> {
    let row = sqlx::query_as::<_, (Uuid, String, Option<String>, String, serde_json::Value, Option<serde_json::Value>, Option<String>, DateTime<Utc>, DateTime<Utc>, Option<DateTime<Utc>>)>(
        r#"
        SELECT id, task_type, template_id, status, params, result, error_message, created_at, updated_at, completed_at
        FROM tasks WHERE id = $1 AND user_id = $2
        "#,
    )
    .bind(task_id)
    .bind(claims.sub)
    .fetch_optional(&state.db)
    .await?
    .ok_or(CloudError::NotFound("task not found".to_string()))?;

    Ok(Json(TaskResponse {
        id: row.0,
        task_type: row.1,
        template_id: row.2,
        status: row.3,
        params: row.4,
        result: row.5,
        error_message: row.6,
        created_at: row.7,
        updated_at: row.8,
        completed_at: row.9,
    }))
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

    let rows = sqlx::query_as::<_, (Uuid, i32, String, String, serde_json::Value, Option<serde_json::Value>)>(
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
            output: r.5,
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
    let row = sqlx::query_as::<_, (Uuid, String, Option<String>, String, serde_json::Value, Option<serde_json::Value>, Option<String>, DateTime<Utc>, DateTime<Utc>, Option<DateTime<Utc>>)>(
        r#"
        UPDATE tasks SET status = 'cancelled', updated_at = now()
        WHERE id = $1 AND user_id = $2 AND status IN ('pending', 'in_progress', 'awaiting_approval')
        RETURNING id, task_type, template_id, status, params, result, error_message, created_at, updated_at, completed_at
        "#,
    )
    .bind(task_id)
    .bind(claims.sub)
    .fetch_optional(&state.db)
    .await?
    .ok_or(CloudError::NotFound("task not found or already completed".to_string()))?;

    Ok(Json(TaskResponse {
        id: row.0,
        task_type: row.1,
        template_id: row.2,
        status: row.3,
        params: row.4,
        result: row.5,
        error_message: row.6,
        created_at: row.7,
        updated_at: row.8,
        completed_at: row.9,
    }))
}
