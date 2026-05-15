//! `vsock-env-server` — host-side side-channel that hands the
//! attestation envs (`PROVIDER_AUTH_KEY`, `ALLOWLIST_SIG_B64`) over
//! vsock so the enclave's entrypoint can populate them before exec'ing
//! the provider.
//!
//! Background: `nitro-cli run-enclave` does not accept `--env`, and
//! Nitro Enclaves do not inherit the parent's environment. The runbook
//! anticipated this with a placeholder for `/opt/ghola/bin/vsock-env.sh`;
//! this is the real thing.
//!
//! Wire format: KEY=VALUE\n, one per line, then EOF (close).
//!
//! Security:
//!   * vsock is host-↔-enclave only; nothing outside the box can dial.
//!   * Contents are *signatures* and a per-deploy provider seed — not
//!     identity keys. Acceptable to read from disk into the channel.
//!   * Listens on VMADDR_CID_ANY so any local enclave can pull. If a
//!     future deployment runs multiple enclaves on the same host, gate
//!     by CID at accept time (currently not needed).
//!
//! Env:
//!   ENV_DIR           — directory containing the files to publish
//!                       (default: /opt/ghola/env)
//!   ENV_KEYS          — comma-separated list of env names; each
//!                       corresponds to a file in ENV_DIR with the
//!                       same name. Defaults to the Phase 1 pair.
//!   VSOCK_LISTEN_PORT — vsock port (default: 8444; distinct from the
//!                       relay tunnel on 8443).

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("vsock-env-server runs only on Linux (Nitro Enclaves host).");
    std::process::exit(1);
}

#[cfg(target_os = "linux")]
mod linux {
    use anyhow::Result;
    use ghola_vsock_proxy::{env_port, init_tracing};
    use std::env;
    use std::path::PathBuf;
    use tokio::io::AsyncWriteExt;
    use tokio_vsock::{VsockAddr, VsockListener, VMADDR_CID_ANY};

    const DEFAULT_ENV_DIR: &str = "/opt/ghola/env";
    const DEFAULT_ENV_KEYS: &str = "PROVIDER_AUTH_KEY,ALLOWLIST_SIG_B64";

    #[tokio::main]
    pub async fn main() -> Result<()> {
        init_tracing();

        let env_dir: PathBuf = env::var("ENV_DIR")
            .unwrap_or_else(|_| DEFAULT_ENV_DIR.to_string())
            .into();
        let keys_csv = env::var("ENV_KEYS").unwrap_or_else(|_| DEFAULT_ENV_KEYS.to_string());
        let keys: Vec<String> = keys_csv
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        let vsock_port = env_port("VSOCK_LISTEN_PORT", 8444)? as u32;

        tracing::info!(
            env_dir = %env_dir.display(),
            keys = ?keys,
            vsock_port,
            "vsock-env-server starting"
        );

        let addr = VsockAddr::new(VMADDR_CID_ANY, vsock_port);
        let mut listener = VsockListener::bind(addr)
            .map_err(|e| anyhow::anyhow!("vsock bind {VMADDR_CID_ANY}:{vsock_port}: {e}"))?;
        tracing::info!("vsock-env listener bound");

        loop {
            let (mut stream, peer) = match listener.accept().await {
                Ok(v) => v,
                Err(e) => {
                    tracing::warn!(error = %e, "vsock accept failed");
                    continue;
                }
            };
            tracing::info!(?peer, "vsock-env: peer fetched envs");

            let mut payload: Vec<u8> = Vec::new();
            for key in &keys {
                let path = env_dir.join(key);
                let value = match std::fs::read_to_string(&path) {
                    Ok(v) => v.trim_end_matches('\n').to_string(),
                    Err(e) => {
                        tracing::warn!(
                            key = %key,
                            path = %path.display(),
                            error = %e,
                            "vsock-env: env file missing/unreadable; skipping"
                        );
                        continue;
                    }
                };
                // Shell-escape: wrap in single quotes, replace embedded
                // single quotes with the standard '"'"' dance. The values
                // we expect are base64/hex/raw — none should contain
                // single quotes, but defense-in-depth is cheap.
                let escaped = value.replace('\'', "'\"'\"'");
                payload.extend_from_slice(
                    format!("export {key}='{escaped}'\n").as_bytes(),
                );
            }

            if let Err(e) = stream.write_all(&payload).await {
                tracing::warn!(error = %e, "vsock-env: write failed");
            }
            // Close the connection so the client sees a clean EOF.
            let _ = stream.shutdown().await;
        }
    }
}

#[cfg(target_os = "linux")]
fn main() -> anyhow::Result<()> {
    linux::main()
}
