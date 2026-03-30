use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::CloudError;
use crate::services::compute_service;

#[derive(Serialize)]
pub struct TaskBounty {
    pub id: Uuid,
    pub task_id: Uuid,
    pub funder_id: Uuid,
    pub executor_id: Option<Uuid>,
    pub amount_usdc: i64,
    pub platform_fee_bps: i32,
    pub executor_amount: i64,
    pub platform_fee: i64,
    pub status: String,
    pub created_at: DateTime<Utc>,
    pub settled_at: Option<DateTime<Utc>>,
}

#[derive(Serialize)]
pub struct BountySettlement {
    pub bounty_id: Uuid,
    pub executor_amount: i64,
    pub platform_fee: i64,
}

/// Create a bounty for a task. Holds funds via escrow against the user's
/// daily spending limit.
pub async fn create_bounty(
    db: &PgPool,
    user_id: Uuid,
    task_id: Uuid,
    amount_usdc: i64,
    fee_bps: i32,
) -> Result<Uuid, CloudError> {
    if amount_usdc <= 0 {
        return Err(CloudError::BadRequest(
            "bounty amount must be positive".to_string(),
        ));
    }

    // Hold funds via existing escrow system (no provider for bounties)
    let escrow_id = compute_service::create_escrow(db, user_id, None, amount_usdc).await?;

    // Insert bounty record
    let bounty_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO task_bounties (task_id, funder_id, amount_usdc, platform_fee_bps, escrow_id)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id
        "#,
    )
    .bind(task_id)
    .bind(user_id)
    .bind(amount_usdc)
    .bind(fee_bps)
    .bind(escrow_id)
    .fetch_one(db)
    .await?;

    // Tag the task with the bounty amount
    sqlx::query("UPDATE tasks SET bounty_usdc = $1 WHERE id = $2")
        .bind(amount_usdc)
        .bind(task_id)
        .execute(db)
        .await?;

    tracing::info!(
        %bounty_id,
        %task_id,
        amount_usdc,
        "task bounty created"
    );

    Ok(bounty_id)
}

/// Settle a bounty: split the amount between executor and platform, credit
/// the executor's earned_usdc balance.
pub async fn settle_bounty(
    db: &PgPool,
    task_id: Uuid,
    executor_id: Uuid,
) -> Result<BountySettlement, CloudError> {
    let row = sqlx::query_as::<_, (Uuid, i64, i32, Option<Uuid>)>(
        r#"
        SELECT id, amount_usdc, platform_fee_bps, escrow_id
        FROM task_bounties
        WHERE task_id = $1 AND status = 'held'
        "#,
    )
    .bind(task_id)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| CloudError::NotFound("no held bounty for this task".to_string()))?;

    let (bounty_id, amount, fee_bps, escrow_id) = row;

    let platform_fee = amount * fee_bps as i64 / 10_000;
    let executor_amount = amount - platform_fee;

    // Mark bounty as released
    sqlx::query(
        r#"
        UPDATE task_bounties
        SET status = 'released',
            executor_id = $1,
            executor_amount = $2,
            platform_fee = $3,
            settled_at = now()
        WHERE id = $4
        "#,
    )
    .bind(executor_id)
    .bind(executor_amount)
    .bind(platform_fee)
    .bind(bounty_id)
    .execute(db)
    .await?;

    // Release the escrow hold
    if let Some(eid) = escrow_id {
        let _ = sqlx::query(
            "UPDATE escrow_holds SET status = 'released', released_to_provider = $1, platform_fee = $2, resolved_at = now() WHERE id = $3 AND status = 'held'",
        )
        .bind(executor_amount)
        .bind(platform_fee)
        .bind(eid)
        .execute(db)
        .await;
    }

    // Credit executor's earned balance
    sqlx::query(
        "UPDATE user_wallets SET earned_usdc = COALESCE(earned_usdc, 0) + $1 WHERE user_id = $2",
    )
    .bind(executor_amount)
    .bind(executor_id)
    .execute(db)
    .await?;

    // Tag the task with executor_id
    sqlx::query("UPDATE tasks SET executor_id = $1 WHERE id = $2")
        .bind(executor_id)
        .bind(task_id)
        .execute(db)
        .await?;

    // Update reputation: increment bounties_completed for executor, bounties_funded for funder
    sqlx::query(
        r#"
        UPDATE users SET
            bounties_completed = COALESCE(bounties_completed, 0) + 1,
            reputation_score = LEAST(1.0, COALESCE(reputation_score, 0.5) + 0.01)
        WHERE id = $1
        "#,
    )
    .bind(executor_id)
    .execute(db)
    .await?;

    // Get funder_id from the bounty to update their stats
    let funder_id = row.0; // bounty_id is row.0, but we need funder — let me use task_id
    sqlx::query(
        r#"
        UPDATE users SET
            bounties_funded = COALESCE(bounties_funded, 0) + 1,
            reputation_score = LEAST(1.0, COALESCE(reputation_score, 0.5) + 0.005)
        WHERE id = (SELECT user_id FROM tasks WHERE id = $1)
        "#,
    )
    .bind(task_id)
    .execute(db)
    .await?;

    tracing::info!(
        %bounty_id,
        %task_id,
        executor_amount,
        platform_fee,
        "bounty settled + reputation updated"
    );

    Ok(BountySettlement {
        bounty_id,
        executor_amount,
        platform_fee,
    })
}

/// Refund a bounty (on task failure or cancellation).
pub async fn refund_bounty(db: &PgPool, task_id: Uuid) -> Result<(), CloudError> {
    let row = sqlx::query_as::<_, (Uuid, Option<Uuid>)>(
        "SELECT id, escrow_id FROM task_bounties WHERE task_id = $1 AND status = 'held'",
    )
    .bind(task_id)
    .fetch_optional(db)
    .await?;

    let Some((bounty_id, escrow_id)) = row else {
        return Ok(()); // no bounty or already resolved
    };

    // Refund the escrow hold
    if let Some(eid) = escrow_id {
        let _ = compute_service::refund_escrow(db, eid).await;
    }

    // Mark bounty refunded
    sqlx::query("UPDATE task_bounties SET status = 'refunded', settled_at = now() WHERE id = $1")
        .bind(bounty_id)
        .execute(db)
        .await?;

    tracing::info!(%bounty_id, %task_id, "bounty refunded");
    Ok(())
}

/// Get bounty details for a task.
pub async fn get_bounty(db: &PgPool, task_id: Uuid) -> Result<Option<TaskBounty>, CloudError> {
    let row = sqlx::query_as::<_, (Uuid, Uuid, Uuid, Option<Uuid>, i64, i32, i64, i64, String, DateTime<Utc>, Option<DateTime<Utc>>)>(
        r#"
        SELECT id, task_id, funder_id, executor_id, amount_usdc, platform_fee_bps,
               executor_amount, platform_fee, status, created_at, settled_at
        FROM task_bounties
        WHERE task_id = $1
        "#,
    )
    .bind(task_id)
    .fetch_optional(db)
    .await?;

    Ok(row.map(|r| TaskBounty {
        id: r.0,
        task_id: r.1,
        funder_id: r.2,
        executor_id: r.3,
        amount_usdc: r.4,
        platform_fee_bps: r.5,
        executor_amount: r.6,
        platform_fee: r.7,
        status: r.8,
        created_at: r.9,
        settled_at: r.10,
    }))
}

/// List bounties for a user (as funder or executor).
pub async fn list_bounties(
    db: &PgPool,
    user_id: Uuid,
    status_filter: Option<&str>,
    limit: i64,
    offset: i64,
) -> Result<Vec<TaskBounty>, CloudError> {
    let rows = if let Some(status) = status_filter {
        sqlx::query_as::<_, (Uuid, Uuid, Uuid, Option<Uuid>, i64, i32, i64, i64, String, DateTime<Utc>, Option<DateTime<Utc>>)>(
            r#"
            SELECT id, task_id, funder_id, executor_id, amount_usdc, platform_fee_bps,
                   executor_amount, platform_fee, status, created_at, settled_at
            FROM task_bounties
            WHERE (funder_id = $1 OR executor_id = $1) AND status = $2
            ORDER BY created_at DESC
            LIMIT $3 OFFSET $4
            "#,
        )
        .bind(user_id)
        .bind(status)
        .bind(limit)
        .bind(offset)
        .fetch_all(db)
        .await?
    } else {
        sqlx::query_as::<_, (Uuid, Uuid, Uuid, Option<Uuid>, i64, i32, i64, i64, String, DateTime<Utc>, Option<DateTime<Utc>>)>(
            r#"
            SELECT id, task_id, funder_id, executor_id, amount_usdc, platform_fee_bps,
                   executor_amount, platform_fee, status, created_at, settled_at
            FROM task_bounties
            WHERE funder_id = $1 OR executor_id = $1
            ORDER BY created_at DESC
            LIMIT $2 OFFSET $3
            "#,
        )
        .bind(user_id)
        .bind(limit)
        .bind(offset)
        .fetch_all(db)
        .await?
    };

    Ok(rows
        .into_iter()
        .map(|r| TaskBounty {
            id: r.0,
            task_id: r.1,
            funder_id: r.2,
            executor_id: r.3,
            amount_usdc: r.4,
            platform_fee_bps: r.5,
            executor_amount: r.6,
            platform_fee: r.7,
            status: r.8,
            created_at: r.9,
            settled_at: r.10,
        })
        .collect())
}
