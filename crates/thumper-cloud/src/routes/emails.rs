use axum::extract::{Path, State};
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::error::CloudError;
use crate::state::AppState;

#[derive(Deserialize)]
pub struct DraftEmailRequest {
    pub to_address: String,
    pub cc_addresses: Option<Vec<String>>,
    pub subject: String,
    pub body: String,
    pub task_id: Option<Uuid>,
}

#[derive(Deserialize)]
pub struct GenerateEmailRequest {
    pub intent: String,
    pub context: Option<String>,
    pub tone: Option<String>,
    pub task_id: Option<Uuid>,
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

/// POST /api/emails/draft — Create a draft email
pub async fn create_draft(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Json(req): Json<DraftEmailRequest>,
) -> Result<Json<EmailResponse>, CloudError> {
    let row = sqlx::query_as::<_, (Uuid, Option<Uuid>, String, String, String, String, DateTime<Utc>, Option<DateTime<Utc>>)>(
        r#"
        INSERT INTO email_actions (user_id, task_id, to_address, cc_addresses, subject, body, status)
        VALUES ($1, $2, $3, $4, $5, $6, 'draft')
        RETURNING id, task_id, to_address, subject, body, status, created_at, sent_at
        "#,
    )
    .bind(claims.sub)
    .bind(req.task_id)
    .bind(&req.to_address)
    .bind(&req.cc_addresses.unwrap_or_default())
    .bind(&req.subject)
    .bind(&req.body)
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
        INSERT INTO email_actions (user_id, task_id, to_address, subject, body, status)
        VALUES ($1, $2, $3, $4, $5, 'draft')
        RETURNING id, task_id, to_address, subject, body, status, created_at, sent_at
        "#,
    )
    .bind(claims.sub)
    .bind(req.task_id)
    .bind(&generated.to_address)
    .bind(&generated.subject)
    .bind(&generated.body)
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
) -> Result<Json<EmailResponse>, CloudError> {
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
        UPDATE email_actions SET status = 'sent', gmail_message_id = $1, sent_at = now()
        WHERE id = $2
        RETURNING id, task_id, to_address, subject, body, status, created_at, sent_at
        "#,
    )
    .bind(&gmail_message_id)
    .bind(email_id)
    .fetch_one(&state.db)
    .await?;

    if let Some(task_id) = draft.4 {
        let result = serde_json::json!({
            "email_action_id": email_id,
            "status": "sent",
            "to_address": row.2,
            "subject": row.3,
            "summary": format!("Email sent to {}", row.2),
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
            let summary = format!("Email sent!\n\nTo: {}\nSubject: {}", &draft.0, &draft.2);
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
}

pub async fn send_email_direct(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Json(req): Json<SendEmailDirectRequest>,
) -> Result<Json<EmailResponse>, CloudError> {
    // Check email usage limit
    check_email_limit(&state, claims.sub, &claims.tier).await?;

    // Insert as draft first
    let draft_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO email_actions (user_id, to_address, subject, body, status)
        VALUES ($1, $2, $3, $4, 'draft')
        RETURNING id
        "#,
    )
    .bind(claims.sub)
    .bind(&req.to)
    .bind(&req.subject)
    .bind(&req.body)
    .fetch_one(&state.db)
    .await?;

    // Send via Gmail API
    let gmail_message_id = crate::services::email_service::send_via_gmail(
        &state,
        claims.sub,
        &req.to,
        &[],
        &req.subject,
        &req.body,
    )
    .await?;

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
        UPDATE email_actions SET status = 'sent', gmail_message_id = $1, sent_at = now()
        WHERE id = $2
        RETURNING id, task_id, to_address, subject, body, status, created_at, sent_at
        "#,
    )
    .bind(&gmail_message_id)
    .bind(draft_id)
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
            let summary = format!("Email sent!\n\nTo: {}\nSubject: {}", &req.to, &req.subject);
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
        "trial_pack" => 15,
        "starter" => 30,
        "pro" | "private_agent" => 50,
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
) -> Result<Json<Vec<EmailResponse>>, CloudError> {
    let rows = sqlx::query_as::<
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
        FROM email_actions WHERE user_id = $1
        ORDER BY created_at DESC LIMIT 50
        "#,
    )
    .bind(claims.sub)
    .fetch_all(&state.db)
    .await?;

    let emails: Vec<EmailResponse> = rows
        .into_iter()
        .map(|r| EmailResponse {
            id: r.0,
            task_id: r.1,
            to_address: r.2,
            subject: r.3,
            body: r.4,
            status: r.5,
            created_at: r.6,
            sent_at: r.7,
        })
        .collect();

    Ok(Json(emails))
}
