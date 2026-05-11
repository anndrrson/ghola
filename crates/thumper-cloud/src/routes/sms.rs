use axum::extract::State;
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::error::CloudError;
use crate::state::AppState;

#[derive(Deserialize)]
pub struct SendSmsRequest {
    pub to: String,
    pub body: String,
}

#[derive(Serialize)]
pub struct SmsResponse {
    pub id: Uuid,
    pub to_number: String,
    pub body: String,
    pub status: String,
    pub vendor: Option<String>,
    pub vendor_message_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub sent_at: Option<DateTime<Utc>>,
}

/// POST /api/sms/send — send a text message via the configured vendor.
pub async fn send_sms(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Json(req): Json<SendSmsRequest>,
) -> Result<Json<SmsResponse>, CloudError> {
    check_sms_limit(&state, claims.sub, &claims.tier).await?;

    if req.to.trim().is_empty() {
        return Err(CloudError::BadRequest("missing recipient".into()));
    }
    if req.body.trim().is_empty() {
        return Err(CloudError::BadRequest("missing body".into()));
    }

    // Insert as in-flight
    let sms_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO sms_actions (user_id, to_number, body, status)
        VALUES ($1, $2, $3, 'sending')
        RETURNING id
        "#,
    )
    .bind(claims.sub)
    .bind(&req.to)
    .bind(&req.body)
    .fetch_one(&state.db)
    .await?;

    let send_result =
        crate::services::sms_service::send_sms(&state, claims.sub, sms_id, &req.to, &req.body)
            .await;

    let row = match send_result {
        Ok(ok) => sqlx::query_as::<_, (Uuid, String, String, String, Option<String>, Option<String>, DateTime<Utc>, Option<DateTime<Utc>>)>(
            r#"
            UPDATE sms_actions
            SET status = 'sent', vendor = $1, vendor_message_id = $2, sent_at = now()
            WHERE id = $3
            RETURNING id, to_number, body, status, vendor, vendor_message_id, created_at, sent_at
            "#,
        )
        .bind(ok.vendor)
        .bind(&ok.vendor_message_id)
        .bind(sms_id)
        .fetch_one(&state.db)
        .await?,
        Err(e) => {
            sqlx::query("UPDATE sms_actions SET status = 'failed', error = $1 WHERE id = $2")
                .bind(e.to_string())
                .bind(sms_id)
                .execute(&state.db)
                .await?;
            return Err(e);
        }
    };

    // Bump usage
    let period_start = chrono::Utc::now()
        .date_naive()
        .format("%Y-%m-01")
        .to_string();
    sqlx::query(
        r#"
        INSERT INTO usage_tracking (user_id, period_start, sms_count)
        VALUES ($1, $2::date, 1)
        ON CONFLICT (user_id, period_start) DO UPDATE SET
            sms_count = COALESCE(usage_tracking.sms_count, 0) + 1
        "#,
    )
    .bind(claims.sub)
    .bind(&period_start)
    .execute(&state.db)
    .await?;

    // Telegram notify
    if let Ok(Some(tg_link)) =
        crate::services::telegram::get_telegram_link(&state.db, claims.sub).await
    {
        if let Some(ref token) = state.config.telegram_bot_token {
            let summary = format!("Text sent!\n\nTo: {}\n\n{}", &req.to, &req.body);
            let _ = crate::services::telegram::notify_user(token, tg_link.0, &summary).await;
        }
    }

    Ok(Json(SmsResponse {
        id: row.0,
        to_number: row.1,
        body: row.2,
        status: row.3,
        vendor: row.4,
        vendor_message_id: row.5,
        created_at: row.6,
        sent_at: row.7,
    }))
}

async fn check_sms_limit(state: &AppState, user_id: Uuid, tier: &str) -> Result<(), CloudError> {
    let max: i64 = match tier {
        "pro" => 50,
        "unlimited" | "enterprise" => i64::MAX,
        _ => 10,
    };

    let period_start = chrono::Utc::now()
        .date_naive()
        .format("%Y-%m-01")
        .to_string();
    let count: i64 = sqlx::query_scalar(
        "SELECT COALESCE(sms_count, 0) FROM usage_tracking WHERE user_id = $1 AND period_start = $2::date",
    )
    .bind(user_id)
    .bind(&period_start)
    .fetch_optional(&state.db)
    .await?
    .unwrap_or(0);

    if count >= max {
        return Err(CloudError::PaymentRequired(
            "monthly SMS limit reached — upgrade your plan".into(),
        ));
    }
    Ok(())
}
