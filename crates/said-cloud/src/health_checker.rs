use std::sync::Arc;
use std::time::Duration;

use crate::state::AppState;

pub async fn run(state: Arc<AppState>) {
    let interval = Duration::from_secs(60);

    loop {
        tokio::time::sleep(interval).await;

        if let Err(e) = check_nodes(&state).await {
            tracing::error!("Health checker error: {e}");
        }
    }
}

async fn check_nodes(state: &AppState) -> anyhow::Result<()> {
    // Get all non-offline nodes
    let nodes: Vec<(uuid::Uuid, String)> = sqlx::query_as(
        "SELECT id, endpoint_url FROM inference_nodes WHERE status != 'offline'",
    )
    .fetch_all(&state.db)
    .await?;

    for (node_id, endpoint_url) in nodes {
        let start = std::time::Instant::now();
        let url = format!("{}/v1/models", endpoint_url.trim_end_matches('/'));

        let result = state
            .http_client
            .get(&url)
            .timeout(Duration::from_secs(10))
            .send()
            .await;

        let latency_ms = start.elapsed().as_millis() as i32;

        match result {
            Ok(resp) if resp.status().is_success() => {
                // Success -- record heartbeat, reset failures
                sqlx::query(
                    "INSERT INTO node_heartbeats (node_id, status, latency_ms) VALUES ($1, 'ok', $2)",
                )
                .bind(node_id)
                .bind(latency_ms)
                .execute(&state.db)
                .await?;

                sqlx::query(
                    r#"UPDATE inference_nodes SET
                        consecutive_failures = 0,
                        status = CASE WHEN status = 'degraded' THEN 'active' ELSE status END,
                        last_checked_at = NOW(),
                        last_heartbeat_at = NOW()
                    WHERE id = $1"#,
                )
                .bind(node_id)
                .execute(&state.db)
                .await?;
            }
            Ok(resp) => {
                // Non-success status
                let error_msg = format!("HTTP {}", resp.status());
                record_failure(state, node_id, &error_msg).await?;
            }
            Err(e) => {
                record_failure(state, node_id, &e.to_string()).await?;
            }
        }
    }

    // Calculate rolling 24h uptime for all nodes
    sqlx::query(
        r#"UPDATE inference_nodes SET uptime_percent = COALESCE(
            (SELECT 100.0 * COUNT(*) FILTER (WHERE status = 'ok') / NULLIF(COUNT(*), 0)
             FROM node_heartbeats
             WHERE node_id = inference_nodes.id AND created_at > NOW() - INTERVAL '24 hours'),
            0.0
        )"#,
    )
    .execute(&state.db)
    .await?;

    Ok(())
}

async fn record_failure(
    state: &AppState,
    node_id: uuid::Uuid,
    error_msg: &str,
) -> anyhow::Result<()> {
    sqlx::query(
        "INSERT INTO node_heartbeats (node_id, status, error_message) VALUES ($1, 'error', $2)",
    )
    .bind(node_id)
    .bind(error_msg)
    .execute(&state.db)
    .await?;

    // Increment failures and update status
    sqlx::query(
        r#"UPDATE inference_nodes SET
            consecutive_failures = consecutive_failures + 1,
            last_checked_at = NOW(),
            status = CASE
                WHEN consecutive_failures + 1 >= 5 THEN 'offline'
                WHEN consecutive_failures + 1 >= 3 THEN 'degraded'
                ELSE status
            END
        WHERE id = $1"#,
    )
    .bind(node_id)
    .execute(&state.db)
    .await?;

    Ok(())
}
