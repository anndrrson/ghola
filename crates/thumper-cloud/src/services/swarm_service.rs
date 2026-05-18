//! Swarm job service — elastic agent dispatch.
//! Dispatches work units to rental agents across the provider network,
//! manages concurrency, budget enforcement, retries, and result aggregation.

use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
use std::sync::Arc;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::error::CloudError;
use crate::privacy::PrivacyApproval;
use crate::services::{agent_service, compute_service};
use crate::state::AppState;

// ---------------------------------------------------------------------------
// Types — Request
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct CreateSwarmRequest {
    pub title: String,
    pub description: Option<String>,
    pub work_units: Vec<WorkUnitInput>,
    pub require_tags: Option<Vec<String>>,
    pub require_tools: Option<Vec<String>>,
    pub prefer_model: Option<String>,
    pub min_reputation: Option<f64>,
    pub max_budget_usdc: i64,
    pub max_parallel: Option<i32>,
    pub max_retries: Option<i32>,
    pub timeout_secs: Option<i32>,
    #[serde(flatten)]
    pub approval: PrivacyApproval,
}

#[derive(Debug, Deserialize)]
pub struct WorkUnitInput {
    pub prompt: String,
    pub context: Option<serde_json::Value>,
}

// ---------------------------------------------------------------------------
// Types — Response
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct SwarmJobInfo {
    pub id: Uuid,
    pub title: String,
    pub description: String,
    pub status: String,
    pub total_units: i32,
    pub completed_units: i32,
    pub failed_units: i32,
    pub running_units: i32,
    pub max_budget_usdc: i64,
    pub spent_usdc: i64,
    pub created_at: DateTime<Utc>,
    pub started_at: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize)]
pub struct WorkUnitInfo {
    pub id: Uuid,
    pub unit_index: i32,
    pub prompt: String,
    pub status: String,
    pub agent_name: Option<String>,
    pub result: Option<String>,
    pub cost_usdc: i64,
    pub error_message: Option<String>,
    pub retry_count: i32,
    pub started_at: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize)]
pub struct WorkUnitResult {
    pub id: Uuid,
    pub unit_index: i32,
    pub prompt: String,
    pub result: String,
    pub result_metadata: Option<serde_json::Value>,
    pub cost_usdc: i64,
    pub agent_name: Option<String>,
    pub completed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize)]
pub struct SwarmEstimate {
    pub total_units: usize,
    pub available_agents: usize,
    pub estimated_cost_usdc: i64,
    pub estimated_parallel: usize,
    pub can_fulfill: bool,
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

struct SwarmConfig {
    user_id: Uuid,
    require_tags: Vec<String>,
    require_tools: Vec<String>,
    prefer_model: Option<String>,
    min_reputation: f64,
    max_budget_usdc: i64,
    max_parallel: i32,
    max_retries: i32,
    timeout_secs: i32,
}

struct PendingUnit {
    id: Uuid,
    unit_index: i32,
    prompt: String,
    context: serde_json::Value,
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

pub async fn create_swarm(
    db: &PgPool,
    user_id: Uuid,
    req: CreateSwarmRequest,
) -> Result<SwarmJobInfo, CloudError> {
    if req.work_units.is_empty() {
        return Err(CloudError::BadRequest("work_units cannot be empty".into()));
    }
    if req.max_budget_usdc <= 0 {
        return Err(CloudError::BadRequest(
            "max_budget_usdc must be positive".into(),
        ));
    }

    // Verify wallet exists — escrow creation will fail without one
    let has_wallet: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM user_wallets WHERE user_id = $1)")
            .bind(user_id)
            .fetch_one(db)
            .await
            .unwrap_or(false);

    if !has_wallet {
        return Err(CloudError::BadRequest(
            "wallet not provisioned — required for swarm dispatch (POST /api/wallet/provision first)".into(),
        ));
    }

    let max_parallel = req.max_parallel.unwrap_or(10).clamp(1, 50);
    let max_retries = req.max_retries.unwrap_or(1).clamp(0, 5);
    let timeout_secs = req.timeout_secs.unwrap_or(300).clamp(30, 600);
    let description = req.description.as_deref().unwrap_or("");
    let require_tags = req.require_tags.clone().unwrap_or_default();
    let require_tools = req.require_tools.clone().unwrap_or_default();
    let total_units = req.work_units.len() as i32;

    let row = sqlx::query(
        r#"
        INSERT INTO swarm_jobs (
            user_id, title, description,
            require_tags, require_tools, prefer_model, min_reputation,
            max_budget_usdc, max_parallel, max_retries, timeout_secs,
            total_units
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING id, created_at
        "#,
    )
    .bind(user_id)
    .bind(&req.title)
    .bind(description)
    .bind(&require_tags)
    .bind(&require_tools)
    .bind(&req.prefer_model)
    .bind(req.min_reputation.unwrap_or(0.5))
    .bind(req.max_budget_usdc)
    .bind(max_parallel)
    .bind(max_retries)
    .bind(timeout_secs)
    .bind(total_units)
    .fetch_one(db)
    .await?;

    let swarm_id: Uuid = row.get("id");
    let created_at: DateTime<Utc> = row.get("created_at");

    // Bulk insert work units
    for (i, unit) in req.work_units.iter().enumerate() {
        let context = unit
            .context
            .clone()
            .unwrap_or_else(|| serde_json::json!({}));
        sqlx::query(
            "INSERT INTO swarm_work_units (swarm_id, unit_index, prompt, context) VALUES ($1, $2, $3, $4)",
        )
        .bind(swarm_id)
        .bind(i as i32)
        .bind(&unit.prompt)
        .bind(&context)
        .execute(db)
        .await?;
    }

    Ok(SwarmJobInfo {
        id: swarm_id,
        title: req.title,
        description: description.to_string(),
        status: "pending".into(),
        total_units,
        completed_units: 0,
        failed_units: 0,
        running_units: 0,
        max_budget_usdc: req.max_budget_usdc,
        spent_usdc: 0,
        created_at,
        started_at: None,
        completed_at: None,
    })
}

// ---------------------------------------------------------------------------
// Estimate
// ---------------------------------------------------------------------------

pub async fn estimate_swarm(
    db: &PgPool,
    req: &CreateSwarmRequest,
) -> Result<SwarmEstimate, CloudError> {
    let criteria = agent_service::AgentMatchCriteria {
        require_tags: req.require_tags.clone().unwrap_or_default(),
        require_tools: req.require_tools.clone().unwrap_or_default(),
        prefer_model: req.prefer_model.clone(),
        min_reputation: req.min_reputation.unwrap_or(0.5),
        limit: 200,
    };

    let agents = agent_service::match_agents(db, &criteria).await?;

    if agents.is_empty() {
        return Ok(SwarmEstimate {
            total_units: req.work_units.len(),
            available_agents: 0,
            estimated_cost_usdc: 0,
            estimated_parallel: 0,
            can_fulfill: false,
        });
    }

    // Estimate cost: 500 input + 500 output tokens per unit (default estimate)
    let avg_input_price: f64 = agents
        .iter()
        .map(|a| a.price_per_1k_input as f64)
        .sum::<f64>()
        / agents.len() as f64;
    let avg_output_price: f64 = agents
        .iter()
        .map(|a| a.price_per_1k_output as f64)
        .sum::<f64>()
        / agents.len() as f64;
    let estimated_cost_per_unit =
        ((500.0 * avg_input_price + 500.0 * avg_output_price) / 1000.0) as i64;
    let estimated_cost = estimated_cost_per_unit * req.work_units.len() as i64;

    let max_parallel = req.max_parallel.unwrap_or(10) as usize;
    let estimated_parallel = agents.len().min(max_parallel).min(req.work_units.len());

    Ok(SwarmEstimate {
        total_units: req.work_units.len(),
        available_agents: agents.len(),
        estimated_cost_usdc: estimated_cost,
        estimated_parallel,
        can_fulfill: !agents.is_empty() && estimated_cost <= req.max_budget_usdc,
    })
}

// ---------------------------------------------------------------------------
// Start (dispatch loop)
// ---------------------------------------------------------------------------

/// Start the swarm dispatch loop in a background task.
/// Creates the SSE broadcast channel immediately so clients can subscribe
/// before the dispatch loop reaches its event-emitting phase.
pub fn start_swarm(state: AppState, swarm_id: Uuid) {
    let (tx, _) = tokio::sync::broadcast::channel::<String>(256);
    state.swarm_channels.insert(swarm_id, tx);

    tokio::spawn(async move {
        if let Err(e) = dispatch_loop(state, swarm_id).await {
            tracing::error!(%swarm_id, "swarm dispatch loop failed: {e}");
        }
    });
}

async fn dispatch_loop(state: AppState, swarm_id: Uuid) -> Result<(), CloudError> {
    // 1. Set status to matching
    sqlx::query("UPDATE swarm_jobs SET status = 'matching', started_at = now() WHERE id = $1")
        .bind(swarm_id)
        .execute(&state.db)
        .await?;

    // 2. Load swarm config
    let config = load_swarm_config(&state.db, swarm_id).await?;

    // 3. Match agents
    let criteria = agent_service::AgentMatchCriteria {
        require_tags: config.require_tags.clone(),
        require_tools: config.require_tools.clone(),
        prefer_model: config.prefer_model.clone(),
        min_reputation: config.min_reputation,
        limit: 200,
    };

    let agents = agent_service::match_agents(&state.db, &criteria).await?;

    if agents.is_empty() {
        sqlx::query("UPDATE swarm_jobs SET status = 'failed', completed_at = now() WHERE id = $1")
            .bind(swarm_id)
            .execute(&state.db)
            .await?;
        emit_event(
            &state,
            swarm_id,
            "swarm_failed",
            None,
            None,
            serde_json::json!({"error": "no matching agents available"}),
        );
        return Ok(());
    }

    tracing::info!(
        %swarm_id,
        agents = agents.len(),
        "swarm matched agents, starting dispatch"
    );

    // 4. Set status to running
    sqlx::query("UPDATE swarm_jobs SET status = 'running' WHERE id = $1")
        .bind(swarm_id)
        .execute(&state.db)
        .await?;

    // Broadcast channel already created in start_swarm() before spawn

    // 5. Load pending work units
    let units = load_pending_units(&state.db, swarm_id).await?;

    // 6. Create shared state for dispatch
    let sem = Arc::new(tokio::sync::Semaphore::new(config.max_parallel as usize));
    let spent = Arc::new(AtomicI64::new(0));
    let agent_counter = Arc::new(AtomicUsize::new(0));
    let agents = Arc::new(agents);

    // 7. Dispatch units
    let mut handles = Vec::new();

    for unit in units {
        // Budget check before dispatching
        if spent.load(Ordering::Relaxed) >= config.max_budget_usdc {
            tracing::info!(%swarm_id, "budget exhausted, stopping dispatch");
            break;
        }

        let permit = sem
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| CloudError::Internal("semaphore closed".into()))?;

        let state = state.clone();
        let agents = agents.clone();
        let spent = spent.clone();
        let agent_counter = agent_counter.clone();
        let max_retries = config.max_retries;
        let timeout_secs = config.timeout_secs;
        let user_id = config.user_id;
        let max_budget = config.max_budget_usdc;

        let handle = tokio::spawn(async move {
            dispatch_single_unit(
                &state,
                swarm_id,
                unit,
                &agents,
                &spent,
                &agent_counter,
                max_retries,
                timeout_secs,
                user_id,
                max_budget,
            )
            .await;
            drop(permit);
        });
        handles.push(handle);
    }

    // 8. Wait for all dispatched units
    for h in handles {
        let _ = h.await;
    }

    // 9. Finalize swarm status
    finalize_swarm(&state, swarm_id).await?;

    // Remove broadcast channel
    state.swarm_channels.remove(&swarm_id);

    Ok(())
}

async fn dispatch_single_unit(
    state: &AppState,
    swarm_id: Uuid,
    unit: PendingUnit,
    agents: &[agent_service::MatchedAgent],
    spent: &AtomicI64,
    agent_counter: &AtomicUsize,
    max_retries: i32,
    timeout_secs: i32,
    user_id: Uuid,
    max_budget: i64,
) {
    let mut attempts = 0;

    loop {
        // Pick next agent (round-robin)
        let agent_idx = agent_counter.fetch_add(1, Ordering::Relaxed) % agents.len();
        let agent = &agents[agent_idx];

        // Update unit to running
        sqlx::query(
            r#"
            UPDATE swarm_work_units SET
                status = 'running', agent_id = $1, provider_id = $2, started_at = now()
            WHERE id = $3
            "#,
        )
        .bind(agent.agent_id)
        .bind(agent.provider_id)
        .bind(unit.id)
        .execute(&state.db)
        .await
        .ok();

        // Increment running count
        sqlx::query("UPDATE swarm_jobs SET running_units = running_units + 1 WHERE id = $1")
            .bind(swarm_id)
            .execute(&state.db)
            .await
            .ok();

        emit_event(
            state,
            swarm_id,
            "unit_started",
            Some(unit.id),
            Some(unit.unit_index),
            serde_json::json!({"agent_id": agent.agent_id}),
        );

        match try_dispatch_unit(state, &unit, agent, user_id, timeout_secs).await {
            Ok((result_text, cost, metadata)) => {
                // Update unit to completed
                sqlx::query(
                    r#"
                    UPDATE swarm_work_units SET
                        status = 'completed', result = $1, cost_usdc = $2,
                        result_metadata = $3, completed_at = now()
                    WHERE id = $4
                    "#,
                )
                .bind(&result_text)
                .bind(cost)
                .bind(&metadata)
                .bind(unit.id)
                .execute(&state.db)
                .await
                .ok();

                // Update swarm counters
                spent.fetch_add(cost, Ordering::Relaxed);
                sqlx::query(
                    r#"
                    UPDATE swarm_jobs SET
                        completed_units = completed_units + 1,
                        running_units = running_units - 1,
                        spent_usdc = spent_usdc + $1
                    WHERE id = $2
                    "#,
                )
                .bind(cost)
                .bind(swarm_id)
                .execute(&state.db)
                .await
                .ok();

                // Update agent message counter directly (no session for swarm units)
                sqlx::query(
                    "UPDATE rental_agents SET total_messages = total_messages + 1, updated_at = now() WHERE id = $1",
                )
                .bind(agent.agent_id)
                .execute(&state.db)
                .await
                .ok();

                let preview: String = result_text.chars().take(200).collect();
                emit_event(
                    state,
                    swarm_id,
                    "unit_completed",
                    Some(unit.id),
                    Some(unit.unit_index),
                    serde_json::json!({"cost": cost, "preview": preview}),
                );
                return;
            }
            Err(error_msg) => {
                attempts += 1;

                // Decrement running count
                sqlx::query(
                    "UPDATE swarm_jobs SET running_units = running_units - 1 WHERE id = $1",
                )
                .bind(swarm_id)
                .execute(&state.db)
                .await
                .ok();

                if attempts <= max_retries {
                    // Retry with different agent
                    sqlx::query(
                        "UPDATE swarm_work_units SET status = 'retrying', retry_count = $1 WHERE id = $2",
                    )
                    .bind(attempts)
                    .bind(unit.id)
                    .execute(&state.db)
                    .await
                    .ok();

                    emit_event(
                        state,
                        swarm_id,
                        "unit_retrying",
                        Some(unit.id),
                        Some(unit.unit_index),
                        serde_json::json!({"attempt": attempts, "error": error_msg}),
                    );

                    // Budget check before retry
                    if spent.load(Ordering::Relaxed) >= max_budget {
                        // Mark as failed — no budget for retry
                        sqlx::query(
                            "UPDATE swarm_work_units SET status = 'failed', error_message = 'budget exhausted' WHERE id = $1",
                        )
                        .bind(unit.id)
                        .execute(&state.db)
                        .await
                        .ok();
                        sqlx::query(
                            "UPDATE swarm_jobs SET failed_units = failed_units + 1 WHERE id = $1",
                        )
                        .bind(swarm_id)
                        .execute(&state.db)
                        .await
                        .ok();
                        return;
                    }

                    continue;
                } else {
                    // Final failure
                    sqlx::query(
                        "UPDATE swarm_work_units SET status = 'failed', error_message = $1 WHERE id = $2",
                    )
                    .bind(&error_msg)
                    .bind(unit.id)
                    .execute(&state.db)
                    .await
                    .ok();

                    sqlx::query(
                        "UPDATE swarm_jobs SET failed_units = failed_units + 1 WHERE id = $1",
                    )
                    .bind(swarm_id)
                    .execute(&state.db)
                    .await
                    .ok();

                    emit_event(
                        state,
                        swarm_id,
                        "unit_failed",
                        Some(unit.id),
                        Some(unit.unit_index),
                        serde_json::json!({"error": error_msg}),
                    );
                    return;
                }
            }
        }
    }
}

/// Attempt to dispatch a single work unit to an agent. Returns (result_text, cost, metadata)
/// on success, or an error message string on failure.
async fn try_dispatch_unit(
    state: &AppState,
    unit: &PendingUnit,
    agent: &agent_service::MatchedAgent,
    user_id: Uuid,
    timeout_secs: i32,
) -> Result<(String, i64, serde_json::Value), String> {
    // Estimate cost for escrow (500 tokens in + 500 out as rough estimate)
    let estimated_cost =
        ((500 * agent.price_per_1k_input + 500 * agent.price_per_1k_output) / 1000).max(1000); // min 1000 micro-USDC ($0.001) escrow

    // Create escrow hold
    let escrow_id =
        compute_service::create_escrow(&state.db, user_id, Some(agent.provider_id), estimated_cost)
            .await
            .map_err(|e| format!("escrow failed: {e}"))?;

    // Create compute job
    let job_id = compute_service::create_job(
        &state.db,
        user_id,
        agent.provider_id,
        escrow_id,
        &agent.model_id,
    )
    .await
    .map_err(|e| format!("job creation failed: {e}"))?;

    // Update work unit with escrow and job IDs
    sqlx::query("UPDATE swarm_work_units SET escrow_id = $1, job_id = $2 WHERE id = $3")
        .bind(escrow_id)
        .bind(job_id)
        .bind(unit.id)
        .execute(&state.db)
        .await
        .ok();

    // Build messages for inference
    let prompt_text = if unit.context != serde_json::json!({}) {
        format!("{}\n\nContext:\n{}", unit.prompt, unit.context)
    } else {
        unit.prompt.clone()
    };

    let messages = serde_json::json!([
        {"role": "user", "content": prompt_text}
    ]);

    // Dispatch inference with timeout
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs as u64),
        compute_service::dispatch_inference(
            state,
            &agent.relay_pubkey,
            &messages,
            Some(&agent.system_prompt),
            &agent.model_id,
            agent.max_tokens as u32,
            &job_id.to_string(),
        ),
    )
    .await;

    match result {
        Ok(Ok(inference)) => {
            // Settle escrow with actual token counts
            let settlement = compute_service::settle_escrow(
                &state.db,
                escrow_id,
                inference.input_tokens as i64,
                inference.output_tokens as i64,
                agent.price_per_1k_input as u64,
                agent.price_per_1k_output as u64,
            )
            .await
            .map_err(|e| format!("escrow settlement failed: {e}"))?;

            // Complete the job
            compute_service::complete_job(
                &state.db,
                job_id,
                inference.input_tokens as i64,
                inference.output_tokens as i64,
                inference.latency_ms as i64,
                1.0,
            )
            .await
            .ok();

            // Update provider reputation
            compute_service::update_reputation(
                &state.db,
                agent.provider_id,
                true,
                Some(inference.latency_ms as i64),
            )
            .await
            .ok();

            let metadata = serde_json::json!({
                "input_tokens": inference.input_tokens,
                "output_tokens": inference.output_tokens,
                "latency_ms": inference.latency_ms,
                "model_id": agent.model_id,
            });

            Ok((inference.text, settlement.actual_cost, metadata))
        }
        Ok(Err(e)) => {
            // Inference failed — refund escrow, fail job
            compute_service::refund_escrow(&state.db, escrow_id)
                .await
                .ok();
            compute_service::fail_job(&state.db, job_id, &e.to_string())
                .await
                .ok();
            compute_service::update_reputation(&state.db, agent.provider_id, false, None)
                .await
                .ok();
            Err(format!("inference failed: {e}"))
        }
        Err(_) => {
            // Timeout — refund escrow, fail job
            compute_service::refund_escrow(&state.db, escrow_id)
                .await
                .ok();
            compute_service::fail_job(&state.db, job_id, "timeout")
                .await
                .ok();
            compute_service::update_reputation(&state.db, agent.provider_id, false, None)
                .await
                .ok();
            Err("inference timed out".into())
        }
    }
}

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

pub async fn cancel_swarm(db: &PgPool, swarm_id: Uuid, user_id: Uuid) -> Result<(), CloudError> {
    // Verify ownership
    let result = sqlx::query(
        "UPDATE swarm_jobs SET status = 'cancelled', completed_at = now() WHERE id = $1 AND user_id = $2 AND status NOT IN ('completed', 'failed', 'cancelled')",
    )
    .bind(swarm_id)
    .bind(user_id)
    .execute(db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(CloudError::NotFound(
            "swarm not found or already terminal".into(),
        ));
    }

    // Cancel pending/assigned units
    sqlx::query(
        "UPDATE swarm_work_units SET status = 'cancelled' WHERE swarm_id = $1 AND status IN ('pending', 'assigned')",
    )
    .bind(swarm_id)
    .execute(db)
    .await?;

    // Refund escrows for cancelled units that had escrows but hadn't started inference
    let escrow_ids: Vec<Uuid> = sqlx::query_scalar(
        r#"
        SELECT escrow_id FROM swarm_work_units
        WHERE swarm_id = $1 AND status = 'cancelled' AND escrow_id IS NOT NULL
        "#,
    )
    .bind(swarm_id)
    .fetch_all(db)
    .await?;

    for eid in escrow_ids {
        compute_service::refund_escrow(db, eid).await.ok();
    }

    tracing::info!(%swarm_id, "swarm cancelled");
    Ok(())
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

pub async fn get_swarm(
    db: &PgPool,
    swarm_id: Uuid,
    user_id: Uuid,
) -> Result<SwarmJobInfo, CloudError> {
    let row = sqlx::query(
        r#"
        SELECT id, title, description, status,
               total_units, completed_units, failed_units, running_units,
               max_budget_usdc, spent_usdc,
               created_at, started_at, completed_at
        FROM swarm_jobs WHERE id = $1 AND user_id = $2
        "#,
    )
    .bind(swarm_id)
    .bind(user_id)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| CloudError::NotFound("swarm not found".into()))?;

    Ok(row_to_swarm_info(&row))
}

pub async fn list_swarms(db: &PgPool, user_id: Uuid) -> Result<Vec<SwarmJobInfo>, CloudError> {
    let rows = sqlx::query(
        r#"
        SELECT id, title, description, status,
               total_units, completed_units, failed_units, running_units,
               max_budget_usdc, spent_usdc,
               created_at, started_at, completed_at
        FROM swarm_jobs WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 50
        "#,
    )
    .bind(user_id)
    .fetch_all(db)
    .await?;

    Ok(rows.iter().map(row_to_swarm_info).collect())
}

pub async fn get_work_units(
    db: &PgPool,
    swarm_id: Uuid,
    user_id: Uuid,
    status_filter: Option<&str>,
) -> Result<Vec<WorkUnitInfo>, CloudError> {
    // Verify ownership
    verify_swarm_ownership(db, swarm_id, user_id).await?;

    let rows = if let Some(status) = status_filter {
        sqlx::query(
            r#"
            SELECT u.id, u.unit_index, u.prompt, u.status,
                   u.result, u.cost_usdc, u.error_message, u.retry_count,
                   u.started_at, u.completed_at,
                   a.display_name AS agent_name
            FROM swarm_work_units u
            LEFT JOIN rental_agents a ON u.agent_id = a.id
            WHERE u.swarm_id = $1 AND u.status = $2
            ORDER BY u.unit_index
            "#,
        )
        .bind(swarm_id)
        .bind(status)
        .fetch_all(db)
        .await?
    } else {
        sqlx::query(
            r#"
            SELECT u.id, u.unit_index, u.prompt, u.status,
                   u.result, u.cost_usdc, u.error_message, u.retry_count,
                   u.started_at, u.completed_at,
                   a.display_name AS agent_name
            FROM swarm_work_units u
            LEFT JOIN rental_agents a ON u.agent_id = a.id
            WHERE u.swarm_id = $1
            ORDER BY u.unit_index
            "#,
        )
        .bind(swarm_id)
        .fetch_all(db)
        .await?
    };

    Ok(rows
        .iter()
        .map(|row| {
            let prompt: String = row.get("prompt");
            let result: Option<String> = row.get("result");
            WorkUnitInfo {
                id: row.get("id"),
                unit_index: row.get("unit_index"),
                prompt: prompt.chars().take(200).collect(),
                status: row.get("status"),
                agent_name: row.get("agent_name"),
                result: result.map(|r| r.chars().take(200).collect()),
                cost_usdc: row.get("cost_usdc"),
                error_message: row.get("error_message"),
                retry_count: row.get("retry_count"),
                started_at: row.get("started_at"),
                completed_at: row.get("completed_at"),
            }
        })
        .collect())
}

pub async fn get_swarm_results(
    db: &PgPool,
    swarm_id: Uuid,
    user_id: Uuid,
) -> Result<Vec<WorkUnitResult>, CloudError> {
    verify_swarm_ownership(db, swarm_id, user_id).await?;

    let rows = sqlx::query(
        r#"
        SELECT u.id, u.unit_index, u.prompt, u.result, u.result_metadata,
               u.cost_usdc, u.completed_at,
               a.display_name AS agent_name
        FROM swarm_work_units u
        LEFT JOIN rental_agents a ON u.agent_id = a.id
        WHERE u.swarm_id = $1 AND u.status = 'completed'
        ORDER BY u.unit_index
        "#,
    )
    .bind(swarm_id)
    .fetch_all(db)
    .await?;

    Ok(rows
        .iter()
        .map(|row| WorkUnitResult {
            id: row.get("id"),
            unit_index: row.get("unit_index"),
            prompt: row.get("prompt"),
            result: row.get::<Option<String>, _>("result").unwrap_or_default(),
            result_metadata: row.get("result_metadata"),
            cost_usdc: row.get("cost_usdc"),
            agent_name: row.get("agent_name"),
            completed_at: row.get("completed_at"),
        })
        .collect())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn row_to_swarm_info(row: &sqlx::postgres::PgRow) -> SwarmJobInfo {
    SwarmJobInfo {
        id: row.get("id"),
        title: row.get("title"),
        description: row.get("description"),
        status: row.get("status"),
        total_units: row.get("total_units"),
        completed_units: row.get("completed_units"),
        failed_units: row.get("failed_units"),
        running_units: row.get("running_units"),
        max_budget_usdc: row.get("max_budget_usdc"),
        spent_usdc: row.get("spent_usdc"),
        created_at: row.get("created_at"),
        started_at: row.get("started_at"),
        completed_at: row.get("completed_at"),
    }
}

async fn verify_swarm_ownership(
    db: &PgPool,
    swarm_id: Uuid,
    user_id: Uuid,
) -> Result<(), CloudError> {
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM swarm_jobs WHERE id = $1 AND user_id = $2)",
    )
    .bind(swarm_id)
    .bind(user_id)
    .fetch_one(db)
    .await
    .unwrap_or(false);

    if !exists {
        return Err(CloudError::NotFound("swarm not found".into()));
    }
    Ok(())
}

async fn load_swarm_config(db: &PgPool, swarm_id: Uuid) -> Result<SwarmConfig, CloudError> {
    let row = sqlx::query(
        r#"
        SELECT user_id, require_tags, require_tools, prefer_model, min_reputation,
               max_budget_usdc, max_parallel, max_retries, timeout_secs
        FROM swarm_jobs WHERE id = $1
        "#,
    )
    .bind(swarm_id)
    .fetch_one(db)
    .await?;

    Ok(SwarmConfig {
        user_id: row.get("user_id"),
        require_tags: row.get("require_tags"),
        require_tools: row.get("require_tools"),
        prefer_model: row.get("prefer_model"),
        min_reputation: row.get("min_reputation"),
        max_budget_usdc: row.get("max_budget_usdc"),
        max_parallel: row.get("max_parallel"),
        max_retries: row.get("max_retries"),
        timeout_secs: row.get("timeout_secs"),
    })
}

async fn load_pending_units(db: &PgPool, swarm_id: Uuid) -> Result<Vec<PendingUnit>, CloudError> {
    let rows = sqlx::query(
        r#"
        SELECT id, unit_index, prompt, context
        FROM swarm_work_units
        WHERE swarm_id = $1 AND status = 'pending'
        ORDER BY unit_index
        "#,
    )
    .bind(swarm_id)
    .fetch_all(db)
    .await?;

    Ok(rows
        .iter()
        .map(|row| PendingUnit {
            id: row.get("id"),
            unit_index: row.get("unit_index"),
            prompt: row.get("prompt"),
            context: row.get("context"),
        })
        .collect())
}

async fn finalize_swarm(state: &AppState, swarm_id: Uuid) -> Result<(), CloudError> {
    let row = sqlx::query(
        "SELECT total_units, completed_units, failed_units, spent_usdc FROM swarm_jobs WHERE id = $1",
    )
    .bind(swarm_id)
    .fetch_one(&state.db)
    .await?;

    let total: i32 = row.get("total_units");
    let completed: i32 = row.get("completed_units");
    let failed: i32 = row.get("failed_units");
    let spent: i64 = row.get("spent_usdc");

    let status = if completed == total {
        "completed"
    } else if completed == 0 && failed == total {
        "failed"
    } else if completed > 0 {
        "partial"
    } else {
        "failed"
    };

    sqlx::query("UPDATE swarm_jobs SET status = $1, completed_at = now() WHERE id = $2")
        .bind(status)
        .bind(swarm_id)
        .execute(&state.db)
        .await?;

    emit_event(
        state,
        swarm_id,
        "swarm_completed",
        None,
        None,
        serde_json::json!({
            "status": status,
            "completed": completed,
            "failed": failed,
            "total_cost": spent,
        }),
    );

    tracing::info!(
        %swarm_id,
        %status,
        completed,
        failed,
        total,
        spent,
        "swarm finalized"
    );

    Ok(())
}

fn emit_event(
    state: &AppState,
    swarm_id: Uuid,
    event_type: &str,
    unit_id: Option<Uuid>,
    unit_index: Option<i32>,
    data: serde_json::Value,
) {
    let event = serde_json::json!({
        "swarm_id": swarm_id,
        "event_type": event_type,
        "unit_id": unit_id,
        "unit_index": unit_index,
        "data": data,
    });
    if let Some(tx) = state.swarm_channels.get(&swarm_id) {
        // Silently drop if no listeners
        let _ = tx.send(event.to_string());
    }
}
