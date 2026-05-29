//! Thin binary entry point. All the work lives in `lib.rs`; this file
//! just wires up tracing and loads config from the environment.

use anyhow::Result;
use ghola_gpu_provider::{run, ProviderConfig};

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let cfg = ProviderConfig::from_env()?;
    tracing::info!(
        relay = %cfg.relay_url,
        models = ?cfg.models,
        max_concurrent = cfg.max_concurrent,
        "thumper-gpu-provider starting"
    );
    run(cfg).await
}
