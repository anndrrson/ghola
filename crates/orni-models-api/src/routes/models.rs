use std::sync::Arc;

use axum::extract::{Path, State};
use axum::Json;
use uuid::Uuid;

use crate::auth::Claims;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use orni_models_types::{
    AddContentRequest, ContentSource, CreateModelRequest, CreateReviewRequest, Model,
    ModelInterestRequest, ModelInterestResponse, ModelReview, QuickListRequest, QuickListResponse,
    ReviewWithUser, UpdateModelRequest,
};

pub async fn create_model(
    State(state): State<Arc<AppState>>,
    claims: axum::Extension<Claims>,
    Json(req): Json<CreateModelRequest>,
) -> AppResult<Json<Model>> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("Invalid token".into()))?;

    // Verify slug is valid
    if req.slug.is_empty()
        || req.slug.len() > 64
        || !req
            .slug
            .chars()
            .all(|c| c.is_alphanumeric() || c == '-')
    {
        return Err(AppError::BadRequest(
            "Invalid slug: use lowercase alphanumeric and hyphens".into(),
        ));
    }

    let base_model = req
        .base_model
        .unwrap_or_else(|| state.config.default_base_model.clone());
    let price = req.price_per_query.unwrap_or(100_000); // $0.10 default
    let tags = req.tags.unwrap_or_default();

    // Mark user as creator and auto-generate slug if not set
    let user_slug = req.slug.to_lowercase();
    sqlx::query(
        "UPDATE users SET is_creator = true, slug = COALESCE(slug, $2) WHERE id = $1",
    )
    .bind(user_id)
    .bind(&user_slug)
    .execute(&state.db)
    .await?;

    // Create model — set status=live and provider_model_id=base_model immediately
    // This makes the model instantly usable (one-click publish)
    let model = sqlx::query_as::<_, Model>(
        r#"
        INSERT INTO models (id, creator_id, slug, name, description, system_prompt, base_model, provider_model_id, status, price_per_query, category, tags, self_hosted_endpoint)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'live', $9, $10, $11, $12)
        RETURNING *
        "#,
    )
    .bind(Uuid::new_v4())
    .bind(user_id)
    .bind(&req.slug.to_lowercase())
    .bind(&req.name)
    .bind(&req.description)
    .bind(&req.system_prompt)
    .bind(&base_model)
    .bind(&base_model) // provider_model_id = base_model
    .bind(price)
    .bind(&req.category)
    .bind(&tags)
    .bind(&req.self_hosted_endpoint)
    .fetch_one(&state.db)
    .await
    .map_err(|e| {
        if let sqlx::Error::Database(ref db_err) = e {
            if db_err.constraint() == Some("models_slug_key") {
                return AppError::Conflict("Slug already taken".into());
            }
        }
        AppError::from(e)
    })?;

    Ok(Json(model))
}

pub async fn get_model(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
) -> AppResult<Json<Model>> {
    let model = sqlx::query_as::<_, Model>("SELECT * FROM models WHERE slug = $1")
        .bind(&slug)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::NotFound("Model not found".into()))?;

    Ok(Json(model))
}

pub async fn update_model(
    State(state): State<Arc<AppState>>,
    claims: axum::Extension<Claims>,
    Path(id): Path<Uuid>,
    Json(req): Json<UpdateModelRequest>,
) -> AppResult<Json<Model>> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("Invalid token".into()))?;

    // Verify ownership
    let existing = sqlx::query_as::<_, Model>("SELECT * FROM models WHERE id = $1")
        .bind(id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::NotFound("Model not found".into()))?;

    if existing.creator_id != user_id {
        return Err(AppError::Unauthorized("Not your model".into()));
    }

    let model = sqlx::query_as::<_, Model>(
        r#"
        UPDATE models SET
            name = COALESCE($2, name),
            description = COALESCE($3, description),
            system_prompt = COALESCE($4, system_prompt),
            price_per_query = COALESCE($5, price_per_query),
            category = COALESCE($6, category),
            tags = COALESCE($7, tags),
            updated_at = NOW()
        WHERE id = $1
        RETURNING *
        "#,
    )
    .bind(id)
    .bind(&req.name)
    .bind(&req.description)
    .bind(&req.system_prompt)
    .bind(req.price_per_query)
    .bind(&req.category)
    .bind(&req.tags)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(model))
}

pub async fn add_content(
    State(state): State<Arc<AppState>>,
    claims: axum::Extension<Claims>,
    Path(model_id): Path<Uuid>,
    Json(req): Json<AddContentRequest>,
) -> AppResult<Json<ContentSource>> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("Invalid token".into()))?;

    // Verify ownership
    let model = sqlx::query_as::<_, Model>("SELECT * FROM models WHERE id = $1")
        .bind(model_id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::NotFound("Model not found".into()))?;

    if model.creator_id != user_id {
        return Err(AppError::Unauthorized("Not your model".into()));
    }

    let source = sqlx::query_as::<_, ContentSource>(
        r#"
        INSERT INTO content_sources (id, model_id, source_type, source_url, content_text)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
        "#,
    )
    .bind(Uuid::new_v4())
    .bind(model_id)
    .bind(&req.source_type)
    .bind(&req.source_url)
    .bind(&req.content_text)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(source))
}

/// POST /api/models/{slug}/review — Submit a review
pub async fn create_review(
    State(state): State<Arc<AppState>>,
    claims: axum::Extension<Claims>,
    Path(slug): Path<String>,
    Json(req): Json<CreateReviewRequest>,
) -> AppResult<Json<ModelReview>> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("Invalid token".into()))?;

    if req.rating < 1 || req.rating > 5 {
        return Err(AppError::BadRequest("Rating must be 1-5".into()));
    }

    let model = sqlx::query_as::<_, Model>("SELECT * FROM models WHERE slug = $1")
        .bind(&slug)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::NotFound("Model not found".into()))?;

    let review = sqlx::query_as::<_, ModelReview>(
        r#"
        INSERT INTO model_reviews (id, user_id, model_id, rating, review_text)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (user_id, model_id) DO UPDATE SET rating = $4, review_text = $5
        RETURNING *
        "#,
    )
    .bind(Uuid::new_v4())
    .bind(user_id)
    .bind(model.id)
    .bind(req.rating)
    .bind(&req.review_text)
    .fetch_one(&state.db)
    .await?;

    // Update model's avg_rating and review_count
    sqlx::query(
        r#"
        UPDATE models SET
            avg_rating = (SELECT COALESCE(AVG(rating)::float8, 0) FROM model_reviews WHERE model_id = $1),
            review_count = (SELECT COUNT(*) FROM model_reviews WHERE model_id = $1)
        WHERE id = $1
        "#,
    )
    .bind(model.id)
    .execute(&state.db)
    .await?;

    Ok(Json(review))
}

/// GET /api/models/{slug}/reviews — Get reviews for a model
pub async fn get_reviews(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
) -> AppResult<Json<Vec<ReviewWithUser>>> {
    let model = sqlx::query_as::<_, Model>("SELECT * FROM models WHERE slug = $1")
        .bind(&slug)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::NotFound("Model not found".into()))?;

    let reviews = sqlx::query_as::<_, ReviewWithUser>(
        r#"
        SELECT r.id, r.rating, r.review_text, r.created_at,
               COALESCE(u.display_name, u.email, 'Anonymous') as user_name
        FROM model_reviews r
        JOIN users u ON u.id = r.user_id
        WHERE r.model_id = $1
        ORDER BY r.created_at DESC
        LIMIT 50
        "#,
    )
    .bind(model.id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(reviews))
}

/// POST /api/models/{slug}/interest — Register interest in a catalog-only model.
/// Public endpoint: anon users supply email; logged-in users may pass their email
/// from their profile. Idempotent via unique indexes on (model_id, email/user_id).
pub async fn register_interest(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
    Json(req): Json<ModelInterestRequest>,
) -> AppResult<Json<ModelInterestResponse>> {
    let email = req
        .email
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::BadRequest("email is required".into()))?;

    if !email.contains('@') || email.len() > 254 {
        return Err(AppError::BadRequest("invalid email".into()));
    }

    let model_id: Uuid = sqlx::query_scalar("SELECT id FROM models WHERE slug = $1")
        .bind(&slug)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::NotFound("Model not found".into()))?;

    // Idempotent insert — unique index on (model_id, email) absorbs duplicates.
    sqlx::query(
        "INSERT INTO model_interest (model_id, email) VALUES ($1, $2)
         ON CONFLICT DO NOTHING",
    )
    .bind(model_id)
    .bind(email)
    .execute(&state.db)
    .await?;

    Ok(Json(ModelInterestResponse { registered: true }))
}

// ── Quick List ──

#[derive(serde::Deserialize)]
struct ProbeModelsResponse {
    data: Vec<ProbeModelEntry>,
}

#[derive(serde::Deserialize)]
struct ProbeModelEntry {
    id: String,
}

fn slugify(name: &str) -> String {
    let base: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect();
    let trimmed = base.trim_matches('-').to_string();
    // Collapse consecutive hyphens
    let mut result = String::new();
    let mut prev_dash = false;
    for c in trimmed.chars() {
        if c == '-' {
            if !prev_dash {
                result.push(c);
            }
            prev_dash = true;
        } else {
            result.push(c);
            prev_dash = false;
        }
    }
    // Append random suffix for uniqueness
    let suffix = format!("{:04x}", rand::random::<u16>());
    if result.is_empty() {
        format!("model-{suffix}")
    } else {
        format!("{result}-{suffix}")
    }
}

/// POST /api/models/quick-list
///
/// One-click model listing. Paste an endpoint URL, get a live model.
/// Probes the endpoint to auto-detect model names.
pub async fn quick_list_model(
    State(state): State<Arc<AppState>>,
    claims: axum::Extension<Claims>,
    Json(req): Json<QuickListRequest>,
) -> AppResult<Json<QuickListResponse>> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("Invalid token".into()))?;

    // Validate endpoint URL
    let url = req.endpoint_url.trim().trim_end_matches('/');
    if url.is_empty() {
        return Err(AppError::BadRequest("endpoint_url is required".into()));
    }
    if !url.starts_with("https://") {
        return Err(AppError::BadRequest(
            "endpoint_url must use HTTPS".into(),
        ));
    }
    if !crate::security::is_safe_url(url) {
        return Err(AppError::BadRequest(
            "endpoint_url points to a private/internal address".into(),
        ));
    }
    if url.len() > 2048 {
        return Err(AppError::BadRequest("endpoint_url too long".into()));
    }

    // Rate limit: 5 models per user per day
    let today_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM models WHERE creator_id = $1 AND created_at > NOW() - INTERVAL '1 day'",
    )
    .bind(user_id)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);

    if today_count >= 5 {
        return Err(AppError::BadRequest(
            "You can list at most 5 models per day".into(),
        ));
    }

    // Probe endpoint to detect models (best-effort, non-blocking on failure)
    let probe_url = if url.ends_with("/v1") || url.ends_with("/v1/") {
        format!("{}/models", url.trim_end_matches('/'))
    } else {
        format!("{}/v1/models", url)
    };

    let detected_models: Vec<String> = match state
        .http_client
        .get(&probe_url)
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {
            match resp.json::<ProbeModelsResponse>().await {
                Ok(body) => body.data.into_iter().map(|m| m.id).collect(),
                Err(_) => vec![],
            }
        }
        _ => vec![],
    };

    // Determine model name
    let model_name = req
        .name
        .filter(|n| !n.trim().is_empty())
        .or_else(|| detected_models.first().cloned())
        .unwrap_or_else(|| {
            // Fallback: extract hostname
            url.split("://")
                .nth(1)
                .and_then(|h| h.split('/').next())
                .and_then(|h| h.split(':').next())
                .unwrap_or("custom-model")
                .to_string()
        });

    let slug = slugify(&model_name);
    let base_model = detected_models
        .first()
        .cloned()
        .unwrap_or_else(|| state.config.default_base_model.clone());

    let description = if !detected_models.is_empty() {
        format!(
            "Self-hosted {} — {} model(s) available",
            model_name,
            detected_models.len()
        )
    } else {
        format!("Self-hosted model at {}", url.split("://").nth(1).unwrap_or(url))
    };

    // Mark user as creator
    sqlx::query("UPDATE users SET is_creator = true, slug = COALESCE(slug, $2) WHERE id = $1")
        .bind(user_id)
        .bind(&slug)
        .execute(&state.db)
        .await?;

    // Create the model
    let model = sqlx::query_as::<_, Model>(
        r#"
        INSERT INTO models (id, creator_id, slug, name, description, system_prompt, base_model,
                           provider_model_id, status, price_per_query, category, tags,
                           self_hosted_endpoint, free_queries_per_day)
        VALUES ($1, $2, $3, $4, $5, 'You are a helpful assistant.', $6, $7, 'live', 100000,
                'Technology', '{}', $8, 100)
        RETURNING *
        "#,
    )
    .bind(Uuid::new_v4())
    .bind(user_id)
    .bind(&slug)
    .bind(&model_name)
    .bind(&description)
    .bind(&base_model)
    .bind(&base_model)
    .bind(url)
    .fetch_one(&state.db)
    .await
    .map_err(|e| {
        if let sqlx::Error::Database(ref db_err) = e {
            if db_err.constraint() == Some("models_slug_key") {
                return AppError::Conflict("A model with this name already exists. Try a different name.".into());
            }
        }
        AppError::from(e)
    })?;

    Ok(Json(QuickListResponse {
        model,
        detected_models,
    }))
}
