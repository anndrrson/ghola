//! said-receipts-service binary entrypoint.
//!
//! Spins up: Postgres pool + migrations, the Solana publisher, the
//! Merkle batcher background task, and the axum HTTP router.

use std::net::SocketAddr;
use std::str::FromStr;
use std::sync::Arc;

use anyhow::Context;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions, PgSslMode};
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;

use said_receipts_service::batch::{spawn, Batcher};
use said_receipts_service::routes::{router_with_config, AppState, ReceiptsServiceConfig};
use said_receipts_service::solana::{
    load_signer_from_env, InMemoryPublisher, RpcConfig, RpcPublisher, SolanaPublisher,
};
use said_receipts_service::storage::{PgStore, ReceiptsStore};

fn db_connect_options_from_env() -> anyhow::Result<PgConnectOptions> {
    for key in [
        "DATABASE_URL",
        "RENDER_DATABASE_URL",
        "INTERNAL_DATABASE_URL",
        "POSTGRES_URL",
        "RECEIPTS_DATABASE_URL",
    ] {
        if let Ok(raw) = std::env::var(key) {
            let raw = raw.trim();
            if raw.is_empty() {
                continue;
            }
            match PgConnectOptions::from_str(raw) {
                Ok(opts) => {
                    tracing::info!(db_url_var = key, "using Postgres URL from env");
                    return Ok(opts);
                }
                Err(e) => {
                    tracing::warn!(db_url_var = key, error = %e, "invalid Postgres URL in env, trying fallback");
                }
            }
        }
    }

    let host = std::env::var("PGHOST").context("missing PGHOST for Postgres fallback")?;
    let user = std::env::var("PGUSER").context("missing PGUSER for Postgres fallback")?;
    let password = std::env::var("PGPASSWORD").unwrap_or_default();
    let database =
        std::env::var("PGDATABASE").context("missing PGDATABASE for Postgres fallback")?;
    let port = std::env::var("PGPORT")
        .ok()
        .and_then(|v| v.parse::<u16>().ok())
        .unwrap_or(5432);
    let ssl_mode = match std::env::var("PGSSLMODE")
        .unwrap_or_else(|_| "prefer".to_string())
        .to_ascii_lowercase()
        .as_str()
    {
        "disable" => PgSslMode::Disable,
        "allow" => PgSslMode::Allow,
        "prefer" => PgSslMode::Prefer,
        "require" => PgSslMode::Require,
        "verify-ca" => PgSslMode::VerifyCa,
        "verify-full" => PgSslMode::VerifyFull,
        _ => PgSslMode::Prefer,
    };

    tracing::info!("using PG* env fallback for Postgres");
    Ok(PgConnectOptions::new()
        .host(&host)
        .port(port)
        .username(&user)
        .password(&password)
        .database(&database)
        .ssl_mode(ssl_mode))
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("said_receipts_service=debug,tower_http=info")),
        )
        .init();

    let connect_options =
        db_connect_options_from_env().context("resolve Postgres configuration")?;
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
        .connect_with(connect_options)
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
