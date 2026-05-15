//! said-receipts-service binary entrypoint.
//!
//! Spins up: Postgres pool + migrations, the Solana publisher, the
//! Merkle batcher background task, and the axum HTTP router.

use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::Context;
use sqlx::postgres::PgPoolOptions;
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;

use said_receipts_service::batch::{spawn, Batcher};
use said_receipts_service::routes::{router_with_config, AppState, ReceiptsServiceConfig};
use said_receipts_service::solana::{
    load_signer_from_env, InMemoryPublisher, RpcConfig, RpcPublisher, SolanaPublisher,
};
use said_receipts_service::storage::{PgStore, ReceiptsStore};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("said_receipts_service=debug,tower_http=info")),
        )
        .init();

    let database_url = std::env::var("DATABASE_URL")
        .context("DATABASE_URL must be set for said-receipts-service")?;
    let interval_secs: u64 = std::env::var("RECEIPTS_BATCH_INTERVAL_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(3600);
    let bind_addr: SocketAddr = std::env::var("RECEIPTS_BIND_ADDR")
        .unwrap_or_else(|_| "0.0.0.0:8085".into())
        .parse()
        .context("invalid RECEIPTS_BIND_ADDR")?;
    // SAID_RECEIPTS_DRY_RUN=1 disables on-chain publish (for staging
    // environments where you want to exercise the HTTP + batching
    // path without burning SOL). Defaults to off so prod is safe.
    let dry_run = std::env::var("SAID_RECEIPTS_DRY_RUN")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);

    let pool = PgPoolOptions::new()
        .max_connections(10)
        .connect(&database_url)
        .await
        .context("connect Postgres")?;
    tracing::info!("connected to Postgres");

    sqlx::migrate!("../../migrations-receipts")
        .run(&pool)
        .await
        .context("run migrations")?;
    tracing::info!("migrations applied");

    let store: Arc<dyn ReceiptsStore> = Arc::new(PgStore::new(pool));

    let publisher: Arc<dyn SolanaPublisher> = if dry_run {
        tracing::warn!("SAID_RECEIPTS_DRY_RUN=1; using in-memory publisher (no on-chain anchor)");
        Arc::new(InMemoryPublisher::new())
    } else {
        let cfg = RpcConfig::from_env().map_err(|e| anyhow::anyhow!(e))?;
        let signer = load_signer_from_env().map_err(|e| anyhow::anyhow!(e))?;
        Arc::new(RpcPublisher::new(cfg, signer))
    };

    let batcher = Batcher::new(store.clone(), publisher);
    spawn(batcher, interval_secs);
    tracing::info!(interval_secs, "spawned Merkle batcher");

    let app = router_with_config(
        AppState {
            store,
            batcher_interval_secs: interval_secs,
        },
        ReceiptsServiceConfig::from_env(),
    )
    .layer(TraceLayer::new_for_http());

    tracing::info!(%bind_addr, "said-receipts-service listening");
    let listener = tokio::net::TcpListener::bind(bind_addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
