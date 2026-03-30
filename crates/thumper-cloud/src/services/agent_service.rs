//! Agent rental marketplace service.
//! Manages agent CRUD, sessions, stats, and ratings for the GPU compute marketplace.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::error::CloudError;

// ---------------------------------------------------------------------------
// Types — Agent Management
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct CreateAgentRequest {
    pub slug: String,
    pub display_name: String,
    pub description: Option<String>,
    pub avatar_url: Option<String>,
    pub system_prompt: String,
    pub model_id: String,
    pub temperature: Option<f64>,
    pub max_tokens: Option<i32>,
    pub tools: Option<Vec<String>>,
    pub tags: Option<Vec<String>>,
    pub is_public: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateAgentRequest {
    pub display_name: Option<String>,
    pub description: Option<String>,
    pub avatar_url: Option<String>,
    pub system_prompt: Option<String>,
    pub model_id: Option<String>,
    pub temperature: Option<f64>,
    pub max_tokens: Option<i32>,
    pub tools: Option<Vec<String>>,
    pub tags: Option<Vec<String>>,
    pub is_public: Option<bool>,
    pub is_active: Option<bool>,
}

/// Full agent info (for owner — includes system_prompt).
#[derive(Debug, Serialize)]
pub struct AgentInfo {
    pub id: Uuid,
    pub provider_id: Uuid,
    pub slug: String,
    pub display_name: String,
    pub description: String,
    pub avatar_url: Option<String>,
    pub system_prompt: String,
    pub model_id: String,
    pub temperature: f64,
    pub max_tokens: i32,
    pub tools: Vec<String>,
    pub tags: Vec<String>,
    pub is_public: bool,
    pub is_active: bool,
    pub total_conversations: i64,
    pub total_messages: i64,
    pub avg_rating: f64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Public agent info (for browse — omits system_prompt, adds provider details).
#[derive(Debug, Serialize)]
pub struct PublicAgentInfo {
    pub id: Uuid,
    pub slug: String,
    pub display_name: String,
    pub description: String,
    pub avatar_url: Option<String>,
    pub model_id: String,
    pub tools: Vec<String>,
    pub tags: Vec<String>,
    pub total_conversations: i64,
    pub total_messages: i64,
    pub avg_rating: f64,
    pub provider_name: String,
    pub provider_reputation: f64,
    pub price_per_1k_input: i64,
    pub price_per_1k_output: i64,
    pub created_at: DateTime<Utc>,
}

/// Session info for a user's conversation with an agent.
#[derive(Debug, Serialize)]
pub struct SessionInfo {
    pub id: Uuid,
    pub agent_id: Uuid,
    pub agent_name: String,
    pub message_count: i32,
    pub total_cost_usdc: i64,
    pub created_at: DateTime<Utc>,
    pub last_message_at: DateTime<Utc>,
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const ALLOWED_TOOLS: &[&str] = &["wallet", "web_search"];

fn validate_slug(slug: &str) -> Result<(), CloudError> {
    if slug.is_empty() || slug.len() > 64 {
        return Err(CloudError::BadRequest("slug must be 1-64 characters".into()));
    }
    if !slug.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(CloudError::BadRequest(
            "slug must contain only alphanumeric characters, hyphens, and underscores".into(),
        ));
    }
    Ok(())
}

fn validate_tools(tools: &[String]) -> Result<(), CloudError> {
    for t in tools {
        if !ALLOWED_TOOLS.contains(&t.as_str()) {
            return Err(CloudError::BadRequest(format!(
                "invalid tool '{t}' — allowed: {}",
                ALLOWED_TOOLS.join(", ")
            )));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Agent CRUD
// ---------------------------------------------------------------------------

pub async fn create_agent(
    db: &PgPool,
    provider_id: Uuid,
    req: CreateAgentRequest,
) -> Result<AgentInfo, CloudError> {
    validate_slug(&req.slug)?;

    let tools = req.tools.unwrap_or_default();
    validate_tools(&tools)?;
    let tags = req.tags.unwrap_or_default();
    let temperature = req.temperature.unwrap_or(0.7);
    let max_tokens = req.max_tokens.unwrap_or(2048);
    let is_public = req.is_public.unwrap_or(true);
    let description = req.description.unwrap_or_default();

    // Validate model_id exists in provider's models JSONB
    let models_json: serde_json::Value = sqlx::query_scalar(
        "SELECT models FROM compute_providers WHERE id = $1",
    )
    .bind(provider_id)
    .fetch_one(db)
    .await
    .map_err(|_| CloudError::NotFound("provider not found".into()))?;

    let model_exists = models_json
        .as_array()
        .map(|arr| {
            arr.iter().any(|m| {
                m.get("model_id")
                    .and_then(|v| v.as_str())
                    .map(|s| s == req.model_id)
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false);

    if !model_exists {
        return Err(CloudError::BadRequest(format!(
            "model '{}' is not in your provider's model list",
            req.model_id
        )));
    }

    let row = sqlx::query(
        r#"
        INSERT INTO rental_agents
            (provider_id, slug, display_name, description, avatar_url,
             system_prompt, model_id, temperature, max_tokens,
             tools, tags, is_public)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING id, created_at, updated_at
        "#,
    )
    .bind(provider_id)
    .bind(&req.slug)
    .bind(&req.display_name)
    .bind(&description)
    .bind(&req.avatar_url)
    .bind(&req.system_prompt)
    .bind(&req.model_id)
    .bind(temperature)
    .bind(max_tokens)
    .bind(&tools)
    .bind(&tags)
    .bind(is_public)
    .fetch_one(db)
    .await
    .map_err(|e| {
        if e.to_string().contains("duplicate key") || e.to_string().contains("unique") {
            CloudError::BadRequest(format!("slug '{}' is already taken", req.slug))
        } else {
            CloudError::Database(e)
        }
    })?;

    Ok(AgentInfo {
        id: row.get("id"),
        provider_id,
        slug: req.slug,
        display_name: req.display_name,
        description,
        avatar_url: req.avatar_url,
        system_prompt: req.system_prompt,
        model_id: req.model_id,
        temperature,
        max_tokens,
        tools,
        tags,
        is_public,
        is_active: true,
        total_conversations: 0,
        total_messages: 0,
        avg_rating: 0.0,
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    })
}

pub async fn update_agent(
    db: &PgPool,
    agent_id: Uuid,
    provider_id: Uuid,
    req: UpdateAgentRequest,
) -> Result<AgentInfo, CloudError> {
    // Verify ownership
    let existing = get_agent(db, agent_id).await?;
    if existing.provider_id != provider_id {
        return Err(CloudError::Unauthorized);
    }

    if let Some(ref tools) = req.tools {
        validate_tools(tools)?;
    }

    // If model_id is changing, validate it exists
    if let Some(ref model_id) = req.model_id {
        let models_json: serde_json::Value = sqlx::query_scalar(
            "SELECT models FROM compute_providers WHERE id = $1",
        )
        .bind(provider_id)
        .fetch_one(db)
        .await?;

        let model_exists = models_json
            .as_array()
            .map(|arr| {
                arr.iter().any(|m| {
                    m.get("model_id")
                        .and_then(|v| v.as_str())
                        .map(|s| s == model_id.as_str())
                        .unwrap_or(false)
                })
            })
            .unwrap_or(false);

        if !model_exists {
            return Err(CloudError::BadRequest(format!(
                "model '{model_id}' is not in your provider's model list"
            )));
        }
    }

    let display_name = req.display_name.unwrap_or(existing.display_name);
    let description = req.description.unwrap_or(existing.description);
    let avatar_url = req.avatar_url.or(existing.avatar_url);
    let system_prompt = req.system_prompt.unwrap_or(existing.system_prompt);
    let model_id = req.model_id.unwrap_or(existing.model_id);
    let temperature = req.temperature.unwrap_or(existing.temperature);
    let max_tokens = req.max_tokens.unwrap_or(existing.max_tokens);
    let tools = req.tools.unwrap_or(existing.tools);
    let tags = req.tags.unwrap_or(existing.tags);
    let is_public = req.is_public.unwrap_or(existing.is_public);
    let is_active = req.is_active.unwrap_or(existing.is_active);

    sqlx::query(
        r#"
        UPDATE rental_agents SET
            display_name = $1, description = $2, avatar_url = $3,
            system_prompt = $4, model_id = $5, temperature = $6,
            max_tokens = $7, tools = $8, tags = $9,
            is_public = $10, is_active = $11, updated_at = now()
        WHERE id = $12
        "#,
    )
    .bind(&display_name)
    .bind(&description)
    .bind(&avatar_url)
    .bind(&system_prompt)
    .bind(&model_id)
    .bind(temperature)
    .bind(max_tokens)
    .bind(&tools)
    .bind(&tags)
    .bind(is_public)
    .bind(is_active)
    .bind(agent_id)
    .execute(db)
    .await?;

    Ok(AgentInfo {
        id: agent_id,
        provider_id,
        slug: existing.slug,
        display_name,
        description,
        avatar_url,
        system_prompt,
        model_id,
        temperature,
        max_tokens,
        tools,
        tags,
        is_public,
        is_active,
        total_conversations: existing.total_conversations,
        total_messages: existing.total_messages,
        avg_rating: existing.avg_rating,
        created_at: existing.created_at,
        updated_at: Utc::now(),
    })
}

pub async fn delete_agent(
    db: &PgPool,
    agent_id: Uuid,
    provider_id: Uuid,
) -> Result<(), CloudError> {
    let result = sqlx::query(
        "UPDATE rental_agents SET is_active = false, updated_at = now() WHERE id = $1 AND provider_id = $2",
    )
    .bind(agent_id)
    .bind(provider_id)
    .execute(db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(CloudError::NotFound("agent not found or not owned by you".into()));
    }
    Ok(())
}

pub async fn get_agent(db: &PgPool, agent_id: Uuid) -> Result<AgentInfo, CloudError> {
    let row = sqlx::query(
        r#"
        SELECT id, provider_id, slug, display_name, description, avatar_url,
               system_prompt, model_id, temperature, max_tokens,
               tools, tags, is_public, is_active,
               total_conversations, total_messages, avg_rating,
               created_at, updated_at
        FROM rental_agents WHERE id = $1
        "#,
    )
    .bind(agent_id)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| CloudError::NotFound("agent not found".into()))?;

    Ok(row_to_agent_info(&row))
}

pub async fn get_agent_by_slug(db: &PgPool, slug: &str) -> Result<AgentInfo, CloudError> {
    let row = sqlx::query(
        r#"
        SELECT id, provider_id, slug, display_name, description, avatar_url,
               system_prompt, model_id, temperature, max_tokens,
               tools, tags, is_public, is_active,
               total_conversations, total_messages, avg_rating,
               created_at, updated_at
        FROM rental_agents WHERE slug = $1
        "#,
    )
    .bind(slug)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| CloudError::NotFound("agent not found".into()))?;

    Ok(row_to_agent_info(&row))
}

fn row_to_agent_info(row: &sqlx::postgres::PgRow) -> AgentInfo {
    AgentInfo {
        id: row.get("id"),
        provider_id: row.get("provider_id"),
        slug: row.get("slug"),
        display_name: row.get("display_name"),
        description: row.get("description"),
        avatar_url: row.get("avatar_url"),
        system_prompt: row.get("system_prompt"),
        model_id: row.get("model_id"),
        temperature: row.get("temperature"),
        max_tokens: row.get("max_tokens"),
        tools: row.get("tools"),
        tags: row.get("tags"),
        is_public: row.get("is_public"),
        is_active: row.get("is_active"),
        total_conversations: row.get("total_conversations"),
        total_messages: row.get("total_messages"),
        avg_rating: row.get("avg_rating"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

pub async fn list_provider_agents(
    db: &PgPool,
    provider_id: Uuid,
) -> Result<Vec<AgentInfo>, CloudError> {
    let rows = sqlx::query(
        r#"
        SELECT id, provider_id, slug, display_name, description, avatar_url,
               system_prompt, model_id, temperature, max_tokens,
               tools, tags, is_public, is_active,
               total_conversations, total_messages, avg_rating,
               created_at, updated_at
        FROM rental_agents WHERE provider_id = $1
        ORDER BY created_at DESC
        "#,
    )
    .bind(provider_id)
    .fetch_all(db)
    .await?;

    Ok(rows.iter().map(row_to_agent_info).collect())
}

// ---------------------------------------------------------------------------
// Public Browse
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct BrowseQuery {
    pub tags: Option<String>,
    pub sort: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

pub async fn list_public_agents(
    db: &PgPool,
    query: &BrowseQuery,
) -> Result<Vec<PublicAgentInfo>, CloudError> {
    let limit = query.limit.unwrap_or(20).min(100);
    let offset = query.offset.unwrap_or(0);

    let order = match query.sort.as_deref() {
        Some("newest") => "a.created_at DESC",
        Some("rating") => "a.avg_rating DESC, a.total_conversations DESC",
        _ => "a.total_conversations DESC, a.avg_rating DESC", // popular (default)
    };

    // Build query with optional tag filter
    let base = format!(
        r#"
        SELECT
            a.id, a.slug, a.display_name, a.description, a.avatar_url,
            a.model_id, a.tools, a.tags,
            a.total_conversations, a.total_messages, a.avg_rating,
            a.created_at,
            cp.display_name AS provider_name,
            cp.reputation_score AS provider_reputation,
            cp.models AS provider_models
        FROM rental_agents a
        JOIN compute_providers cp ON a.provider_id = cp.id
        WHERE a.is_active = true
          AND a.is_public = true
          AND cp.status = 'online'
          {tag_filter}
        ORDER BY {order}
        LIMIT $1 OFFSET $2
        "#,
        tag_filter = if query.tags.is_some() {
            "AND a.tags && $3"
        } else {
            ""
        },
        order = order,
    );

    let rows = if let Some(ref tags_str) = query.tags {
        let tags: Vec<String> = tags_str.split(',').map(|s| s.trim().to_string()).collect();
        sqlx::query(&base)
            .bind(limit)
            .bind(offset)
            .bind(&tags)
            .fetch_all(db)
            .await?
    } else {
        sqlx::query(&base)
            .bind(limit)
            .bind(offset)
            .fetch_all(db)
            .await?
    };

    Ok(rows
        .iter()
        .map(|row| {
            let model_id: String = row.get("model_id");
            let provider_models: serde_json::Value = row.get("provider_models");
            let (price_in, price_out) = extract_model_pricing(&provider_models, &model_id);

            PublicAgentInfo {
                id: row.get("id"),
                slug: row.get("slug"),
                display_name: row.get("display_name"),
                description: row.get("description"),
                avatar_url: row.get("avatar_url"),
                model_id,
                tools: row.get("tools"),
                tags: row.get("tags"),
                total_conversations: row.get("total_conversations"),
                total_messages: row.get("total_messages"),
                avg_rating: row.get("avg_rating"),
                provider_name: row.get("provider_name"),
                provider_reputation: row.get("provider_reputation"),
                price_per_1k_input: price_in,
                price_per_1k_output: price_out,
                created_at: row.get("created_at"),
            }
        })
        .collect())
}

pub async fn get_public_agent(
    db: &PgPool,
    slug_or_id: &str,
) -> Result<PublicAgentInfo, CloudError> {
    // Try UUID first, then slug
    let row = if let Ok(id) = slug_or_id.parse::<Uuid>() {
        sqlx::query(
            r#"
            SELECT
                a.id, a.slug, a.display_name, a.description, a.avatar_url,
                a.model_id, a.tools, a.tags,
                a.total_conversations, a.total_messages, a.avg_rating,
                a.created_at,
                cp.display_name AS provider_name,
                cp.reputation_score AS provider_reputation,
                cp.models AS provider_models
            FROM rental_agents a
            JOIN compute_providers cp ON a.provider_id = cp.id
            WHERE a.id = $1 AND a.is_active = true AND a.is_public = true
            "#,
        )
        .bind(id)
        .fetch_optional(db)
        .await?
    } else {
        sqlx::query(
            r#"
            SELECT
                a.id, a.slug, a.display_name, a.description, a.avatar_url,
                a.model_id, a.tools, a.tags,
                a.total_conversations, a.total_messages, a.avg_rating,
                a.created_at,
                cp.display_name AS provider_name,
                cp.reputation_score AS provider_reputation,
                cp.models AS provider_models
            FROM rental_agents a
            JOIN compute_providers cp ON a.provider_id = cp.id
            WHERE a.slug = $1 AND a.is_active = true AND a.is_public = true
            "#,
        )
        .bind(slug_or_id)
        .fetch_optional(db)
        .await?
    };

    let row = row.ok_or_else(|| CloudError::NotFound("agent not found".into()))?;
    let model_id: String = row.get("model_id");
    let provider_models: serde_json::Value = row.get("provider_models");
    let (price_in, price_out) = extract_model_pricing(&provider_models, &model_id);

    Ok(PublicAgentInfo {
        id: row.get("id"),
        slug: row.get("slug"),
        display_name: row.get("display_name"),
        description: row.get("description"),
        avatar_url: row.get("avatar_url"),
        model_id,
        tools: row.get("tools"),
        tags: row.get("tags"),
        total_conversations: row.get("total_conversations"),
        total_messages: row.get("total_messages"),
        avg_rating: row.get("avg_rating"),
        provider_name: row.get("provider_name"),
        provider_reputation: row.get("provider_reputation"),
        price_per_1k_input: price_in,
        price_per_1k_output: price_out,
        created_at: row.get("created_at"),
    })
}

/// Extract pricing for a specific model from provider's models JSONB array.
fn extract_model_pricing(models: &serde_json::Value, model_id: &str) -> (i64, i64) {
    models
        .as_array()
        .and_then(|arr| {
            arr.iter().find(|m| {
                m.get("model_id")
                    .and_then(|v| v.as_str())
                    .map(|s| s == model_id)
                    .unwrap_or(false)
            })
        })
        .map(|m| {
            let input = m
                .get("price_per_1k_input")
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            let output = m
                .get("price_per_1k_output")
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            (input, output)
        })
        .unwrap_or((0, 0))
}

// ---------------------------------------------------------------------------
// Agent Matching (for swarm dispatch)
// ---------------------------------------------------------------------------

/// Criteria for matching agents across the provider network.
#[derive(Debug)]
pub struct AgentMatchCriteria {
    pub require_tags: Vec<String>,
    pub require_tools: Vec<String>,
    pub prefer_model: Option<String>,
    pub min_reputation: f64,
    pub limit: i64,
}

/// A matched agent with full dispatch info.
#[derive(Debug, Clone)]
pub struct MatchedAgent {
    pub agent_id: Uuid,
    pub provider_id: Uuid,
    pub relay_pubkey: String,
    pub model_id: String,
    pub system_prompt: String,
    pub max_tokens: i32,
    pub temperature: f64,
    pub tools: Vec<String>,
    pub price_per_1k_input: i64,
    pub price_per_1k_output: i64,
    pub provider_reputation: f64,
    pub provider_load_ratio: f64,
}

/// Find agents matching the given criteria, sorted by quality and availability.
pub async fn match_agents(
    db: &PgPool,
    criteria: &AgentMatchCriteria,
) -> Result<Vec<MatchedAgent>, CloudError> {
    let rows = sqlx::query(
        r#"
        SELECT
            a.id AS agent_id, a.provider_id, a.model_id, a.system_prompt,
            a.max_tokens, a.temperature, a.tools,
            cp.relay_pubkey, cp.reputation_score,
            cp.current_load, cp.max_concurrent,
            cp.models AS provider_models
        FROM rental_agents a
        JOIN compute_providers cp ON a.provider_id = cp.id
        WHERE a.is_active = true
          AND a.is_public = true
          AND cp.status = 'online'
          AND cp.reputation_score >= $1
          AND a.tags @> $2::text[]
          AND a.tools @> $3::text[]
          AND ($4::text IS NULL OR a.model_id = $4)
        ORDER BY cp.reputation_score DESC,
                 (cp.current_load::float / GREATEST(cp.max_concurrent, 1)) ASC
        LIMIT $5
        "#,
    )
    .bind(criteria.min_reputation)
    .bind(&criteria.require_tags)
    .bind(&criteria.require_tools)
    .bind(&criteria.prefer_model)
    .bind(criteria.limit)
    .fetch_all(db)
    .await?;

    Ok(rows
        .iter()
        .map(|row| {
            let model_id: String = row.get("model_id");
            let provider_models: serde_json::Value = row.get("provider_models");
            let (price_in, price_out) = extract_model_pricing(&provider_models, &model_id);
            let current_load: i32 = row.get("current_load");
            let max_concurrent: i32 = row.get("max_concurrent");
            let load_ratio = if max_concurrent > 0 {
                current_load as f64 / max_concurrent as f64
            } else {
                1.0
            };

            MatchedAgent {
                agent_id: row.get("agent_id"),
                provider_id: row.get("provider_id"),
                relay_pubkey: row.get("relay_pubkey"),
                model_id,
                system_prompt: row.get("system_prompt"),
                max_tokens: row.get("max_tokens"),
                temperature: row.get("temperature"),
                tools: row.get("tools"),
                price_per_1k_input: price_in,
                price_per_1k_output: price_out,
                provider_reputation: row.get("reputation_score"),
                provider_load_ratio: load_ratio,
            }
        })
        .collect())
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

pub async fn get_or_create_session(
    db: &PgPool,
    user_id: Uuid,
    agent_id: Uuid,
    session_id: Option<Uuid>,
) -> Result<Uuid, CloudError> {
    if let Some(sid) = session_id {
        // Check if session exists and belongs to user
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM agent_sessions WHERE id = $1 AND user_id = $2 AND agent_id = $3)",
        )
        .bind(sid)
        .bind(user_id)
        .bind(agent_id)
        .fetch_one(db)
        .await
        .unwrap_or(false);

        if exists {
            return Ok(sid);
        }
    }

    // Create new session
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO agent_sessions (user_id, agent_id) VALUES ($1, $2) RETURNING id",
    )
    .bind(user_id)
    .bind(agent_id)
    .fetch_one(db)
    .await?;

    Ok(id)
}

pub async fn list_user_sessions(
    db: &PgPool,
    user_id: Uuid,
    agent_id: Option<Uuid>,
) -> Result<Vec<SessionInfo>, CloudError> {
    let rows = if let Some(aid) = agent_id {
        sqlx::query(
            r#"
            SELECT s.id, s.agent_id, a.display_name AS agent_name,
                   s.message_count, s.total_cost_usdc, s.created_at, s.last_message_at
            FROM agent_sessions s
            JOIN rental_agents a ON s.agent_id = a.id
            WHERE s.user_id = $1 AND s.agent_id = $2
            ORDER BY s.last_message_at DESC
            LIMIT 50
            "#,
        )
        .bind(user_id)
        .bind(aid)
        .fetch_all(db)
        .await?
    } else {
        sqlx::query(
            r#"
            SELECT s.id, s.agent_id, a.display_name AS agent_name,
                   s.message_count, s.total_cost_usdc, s.created_at, s.last_message_at
            FROM agent_sessions s
            JOIN rental_agents a ON s.agent_id = a.id
            WHERE s.user_id = $1
            ORDER BY s.last_message_at DESC
            LIMIT 50
            "#,
        )
        .bind(user_id)
        .fetch_all(db)
        .await?
    };

    Ok(rows
        .iter()
        .map(|r| SessionInfo {
            id: r.get("id"),
            agent_id: r.get("agent_id"),
            agent_name: r.get("agent_name"),
            message_count: r.get("message_count"),
            total_cost_usdc: r.get("total_cost_usdc"),
            created_at: r.get("created_at"),
            last_message_at: r.get("last_message_at"),
        })
        .collect())
}

// ---------------------------------------------------------------------------
// Stats & Ratings
// ---------------------------------------------------------------------------

pub async fn increment_agent_stats(
    db: &PgPool,
    agent_id: Uuid,
    session_id: Uuid,
    cost_usdc: i64,
) -> Result<(), CloudError> {
    // Check if this is the first message in the session
    let msg_count: i32 = sqlx::query_scalar(
        "SELECT message_count FROM agent_sessions WHERE id = $1",
    )
    .bind(session_id)
    .fetch_one(db)
    .await
    .unwrap_or(0);

    let is_first = msg_count == 0;

    // Update session
    sqlx::query(
        r#"
        UPDATE agent_sessions SET
            message_count = message_count + 1,
            total_cost_usdc = total_cost_usdc + $1,
            last_message_at = now()
        WHERE id = $2
        "#,
    )
    .bind(cost_usdc)
    .bind(session_id)
    .execute(db)
    .await?;

    // Update agent stats
    if is_first {
        sqlx::query(
            r#"
            UPDATE rental_agents SET
                total_conversations = total_conversations + 1,
                total_messages = total_messages + 1,
                updated_at = now()
            WHERE id = $1
            "#,
        )
        .bind(agent_id)
        .execute(db)
        .await?;
    } else {
        sqlx::query(
            "UPDATE rental_agents SET total_messages = total_messages + 1, updated_at = now() WHERE id = $1",
        )
        .bind(agent_id)
        .execute(db)
        .await?;
    }

    Ok(())
}

pub async fn rate_agent(
    db: &PgPool,
    user_id: Uuid,
    session_id: Uuid,
    agent_id: Uuid,
    rating: i32,
    feedback: Option<String>,
) -> Result<(), CloudError> {
    if !(1..=5).contains(&rating) {
        return Err(CloudError::BadRequest("rating must be between 1 and 5".into()));
    }

    // Verify session belongs to user and agent
    let valid: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM agent_sessions WHERE id = $1 AND user_id = $2 AND agent_id = $3)",
    )
    .bind(session_id)
    .bind(user_id)
    .bind(agent_id)
    .fetch_one(db)
    .await
    .unwrap_or(false);

    if !valid {
        return Err(CloudError::BadRequest("invalid session for this agent".into()));
    }

    // Upsert rating
    sqlx::query(
        r#"
        INSERT INTO agent_ratings (agent_id, user_id, session_id, rating, feedback)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (user_id, session_id)
        DO UPDATE SET rating = $4, feedback = $5, created_at = now()
        "#,
    )
    .bind(agent_id)
    .bind(user_id)
    .bind(session_id)
    .bind(rating)
    .bind(&feedback)
    .execute(db)
    .await?;

    // Recalculate average rating
    sqlx::query(
        r#"
        UPDATE rental_agents SET
            avg_rating = COALESCE(
                (SELECT AVG(rating::float) FROM agent_ratings WHERE agent_id = $1),
                0.0
            )
        WHERE id = $1
        "#,
    )
    .bind(agent_id)
    .execute(db)
    .await?;

    Ok(())
}
