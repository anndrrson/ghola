//! Binary entry point — boots the indexer, optionally spawns the
//! forester, and serves the witness API.
//!
//! Env layout: see [`said_shielded_pool_indexer::config`] for the full
//! table and defaults.

use std::sync::Arc;

use tracing::{info, warn};

use said_shielded_pool_indexer::{
    backfill::Backfiller,
    config::Config,
    error::Result,
    forester::Forester,
    listener::EventListener,
    routes::router,
    state::AppState,
    tree::IncrementalMerkleTree,
};

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let cfg = Config::from_env()?;
    info!(
        rpc = %cfg.rpc_url,
        ws = %cfg.ws_url,
        db = %cfg.db_path.display(),
        port = cfg.port,
        program = %cfg.pool_program_id,
        forester = cfg.forester_enabled(),
        "said-shielded-pool-indexer starting"
    );

    let db = sled::open(&cfg.db_path)
        .map_err(|e| said_shielded_pool_indexer::Error::Storage(format!(
            "open {}: {e}", cfg.db_path.display()
        )))?;
    let tree = IncrementalMerkleTree::open(db)?;

    let state = AppState::new(cfg.clone(), tree);

    // Run a backfill pass if the tree is empty. (It's idempotent so it's
    // safe to always run, but skipping when next_index > 0 saves an RPC
    // burst on every restart.)
    {
        let need_backfill = {
            let t = state.tree.read().await;
            t.next_index() == 0
        };
        if need_backfill {
            let bf = Backfiller::new(state.clone());
            match bf.run().await {
                Ok(n) => info!(inserted = n, "backfill complete"),
                Err(e) => warn!("backfill failed: {e:?} (continuing — listener will catch up)"),
            }
        } else {
            info!("local tree non-empty, skipping backfill");
        }
    }

    // Spawn the event listener.
    let listener = Arc::new(EventListener::new(state.clone()));
    let listener_task = tokio::spawn({
        let l = listener.clone();
        async move { l.run().await }
    });

    // Optionally spawn the forester.
    let forester_task = if state.cfg.forester_enabled() {
        let f = Arc::new(Forester::new(state.clone())?);
        Some(tokio::spawn(async move { f.run().await }))
    } else {
        None
    };

    // HTTP server.
    let app = router(state.clone());
    let addr = format!("0.0.0.0:{}", state.cfg.port);
    let listener_sock = tokio::net::TcpListener::bind(&addr)
        .await
        .map_err(|e| said_shielded_pool_indexer::Error::Http(format!("bind {addr}: {e}")))?;
    info!(%addr, "indexer http server listening");

    let server = tokio::spawn(async move {
        if let Err(e) = axum::serve(listener_sock, app).await {
            warn!("axum server exited: {e:?}");
        }
    });

    // Wait for any of the long-lived tasks to exit; in normal operation
    // none of them ever do.
    tokio::select! {
        _ = listener_task => warn!("event listener task exited"),
        _ = server => warn!("http server task exited"),
        _ = async {
            if let Some(t) = forester_task { t.await.ok(); }
            else { std::future::pending::<()>().await; }
        } => warn!("forester task exited"),
    }

    Ok(())
}
