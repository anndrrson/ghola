use std::sync::Arc;
use std::time::Duration;

use crate::state::AppState;

pub async fn run(state: Arc<AppState>) {
    let interval = Duration::from_secs(60);

    loop {
        tokio::time::sleep(interval).await;

        if let Err(e) = check_nodes(&state).await {
            tracing::error!("Health checker (nodes) error: {e}");
        }

        if let Err(e) = check_services(&state).await {
            tracing::error!("Health checker (services) error: {e}");
        }
    }
}

/// Shared endpoint health check — pings a URL and returns (success, latency_ms, status_code, error)
async fn check_endpoint(
    client: &reqwest::Client,
    url: &str,
) -> (bool, i32, Option<u16>, Option<String>) {
    let start = std::time::Instant::now();

    match client
        .get(url)
        .timeout(Duration::from_secs(10))
        .send()
        .await
    {
        Ok(resp) => {
            let latency_ms = start.elapsed().as_millis() as i32;
            let status_code = resp.status().as_u16();
            if resp.status().is_success() {
                (true, latency_ms, Some(status_code), None)
            } else {
                (
                    false,
                    latency_ms,
                    Some(status_code),
                    Some(format!("HTTP {}", resp.status())),
                )
            }
        }
        Err(e) => {
            let latency_ms = start.elapsed().as_millis() as i32;
            (false, latency_ms, None, Some(e.to_string()))
        }
    }
}

// ── Inference Node Health Checks ──

async fn check_nodes(state: &AppState) -> anyhow::Result<()> {
    let nodes: Vec<(uuid::Uuid, String)> = sqlx::query_as(
        "SELECT id, endpoint_url FROM inference_nodes WHERE status != 'offline'",
    )
    .fetch_all(&state.db)
    .await?;

    for (node_id, endpoint_url) in nodes {
        let url = format!("{}/v1/models", endpoint_url.trim_end_matches('/'));
        let (success, latency_ms, _status_code, error_msg) =
            check_endpoint(&state.http_client, &url).await;

        if success {
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
        } else {
            record_node_failure(state, node_id, error_msg.as_deref().unwrap_or("unknown"))
                .await?;
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

async fn record_node_failure(
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

// ── Service Listing Health Checks ──

async fn check_services(state: &AppState) -> anyhow::Result<()> {
    let services: Vec<(uuid::Uuid, String, Option<String>)> = sqlx::query_as(
        "SELECT id, base_url, health_check_url FROM service_listings WHERE status::text NOT IN ('offline', 'suspended')",
    )
    .fetch_all(&state.db)
    .await?;

    for (service_id, base_url, health_check_url) in services {
        let url = health_check_url.unwrap_or_else(|| {
            format!("{}/health", base_url.trim_end_matches('/'))
        });

        let (success, latency_ms, status_code, error_msg) =
            check_endpoint(&state.http_client, &url).await;

        if success {
            sqlx::query(
                "INSERT INTO service_heartbeats (service_id, status, latency_ms, status_code) VALUES ($1, 'ok', $2, $3)",
            )
            .bind(service_id)
            .bind(latency_ms)
            .bind(status_code.map(|s| s as i32))
            .execute(&state.db)
            .await?;

            sqlx::query(
                r#"UPDATE service_listings SET
                    consecutive_failures = 0,
                    status = CASE WHEN status = 'degraded'::service_status THEN 'active'::service_status ELSE status END,
                    last_checked_at = NOW(),
                    last_heartbeat_at = NOW()
                WHERE id = $1"#,
            )
            .bind(service_id)
            .execute(&state.db)
            .await?;
        } else {
            record_service_failure(
                state,
                service_id,
                error_msg.as_deref().unwrap_or("unknown"),
                status_code,
            )
            .await?;
        }
    }

    // Calculate rolling 24h uptime for all services
    sqlx::query(
        r#"UPDATE service_listings SET
            uptime_percent = COALESCE(
                (SELECT 100.0 * COUNT(*) FILTER (WHERE status = 'ok') / NULLIF(COUNT(*), 0)
                 FROM service_heartbeats
                 WHERE service_id = service_listings.id AND created_at > NOW() - INTERVAL '24 hours'),
                0.0
            ),
            avg_latency_ms = COALESCE(
                (SELECT AVG(latency_ms)::REAL
                 FROM service_heartbeats
                 WHERE service_id = service_listings.id AND status = 'ok' AND created_at > NOW() - INTERVAL '24 hours'),
                0.0
            )"#,
    )
    .execute(&state.db)
    .await?;

    Ok(())
}

async fn record_service_failure(
    state: &AppState,
    service_id: uuid::Uuid,
    error_msg: &str,
    status_code: Option<u16>,
) -> anyhow::Result<()> {
    sqlx::query(
        "INSERT INTO service_heartbeats (service_id, status, error_message, status_code) VALUES ($1, 'error', $2, $3)",
    )
    .bind(service_id)
    .bind(error_msg)
    .bind(status_code.map(|s| s as i32))
    .execute(&state.db)
    .await?;

    sqlx::query(
        r#"UPDATE service_listings SET
            consecutive_failures = consecutive_failures + 1,
            last_checked_at = NOW(),
            status = CASE
                WHEN consecutive_failures + 1 >= 5 THEN 'offline'::service_status
                WHEN consecutive_failures + 1 >= 3 THEN 'degraded'::service_status
                ELSE status
            END
        WHERE id = $1"#,
    )
    .bind(service_id)
    .execute(&state.db)
    .await?;

    Ok(())
}
