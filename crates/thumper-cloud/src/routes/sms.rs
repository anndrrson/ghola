use axum::extract::State;
use axum::Json;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::error::CloudError;
use crate::state::AppState;

#[derive(Deserialize)]
pub struct SendSmsRequest {
    pub to: String,
    pub body: String,
    pub task_id: Option<Uuid>,
}

#[derive(Serialize)]
pub struct SmsResponse {
    pub id: Uuid,
    pub to: String,
    pub body: String,
    pub status: String,
    pub sent_at: Option<chrono::DateTime<chrono::Utc>>,
    pub vendor_message_id: Option<String>,
}

/// POST /api/sms/send
pub async fn send_sms(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Json(req): Json<SendSmsRequest>,
) -> Result<Json<SmsResponse>, CloudError> {
    check_sms_limit(&state, claims.sub, &claims.tier).await?;

    let sms_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO sms_actions (user_id, task_id, to_number, body, vendor, status)
        VALUES ($1, $2, $3, $4, 'bland', 'sending')
        RETURNING id
        "#,
    )
    .bind(claims.sub)
    .bind(req.task_id)
    .bind(&req.to)
    .bind(&req.body)
    .fetch_one(&state.db)
    .await?;

    let send_result =
        crate::services::sms_service::send_sms(&state, claims.sub, &req.to, &req.body).await;

    match send_result {
        Ok(vendor_message_id) => {
            let now = chrono::Utc::now();
            sqlx::query(
                r#"
                UPDATE sms_actions SET
                    vendor_message_id = $1,
                    status = 'sent',
                    sent_at = $2
                WHERE id = $3
                "#,
            )
            .bind(&vendor_message_id)
            .bind(now)
            .bind(sms_id)
            .execute(&state.db)
            .await?;

            update_usage(&state, claims.sub).await?;

            if let Ok(Some(tg_link)) =
                crate::services::telegram::get_telegram_link(&state.db, claims.sub).await
            {
                if let Some(ref token) = state.config.telegram_bot_token {
                    let summary = format!("📱 SMS sent to {} ({}…)", req.to, &req.body.chars().take(40).collect::<String>());
                    let _ = crate::services::telegram::notify_user(token, tg_link.0, &summary).await;
                }
            }

            Ok(Json(SmsResponse {
                id: sms_id,
                to: req.to,
                body: req.body,
                status: "sent".to_string(),
                sent_at: Some(now),
                vendor_message_id: Some(vendor_message_id),
            }))
        }
        Err(e) => {
            let err_msg = e.to_string();
            sqlx::query(
                "UPDATE sms_actions SET status = 'failed', error = $1 WHERE id = $2",
            )
            .bind(&err_msg)
            .bind(sms_id)
            .execute(&state.db)
            .await?;
            Err(e)
        }
    }
}

/// POST /api/sms/webhook — vendor delivery status callback (stub).
///
/// Bland AI's SMS delivery webhooks aren't fully documented at the time of
/// writing. This endpoint accepts arbitrary JSON, stores the status if it can
/// match a row by `vendor_message_id`, and acks. Tighten the payload struct
/// once vendor behavior is confirmed in production.
pub async fn sms_webhook(
    State(state): State<AppState>,
    Json(payload): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, CloudError> {
    let vendor_message_id = payload
        .get("message_id")
        .and_then(|v| v.as_str())
        .or_else(|| payload.get("id").and_then(|v| v.as_str()));
    let status = payload
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");

    if let Some(mid) = vendor_message_id {
        let new_status = match status {
            "delivered" | "sent" => "sent",
            "failed" | "undelivered" => "failed",
            _ => return Ok(Json(serde_json::json!({ "ok": true }))),
        };
        sqlx::query("UPDATE sms_actions SET status = $1 WHERE vendor_message_id = $2")
            .bind(new_status)
            .bind(mid)
            .execute(&state.db)
            .await?;
    }

    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn check_sms_limit(state: &AppState, user_id: Uuid, tier: &str) -> Result<(), CloudError> {
    let max_sms = match tier {
        "pro" | "private_agent" => 50,
        "unlimited" => i64::MAX,
        _ => 10, // free
    };

    let period_start = chrono::Utc::now()
        .date_naive()
        .format("%Y-%m-01")
        .to_string();
    let count: i64 = sqlx::query_scalar(
        "SELECT COALESCE(sms_count, 0)::BIGINT FROM usage_tracking WHERE user_id = $1 AND period_start = $2::date",
    )
    .bind(user_id)
    .bind(&period_start)
    .fetch_optional(&state.db)
    .await?
    .unwrap_or(0);

    if count >= max_sms {
        return Err(CloudError::PaymentRequired(
            "monthly SMS limit reached — upgrade your plan".to_string(),
        ));
    }
    Ok(())
}

async fn update_usage(state: &AppState, user_id: Uuid) -> Result<(), CloudError> {
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
    .bind(user_id)
    .bind(&period_start)
    .execute(&state.db)
    .await?;
    Ok(())
}
