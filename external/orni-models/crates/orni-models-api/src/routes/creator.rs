use std::sync::Arc;

use axum::extract::{Path, State};
use axum::Json;
use uuid::Uuid;

use crate::auth::Claims;
use crate::error::{AppError, AppResult};
use crate::services::inference::InferenceService;
use crate::state::AppState;
use orni_models_types::{
    ContentSource, CreatorModelDetail, CreatorStats, DailyEarning, EarningsResponse,
    FineTuneJob, Model, ModelEarning, ModelStatus, StatusToggleRequest,
};

pub async fn get_stats(
    State(state): State<Arc<AppState>>,
    claims: axum::Extension<Claims>,
) -> AppResult<Json<CreatorStats>> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("Invalid token".into()))?;

    let stats = sqlx::query_as::<_, CreatorStats>(
        r#"
        SELECT
            (SELECT COUNT(*) FROM models WHERE creator_id = $1) as total_models,
            (SELECT COALESCE(SUM(total_queries), 0) FROM models WHERE creator_id = $1) as total_queries,
            (SELECT COALESCE(SUM(total_revenue), 0) FROM models WHERE creator_id = $1) as total_revenue,
            (SELECT COALESCE(SUM(creator_share), 0) FROM payments p
             JOIN models m ON m.id = p.model_id WHERE m.creator_id = $1) as pending_earnings
        "#,
    )
    .bind(user_id)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(stats))
}

pub async fn get_models(
    State(state): State<Arc<AppState>>,
    claims: axum::Extension<Claims>,
) -> AppResult<Json<Vec<Model>>> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("Invalid token".into()))?;

    let models = sqlx::query_as::<_, Model>(
        "SELECT * FROM models WHERE creator_id = $1 ORDER BY created_at DESC",
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(models))
}

pub async fn get_model_detail(
    State(state): State<Arc<AppState>>,
    claims: axum::Extension<Claims>,
    Path(id): Path<Uuid>,
) -> AppResult<Json<CreatorModelDetail>> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("Invalid token".into()))?;

    let model = sqlx::query_as::<_, Model>(
        "SELECT * FROM models WHERE id = $1 AND creator_id = $2",
    )
    .bind(id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("Model not found".into()))?;

    let content_sources = sqlx::query_as::<_, ContentSource>(
        "SELECT * FROM content_sources WHERE model_id = $1 ORDER BY created_at DESC",
    )
    .bind(id)
    .fetch_all(&state.db)
    .await?;

    let fine_tune_jobs = sqlx::query_as::<_, FineTuneJob>(
        "SELECT * FROM fine_tune_jobs WHERE model_id = $1 ORDER BY created_at DESC",
    )
    .bind(id)
    .fetch_all(&state.db)
    .await?;

    let recent_queries: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM chat_messages cm JOIN chat_sessions cs ON cs.id = cm.session_id WHERE cs.model_id = $1 AND cm.created_at > NOW() - INTERVAL '7 days' AND cm.role = 'user'",
    )
    .bind(id)
    .fetch_one(&state.db)
    .await?;

    let recent_revenue: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(amount), 0) FROM payments WHERE model_id = $1 AND created_at > NOW() - INTERVAL '7 days'",
    )
    .bind(id)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(CreatorModelDetail {
        model,
        content_sources,
        fine_tune_jobs,
        recent_queries,
        recent_revenue,
    }))
}

pub async fn start_fine_tune(
    State(state): State<Arc<AppState>>,
    claims: axum::Extension<Claims>,
    Path(model_id): Path<Uuid>,
) -> AppResult<Json<FineTuneJob>> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("Invalid token".into()))?;

    let model = sqlx::query_as::<_, Model>(
        "SELECT * FROM models WHERE id = $1 AND creator_id = $2",
    )
    .bind(model_id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("Model not found".into()))?;

    // Check for existing training dataset
    let dataset = sqlx::query_scalar::<_, String>(
        "SELECT file_key FROM training_datasets WHERE model_id = $1 ORDER BY created_at DESC LIMIT 1",
    )
    .bind(model_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| {
        AppError::BadRequest("No training dataset available. Add content first.".into())
    })?;

    // Submit to Together.ai
    let inference = InferenceService::new(&state.config, &state.http_client);
    let suffix = format!("orni-{}", model.slug);
    let job_id = inference
        .create_fine_tune(&model.base_model, &dataset, &suffix)
        .await?;

    // Save job
    let job = sqlx::query_as::<_, FineTuneJob>(
        r#"
        INSERT INTO fine_tune_jobs (id, model_id, provider_job_id, status)
        VALUES ($1, $2, $3, 'running')
        RETURNING *
        "#,
    )
    .bind(Uuid::new_v4())
    .bind(model_id)
    .bind(&job_id)
    .fetch_one(&state.db)
    .await?;

    // Update model status
    sqlx::query("UPDATE models SET status = 'training', updated_at = NOW() WHERE id = $1")
        .bind(model_id)
        .execute(&state.db)
        .await?;

    Ok(Json(job))
}

/// POST /api/creator/models/{id}/publish — Simple status toggle to 'live'
pub async fn publish_model(
    State(state): State<Arc<AppState>>,
    claims: axum::Extension<Claims>,
    Path(model_id): Path<Uuid>,
) -> AppResult<Json<Model>> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("Invalid token".into()))?;

    let model = sqlx::query_as::<_, Model>(
        "SELECT * FROM models WHERE id = $1 AND creator_id = $2",
    )
    .bind(model_id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("Model not found".into()))?;

    // Ensure provider_model_id is set — if not, default to base_model
    if model.provider_model_id.is_none() {
        sqlx::query(
            "UPDATE models SET provider_model_id = base_model WHERE id = $1",
        )
        .bind(model_id)
        .execute(&state.db)
        .await?;
    }

    let updated = sqlx::query_as::<_, Model>(
        "UPDATE models SET status = 'live', updated_at = NOW() WHERE id = $1 RETURNING *",
    )
    .bind(model_id)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(updated))
}

/// PUT /api/creator/models/{id}/status — Toggle model status (live/paused)
pub async fn toggle_status(
    State(state): State<Arc<AppState>>,
    claims: axum::Extension<Claims>,
    Path(model_id): Path<Uuid>,
    Json(req): Json<StatusToggleRequest>,
) -> AppResult<Json<Model>> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("Invalid token".into()))?;

    // Verify ownership
    let _model = sqlx::query_as::<_, Model>(
        "SELECT * FROM models WHERE id = $1 AND creator_id = $2",
    )
    .bind(model_id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("Model not found".into()))?;

    // Only allow toggling to live or paused
    match req.status {
        ModelStatus::Live | ModelStatus::Paused => {}
        _ => {
            return Err(AppError::BadRequest(
                "Can only toggle between live and paused".into(),
            ));
        }
    }

    let updated = sqlx::query_as::<_, Model>(
        "UPDATE models SET status = $2, updated_at = NOW() WHERE id = $1 RETURNING *",
    )
    .bind(model_id)
    .bind(&req.status)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(updated))
}

/// GET /api/creator/earnings — Daily earnings + per-model breakdown
pub async fn get_earnings(
    State(state): State<Arc<AppState>>,
    claims: axum::Extension<Claims>,
) -> AppResult<Json<EarningsResponse>> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("Invalid token".into()))?;

    let daily = sqlx::query_as::<_, DailyEarning>(
        r#"
        SELECT p.created_at::date as date, COALESCE(SUM(p.creator_share), 0) as amount
        FROM payments p
        JOIN models m ON m.id = p.model_id
        WHERE m.creator_id = $1 AND p.created_at > NOW() - INTERVAL '30 days'
        GROUP BY p.created_at::date
        ORDER BY date ASC
        "#,
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await?;

    let per_model = sqlx::query_as::<_, ModelEarning>(
        r#"
        SELECT m.id as model_id, m.name as model_name, m.slug as model_slug,
               m.total_revenue,
               COALESCE(SUM(p.creator_share), 0) as creator_earnings,
               COUNT(p.id) as query_count
        FROM models m
        LEFT JOIN payments p ON p.model_id = m.id
        WHERE m.creator_id = $1
        GROUP BY m.id, m.name, m.slug, m.total_revenue
        ORDER BY creator_earnings DESC
        "#,
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await?;

    let total_earnings: i64 = per_model.iter().map(|m| m.creator_earnings).sum();
    let total_revenue: i64 = per_model.iter().map(|m| m.total_revenue).sum();

    Ok(Json(EarningsResponse {
        daily,
        per_model,
        total_earnings,
        total_revenue,
    }))
}
