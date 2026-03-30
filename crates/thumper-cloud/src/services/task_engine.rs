use sqlx::PgPool;
use uuid::Uuid;

use crate::error::CloudError;
use crate::state::AppState;

/// Execute a task. This is the server-side agentic loop.
/// Called asynchronously after task creation.
pub async fn execute_task(
    state: &AppState,
    user_id: Uuid,
    task_id: Uuid,
) -> Result<(), CloudError> {
    // Mark task as in_progress
    sqlx::query("UPDATE tasks SET status = 'in_progress', updated_at = now() WHERE id = $1")
        .bind(task_id)
        .execute(&state.db)
        .await?;

    // Fetch task details
    let task = sqlx::query_as::<_, (String, Option<String>, serde_json::Value)>(
        "SELECT task_type, template_id, params FROM tasks WHERE id = $1",
    )
    .bind(task_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(CloudError::NotFound("task not found".to_string()))?;

    let (task_type, _template_id, params) = task;

    let result = match task_type.as_str() {
        "call" => execute_call_task(state, user_id, task_id, &params).await,
        "email" => execute_email_task(state, user_id, task_id, &params).await,
        "calendar" => execute_calendar_task(state, user_id, task_id, &params).await,
        "crypto" => execute_crypto_task(state, user_id, task_id, &params).await,
        _ => {
            Err(CloudError::BadRequest(format!("unsupported task type: {task_type}")))
        }
    };

    match result {
        Ok(()) => {
            tracing::info!(%task_id, %task_type, "task completed");
        }
        Err(e) => {
            sqlx::query(
                r#"
                UPDATE tasks SET
                    status = 'failed',
                    error_message = $1,
                    updated_at = now()
                WHERE id = $2
                "#,
            )
            .bind(e.to_string())
            .bind(task_id)
            .execute(&state.db)
            .await?;

            // Refund bounty on failure
            let _ = crate::services::bounty_service::refund_bounty(&state.db, task_id).await;

            tracing::error!(%task_id, %task_type, error = %e, "task failed");
        }
    }

    Ok(())
}

async fn execute_call_task(
    state: &AppState,
    user_id: Uuid,
    task_id: Uuid,
    params: &serde_json::Value,
) -> Result<(), CloudError> {
    let phone_number = params["phone_number"]
        .as_str()
        .ok_or(CloudError::BadRequest("missing phone_number".to_string()))?;
    let objective = params["objective"]
        .as_str()
        .or_else(|| params["intent"].as_str())
        .ok_or(CloudError::BadRequest("missing objective".to_string()))?;

    // If no phone number but we have a business name, look it up
    // TODO: integrate Google Places API for phone number lookup

    // Step 1: Generate call script
    add_step(state, task_id, 1, "generate_script", "in_progress").await?;

    let script_prompt = format!(
        "Generate a phone call script. Objective: {}. Additional context: {}",
        objective,
        serde_json::to_string(params).unwrap_or_default()
    );
    let script = crate::services::llm_router::generate(state, user_id, &script_prompt, Some("json")).await?;
    let script_json: serde_json::Value = serde_json::from_str(&script).unwrap_or_default();

    complete_step(state, task_id, 1, &script_json).await?;

    // Step 2: Initiate the call
    add_step(state, task_id, 2, "initiate_call", "in_progress").await?;

    let bland_call_id = crate::services::call_service::start_call(
        state,
        user_id,
        task_id, // Use task_id as our internal reference
        phone_number,
        objective,
        Some(&script_json),
    )
    .await?;

    // Create call record linked to this task
    sqlx::query(
        r#"
        INSERT INTO calls (user_id, task_id, bland_call_id, phone_number, objective, script, outcome)
        VALUES ($1, $2, $3, $4, $5, $6, 'in_progress')
        "#,
    )
    .bind(user_id)
    .bind(task_id)
    .bind(&bland_call_id)
    .bind(phone_number)
    .bind(objective)
    .bind(&script_json)
    .execute(&state.db)
    .await?;

    complete_step(state, task_id, 2, &serde_json::json!({ "bland_call_id": bland_call_id })).await?;

    // Task stays in_progress — webhook will complete it when call finishes
    // Update status to reflect we're waiting on the call
    sqlx::query(
        "UPDATE tasks SET status = 'in_progress', result = $1, updated_at = now() WHERE id = $2",
    )
    .bind(serde_json::json!({ "status": "call_in_progress", "bland_call_id": bland_call_id }))
    .bind(task_id)
    .execute(&state.db)
    .await?;

    Ok(())
}

async fn execute_email_task(
    state: &AppState,
    user_id: Uuid,
    task_id: Uuid,
    params: &serde_json::Value,
) -> Result<(), CloudError> {
    let intent = params["intent"]
        .as_str()
        .or_else(|| params["objective"].as_str())
        .ok_or(CloudError::BadRequest("missing intent".to_string()))?;

    let context = params["context"].as_str();
    let tone = params["tone"].as_str();

    // Step 1: Generate email draft
    add_step(state, task_id, 1, "generate_draft", "in_progress").await?;

    let draft = crate::services::email_service::generate_email_draft(
        state,
        user_id,
        intent,
        context,
        tone,
    )
    .await?;

    let draft_json = serde_json::json!({
        "to_address": draft.to_address,
        "subject": draft.subject,
        "body": draft.body,
    });

    complete_step(state, task_id, 1, &draft_json).await?;

    // Step 2: Create email record and set task to awaiting_approval
    sqlx::query(
        r#"
        INSERT INTO email_actions (user_id, task_id, to_address, subject, body, status)
        VALUES ($1, $2, $3, $4, $5, 'draft')
        "#,
    )
    .bind(user_id)
    .bind(task_id)
    .bind(&draft.to_address)
    .bind(&draft.subject)
    .bind(&draft.body)
    .execute(&state.db)
    .await?;

    sqlx::query(
        r#"
        UPDATE tasks SET
            status = 'awaiting_approval',
            result = $1,
            updated_at = now()
        WHERE id = $2
        "#,
    )
    .bind(&draft_json)
    .bind(task_id)
    .execute(&state.db)
    .await?;

    // Task waits for user to approve/edit/discard the draft
    Ok(())
}

async fn execute_calendar_task(
    state: &AppState,
    user_id: Uuid,
    task_id: Uuid,
    params: &serde_json::Value,
) -> Result<(), CloudError> {
    add_step(state, task_id, 1, "calendar_action", "in_progress").await?;

    let result = crate::services::calendar_service::handle_calendar_request(
        state,
        user_id,
        params,
    )
    .await?;

    complete_step(state, task_id, 1, &result).await?;

    complete_task(&state.db, task_id, &result).await?;

    Ok(())
}

async fn execute_crypto_task(
    state: &AppState,
    user_id: Uuid,
    task_id: Uuid,
    params: &serde_json::Value,
) -> Result<(), CloudError> {
    let action = params["action"]
        .as_str()
        .ok_or(CloudError::BadRequest("missing action".to_string()))?;

    match action {
        "transfer" => {
            // Step 1: Validate
            add_step(state, task_id, 1, "validate_transfer", "in_progress").await?;

            let to = params["to"]
                .as_str()
                .ok_or(CloudError::BadRequest("missing 'to' address".to_string()))?;
            let amount = params["amount"]
                .as_u64()
                .ok_or(CloudError::BadRequest("missing 'amount'".to_string()))?;
            let currency = params["currency"]
                .as_str()
                .ok_or(CloudError::BadRequest("missing 'currency'".to_string()))?;

            // Check wallet exists
            let wallet_exists: Option<(Uuid,)> = sqlx::query_as(
                "SELECT id FROM user_wallets WHERE user_id = $1",
            )
            .bind(user_id)
            .fetch_optional(&state.db)
            .await?;

            if wallet_exists.is_none() {
                return Err(CloudError::BadRequest("wallet not provisioned".to_string()));
            }

            complete_step(
                state,
                task_id,
                1,
                &serde_json::json!({ "validated": true, "to": to, "amount": amount, "currency": currency }),
            )
            .await?;

            // Step 2: Execute transfer
            add_step(state, task_id, 2, "execute_transfer", "in_progress").await?;

            let req = crate::services::wallet_service::TransferRequest {
                to: to.to_string(),
                amount,
                currency: currency.to_string(),
            };
            let tx_result = crate::services::wallet_service::transfer(state, user_id, &req).await?;

            complete_step(
                state,
                task_id,
                2,
                &serde_json::json!({ "signature": tx_result.signature, "explorer_url": tx_result.explorer_url }),
            )
            .await?;

            // Step 3: Confirm
            add_step(state, task_id, 3, "confirm", "in_progress").await?;

            let result = serde_json::json!({
                "signature": tx_result.signature,
                "explorer_url": tx_result.explorer_url,
                "amount": amount,
                "currency": currency,
                "to": to,
            });

            complete_step(state, task_id, 3, &result).await?;

            complete_task(&state.db, task_id, &result).await?;
        }
        "balance" => {
            add_step(state, task_id, 1, "check_balance", "in_progress").await?;

            let balances = crate::services::wallet_service::get_balances(state, user_id).await?;
            let result = serde_json::json!({
                "sol": balances.sol,
                "usdc": balances.usdc,
                "address": balances.address,
            });

            complete_step(state, task_id, 1, &result).await?;

            complete_task(&state.db, task_id, &result).await?;
        }
        _ => {
            return Err(CloudError::BadRequest(format!(
                "unsupported crypto action: {action}"
            )));
        }
    }

    Ok(())
}

async fn add_step(
    state: &AppState,
    task_id: Uuid,
    step_number: i32,
    action_type: &str,
    status: &str,
) -> Result<(), CloudError> {
    sqlx::query(
        r#"
        INSERT INTO task_steps (task_id, step_number, action_type, status, started_at)
        VALUES ($1, $2, $3, $4, now())
        "#,
    )
    .bind(task_id)
    .bind(step_number)
    .bind(action_type)
    .bind(status)
    .execute(&state.db)
    .await?;
    Ok(())
}

async fn complete_step(
    state: &AppState,
    task_id: Uuid,
    step_number: i32,
    output: &serde_json::Value,
) -> Result<(), CloudError> {
    sqlx::query(
        r#"
        UPDATE task_steps SET
            status = 'completed',
            output = $1,
            completed_at = now()
        WHERE task_id = $2 AND step_number = $3
        "#,
    )
    .bind(output)
    .bind(task_id)
    .bind(step_number)
    .execute(&state.db)
    .await?;
    Ok(())
}

/// Mark a task as completed and settle any attached bounty.
async fn complete_task(
    db: &PgPool,
    task_id: Uuid,
    result: &serde_json::Value,
) -> Result<(), CloudError> {
    sqlx::query(
        "UPDATE tasks SET status = 'completed', result = $1, updated_at = now(), completed_at = now() WHERE id = $2",
    )
    .bind(result)
    .bind(task_id)
    .execute(db)
    .await?;

    // Settle bounty if one exists — executor defaults to funder (AI-executed task)
    if let Ok(Some(bounty)) = crate::services::bounty_service::get_bounty(db, task_id).await {
        if bounty.status == "held" {
            let executor_id = bounty.executor_id.unwrap_or(bounty.funder_id);
            if let Err(e) = crate::services::bounty_service::settle_bounty(db, task_id, executor_id).await {
                tracing::warn!(%task_id, error = %e, "failed to settle bounty");
            }
        }
    }

    Ok(())
}
