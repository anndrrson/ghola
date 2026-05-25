//! said-shielded-pool-relayer binary entry point.

use std::sync::Arc;

use said_shielded_pool_relayer::batcher::Batcher;
use said_shielded_pool_relayer::config::Config;
use said_shielded_pool_relayer::decoy::DecoyTrafficGenerator;
use said_shielded_pool_relayer::dedup::Dedup;
use said_shielded_pool_relayer::metrics::Metrics;
use said_shielded_pool_relayer::queue::WithdrawalQueue;
use said_shielded_pool_relayer::routes::{router, AppState};
use said_shielded_pool_relayer::submit::RpcSubmitter;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Default log level INFO. INFO emits only queue counts + timing
    // distributions; per-withdrawal data lives at DEBUG. See SECURITY in README.
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let config = Arc::new(Config::from_env()?);
    tracing::info!(
        port = config.port,
        anonymity_threshold = config.anonymity_threshold,
        batch_size = config.batch_size,
        min_delay_secs = config.min_delay.as_secs(),
        max_delay_secs = config.max_delay.as_secs(),
        decoy_rate_per_hour = config.decoy_rate_per_hour,
        "starting said-shielded-pool-relayer"
    );

    let queue_db = sled::open(&config.queue_db_path)?;
    let queue = WithdrawalQueue::open_in(&queue_db)?;
    // Stream 3: replay-resistant dedup index. Shares the same sled DB
    // as the queue (different tree) so the two indices fsync together.
    let dedup = Arc::new(Dedup::open_in(&queue_db)?);
    let metrics = Arc::new(Metrics::new());

    // Concrete RpcSubmitter holds the zeroizable signer cache; we need
    // a typed handle so the SIGTERM hook below can call
    // `zeroize_signer` (the trait surface intentionally doesn't expose
    // it — only the binary's shutdown path should).
    let rpc_submitter = Arc::new(RpcSubmitter::new_with_program(
        config.rpc_url.clone(),
        config.keypair_path.clone(),
        config.pool_program_id.clone(),
    ));
    let submitter: Arc<dyn said_shielded_pool_relayer::submit::Submitter + Send + Sync> =
        rpc_submitter.clone();

    let batcher = Batcher::new(
        queue.clone(),
        config.clone(),
        submitter.clone(),
        metrics.clone(),
    );

    let state = AppState::with_dedup(
        queue.clone(),
        config.clone(),
        metrics.clone(),
        &batcher,
        dedup.clone(),
    );
    // Keep a handle for the background rate-limiter cleanup sweep.
    let ip_rate_limiter = state.ip_rate_limiter.clone();
    let app = router(state);

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", config.port)).await?;
    tracing::info!("listening on 0.0.0.0:{}", config.port);

    // Spawn background workers.
    let decoy = DecoyTrafficGenerator::new(config.clone(), submitter.clone(), metrics.clone());
    let _decoy_handle = tokio::spawn(decoy.run());
    let _batcher_handle = tokio::spawn(batcher.run());

    // Periodic maintenance (M3): prune the dedup index past its TTL so a flood
    // of unique proofs can't grow it without bound, and drop stale per-IP
    // rate-limit windows. Runs every 5 minutes.
    let prune_dedup = dedup.clone();
    let prune_ttl = config.dedup_ttl_secs;
    let _maintenance_handle = tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(300));
        loop {
            interval.tick().await;
            if prune_ttl > 0 {
                match prune_dedup.prune_older_than(prune_ttl) {
                    Ok(n) if n > 0 => {
                        tracing::debug!(removed = n, "dedup TTL prune swept stale entries")
                    }
                    Ok(_) => {}
                    Err(e) => tracing::warn!(error = %e, "dedup TTL prune failed"),
                }
            }
            ip_rate_limiter.cleanup().await;
        }
    });

    // Install graceful-shutdown hook so the cached signing key is
    // zeroized on SIGTERM / Ctrl-C. Without this the secret seed would
    // live in process memory until the OS finally reclaims the page,
    // which is forensically observable on systems with swap.
    let shutdown_submitter = rpc_submitter.clone();
    let shutdown = async move {
        wait_for_shutdown().await;
        tracing::info!("shutdown signal received; zeroizing signer");
        shutdown_submitter.zeroize_signer();
    };

    // `into_make_service_with_connect_info` exposes the peer `SocketAddr` to
    // handlers via `ConnectInfo`, which the per-IP rate limiter falls back to
    // when no `X-Forwarded-For` is present (direct connections / no proxy).
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown)
    .await?;
    Ok(())
}

/// Wait for either SIGTERM or SIGINT / Ctrl-C. On non-unix targets,
/// fall back to Ctrl-C only.
async fn wait_for_shutdown() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term = match signal(SignalKind::terminate()) {
            Ok(s) => s,
            Err(_) => {
                ctrl_c.await;
                return;
            }
        };
        tokio::select! {
            _ = ctrl_c => {},
            _ = term.recv() => {},
        }
    }
    #[cfg(not(unix))]
    {
        ctrl_c.await;
    }
}
