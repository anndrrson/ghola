use axum::extract::{Path, Query, State};
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::error::CloudError;
use crate::state::AppState;

#[derive(Serialize)]
pub struct TemplateResponse {
    pub id: String,
    pub title: String,
    pub category: String,
    pub description: Option<String>,
    pub params_schema: serde_json::Value,
}

#[derive(Deserialize)]
pub struct TemplateQuery {
    pub category: Option<String>,
}

/// GET /api/templates
pub async fn list_templates(
    State(state): State<AppState>,
    Query(query): Query<TemplateQuery>,
) -> Result<Json<Vec<TemplateResponse>>, CloudError> {
    let rows = if let Some(ref category) = query.category {
        sqlx::query_as::<_, (String, String, String, Option<String>, serde_json::Value)>(
            r#"
            SELECT id, title, category, description, params_schema
            FROM task_templates WHERE is_active = true AND category = $1
            ORDER BY title
            "#,
        )
        .bind(category)
        .fetch_all(&state.db)
        .await?
    } else {
        sqlx::query_as::<_, (String, String, String, Option<String>, serde_json::Value)>(
            r#"
            SELECT id, title, category, description, params_schema
            FROM task_templates WHERE is_active = true
            ORDER BY category, title
            "#,
        )
        .fetch_all(&state.db)
        .await?
    };

    let templates: Vec<TemplateResponse> = rows
        .into_iter()
        .map(|r| TemplateResponse {
            id: r.0,
            title: r.1,
            category: r.2,
            description: r.3,
            params_schema: r.4,
        })
        .collect();

    Ok(Json(templates))
}

/// GET /api/templates/:id
pub async fn get_template(
    State(state): State<AppState>,
    Path(template_id): Path<String>,
) -> Result<Json<TemplateResponse>, CloudError> {
    let row = sqlx::query_as::<_, (String, String, String, Option<String>, serde_json::Value)>(
        "SELECT id, title, category, description, params_schema FROM task_templates WHERE id = $1",
    )
    .bind(&template_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(CloudError::NotFound("template not found".to_string()))?;

    Ok(Json(TemplateResponse {
        id: row.0,
        title: row.1,
        category: row.2,
        description: row.3,
        params_schema: row.4,
    }))
}

/// Seed the default task templates on startup.
pub async fn seed_templates(db: &sqlx::PgPool) -> Result<(), sqlx::Error> {
    let templates = vec![
        (
            "book_restaurant",
            "Book a Restaurant",
            "calls",
            "Call a restaurant to make a reservation",
            r#"{"restaurant_name": "string", "date": "string", "time": "string", "party_size": "number"}"#,
        ),
        (
            "schedule_appointment",
            "Schedule an Appointment",
            "calls",
            "Call to schedule an appointment (doctor, dentist, etc.)",
            r#"{"provider": "string", "preferred_dates": "string[]", "insurance_info": "string?"}"#,
        ),
        (
            "customer_service",
            "Call Customer Service",
            "calls",
            "Call a company's customer service line",
            r#"{"company": "string", "issue": "string", "desired_outcome": "string"}"#,
        ),
        (
            "cancel_service",
            "Cancel a Service",
            "calls",
            "Call to cancel a subscription or service",
            r#"{"service_name": "string", "account_info": "string?", "reason": "string?"}"#,
        ),
        (
            "request_refund",
            "Request a Refund",
            "emails",
            "Email a merchant to request a refund",
            r#"{"merchant": "string", "order_number": "string?", "amount": "string?", "reason": "string"}"#,
        ),
        (
            "follow_up",
            "Follow Up Email",
            "emails",
            "Send a follow-up email about a previous conversation",
            r#"{"original_context": "string", "tone": "string?"}"#,
        ),
        (
            "complaint",
            "File a Complaint",
            "emails",
            "Email a company about an issue or complaint",
            r#"{"company": "string", "issue": "string", "desired_resolution": "string"}"#,
        ),
        (
            "cancel_subscription",
            "Cancel Subscription Email",
            "emails",
            "Email to cancel a subscription",
            r#"{"service": "string", "account_email": "string?"}"#,
        ),
    ];

    let count = templates.len();
    for (id, title, category, description, params_schema) in templates {
        let schema: serde_json::Value = serde_json::from_str(params_schema).unwrap_or_default();
        sqlx::query(
            r#"
            INSERT INTO task_templates (id, title, category, description, params_schema)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (id) DO NOTHING
            "#,
        )
        .bind(id)
        .bind(title)
        .bind(category)
        .bind(description)
        .bind(schema)
        .execute(db)
        .await?;
    }

    tracing::info!("seeded {} task templates", count);
    Ok(())
}
