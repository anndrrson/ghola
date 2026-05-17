//! Spending-limit (budget) routes.
//!
//! GET  /api/limits  → current caps + rolling-window spend
//! POST /api/limits  → upsert caps
//!
//! These wrap the `services::budgets` layer so the UI can show the user
//! their current spend vs. cap and let them adjust either.

use std::sync::Arc;

use axum::{extract::State, Json};
use serde::Deserialize;
use uuid::Uuid;

use crate::auth::Claims;
use crate::error::{AppError, AppResult};
use crate::services::budgets::{self, Budget, SpendSnapshot};
use crate::state::AppState;

#[derive(serde::Serialize)]
pub struct LimitsView {
    pub budget: Budget,
    pub spend: SpendSnapshot,
}

pub async fn get_limits(
    State(state): State<Arc<AppState>>,
    claims: axum::Extension<Claims>,
) -> AppResult<Json<LimitsView>> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("Invalid token".into()))?;
    let budget = budgets::get(&state.db, user_id).await?;
    let spend = budgets::spend_snapshot(&state.db, user_id).await?;
    Ok(Json(LimitsView { budget, spend }))
}

#[derive(Debug, Deserialize)]
pub struct UpdateLimitsRequest {
    pub daily_cap_usd: f64,
    pub monthly_cap_usd: f64,
    pub total_cap_usd: Option<f64>,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

fn usd_to_micro(usd: f64) -> i64 {
    (usd * 1_000_000.0).round() as i64
}

pub async fn update_limits(
    State(state): State<Arc<AppState>>,
    claims: axum::Extension<Claims>,
    Json(req): Json<UpdateLimitsRequest>,
) -> AppResult<Json<Budget>> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("Invalid token".into()))?;

    if req.daily_cap_usd <= 0.0 || req.monthly_cap_usd <= 0.0 {
        return Err(AppError::BadRequest(
            "daily_cap_usd and monthly_cap_usd must be positive".into(),
        ));
    }
    if req.daily_cap_usd > req.monthly_cap_usd {
        return Err(AppError::BadRequest(
            "daily_cap_usd cannot exceed monthly_cap_usd".into(),
        ));
    }
    if let Some(total) = req.total_cap_usd {
        if total > 0.0 && total < req.monthly_cap_usd {
            return Err(AppError::BadRequest(
                "total_cap_usd must be >= monthly_cap_usd".into(),
            ));
        }
    }

    let budget = budgets::upsert(
        &state.db,
        user_id,
        usd_to_micro(req.daily_cap_usd),
        usd_to_micro(req.monthly_cap_usd),
        req.total_cap_usd
            .filter(|v| *v > 0.0)
            .map(usd_to_micro),
        req.enabled,
    )
    .await?;
    Ok(Json(budget))
}
