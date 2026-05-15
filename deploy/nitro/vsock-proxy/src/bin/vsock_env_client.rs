//! `vsock-env-client` — enclave-side side-channel client that pulls
//! environment vars from the host's `vsock-env-server` and writes them
//! to stdout (suitable for `source` in a shell entrypoint).
//!
//! Usage in entrypoint.sh:
//!
//!     /usr/local/bin/vsock-env-client > /tmp/enclave-env.sh
//!     # shellcheck disable=SC1091
//!     source /tmp/enclave-env.sh
//!
//! Env:
//!   VSOCK_HOST_CID    — host vsock CID (default 3, the Nitro parent)
//!   VSOCK_ENV_PORT    — vsock port the env-server listens on (default 8444)
//!   CONNECT_TIMEOUT_MS — give up after this many ms (default 5000)

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("vsock-env-client runs only on Linux (Nitro Enclave guest).");
    std::process::exit(1);
}

#[cfg(target_os = "linux")]
mod linux {
    use anyhow::Result;
    use ghola_vsock_proxy::{env_port, init_tracing};
    use std::env;
    use std::time::Duration;
    use std::io::Write;
    use tokio::io::AsyncReadExt;
    use tokio_vsock::{VsockAddr, VsockStream};

    #[tokio::main]
    pub async fn main() -> Result<()> {
        init_tracing();

        let vsock_host_cid: u32 = match env::var("VSOCK_HOST_CID") {
            Ok(v) => v
                .parse()
                .map_err(|e| anyhow::anyhow!("invalid u32 VSOCK_HOST_CID={v}: {e}"))?,
            Err(_) => 3, // VMADDR_CID_HOST on Nitro is 3, not the libc-default 2.
        };
        let vsock_port = env_port("VSOCK_ENV_PORT", 8444)? as u32;
        let connect_timeout_ms: u64 = env::var("CONNECT_TIMEOUT_MS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(5000);

        tracing::info!(
            vsock_host_cid,
            vsock_port,
            connect_timeout_ms,
            "vsock-env-client connecting"
        );

        let addr = VsockAddr::new(vsock_host_cid, vsock_port);
        let connect_fut = VsockStream::connect(addr);
        let mut stream = tokio::time::timeout(
            Duration::from_millis(connect_timeout_ms),
            connect_fut,
        )
        .await
        .map_err(|_| {
            anyhow::anyhow!(
                "vsock connect to {vsock_host_cid}:{vsock_port} timed out after {connect_timeout_ms}ms"
            )
        })?
        .map_err(|e| anyhow::anyhow!("vsock connect to {vsock_host_cid}:{vsock_port}: {e}"))?;

        // Read everything the server sends until EOF, then dump to stdout.
        // Use std::io::stdout (sync) because the tokio "io-std" feature
        // isn't enabled on this crate and bringing it in just for one
        // final write isn't worth the transitive-dep cost.
        let mut buf = Vec::new();
        stream.read_to_end(&mut buf).await?;
        let mut stdout = std::io::stdout();
        stdout.write_all(&buf)?;
        stdout.flush()?;
        tracing::info!(bytes = buf.len(), "vsock-env-client done");
        Ok(())
    }
}

#[cfg(target_os = "linux")]
fn main() -> anyhow::Result<()> {
    linux::main()
}
