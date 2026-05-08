use std::sync::Arc;

use axum::extract::{Path, State};
use axum::Json;

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use orni_models_types::{CreatorPublicProfile, ModelCard};

/// GET /api/creators/{slug} — Public creator profile page
pub async fn get_creator_by_slug(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
) -> AppResult<Json<serde_json::Value>> {
    let profile = sqlx::query_as::<_, CreatorPublicProfile>(
        r#"
        SELECT
            u.display_name, u.avatar_url, u.slug, u.did,
            COALESCE(u.said_verified, false) as said_verified,
            (SELECT COUNT(*) FROM models WHERE creator_id = u.id AND status = 'live') as model_count,
            (SELECT COALESCE(SUM(total_queries), 0) FROM models WHERE creator_id = u.id) as total_queries,
            u.created_at
        FROM users u
        WHERE u.slug = $1 AND u.is_creator = true
        "#,
    )
    .bind(&slug)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("Creator not found".into()))?;

    let models = sqlx::query_as::<_, ModelCard>(
        r#"
        SELECT
            m.id, m.slug, m.name, m.description, m.avatar_url,
            u.display_name as creator_name, u.wallet_address as creator_wallet,
            m.status, m.price_per_query, m.total_queries, m.category, m.tags,
            u.did as creator_did, COALESCE(u.said_verified, false) as creator_verified,
            m.is_featured, m.free_queries_per_day,
            m.is_foundation, m.developer, m.params_b, m.active_params_b,
            m.license, m.context_window, m.modality,
            (m.provider_model_id IS NULL
                AND m.self_hosted_endpoint IS NULL
                AND m.self_hosted_node_id IS NULL) as awaiting_host
        FROM models m
        JOIN users u ON u.id = m.creator_id
        WHERE u.slug = $1 AND m.status = 'live'
        ORDER BY m.total_queries DESC
        "#,
    )
    .bind(&slug)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(serde_json::json!({
        "profile": profile,
        "models": models,
    })))
}
