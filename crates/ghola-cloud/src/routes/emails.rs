use axum::extract::{Path, State};
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::error::CloudError;
use crate::privacy::{NetworkScope, PrivacyApproval};
use crate::state::AppState;

#[derive(Deserialize)]
pub struct DraftEmailRequest {
    pub to_address: String,
    pub cc_addresses: Option<Vec<String>>,
    pub subject: String,
    pub body: String,
    pub task_id: Option<Uuid>,
    #[serde(flatten)]
    pub approval: PrivacyApproval,
}

#[derive(Deserialize)]
pub struct GenerateEmailRequest {
    pub intent: String,
    pub context: Option<String>,
    pub tone: Option<String>,
    pub task_id: Option<Uuid>,
    #[serde(flatten)]
    pub approval: PrivacyApproval,
}

#[derive(Serialize)]
pub struct EmailResponse {
    pub id: Uuid,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<Uuid>,
    pub to_address: String,
    pub subject: String,
    pub body: String,
    pub status: String,
    pub created_at: DateTime<Utc>,
    pub sent_at: Option<DateTime<Utc>>,
}

#[derive(Serialize)]
pub struct EmailListResponse {
    pub id: Uuid,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<Uuid>,
    pub to_address_preview: String,
    pub subject_preview: String,
    pub status: String,
    pub created_at: DateTime<Utc>,
    pub sent_at: Option<DateTime<Utc>>,
}

/// POST /api/emails/draft — Create a draft email
pub async fn create_draft(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Json(req): Json<DraftEmailRequest>,
) -> Result<Json<EmailResponse>, CloudError> {
    let approval = req
        .approval
        .require_and_store_for(NetworkScope::EmailDraft)?;

    let row = sqlx::query_as::<_, (Uuid, Option<Uuid>, String, String, String, String, DateTime<Utc>, Option<DateTime<Utc>>)>(
        r#"
        INSERT INTO email_actions (user_id, task_id, to_address, cc_addresses, subject, body, status, privacy_mode, network_scope, user_approved_at, approval_nonce, approval_summary)
        VALUES ($1, $2, $3, $4, $5, $6, 'draft', $7, $8, $9, $10, $11)
        RETURNING id, task_id, to_address, subject, body, status, created_at, sent_at
        "#,
    )
    .bind(claims.sub)
    .bind(req.task_id)
    .bind(&req.to_address)
    .bind(&req.cc_addresses.unwrap_or_default())
    .bind(&req.subject)
    .bind(&req.body)
    .bind(&approval.privacy_mode)
    .bind(&approval.network_scope)
    .bind(approval.user_approved_at)
    .bind(&approval.approval_nonce_hash)
    .bind(&approval.approval_summary)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(EmailResponse {
        id: row.0,
        task_id: row.1,
        to_address: row.2,
        subject: row.3,
        body: row.4,
        status: row.5,
        created_at: row.6,
        sent_at: row.7,
    }))
}

/// POST /api/emails/generate — LLM generates a draft from intent
pub async fn generate_email(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Json(req): Json<GenerateEmailRequest>,
) -> Result<Json<EmailResponse>, CloudError> {
    let approval = req
        .approval
        .require_and_store_for(NetworkScope::EmailDraft)?;

    // Use LLM to generate the email
    let generated = crate::services::email_service::generate_email_draft(
        &state,
        claims.sub,
        &req.intent,
        req.context.as_deref(),
        req.tone.as_deref(),
    )
    .await?;

    let row = sqlx::query_as::<
        _,
        (
            Uuid,
            Option<Uuid>,
            String,
            String,
            String,
            String,
            DateTime<Utc>,
            Option<DateTime<Utc>>,
        ),
    >(
        r#"
        INSERT INTO email_actions (user_id, task_id, to_address, subject, body, status, privacy_mode, network_scope, user_approved_at, approval_nonce, approval_summary)
        VALUES ($1, $2, $3, $4, $5, 'draft', $6, $7, $8, $9, $10)
        RETURNING id, task_id, to_address, subject, body, status, created_at, sent_at
        "#,
    )
    .bind(claims.sub)
    .bind(req.task_id)
    .bind(&generated.to_address)
    .bind(&generated.subject)
    .bind(&generated.body)
    .bind(&approval.privacy_mode)
    .bind(&approval.network_scope)
    .bind(approval.user_approved_at)
    .bind(&approval.approval_nonce_hash)
    .bind(&approval.approval_summary)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(EmailResponse {
        id: row.0,
        task_id: row.1,
        to_address: row.2,
        subject: row.3,
        body: row.4,
        status: row.5,
        created_at: row.6,
        sent_at: row.7,
    }))
}

/// POST /api/emails/:id/send — Approve and send a draft
pub async fn send_email(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Path(email_id): Path<Uuid>,
    Json(approval): Json<PrivacyApproval>,
) -> Result<Json<EmailResponse>, CloudError> {
    let approval = approval.require_and_store_for(NetworkScope::EmailSend)?;

    // Check email usage limit
    check_email_limit(&state, claims.sub, &claims.tier).await?;

    // Fetch the draft
    let draft = sqlx::query_as::<_, (String, Option<Vec<String>>, String, String, Option<Uuid>)>(
        "SELECT to_address, cc_addresses, subject, body, task_id FROM email_actions WHERE id = $1 AND user_id = $2 AND status = 'draft'",
    )
    .bind(email_id)
    .bind(claims.sub)
    .fetch_optional(&state.db)
    .await?
    .ok_or(CloudError::NotFound("draft not found".to_string()))?;

    // Send via Gmail API
    let gmail_message_id = crate::services::email_service::send_via_gmail(
        &state,
        claims.sub,
        &draft.0,
        draft.1.as_deref().unwrap_or(&[]),
        &draft.2,
        &draft.3,
    )
    .await?;

    // Update status
    let row = sqlx::query_as::<
        _,
        (
            Uuid,
            Option<Uuid>,
            String,
            String,
            String,
            String,
            DateTime<Utc>,
            Option<DateTime<Utc>>,
        ),
    >(
        r#"
        UPDATE email_actions SET
            status = 'sent',
            body = '',
            gmail_message_id = $1,
            sent_at = now(),
            privacy_mode = $3,
            network_scope = $4,
            user_approved_at = $5,
            approval_nonce = $6,
            approval_summary = $7
        WHERE id = $2
        RETURNING id, task_id, to_address, subject, body, status, created_at, sent_at
        "#,
    )
    .bind(&gmail_message_id)
    .bind(email_id)
    .bind(&approval.privacy_mode)
    .bind(&approval.network_scope)
    .bind(approval.user_approved_at)
    .bind(&approval.approval_nonce_hash)
    .bind(&approval.approval_summary)
    .fetch_one(&state.db)
    .await?;

    if let Some(task_id) = draft.4 {
        let result = serde_json::json!({
            "email_action_id": email_id,
            "status": "sent",
            "to_address_preview": email_address_preview(&row.2),
            "subject_preview": redacted_subject(),
            "summary": "Email sent through external provider.",
        });
        sqlx::query(
            r#"
            UPDATE tasks SET
                status = 'completed',
                result = $1,
                updated_at = now(),
                completed_at = now()
            WHERE id = $2 AND user_id = $3
            "#,
        )
        .bind(result)
        .bind(task_id)
        .bind(claims.sub)
        .execute(&state.db)
        .await?;
    }

    // Update usage
    let period_start = chrono::Utc::now()
        .date_naive()
        .format("%Y-%m-01")
        .to_string();
    sqlx::query(
        r#"
        INSERT INTO usage_tracking (user_id, period_start, email_count)
        VALUES ($1, $2::date, 1)
        ON CONFLICT (user_id, period_start) DO UPDATE SET
            email_count = usage_tracking.email_count + 1
        "#,
    )
    .bind(claims.sub)
    .bind(&period_start)
    .execute(&state.db)
    .await?;

    // Notify via Telegram if linked
    if let Ok(Some(tg_link)) =
        crate::services::telegram::get_telegram_link(&state.db, claims.sub).await
    {
        if let Some(ref token) = state.config.telegram_bot_token {
            let summary = "Email sent through external provider.";
            let _ = crate::services::telegram::notify_user(token, tg_link.0, &summary).await;
        }
    }

    Ok(Json(EmailResponse {
        id: row.0,
        task_id: row.1,
        to_address: row.2,
        subject: row.3,
        body: row.4,
        status: row.5,
        created_at: row.6,
        sent_at: row.7,
    }))
}

/// POST /api/emails/send — Send an email directly (no prior draft needed)
#[derive(Deserialize)]
pub struct SendEmailDirectRequest {
    pub to: String,
    pub subject: String,
    pub body: String,
    #[serde(flatten)]
    pub approval: PrivacyApproval,
}

pub async fn send_email_direct(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Json(req): Json<SendEmailDirectRequest>,
) -> Result<Json<EmailResponse>, CloudError> {
    let approval = req
        .approval
        .require_and_store_for(NetworkScope::EmailSend)?;

    // Check email usage limit
    check_email_limit(&state, claims.sub, &claims.tier).await?;

    // Insert as draft first
    let draft_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO email_actions (user_id, to_address, subject, body, status, privacy_mode, network_scope, user_approved_at, approval_nonce, approval_summary)
        VALUES ($1, $2, $3, $4, 'draft', $5, $6, $7, $8, $9)
        RETURNING id
        "#,
    )
    .bind(claims.sub)
    .bind(&req.to)
    .bind(&req.subject)
    .bind("")
    .bind(&approval.privacy_mode)
    .bind(&approval.network_scope)
    .bind(approval.user_approved_at)
    .bind(&approval.approval_nonce_hash)
    .bind(&approval.approval_summary)
    .fetch_one(&state.db)
    .await?;

    // Send via Gmail API. The body is used transiently and is not persisted.
    let gmail_message_id = match crate::services::email_service::send_via_gmail(
        &state,
        claims.sub,
        &req.to,
        &[],
        &req.subject,
        &req.body,
    )
    .await
    {
        Ok(id) => id,
        Err(e) => {
            let _ =
                sqlx::query("UPDATE email_actions SET status = 'failed', body = '' WHERE id = $1")
                    .bind(draft_id)
                    .execute(&state.db)
                    .await;
            return Err(e);
        }
    };

    // Update status to sent
    let row = sqlx::query_as::<
        _,
        (
            Uuid,
            Option<Uuid>,
            String,
            String,
            String,
            String,
            DateTime<Utc>,
            Option<DateTime<Utc>>,
        ),
    >(
        r#"
        UPDATE email_actions SET
            status = 'sent',
            body = '',
            gmail_message_id = $1,
            sent_at = now(),
            privacy_mode = $3,
            network_scope = $4,
            user_approved_at = $5,
            approval_nonce = $6,
            approval_summary = $7
        WHERE id = $2
        RETURNING id, task_id, to_address, subject, body, status, created_at, sent_at
        "#,
    )
    .bind(&gmail_message_id)
    .bind(draft_id)
    .bind(&approval.privacy_mode)
    .bind(&approval.network_scope)
    .bind(approval.user_approved_at)
    .bind(&approval.approval_nonce_hash)
    .bind(&approval.approval_summary)
    .fetch_one(&state.db)
    .await?;

    // Update usage
    let period_start = chrono::Utc::now()
        .date_naive()
        .format("%Y-%m-01")
        .to_string();
    sqlx::query(
        r#"
        INSERT INTO usage_tracking (user_id, period_start, email_count)
        VALUES ($1, $2::date, 1)
        ON CONFLICT (user_id, period_start) DO UPDATE SET
            email_count = usage_tracking.email_count + 1
        "#,
    )
    .bind(claims.sub)
    .bind(&period_start)
    .execute(&state.db)
    .await?;

    // Notify via Telegram if linked
    if let Ok(Some(tg_link)) =
        crate::services::telegram::get_telegram_link(&state.db, claims.sub).await
    {
        if let Some(ref token) = state.config.telegram_bot_token {
            let summary = "Email sent through external provider.";
            let _ = crate::services::telegram::notify_user(token, tg_link.0, &summary).await;
        }
    }

    Ok(Json(EmailResponse {
        id: row.0,
        task_id: row.1,
        to_address: row.2,
        subject: row.3,
        body: row.4,
        status: row.5,
        created_at: row.6,
        sent_at: row.7,
    }))
}

/// Check email usage against tier limits.
async fn check_email_limit(state: &AppState, user_id: Uuid, tier: &str) -> Result<(), CloudError> {
    let max_emails: i64 = match tier {
        "pro" => 50,
        "unlimited" | "enterprise" => i64::MAX,
        _ => 10, // free
    };

    let period_start = chrono::Utc::now()
        .date_naive()
        .format("%Y-%m-01")
        .to_string();
    let count: i64 = sqlx::query_scalar(
        "SELECT COALESCE(email_count, 0) FROM usage_tracking WHERE user_id = $1 AND period_start = $2::date",
    )
    .bind(user_id)
    .bind(&period_start)
    .fetch_optional(&state.db)
    .await?
    .unwrap_or(0);

    if count >= max_emails {
        return Err(CloudError::PaymentRequired(
            "monthly email limit reached — upgrade your plan".to_string(),
        ));
    }
    Ok(())
}

/// GET /api/emails — List email actions
pub async fn list_emails(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
) -> Result<Json<Vec<EmailListResponse>>, CloudError> {
    let rows = sqlx::query_as::<
        _,
        (
            Uuid,
            Option<Uuid>,
            String,
            String,
            String,
            DateTime<Utc>,
            Option<DateTime<Utc>>,
        ),
    >(
        r#"
        SELECT id, task_id, to_address, subject, status, created_at, sent_at
        FROM email_actions WHERE user_id = $1
        ORDER BY created_at DESC LIMIT 50
        "#,
    )
    .bind(claims.sub)
    .fetch_all(&state.db)
    .await?;

    let emails: Vec<EmailListResponse> = rows
        .into_iter()
        .map(|r| EmailListResponse {
            id: r.0,
            task_id: r.1,
            to_address_preview: email_address_preview(&r.2),
            subject_preview: subject_preview_for_list(&r.3),
            status: r.4,
            created_at: r.5,
            sent_at: r.6,
        })
        .collect();

    Ok(Json(emails))
}

/// GET /api/emails/:id — Fetch full draft detail for the owning user.
pub async fn get_email_detail(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Path(email_id): Path<Uuid>,
) -> Result<Json<EmailResponse>, CloudError> {
    let row = sqlx::query_as::<
        _,
        (
            Uuid,
            Option<Uuid>,
            String,
            String,
            String,
            String,
            DateTime<Utc>,
            Option<DateTime<Utc>>,
        ),
    >(
        r#"
        SELECT id, task_id, to_address, subject, body, status, created_at, sent_at
        FROM email_actions
        WHERE id = $1 AND user_id = $2 AND status = 'draft'
        "#,
    )
    .bind(email_id)
    .bind(claims.sub)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| CloudError::NotFound("draft not found".to_string()))?;

    Ok(Json(EmailResponse {
        id: row.0,
        task_id: row.1,
        to_address: row.2,
        subject: row.3,
        body: row.4,
        status: row.5,
        created_at: row.6,
        sent_at: row.7,
    }))
}

fn email_address_preview(address: &str) -> String {
    let trimmed = address.trim();
    let Some((local, _domain)) = trimmed.split_once('@') else {
        return "[redacted]".to_string();
    };
    let first = local.chars().next().unwrap_or('*');
    format!("{first}***@***")
}

fn redacted_subject() -> String {
    "[redacted]".to_string()
}

fn subject_preview_for_list(subject: &str) -> String {
    if subject.trim().is_empty() {
        "[redacted]".to_string()
    } else {
        "[redacted]".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn email_preview_masks_recipient() {
        assert_eq!(email_address_preview("alice@example.com"), "a***@***");
        assert_eq!(email_address_preview("not-an-email"), "[redacted]");
    }

    #[test]
    fn list_subject_preview_never_returns_raw_subject() {
        assert_eq!(subject_preview_for_list("Sensitive subject"), "[redacted]");
    }
}
