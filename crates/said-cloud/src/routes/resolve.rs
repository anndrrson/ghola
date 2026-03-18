use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::db::{DbBusinessProfile, DbPublicProfile};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// Public profile response (subset of BusinessProfile, no internal IDs)
#[derive(Debug, Serialize)]
pub struct PublicBusinessProfile {
    pub did: String,
    pub business_name: String,
    pub handle: Option<String>,
    pub category: String,
    pub description: String,
    pub logo_url: Option<String>,
    pub website: String,
    pub verified_domain: Option<String>,
    pub services: serde_json::Value,
    pub policies: serde_json::Value,
    pub api_endpoints: serde_json::Value,
    pub payment_methods: serde_json::Value,
    pub operating_hours: Option<serde_json::Value>,
    pub location: Option<serde_json::Value>,
    pub contact: Option<serde_json::Value>,
}

impl From<DbBusinessProfile> for PublicBusinessProfile {
    fn from(db: DbBusinessProfile) -> Self {
        Self {
            did: db.did,
            business_name: db.business_name,
            handle: db.handle,
            category: db.category,
            description: db.description,
            logo_url: db.logo_url,
            website: db.website,
            verified_domain: db.verified_domain,
            services: db.services,
            policies: db.policies,
            api_endpoints: db.api_endpoints,
            payment_methods: db.payment_methods,
            operating_hours: db.operating_hours,
            location: db.location,
            contact: db.contact,
        }
    }
}

/// Unified resolve response — can be either a business or consumer profile.
#[derive(Debug, Serialize)]
#[serde(tag = "profile_type")]
pub enum ResolvedProfile {
    #[serde(rename = "business")]
    Business(PublicBusinessProfile),
    #[serde(rename = "consumer")]
    Consumer(said_types::PublicProfile),
}

/// GET /v1/resolve/:did_or_handle
pub async fn resolve(
    State(state): State<Arc<AppState>>,
    Path(did_or_handle): Path<String>,
) -> AppResult<Json<ResolvedProfile>> {
    // Rate limit by DID/handle being resolved
    let rate_key = format!("resolve:{}", did_or_handle);
    if let Err(retry_after) = state.rate_limiter.check(&rate_key, 60) {
        return Err(AppError::TooManyRequests(retry_after));
    }

    if did_or_handle.starts_with("did:") {
        // Try business profiles first
        let biz: Option<DbBusinessProfile> = sqlx::query_as(
            r#"SELECT id, user_id, did, business_name, handle, category, description,
                      logo_url, website, verified_domain, verified_at,
                      operating_hours, location, contact,
                      services, policies, api_endpoints, payment_methods,
                      created_at, updated_at
               FROM business_profiles WHERE did = $1"#,
        )
        .bind(&did_or_handle)
        .fetch_optional(&state.db)
        .await?;

        if let Some(profile) = biz {
            log_resolve(&state, profile.id).await;
            return Ok(Json(ResolvedProfile::Business(profile.into())));
        }

        // Fall back to public profiles
        let consumer: Option<DbPublicProfile> = sqlx::query_as(
            r#"SELECT id, user_id, did, display_name, handle, avatar_url, bio, timezone,
                      agent_preferences, encrypted_wallet, on_chain_registered,
                      created_at, updated_at
               FROM public_profiles WHERE did = $1"#,
        )
        .bind(&did_or_handle)
        .fetch_optional(&state.db)
        .await?;

        if let Some(profile) = consumer {
            log_resolve(&state, profile.id).await;
            return Ok(Json(ResolvedProfile::Consumer(profile.into())));
        }
    } else {
        // Treat as handle — strip leading @ if present
        let handle = did_or_handle.strip_prefix('@').unwrap_or(&did_or_handle);

        // Try business profiles first
        let biz: Option<DbBusinessProfile> = sqlx::query_as(
            r#"SELECT id, user_id, did, business_name, handle, category, description,
                      logo_url, website, verified_domain, verified_at,
                      operating_hours, location, contact,
                      services, policies, api_endpoints, payment_methods,
                      created_at, updated_at
               FROM business_profiles WHERE handle = $1"#,
        )
        .bind(handle)
        .fetch_optional(&state.db)
        .await?;

        if let Some(profile) = biz {
            log_resolve(&state, profile.id).await;
            return Ok(Json(ResolvedProfile::Business(profile.into())));
        }

        // Fall back to public profiles
        let consumer: Option<DbPublicProfile> = sqlx::query_as(
            r#"SELECT id, user_id, did, display_name, handle, avatar_url, bio, timezone,
                      agent_preferences, encrypted_wallet, on_chain_registered,
                      created_at, updated_at
               FROM public_profiles WHERE handle = $1"#,
        )
        .bind(handle)
        .fetch_optional(&state.db)
        .await?;

        if let Some(profile) = consumer {
            log_resolve(&state, profile.id).await;
            return Ok(Json(ResolvedProfile::Consumer(profile.into())));
        }
    }

    Err(AppError::NotFound("Profile not found".into()))
}

async fn log_resolve(state: &AppState, profile_id: uuid::Uuid) {
    let _ = sqlx::query(
        "INSERT INTO usage_logs (profile_id, endpoint) VALUES ($1, 'resolve')",
    )
    .bind(profile_id)
    .execute(&state.db)
    .await;
}

#[derive(Debug, Deserialize)]
pub struct DiscoverQuery {
    pub domain: String,
}

#[derive(Debug, Serialize)]
pub struct DiscoverResponse {
    pub domain: String,
    pub agents_txt: Option<said_types::AgentsTxt>,
    pub well_known: Option<said_types::WellKnownSaid>,
    pub source: String,
}

/// GET /v1/discover?domain=example.com
pub async fn discover(
    State(state): State<Arc<AppState>>,
    Query(query): Query<DiscoverQuery>,
) -> AppResult<Json<DiscoverResponse>> {
    let domain = query.domain.trim().to_string();
    if domain.is_empty() || !domain.contains('.') {
        return Err(AppError::BadRequest("Invalid domain".into()));
    }

    // Try fetching agents.txt
    let agents_txt_url = format!("https://{}/agents.txt", domain);
    let agents_txt = match state.http_client.get(&agents_txt_url).send().await {
        Ok(resp) if resp.status().is_success() => {
            let text = resp.text().await.unwrap_or_default();
            Some(parse_agents_txt(&text))
        }
        _ => None,
    };

    // Try fetching .well-known/said.json
    let well_known_url = format!("https://{}/.well-known/said.json", domain);
    let well_known = match state.http_client.get(&well_known_url).send().await {
        Ok(resp) if resp.status().is_success() => {
            resp.json::<said_types::WellKnownSaid>().await.ok()
        }
        _ => None,
    };

    if agents_txt.is_none() && well_known.is_none() {
        return Err(AppError::NotFound(format!(
            "No SAID identity found for domain '{}'",
            domain
        )));
    }

    let source = match (&agents_txt, &well_known) {
        (Some(_), Some(_)) => "agents_txt+well_known",
        (Some(_), None) => "agents_txt",
        (None, Some(_)) => "well_known",
        (None, None) => unreachable!(),
    };

    Ok(Json(DiscoverResponse {
        domain,
        agents_txt,
        well_known,
        source: source.to_string(),
    }))
}

/// Parse an agents.txt file into the AgentsTxt struct.
fn parse_agents_txt(text: &str) -> said_types::AgentsTxt {
    let mut identity = None;
    let mut profile_url = None;
    let mut said_json = None;
    let mut allow_agents = Vec::new();
    let mut services = Vec::new();
    let mut skills = Vec::new();
    let mut auth = None;

    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        if let Some(rest) = line.strip_prefix("Identity:") {
            identity = Some(rest.trim().to_string());
        } else if let Some(rest) = line.strip_prefix("Profile:") {
            profile_url = Some(rest.trim().to_string());
        } else if let Some(rest) = line.strip_prefix("Said-Json:") {
            said_json = Some(rest.trim().to_string());
        } else if let Some(rest) = line.strip_prefix("Allow-Agent:") {
            allow_agents.push(rest.trim().to_string());
        } else if let Some(rest) = line.strip_prefix("Service:") {
            let parts: Vec<&str> = rest.trim().splitn(2, ' ').collect();
            if parts.len() == 2 {
                services.push(said_types::AgentsTxtService {
                    name: parts[0].to_string(),
                    url: parts[1].to_string(),
                });
            }
        } else if let Some(rest) = line.strip_prefix("Skill:") {
            let parts: Vec<&str> = rest.trim().splitn(2, ' ').collect();
            if parts.len() == 2 {
                skills.push(said_types::AgentsTxtSkill {
                    name: parts[0].to_string(),
                    url: parts[1].to_string(),
                });
            }
        } else if let Some(rest) = line.strip_prefix("Auth:") {
            let parts: Vec<&str> = rest.trim().splitn(2, ' ').collect();
            if parts.len() == 2 {
                auth = Some(said_types::AgentsTxtAuth {
                    method: parts[0].to_string(),
                    url: parts[1].to_string(),
                });
            }
        }
    }

    said_types::AgentsTxt {
        identity,
        profile_url,
        said_json,
        allow_agents,
        services,
        skills,
        auth,
    }
}
