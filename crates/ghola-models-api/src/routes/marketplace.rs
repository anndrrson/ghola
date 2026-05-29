use std::sync::Arc;

use axum::extract::{Query, State};
use axum::Json;

use crate::error::AppResult;
use crate::state::AppState;
use ghola_models_types::{MarketplaceQuery, MarketplaceResponse, ModelCard};

pub async fn browse(
    State(state): State<Arc<AppState>>,
    Query(params): Query<MarketplaceQuery>,
) -> AppResult<Json<MarketplaceResponse>> {
    let page = params.page.unwrap_or(1).max(1);
    let limit = params.limit.unwrap_or(20).min(100);
    let offset = (page - 1) * limit;

    // Sort whitelist preserved for future use; current default is popular.
    let _sort_clause = match params.sort.as_deref() {
        Some("popular") => "m.total_queries DESC",
        Some("revenue") => "m.total_revenue DESC",
        Some("newest") => "m.created_at DESC",
        Some("price_low") => "m.price_per_query ASC",
        Some("price_high") => "m.price_per_query DESC",
        Some("top_rated") => "m.avg_rating DESC, m.review_count DESC",
        _ => "m.total_queries DESC",
    };

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
        WHERE m.status = 'live'
            AND ($1::text IS NULL OR m.name ILIKE '%' || $1 || '%' OR m.description ILIKE '%' || $1 || '%')
            AND ($2::text IS NULL OR m.category = $2)
            AND ($3::bool IS NULL OR m.is_foundation = $3)
            AND ($4::text IS NULL OR m.developer = $4)
            AND ($5::text IS NULL OR m.license = $5)
            AND ($6::float8 IS NULL OR m.params_b >= $6)
            AND ($7::float8 IS NULL OR m.params_b <= $7)
        ORDER BY m.total_queries DESC
        LIMIT $8 OFFSET $9
        "#,
    )
    .bind(params.search.as_deref())
    .bind(params.category.as_deref())
    .bind(params.is_foundation)
    .bind(params.developer.as_deref())
    .bind(params.license.as_deref())
    .bind(params.min_params)
    .bind(params.max_params)
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.db)
    .await?;

    let total: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*) FROM models m
        WHERE m.status = 'live'
            AND ($1::text IS NULL OR m.name ILIKE '%' || $1 || '%' OR m.description ILIKE '%' || $1 || '%')
            AND ($2::text IS NULL OR m.category = $2)
            AND ($3::bool IS NULL OR m.is_foundation = $3)
            AND ($4::text IS NULL OR m.developer = $4)
            AND ($5::text IS NULL OR m.license = $5)
            AND ($6::float8 IS NULL OR m.params_b >= $6)
            AND ($7::float8 IS NULL OR m.params_b <= $7)
        "#,
    )
    .bind(params.search.as_deref())
    .bind(params.category.as_deref())
    .bind(params.is_foundation)
    .bind(params.developer.as_deref())
    .bind(params.license.as_deref())
    .bind(params.min_params)
    .bind(params.max_params)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(MarketplaceResponse {
        models,
        total,
        page,
        limit,
    }))
}

/// GET /api/models/featured — returns top 6 featured live models
pub async fn get_featured(
    State(state): State<Arc<AppState>>,
) -> AppResult<Json<Vec<ModelCard>>> {
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
        WHERE m.status = 'live' AND m.is_featured = true
        ORDER BY m.total_queries DESC
        LIMIT 6
        "#,
    )
    .fetch_all(&state.db)
    .await?;

    Ok(Json(models))
}
