use std::sync::Arc;

use axum::extract::{Query, State};
use axum::Extension;
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::Claims;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Extract the profile_id for the authenticated user, returning None if no profile.
async fn get_profile_id(
    db: &sqlx::PgPool,
    user_id: Uuid,
) -> AppResult<Option<Uuid>> {
    let row: Option<(Uuid,)> =
        sqlx::query_as("SELECT id FROM business_profiles WHERE user_id = $1")
            .bind(user_id)
            .fetch_optional(db)
            .await?;
    Ok(row.map(|(id,)| id))
}

fn parse_user_id(claims: &Claims) -> AppResult<Uuid> {
    claims
        .sub
        .parse()
        .map_err(|_| AppError::Internal("Invalid user ID in token".into()))
}

// ---------------------------------------------------------------------------
// GET /v1/analytics/summary
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct AnalyticsSummary {
    pub profile_views: i64,
    pub resolve_count: i64,
    pub total_api_calls: i64,
    pub agents_txt_fetches: i64,
    pub well_known_fetches: i64,
    pub service_calls: i64,
    pub unique_agents: i64,
    pub period: String,
}

pub async fn summary(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
) -> AppResult<Json<AnalyticsSummary>> {
    let user_id = parse_user_id(&claims)?;
    let profile_id = match get_profile_id(&state.db, user_id).await? {
        Some(id) => id,
        None => {
            return Ok(Json(AnalyticsSummary {
                profile_views: 0,
                resolve_count: 0,
                total_api_calls: 0,
                agents_txt_fetches: 0,
                well_known_fetches: 0,
                service_calls: 0,
                unique_agents: 0,
                period: "last_30_days".to_string(),
            }));
        }
    };

    // usage_logs counts (last 30 days)
    let resolve_count: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM usage_logs \
         WHERE profile_id = $1 AND endpoint = 'resolve' \
         AND created_at >= now() - interval '30 days'",
    )
    .bind(profile_id)
    .fetch_one(&state.db)
    .await?;

    let total_count: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM usage_logs \
         WHERE profile_id = $1 \
         AND created_at >= now() - interval '30 days'",
    )
    .bind(profile_id)
    .fetch_one(&state.db)
    .await?;

    // discovery_events counts (last 30 days)
    let agents_txt: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM discovery_events \
         WHERE profile_id = $1 AND event_type = 'agents_txt_fetched' \
         AND created_at >= now() - interval '30 days'",
    )
    .bind(profile_id)
    .fetch_one(&state.db)
    .await?;

    let well_known: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM discovery_events \
         WHERE profile_id = $1 AND event_type = 'well_known_fetched' \
         AND created_at >= now() - interval '30 days'",
    )
    .bind(profile_id)
    .fetch_one(&state.db)
    .await?;

    let service_calls: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM discovery_events \
         WHERE profile_id = $1 AND event_type = 'service_called' \
         AND created_at >= now() - interval '30 days'",
    )
    .bind(profile_id)
    .fetch_one(&state.db)
    .await?;

    let unique_agents: (i64,) = sqlx::query_as(
        "SELECT COUNT(DISTINCT agent_identifier) FROM agent_interactions \
         WHERE profile_id = $1 \
         AND created_at >= now() - interval '30 days'",
    )
    .bind(profile_id)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(AnalyticsSummary {
        profile_views: resolve_count.0,
        resolve_count: resolve_count.0,
        total_api_calls: total_count.0,
        agents_txt_fetches: agents_txt.0,
        well_known_fetches: well_known.0,
        service_calls: service_calls.0,
        unique_agents: unique_agents.0,
        period: "last_30_days".to_string(),
    }))
}

// ---------------------------------------------------------------------------
// GET /v1/analytics/timeline?days=30
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct TimelineQuery {
    pub days: Option<i32>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct DayStats {
    pub date: String,
    pub views: i64,
    pub resolves: i64,
    pub service_calls: i64,
}

#[derive(Debug, Serialize)]
pub struct TimelineResponse {
    pub days: Vec<DayStats>,
}

pub async fn timeline(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Query(params): Query<TimelineQuery>,
) -> AppResult<Json<TimelineResponse>> {
    let user_id = parse_user_id(&claims)?;
    let profile_id = match get_profile_id(&state.db, user_id).await? {
        Some(id) => id,
        None => return Ok(Json(TimelineResponse { days: vec![] })),
    };

    let days = params.days.unwrap_or(30).min(90).max(1);

    // Build daily stats from usage_logs
    let rows: Vec<DayStats> = sqlx::query_as(
        r#"
        SELECT
            to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS date,
            COUNT(*) FILTER (WHERE endpoint = 'resolve') AS views,
            COUNT(*) FILTER (WHERE endpoint = 'resolve') AS resolves,
            COUNT(*) FILTER (WHERE endpoint = 'service_call') AS service_calls
        FROM usage_logs
        WHERE profile_id = $1
          AND created_at >= now() - make_interval(days => $2)
        GROUP BY date_trunc('day', created_at)
        ORDER BY date_trunc('day', created_at)
        "#,
    )
    .bind(profile_id)
    .bind(days)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(TimelineResponse { days: rows }))
}

// ---------------------------------------------------------------------------
// GET /v1/analytics/agents
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct AgentStat {
    pub identifier: Option<String>,
    pub interactions: i64,
    pub last_seen: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct AgentsResponse {
    pub agents: Vec<AgentStat>,
}

pub async fn agents(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
) -> AppResult<Json<AgentsResponse>> {
    let user_id = parse_user_id(&claims)?;
    let profile_id = match get_profile_id(&state.db, user_id).await? {
        Some(id) => id,
        None => return Ok(Json(AgentsResponse { agents: vec![] })),
    };

    let rows: Vec<AgentStat> = sqlx::query_as(
        r#"
        SELECT
            agent_identifier AS identifier,
            COUNT(*) AS interactions,
            MAX(created_at) AS last_seen
        FROM agent_interactions
        WHERE profile_id = $1
        GROUP BY agent_identifier
        ORDER BY interactions DESC
        LIMIT 20
        "#,
    )
    .bind(profile_id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(AgentsResponse { agents: rows }))
}

// ---------------------------------------------------------------------------
// GET /v1/analytics/funnel
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct FunnelResponse {
    pub agents_txt_fetched: i64,
    pub well_known_fetched: i64,
    pub profile_resolved: i64,
    pub service_called: i64,
}

pub async fn funnel(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
) -> AppResult<Json<FunnelResponse>> {
    let user_id = parse_user_id(&claims)?;
    let profile_id = match get_profile_id(&state.db, user_id).await? {
        Some(id) => id,
        None => {
            return Ok(Json(FunnelResponse {
                agents_txt_fetched: 0,
                well_known_fetched: 0,
                profile_resolved: 0,
                service_called: 0,
            }));
        }
    };

    #[derive(sqlx::FromRow)]
    struct FunnelRow {
        event_type: String,
        cnt: i64,
    }

    let rows: Vec<FunnelRow> = sqlx::query_as(
        r#"
        SELECT event_type, COUNT(*) AS cnt
        FROM discovery_events
        WHERE profile_id = $1
          AND created_at >= now() - interval '30 days'
        GROUP BY event_type
        "#,
    )
    .bind(profile_id)
    .fetch_all(&state.db)
    .await?;

    let mut resp = FunnelResponse {
        agents_txt_fetched: 0,
        well_known_fetched: 0,
        profile_resolved: 0,
        service_called: 0,
    };

    for row in rows {
        match row.event_type.as_str() {
            "agents_txt_fetched" => resp.agents_txt_fetched = row.cnt,
            "well_known_fetched" => resp.well_known_fetched = row.cnt,
            "profile_resolved" => resp.profile_resolved = row.cnt,
            "service_called" => resp.service_called = row.cnt,
            _ => {}
        }
    }

    Ok(Json(resp))
}
