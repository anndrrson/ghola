//! `enclave-vsock-client` — runs **inside the Nitro Enclave**.
//!
//! Listens on a loopback TCP port (default `127.0.0.1:8443`). For each
//! inbound TCP connection from the in-enclave provider, dials the host
//! over vsock (CID `VMADDR_CID_HOST`, port `VSOCK_HOST_PORT`) and
//! tunnels bytes bidirectionally.
//!
//! End-to-end picture:
//!
//!   provider (rustls, SNI=ghola-relay)
//!     │
//!     │ TCP 127.0.0.1:8443
//!     ▼
//!   enclave-vsock-client  (this binary)
//!     │
//!     │ vsock CID=3 port=8443
//!     ▼
//!   vsock-proxy on the host
//!     │
//!     │ TCP relay-host:443
//!     ▼
//!   ghola-relay (Render)
//!
//! Crucially, TLS lives in the provider all the way to the relay; the
//! host vsock-proxy never sees plaintext. The host therefore cannot
//! MITM the relay session even if it's fully compromised — that's the
//! whole point of this Phase-1 work.
//!
//! Env vars:
//!   LISTEN_ADDR       — optional, default 127.0.0.1:8443
//!   VSOCK_HOST_CID    — optional, default 3 (VMADDR_CID_HOST)
//!   VSOCK_HOST_PORT   — optional, default 8443

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("enclave-vsock-client is Linux-only (requires AF_VSOCK).");
    std::process::exit(1);
}

#[cfg(target_os = "linux")]
use anyhow::{Context, Result};
#[cfg(target_os = "linux")]
use tokio::io::AsyncWriteExt;
#[cfg(target_os = "linux")]
use tokio::net::TcpListener;
#[cfg(target_os = "linux")]
use tokio_vsock::{VsockAddr, VsockStream, VMADDR_CID_HOST};

#[cfg(target_os = "linux")]
use ghola_vsock_proxy::{env_port, init_tracing};
#[cfg(target_os = "linux")]
use std::env;

#[cfg(target_os = "linux")]
#[tokio::main]
async fn main() -> Result<()> {
    init_tracing();

    let listen_addr = env::var("LISTEN_ADDR").unwrap_or_else(|_| "127.0.0.1:8443".to_string());
    let vsock_host_cid: u32 = match env::var("VSOCK_HOST_CID") {
        Ok(v) => v
            .parse()
            .with_context(|| format!("invalid u32 VSOCK_HOST_CID={v}"))?,
        Err(_) => VMADDR_CID_HOST,
    };
    let vsock_host_port = env_port("VSOCK_HOST_PORT", 8443)? as u32;

    tracing::info!(
        listen_addr = %listen_addr,
        vsock_host_cid,
        vsock_host_port,
        "enclave-vsock-client starting"
    );

    let listener = TcpListener::bind(&listen_addr)
        .await
        .with_context(|| format!("binding TCP {listen_addr}"))?;
    tracing::info!("TCP listener bound");

    loop {
        let (tcp_stream, peer) = match listener.accept().await {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(error = %e, "tcp accept failed");
                continue;
            }
        };
        tcp_stream.set_nodelay(true).ok();
        tracing::info!(?peer, "accepted TCP conn; dialing host over vsock");
        tokio::spawn(async move {
            if let Err(e) = handle_conn(tcp_stream, vsock_host_cid, vsock_host_port).await {
                tracing::warn!(error = %e, "tcp<->vsock tunnel errored");
            }
        });
    }
}

#[cfg(target_os = "linux")]
async fn handle_conn(
    tcp_stream: tokio::net::TcpStream,
    vsock_host_cid: u32,
    vsock_host_port: u32,
) -> Result<()> {
    let vsock = VsockStream::connect(VsockAddr::new(vsock_host_cid, vsock_host_port))
        .await
        .with_context(|| format!("vsock connect {vsock_host_cid}:{vsock_host_port}"))?;

    let (mut tr, mut tw) = tcp_stream.into_split();
    let (mut vr, mut vw) = tokio::io::split(vsock);

    let t2v = async move {
        let n = tokio::io::copy(&mut tr, &mut vw).await;
        let _ = vw.shutdown().await;
        n
    };
    let v2t = async move {
        let n = tokio::io::copy(&mut vr, &mut tw).await;
        let _ = tw.shutdown().await;
        n
    };

    let (t2v_res, v2t_res) = tokio::join!(t2v, v2t);
    let t2v_bytes = t2v_res.unwrap_or(0);
    let v2t_bytes = v2t_res.unwrap_or(0);
    tracing::debug!(t2v_bytes, v2t_bytes, "tunnel closed");
    Ok(())
}
