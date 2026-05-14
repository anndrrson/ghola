//! `vsock-proxy` — runs on the **EC2 host** (parent of the Nitro Enclave).
//!
//! Listens on a vsock port. For each inbound vsock connection from the
//! enclave, dials a plain TCP connection to `RELAY_HOST:RELAY_PORT` and
//! shovels bytes in both directions.
//!
//! The bytes flowing through here are **already TLS-encrypted**: the
//! provider inside the enclave runs its rustls client all the way to
//! the relay (with SNI explicitly overridden to the relay's hostname).
//! This proxy is therefore a dumb byte tunnel — it MUST NOT terminate
//! or inspect TLS. That property is what shrinks the host's trust
//! footprint to "L4 router on localhost".
//!
//! Why vsock instead of a unix domain socket or a TCP listener on
//! 127.0.0.1? Because the only network surface visible to the enclave
//! is vsock. Bridging vsock<->TCP on the host gives the enclave a
//! workable egress path while keeping the host's wider network
//! completely opaque to enclave code (no DNS, no IAM, no SSM, no IMDS).
//!
//! Env vars:
//!   RELAY_HOST       — required, DNS name of the relay (e.g. ghola-relay.onrender.com)
//!   RELAY_PORT       — optional, default 443
//!   VSOCK_LISTEN_PORT — optional, default 8443
//!
//! Logs go to stderr via `tracing`. systemd captures them.

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("vsock-proxy is Linux-only (requires AF_VSOCK).");
    std::process::exit(1);
}

#[cfg(target_os = "linux")]
use anyhow::{Context, Result};
#[cfg(target_os = "linux")]
use tokio::io::AsyncWriteExt;
#[cfg(target_os = "linux")]
use tokio::net::TcpStream;
#[cfg(target_os = "linux")]
use tokio_vsock::{VsockAddr, VsockListener, VMADDR_CID_ANY};

#[cfg(target_os = "linux")]
use ghola_vsock_proxy::{env_port, env_required, init_tracing};

#[cfg(target_os = "linux")]
#[tokio::main]
async fn main() -> Result<()> {
    init_tracing();

    let relay_host = env_required("RELAY_HOST")?;
    let relay_port = env_port("RELAY_PORT", 443)?;
    let vsock_port = env_port("VSOCK_LISTEN_PORT", 8443)? as u32;

    tracing::info!(
        relay_host = %relay_host,
        relay_port,
        vsock_port,
        "vsock-proxy starting"
    );

    // VMADDR_CID_ANY lets any enclave on this parent CID space connect.
    // The enclave's CID is fixed at run-enclave time (e.g. 16), but we
    // don't need to encode it on the listener side — vsock fans inbound
    // connections to us based on port.
    let addr = VsockAddr::new(VMADDR_CID_ANY, vsock_port);
    let mut listener = VsockListener::bind(addr)
        .with_context(|| format!("binding vsock {VMADDR_CID_ANY}:{vsock_port}"))?;
    tracing::info!("vsock listener bound");

    loop {
        let (vsock_stream, peer) = match listener.accept().await {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(error = %e, "vsock accept failed");
                continue;
            }
        };
        let relay_host = relay_host.clone();
        let relay_port = relay_port;
        tracing::info!(?peer, "accepted vsock conn; dialing relay");
        tokio::spawn(async move {
            if let Err(e) = handle_conn(vsock_stream, &relay_host, relay_port).await {
                tracing::warn!(error = %e, "vsock<->tcp tunnel errored");
            }
        });
    }
}

#[cfg(target_os = "linux")]
async fn handle_conn(
    vsock_stream: tokio_vsock::VsockStream,
    relay_host: &str,
    relay_port: u16,
) -> Result<()> {
    let tcp = TcpStream::connect((relay_host, relay_port))
        .await
        .with_context(|| format!("connecting to relay {relay_host}:{relay_port}"))?;
    // Disable Nagle so handshake byte fragments don't sit in send
    // buffers. WS frames are mostly small, latency is more important
    // than throughput here.
    tcp.set_nodelay(true).ok();

    let (mut vr, mut vw) = tokio::io::split(vsock_stream);
    let (mut tr, mut tw) = tcp.into_split();

    let v2t = async move {
        let n = tokio::io::copy(&mut vr, &mut tw).await;
        let _ = tw.shutdown().await;
        n
    };
    let t2v = async move {
        let n = tokio::io::copy(&mut tr, &mut vw).await;
        let _ = vw.shutdown().await;
        n
    };

    let (v2t_res, t2v_res) = tokio::join!(v2t, t2v);
    let v2t_bytes = v2t_res.unwrap_or(0);
    let t2v_bytes = t2v_res.unwrap_or(0);
    tracing::debug!(v2t_bytes, t2v_bytes, "tunnel closed");
    Ok(())
}
