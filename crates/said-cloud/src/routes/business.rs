use std::sync::Arc;

use axum::extract::State;
use axum::http::header;
use axum::response::IntoResponse;
use axum::Extension;
use axum::Json;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::Claims;
use crate::db::DbBusinessProfile;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// GET /v1/business/profile
pub async fn get_profile(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
) -> AppResult<Json<said_types::BusinessProfile>> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Internal("Invalid user ID in token".into()))?;

    let profile: DbBusinessProfile = sqlx::query_as(
        r#"SELECT id, user_id, did, business_name, handle, category, description,
                  logo_url, website, verified_domain, verified_at,
                  operating_hours, location, contact,
                  services, policies, api_endpoints, payment_methods,
                  created_at, updated_at
           FROM business_profiles WHERE user_id = $1"#,
    )
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("Business profile not found".into()))?;

    Ok(Json(profile.into()))
}

#[derive(Debug, Deserialize)]
pub struct UpdateProfileRequest {
    pub business_name: Option<String>,
    pub handle: Option<String>,
    pub category: Option<String>,
    pub description: Option<String>,
    pub logo_url: Option<String>,
    pub website: Option<String>,
    pub operating_hours: Option<serde_json::Value>,
    pub location: Option<serde_json::Value>,
    pub contact: Option<serde_json::Value>,
    pub services: Option<serde_json::Value>,
    pub policies: Option<serde_json::Value>,
    pub api_endpoints: Option<serde_json::Value>,
    pub payment_methods: Option<serde_json::Value>,
}

/// PUT /v1/business/profile
pub async fn update_profile(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Json(req): Json<UpdateProfileRequest>,
) -> AppResult<Json<said_types::BusinessProfile>> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Internal("Invalid user ID in token".into()))?;

    // Check handle uniqueness if provided
    if let Some(ref handle) = req.handle {
        let existing: Option<(Uuid,)> = sqlx::query_as(
            "SELECT id FROM business_profiles WHERE handle = $1 AND user_id != $2",
        )
        .bind(handle)
        .bind(user_id)
        .fetch_optional(&state.db)
        .await?;

        if existing.is_some() {
            return Err(AppError::Conflict("Handle is already taken".into()));
        }
    }

    // Build dynamic update query
    let profile: DbBusinessProfile = sqlx::query_as(
        r#"UPDATE business_profiles SET
            business_name = COALESCE($2, business_name),
            handle = COALESCE($3, handle),
            category = COALESCE($4, category),
            description = COALESCE($5, description),
            logo_url = COALESCE($6, logo_url),
            website = COALESCE($7, website),
            operating_hours = COALESCE($8, operating_hours),
            location = COALESCE($9, location),
            contact = COALESCE($10, contact),
            services = COALESCE($11, services),
            policies = COALESCE($12, policies),
            api_endpoints = COALESCE($13, api_endpoints),
            payment_methods = COALESCE($14, payment_methods),
            updated_at = now()
           WHERE user_id = $1
           RETURNING id, user_id, did, business_name, handle, category, description,
                     logo_url, website, verified_domain, verified_at,
                     operating_hours, location, contact,
                     services, policies, api_endpoints, payment_methods,
                     created_at, updated_at"#,
    )
    .bind(user_id)
    .bind(&req.business_name)
    .bind(&req.handle)
    .bind(&req.category)
    .bind(&req.description)
    .bind(&req.logo_url)
    .bind(&req.website)
    .bind(&req.operating_hours)
    .bind(&req.location)
    .bind(&req.contact)
    .bind(&req.services)
    .bind(&req.policies)
    .bind(&req.api_endpoints)
    .bind(&req.payment_methods)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("Business profile not found".into()))?;

    Ok(Json(profile.into()))
}

#[derive(Debug, Deserialize)]
pub struct VerifyDomainRequest {
    pub method: String, // "dns-txt" or "well-known"
}

#[derive(Debug, Serialize)]
pub struct VerifyDomainResponse {
    pub method: String,
    pub instructions: String,
    pub token: String,
    /// The content to place (TXT record value or JSON body)
    pub content: String,
}

/// POST /v1/business/verify-domain
pub async fn verify_domain(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Json(req): Json<VerifyDomainRequest>,
) -> AppResult<Json<VerifyDomainResponse>> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Internal("Invalid user ID in token".into()))?;

    if req.method != "dns-txt" && req.method != "well-known" {
        return Err(AppError::BadRequest(
            "Method must be 'dns-txt' or 'well-known'".into(),
        ));
    }

    // Get profile
    let profile: (Uuid, String, String) = sqlx::query_as(
        "SELECT id, did, website FROM business_profiles WHERE user_id = $1",
    )
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("Business profile not found".into()))?;

    let (profile_id, did, website) = profile;

    // Extract domain from website URL
    let domain = extract_domain(&website)
        .ok_or_else(|| AppError::BadRequest("No valid domain in website URL".into()))?;

    // Generate verification token
    let token = format!("said-verify={}", did);

    // Store the verification request
    sqlx::query(
        r#"INSERT INTO domain_verifications (profile_id, domain, method, token)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (id) DO NOTHING"#,
    )
    .bind(profile_id)
    .bind(&domain)
    .bind(&req.method)
    .bind(&token)
    .execute(&state.db)
    .await?;

    let (instructions, content) = match req.method.as_str() {
        "dns-txt" => (
            format!(
                "Add a TXT record to your DNS for domain '{}' with the following value:",
                domain
            ),
            token.clone(),
        ),
        "well-known" => {
            let json_content = serde_json::json!({
                "said_version": "1.0",
                "did": did,
                "verified": true
            });
            (
                format!(
                    "Place the following JSON at https://{}/.well-known/said-verify.json",
                    domain
                ),
                serde_json::to_string_pretty(&json_content)
                    .unwrap_or_default(),
            )
        }
        _ => unreachable!(),
    };

    Ok(Json(VerifyDomainResponse {
        method: req.method,
        instructions,
        token,
        content,
    }))
}

/// GET /v1/business/agents-txt
pub async fn agents_txt(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
) -> AppResult<impl IntoResponse> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Internal("Invalid user ID in token".into()))?;

    let profile: DbBusinessProfile = sqlx::query_as(
        r#"SELECT id, user_id, did, business_name, handle, category, description,
                  logo_url, website, verified_domain, verified_at,
                  operating_hours, location, contact,
                  services, policies, api_endpoints, payment_methods,
                  created_at, updated_at
           FROM business_profiles WHERE user_id = $1"#,
    )
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("Business profile not found".into()))?;

    let bp: said_types::BusinessProfile = profile.into();
    let profile_url = format!("{}/v1/resolve/{}", state.config.base_url, bp.did);

    let mut lines = Vec::new();
    lines.push("# agents.txt - SAID Protocol v1.0".to_string());
    lines.push(format!("Identity: {}", bp.did));
    lines.push(format!("Profile: {}", profile_url));
    lines.push("Said-Json: /.well-known/said.json".to_string());
    lines.push(String::new());
    lines.push("Allow-Agent: *".to_string());

    for svc in &bp.services {
        if let Some(ref url) = svc.api_endpoint {
            lines.push(format!("Service: {} {}", svc.name, url));
        } else if let Some(ref url) = svc.booking_url {
            lines.push(format!("Service: {} {}", svc.name, url));
        }
    }

    // Emit Skill directives for services that have agentskills.io manifests
    let has_skills = bp.services.iter().any(|s| s.skill_url.is_some());
    if has_skills {
        lines.push(String::new());
        for svc in &bp.services {
            if let Some(ref skill_url) = svc.skill_url {
                lines.push(format!("Skill: {} {}", svc.name, skill_url));
            }
        }
    }

    let body = lines.join("\n");

    Ok((
        [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
        body,
    ))
}

/// GET /v1/business/well-known
pub async fn well_known(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
) -> AppResult<Json<said_types::WellKnownSaid>> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Internal("Invalid user ID in token".into()))?;

    let profile: DbBusinessProfile = sqlx::query_as(
        r#"SELECT id, user_id, did, business_name, handle, category, description,
                  logo_url, website, verified_domain, verified_at,
                  operating_hours, location, contact,
                  services, policies, api_endpoints, payment_methods,
                  created_at, updated_at
           FROM business_profiles WHERE user_id = $1"#,
    )
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("Business profile not found".into()))?;

    let bp: said_types::BusinessProfile = profile.into();
    let profile_url = format!("{}/v1/resolve/{}", state.config.base_url, bp.did);

    let verification = bp.verified_domain.as_ref().map(|_| {
        said_types::WellKnownVerification {
            method: "dns-txt".to_string(),
            record: Some(format!("said-verify={}", bp.did)),
        }
    });

    let well_known = said_types::WellKnownSaid {
        said_version: "1.0".to_string(),
        did: bp.did.clone(),
        profile_url: Some(profile_url),
        business: Some(said_types::WellKnownBusiness {
            name: bp.business_name.clone(),
            category: Some(bp.category.clone()),
            description: Some(bp.description.clone()),
        }),
        services: bp.services,
        operating_hours: bp.operating_hours,
        verification,
    };

    Ok(Json(well_known))
}

fn extract_domain(url: &str) -> Option<String> {
    // Handle bare domains and URLs
    let url = url.trim();
    if url.is_empty() {
        return None;
    }

    // If it looks like a URL with scheme
    if url.contains("://") {
        let after_scheme = url.split("://").nth(1)?;
        let domain = after_scheme.split('/').next()?;
        let domain = domain.split(':').next()?; // strip port
        if domain.contains('.') {
            return Some(domain.to_string());
        }
        return None;
    }

    // Bare domain
    let domain = url.split('/').next()?;
    let domain = domain.split(':').next()?;
    if domain.contains('.') {
        Some(domain.to_string())
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// POST /v1/business/check-domain-verification (protected)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct CheckVerificationResponse {
    pub verified: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

pub async fn check_domain_verification(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
) -> AppResult<Json<CheckVerificationResponse>> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Internal("Invalid user ID in token".into()))?;

    // Get user's business profile
    let profile: Option<(Uuid,)> =
        sqlx::query_as("SELECT id FROM business_profiles WHERE user_id = $1")
            .bind(user_id)
            .fetch_optional(&state.db)
            .await?;

    let profile_id = match profile {
        Some((id,)) => id,
        None => {
            return Err(AppError::NotFound("Business profile not found".into()));
        }
    };

    // Get most recent domain verification request
    let record: Option<(Uuid, String, String, String, bool)> = sqlx::query_as(
        "SELECT id, domain, method, token, verified FROM domain_verifications \
         WHERE profile_id = $1 ORDER BY created_at DESC LIMIT 1",
    )
    .bind(profile_id)
    .fetch_optional(&state.db)
    .await?;

    let (record_id, domain, method, token, already_verified) = match record {
        Some(r) => r,
        None => {
            return Ok(Json(CheckVerificationResponse {
                verified: false,
                domain: None,
                message: Some(
                    "No verification request found. Please start domain verification first."
                        .into(),
                ),
            }));
        }
    };

    if already_verified {
        return Ok(Json(CheckVerificationResponse {
            verified: true,
            domain: Some(domain),
            message: None,
        }));
    }

    // Perform the actual verification check
    let verified = match method.as_str() {
        "dns-txt" | "dns" => check_dns_txt(&state.http_client, &domain, &token).await,
        "well-known" => check_well_known(&state.http_client, &domain, &token).await,
        _ => false,
    };

    if verified {
        // Mark verification as complete
        sqlx::query("UPDATE domain_verifications SET verified = true WHERE id = $1")
            .bind(record_id)
            .execute(&state.db)
            .await?;

        // Update business profile
        sqlx::query(
            "UPDATE business_profiles SET verified_domain = $1, verified_at = now() WHERE id = $2",
        )
        .bind(&domain)
        .bind(profile_id)
        .execute(&state.db)
        .await?;

        Ok(Json(CheckVerificationResponse {
            verified: true,
            domain: Some(domain),
            message: None,
        }))
    } else {
        Ok(Json(CheckVerificationResponse {
            verified: false,
            domain: Some(domain),
            message: Some(
                "Verification record not found. Please ensure your DNS TXT record or well-known file is configured correctly."
                    .into(),
            ),
        }))
    }
}

async fn check_dns_txt(client: &reqwest::Client, domain: &str, token: &str) -> bool {
    let url = format!("https://dns.google/resolve?name={domain}&type=TXT");
    let resp = match client.get(&url).send().await {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("DNS lookup failed for {domain}: {e}");
            return false;
        }
    };
    let body: serde_json::Value = match resp.json().await {
        Ok(v) => v,
        Err(_) => return false,
    };
    if let Some(answers) = body.get("Answer").and_then(|a| a.as_array()) {
        for answer in answers {
            if let Some(data) = answer.get("data").and_then(|d| d.as_str()) {
                // DNS TXT records may have surrounding quotes
                let clean = data.trim_matches('"');
                if clean.contains(token) {
                    return true;
                }
            }
        }
    }
    false
}

async fn check_well_known(client: &reqwest::Client, domain: &str, token: &str) -> bool {
    let url = format!("https://{}/.well-known/said-verify.json", domain);
    let resp = match client.get(&url).send().await {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("Well-known fetch failed for {domain}: {e}");
            return false;
        }
    };
    let body = match resp.text().await {
        Ok(t) => t,
        Err(_) => return false,
    };
    // Check if the response body contains the token
    body.contains(token)
}
