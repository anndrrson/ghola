//! Thin binary entry point — starts the axum server.

use said_shielded_pool_prover::{router, Config};
use tracing::info;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let cfg = Config::from_env()?;
    info!(
        port = cfg.port,
        artifacts_dir = %cfg.artifacts_dir.display(),
        backend = cfg.backend.as_str(),
        "starting said-shielded-pool-prover"
    );

    let app = router(cfg.clone());
    let addr: std::net::SocketAddr = ([0, 0, 0, 0], cfg.port).into();
    let listener = tokio::net::TcpListener::bind(addr).await?;
    info!(%addr, "listening");
    axum::serve(listener, app).await?;
    Ok(())
}
