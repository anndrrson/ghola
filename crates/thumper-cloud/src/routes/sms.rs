use axum::extract::State;
use axum::Json;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::error::CloudError;
use crate::privacy::{phone_preview, sensitive_text_hash, NetworkScope, PrivacyApproval};
use crate::state::AppState;

#[derive(Deserialize)]
pub struct SendSmsRequest {
    pub to: String,
    pub body: String,
    pub task_id: Option<Uuid>,
    #[serde(flatten)]
    pub approval: PrivacyApproval,
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
    let approval = req.approval.require_and_store_for(NetworkScope::SmsSend)?;
    check_sms_limit(&state, claims.sub, &claims.tier).await?;
    let to_preview = phone_preview(&req.to);

    let sms_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO sms_actions
            (user_id, task_id, to_number, to_number_hash, to_number_preview, body, vendor, status,
             privacy_mode, network_scope, user_approved_at, approval_nonce, approval_summary)
        VALUES ($1, $2, $3, $4, $5, $6, 'bland', 'sending', $7, $8, $9, $10, $11)
        RETURNING id
        "#,
    )
    .bind(claims.sub)
    .bind(req.task_id)
    .bind(&to_preview)
    .bind(sensitive_text_hash(&req.to))
    .bind(&to_preview)
    .bind("")
    .bind(&approval.privacy_mode)
    .bind(&approval.network_scope)
    .bind(approval.user_approved_at)
    .bind(&approval.approval_nonce_hash)
    .bind(&approval.approval_summary)
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
                    sent_at = $2,
                    to_number = $3,
                    body = ''
                WHERE id = $4
                "#,
            )
            .bind(&vendor_message_id)
            .bind(now)
            .bind(&to_preview)
            .bind(sms_id)
            .execute(&state.db)
            .await?;

            update_usage(&state, claims.sub).await?;

            if let Ok(Some(tg_link)) =
                crate::services::telegram::get_telegram_link(&state.db, claims.sub).await
            {
                if let Some(ref token) = state.config.telegram_bot_token {
                    let summary = "SMS sent through external provider.";
                    let _ = crate::services::telegram::notify_user(token, tg_link.0, summary).await;
                }
            }

            Ok(Json(SmsResponse {
                id: sms_id,
                to: to_preview,
                body: String::new(),
                status: "sent".to_string(),
                sent_at: Some(now),
                vendor_message_id: Some(vendor_message_id),
            }))
        }
        Err(e) => {
            let err_msg = e.to_string();
            sqlx::query("UPDATE sms_actions SET status = 'failed', error = $1 WHERE id = $2")
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
        "pro" => 50,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::privacy::STRICT_LOCAL;
    use chrono::Utc;

    #[test]
    fn sms_send_requires_matching_approval_scope_and_hashes_nonce() {
        assert!(PrivacyApproval::default()
            .require_and_store_for(NetworkScope::SmsSend)
            .is_err());

        let wrong_scope = PrivacyApproval {
            privacy_mode: Some(STRICT_LOCAL.to_string()),
            network_scope: Some(NetworkScope::EmailSend.as_str().to_string()),
            user_approved_at: Some(Utc::now()),
            approval_nonce: Some("sms-send-nonce-123456789".to_string()),
            approval_summary: Some("User approved an SMS send.".to_string()),
        };
        assert!(wrong_scope
            .require_and_store_for(NetworkScope::SmsSend)
            .is_err());

        let raw_nonce = "sms-send-nonce-123456789";
        let approval = PrivacyApproval {
            privacy_mode: Some(STRICT_LOCAL.to_string()),
            network_scope: Some(NetworkScope::SmsSend.as_str().to_string()),
            user_approved_at: Some(Utc::now()),
            approval_nonce: Some(raw_nonce.to_string()),
            approval_summary: Some("User approved an SMS send.".to_string()),
        };
        let stored = approval
            .require_and_store_for(NetworkScope::SmsSend)
            .expect("approval should validate");
        assert_ne!(stored.approval_nonce_hash, raw_nonce);
        assert_eq!(stored.approval_nonce_hash.len(), 64);
    }
}
